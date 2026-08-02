/**
 * Board-relative strength classes for a hole-card combo.
 *
 * This replaces `bayesian.tierOf` everywhere a *postflop* judgement is needed.
 * `tierOf` scores a holding with a Chen preflop formula on every street, so on
 * K-7-2-9-4 it still calls 7-2 "weak" — a hand that has flopped two pair and is
 * beating most of the deck. Bucketing an opponent's range with that is not a
 * small inaccuracy: it puts the made hands in the wrong bin, and every equity
 * number sampled from those bins inherits the error.
 *
 * The fix is to classify against the board. The same combo is a different hand
 * on a different board, and that is the entire point — 7-2 is trash preflop and
 * two pair on K-7-2, and AA is the best hand preflop and a chop on 5-6-7-8-9.
 *
 * Two rules make the classes honest rather than merely categorical:
 *
 *  - A hand the whole field also holds is not this combo's hand. Playing the
 *    board is Air; trips the board already shows are not a monster; two pair
 *    made of a pocket pair plus a paired board is a one-pair hand.
 *  - Draws are worth something only while cards are still to come. A flush draw
 *    on the flop is not "nothing"; the same missed draw on the river is exactly
 *    nothing, and the taxonomy says so because `needed` has hit zero.
 *
 * Preflop there is no board, so the ladder falls back to `holeScore` bands and
 * the preflop story is unchanged.
 *
 * Hot path: `classifyAll` runs all 1326 combos for one board with no allocation
 * beyond the output array — ~190 µs, or 0.14 µs per combo, which buckets.test.ts
 * measures. A decision runs it a handful of times, so it is free next to the
 * Monte Carlo it feeds.
 */

import { holeScore } from "../bayesian";
import { decodeCard, encodeCard, encodeCards } from "../core/card";
import { categoryOf, scoreInts } from "../handEvaluator";
import {
  COMBO_COUNT,
  comboCardA,
  comboCardB,
  comboIndex,
} from "./range";
import { HandCategory, type Card, type StrengthTier } from "../../types";

/**
 * The strength ladder, ordered by increasing equity against a random hand.
 *
 * The ordering is load-bearing, not cosmetic: downstream code aggregates
 * "belief mass at or above bucket k", which only means anything if the index is
 * monotone in strength. The cut points were placed by measurement, not by
 * intuition — buckets.test.ts rolls out every combo on 40 random boards per
 * street and asserts the means come out in this order. Two results from that
 * measurement are worth stating, because both contradict the obvious guess:
 *
 *  - `StrongDraw` sits BELOW `WeakPair`. A bare flush draw or open-ender with
 *    no pair measures 0.514 on the flop and 0.392 on the turn against a random
 *    hand; bottom pair measures 0.571 and 0.550. Draws feel stronger than that
 *    because they are usually held alongside something, and this bucket is what
 *    is left once that something is classified on its own (see classifyPostflop).
 *  - `TopPair` and `Overpair` are the same rung. They measure 0.776 / 0.796 on
 *    the flop, 0.773 / 0.756 on the turn and 0.783 / 0.791 on the river — the
 *    sign of the gap flips with the boards drawn, so the test asserts they are
 *    close rather than pretending the ladder is sharper than the game is.
 */
export enum HandBucket {
  /** No pair, no draw. Also where "playing the board" lands. */
  Air = 0,
  /** Gutshot, two overcards, or a backdoor flush: equity, no showdown value. */
  WeakDraw = 1,
  /** Flush draw or open-ended straight draw, with cards still to come. */
  StrongDraw = 2,
  /** Bottom pair, or a pocket pair under the board's second-highest card. */
  WeakPair = 3,
  /** Second pair, or a pocket pair between the top two board ranks. */
  MidPair = 4,
  /** Pairs the highest board card. */
  TopPair = 5,
  /** Pocket pair above every board card. */
  Overpair = 6,
  /** Two pair made with both hole cards. */
  TwoPair = 7,
  /** Trips or better: set, straight, flush, full house, quads. */
  Monster = 8,
}

export const BUCKET_COUNT = 9;

/** Postflop labels — what the bucket actually means once there is a board. */
export const BUCKET_NAMES: Record<HandBucket, string> = {
  [HandBucket.Air]: "Air",
  [HandBucket.WeakDraw]: "Weak Draw",
  [HandBucket.StrongDraw]: "Strong Draw",
  [HandBucket.WeakPair]: "Weak Pair",
  [HandBucket.MidPair]: "Middle Pair",
  [HandBucket.TopPair]: "Top Pair",
  [HandBucket.Overpair]: "Overpair",
  [HandBucket.TwoPair]: "Two Pair",
  [HandBucket.Monster]: "Monster",
};

/**
 * `holeScore` cut points, descending: band 8 - i covers scores >= BANDS[i].
 *
 * Placed on the Chen score's own quantiles rather than on round numbers,
 * because the score is lumpy — it takes only 17 distinct values over the 1326
 * combos and 236 of them score exactly 5. These cuts give roughly
 * 2 / 2 / 2 / 4 / 7 / 8 / 18 / 24 / 33 percent of the deck per band, top to
 * bottom, which is the shape a preflop range chart actually has. Even cuts on
 * the score's *range* would put 0.5% in the top band and 42% in one middle one.
 */
const PREFLOP_BANDS: readonly number[] = [12, 10, 9, 8, 7, 6, 5, 3];

// ---------------------------------------------------------------------------
// Straight lookup, keyed by a 13-bit rank mask (bit i set => rank i+2 present)
// ---------------------------------------------------------------------------
//
// A copy of the table in handEvaluator.ts, which does not export it. Rebuilding
// 8 KB at module load is cheaper than the alternative — reaching into another
// module's internals — and the wheel case below is the only subtlety.

const MASKS = 1 << 13;
/** High card of the best straight in the mask, 0 if none. */
const STRAIGHT = new Uint8Array(MASKS);

for (let mask = 1; mask < MASKS; mask++) {
  for (let high = 14; high >= 6; high--) {
    const need = 0x1f << (high - 6);
    if ((mask & need) === need) {
      STRAIGHT[mask] = high;
      break;
    }
  }
  // A-2-3-4-5 is the one straight that is not five consecutive bits.
  if (STRAIGHT[mask] === 0 && (mask & 0x100f) === 0x100f) STRAIGHT[mask] = 5;
}

// ---------------------------------------------------------------------------
// Preflop band table
// ---------------------------------------------------------------------------

/** Bucket per combo with no board. Built once; preflop classify is one load. */
const PREFLOP_BUCKET = new Uint8Array(COMBO_COUNT);

for (let i = 0; i < COMBO_COUNT; i++) {
  const score = holeScore(decodeCard(comboCardA(i)), decodeCard(comboCardB(i)));
  let bucket = HandBucket.Air;
  for (let band = 0; band < PREFLOP_BANDS.length; band++) {
    if (score >= PREFLOP_BANDS[band]) {
      bucket = (HandBucket.Monster - band) as HandBucket;
      break;
    }
  }
  PREFLOP_BUCKET[i] = bucket;
}

// ---------------------------------------------------------------------------
// Board context
// ---------------------------------------------------------------------------

/**
 * Everything about a board that does not depend on the hole cards, computed
 * once so classifying 1326 combos costs one evaluator call each and nothing
 * else.
 */
export interface BoardContext {
  /** Board card codes (0..51). Length 0, 3, 4 or 5. */
  readonly board: Uint8Array;
  readonly len: number;
  /** Cards still to come, 5 - len. Zero kills every draw class. */
  readonly needed: number;
  /** 13-bit rank mask of the board (bit r-2). */
  readonly boardMask: number;
  /** Score of the board's own best hand — what "playing the board" is worth. */
  readonly boardScore: number;
  readonly boardCat: HandCategory;
  /** Distinct board ranks, descending. */
  readonly ranks: Uint8Array;
  /** How many of `ranks` are populated. */
  readonly rankCount: number;
  /** Index into `ranks` for each rank 2..14, 255 when the rank is absent. */
  readonly rankSlot: Uint8Array;
  /**
   * Highest rank the board holds two or more of, 0 if the board is unpaired.
   *
   * A paired board spends one of the two available pair slots on its own pair,
   * which is what decides whether a hole-card pair actually plays. See
   * `madeBucket` and `pairBucket`.
   */
  readonly boardPairRank: number;
  /**
   * Second-highest such rank, 0 if the board holds fewer than two pairs.
   *
   * Both of the board's pairs play on a double-paired board, so a hole-card
   * pair below this one never reaches the five-card hand at all.
   */
  readonly boardPair2Rank: number;
  /** Board cards of each suit, indexed by suit code 0..3. */
  readonly suitCount: Uint8Array;
  /**
   * Scratch buffer `[holeA, holeB, ...board]`, refilled per combo. Shared, so
   * classification is not reentrant — same bargain the evaluator's SUIT_MASKS
   * makes, and for the same reason.
   */
  readonly hand: Uint8Array;
}

export function makeBoardContext(board: ArrayLike<number>): BoardContext {
  const len = board.length;
  if (len > 5) throw new Error(`makeBoardContext: board of ${len} cards`);

  const cards = new Uint8Array(len);
  const suitCount = new Uint8Array(4);
  const rankSlot = new Uint8Array(15).fill(255);
  const counts = new Uint8Array(15);
  let boardMask = 0;

  for (let i = 0; i < len; i++) {
    const c = board[i];
    // `c < 0 || c > 51` alone is false for NaN, undefined and null, so a bad
    // code would sail through and index as 0 (the ace of spades) or corrupt a
    // whole classification pass. Every sibling entry point checks; so does this.
    if (!Number.isInteger(c) || c < 0 || c > 51) {
      throw new Error(`makeBoardContext: bad card code ${c}`);
    }
    cards[i] = c;
    suitCount[c & 3]++;
    counts[(c >> 2) + 2]++;
    boardMask |= 1 << (c >> 2);
  }

  const ranks = new Uint8Array(len);
  let rankCount = 0;
  // Descending, so the first two ranks the board holds a pair of are found in
  // the same sweep that fills `ranks`.
  let boardPairRank = 0;
  let boardPair2Rank = 0;
  for (let r = 14; r >= 2; r--) {
    if (counts[r] > 0) {
      rankSlot[r] = rankCount;
      ranks[rankCount++] = r;
      if (counts[r] >= 2) {
        if (boardPairRank === 0) boardPairRank = r;
        else if (boardPair2Rank === 0) boardPair2Rank = r;
      }
    }
  }

  // With fewer than five cards this is the board's best *partial* hand; it is
  // only compared for equality against a seven-card score when len === 5, and
  // only its category is consulted otherwise.
  const boardScore = len > 0 ? scoreInts(cards, len) : 0;

  // The board never moves, so it is written into the scratch hand once here
  // rather than 1326 times per classification pass.
  const hand = new Uint8Array(2 + len);
  for (let i = 0; i < len; i++) hand[2 + i] = cards[i];

  return {
    board: cards,
    len,
    needed: 5 - len,
    boardMask,
    boardScore,
    boardCat: categoryOf(boardScore),
    ranks,
    rankCount,
    rankSlot,
    boardPairRank,
    boardPair2Rank,
    suitCount,
    hand,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Bucket of a combo index (see range.ts) on this board. */
export function classifyCombo(combo: number, ctx: BoardContext): HandBucket {
  if (ctx.len === 0) return PREFLOP_BUCKET[combo] as HandBucket;
  return classifyPostflop(comboCardA(combo), comboCardB(combo), ctx);
}

/** Bucket of two card codes on this board. */
export function classifyHole(
  a: number,
  b: number,
  ctx: BoardContext
): HandBucket {
  if (ctx.len === 0) return PREFLOP_BUCKET[comboIndex(a, b)] as HandBucket;
  return classifyPostflop(a, b, ctx);
}

/**
 * Every combo at once — the entry point a decision actually uses.
 *
 * Combos that clash with the board are classified anyway (the evaluator simply
 * sees a repeated rank) rather than flagged: callers zero them with
 * `removeCards`, so the value is never read, and branching on it would cost a
 * test per combo to protect a result nobody looks at.
 */
export function classifyAll(ctx: BoardContext, out?: Uint8Array): Uint8Array {
  // A short buffer would be written past its end silently — typed arrays drop
  // out-of-range stores — and the caller would read stale buckets for the tail.
  if (out !== undefined && out.length < COMBO_COUNT) {
    throw new Error(
      `classifyAll: out buffer holds ${out.length}, need ${COMBO_COUNT}`
    );
  }
  const buckets = out ?? new Uint8Array(COMBO_COUNT);
  if (ctx.len === 0) {
    buckets.set(PREFLOP_BUCKET);
    return buckets;
  }
  for (let i = 0; i < COMBO_COUNT; i++) {
    buckets[i] = classifyPostflop(comboCardA(i), comboCardB(i), ctx);
  }
  return buckets;
}

/** `tierOf`-shaped convenience for `Card`s. Builds a context, so not hot-path. */
export function bucketOfCards(
  a: Card,
  b: Card,
  board: Card[] = []
): HandBucket {
  const ctx = makeBoardContext(encodeCards(board));
  return classifyHole(encodeCard(a), encodeCard(b), ctx);
}

/**
 * Collapse the ladder onto the three tiers the existing belief model speaks, so
 * a bucketed range can drive `BeliefDistribution` without either side changing.
 * Three even thirds of the ladder — the cut points are a convention, not a
 * claim.
 */
export function tierFromBucket(bucket: HandBucket): StrengthTier {
  if (bucket >= HandBucket.Overpair) return "strong";
  if (bucket >= HandBucket.WeakPair) return "medium";
  return "weak";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function classifyPostflop(
  a: number,
  b: number,
  ctx: BoardContext
): HandBucket {
  const ra = (a >> 2) + 2;
  const rb = (b >> 2) + 2;
  const hi = ra > rb ? ra : rb;
  const lo = ra > rb ? rb : ra;

  // Slots 2.. already hold the board (see makeBoardContext).
  const hand = ctx.hand;
  hand[0] = a;
  hand[1] = b;
  const score = scoreInts(hand, 2 + ctx.len);

  // A complete board the hole cards cannot improve is everybody's hand, not
  // this combo's. This is the one case where a straight or flush on the score
  // sheet is worth nothing at all, which is why it is checked before category.
  if (ctx.needed === 0 && score === ctx.boardScore) return HandBucket.Air;

  // Quads on a board still to come is the same story, but the equality above
  // cannot see it: `boardScore` is then a four-card partial hand and ours a
  // six-card one, so they never compare equal. Every combo makes the board's
  // quads and nothing better, so without this a 7-7-7-7 turn reads Monster for
  // all 1326. On the river the equality does fire, and the one combo that beats
  // the board there — a better kicker — must keep its Monster.
  if (ctx.needed > 0 && ctx.boardCat === HandCategory.FourOfAKind) {
    return HandBucket.Air;
  }

  const made = madeBucket(score, hi, lo, ctx);
  if (ctx.needed === 0) return made;

  // Made hand and draw are two readings of the same combo; the honest class is
  // the better of them, so a flush draw with bottom pair is a flush draw and
  // top pair with a flush draw is at least top pair.
  const draw = drawBucket(a, b, ra, rb, lo, ctx);
  return made > draw ? made : draw;
}

function madeBucket(
  score: number,
  hi: number,
  lo: number,
  ctx: BoardContext
): HandBucket {
  const cat = categoryOf(score);

  if (cat >= HandCategory.Straight) {
    // Below five board cards the board cannot make a five-card hand on its own,
    // and at five the "plays the board" check already fired — so a straight or
    // better here is always at least partly the hole cards' doing.
    return HandBucket.Monster;
  }

  if (cat === HandCategory.ThreeOfAKind) {
    // Trips the board already shows are shared by the whole field. Strip them
    // and rank whatever the hole cards do on their own.
    if (ctx.boardCat !== HandCategory.ThreeOfAKind) return HandBucket.Monster;
    return pairBucket(hi, lo, ctx);
  }

  if (cat === HandCategory.TwoPair) {
    // Only two pair made with BOTH hole cards is really two pair. A pocket pair
    // beside a paired board, or one hole card pairing a paired board, is a
    // one-pair hand wearing the board's pair as a hat — rank it by its own pair.
    //
    // A paired board is the same story a rung up: the board's own pair already
    // occupies one of the two pair slots, so the lower of our two paired ranks
    // is a kicker rather than a pair. On As-Ah-Kd-7c-2s, K-7 and K-Q both play
    // A-A-K-K plus a kicker, and K-Q's is the better one — so requiring `lo` to
    // beat the board's pair is what keeps the ladder pointing the right way.
    if (
      hi !== lo &&
      ctx.rankSlot[hi] !== 255 &&
      ctx.rankSlot[lo] !== 255 &&
      lo > ctx.boardPairRank
    ) {
      return HandBucket.TwoPair;
    }
    return pairBucket(hi, lo, ctx);
  }

  if (cat === HandCategory.Pair) return pairBucket(hi, lo, ctx);

  return HandBucket.Air;
}

/**
 * Where a one-pair hand sits, measured against the board rather than in the
 * abstract: which board card it paired, or where a pocket pair falls among the
 * board's ranks. Returns Air when the pair on the score sheet is entirely the
 * board's (A-K on 7-7-2 has a pair of sevens and nothing else).
 *
 * A five-card hand shows at most two pairs, so on a board that already shows
 * two of its own — K-K-J-J-6 — our pair only reaches the hand if it outranks
 * the lower of them. A pair of sixes there is not bottom pair, it is nothing:
 * the hand is K-K-J-J plus a kicker either way. That is `boardPair2Rank`, and
 * it is deliberately NOT `boardPairRank`: on a singly-paired board like
 * A-A-K-7-2 our pair does still play (7-3 makes A-A-7-7, real two pair that
 * beats anyone holding one pair), so testing against the board's top pair there
 * would bury genuinely strong hands in Air. Measured over 200 exact-equity
 * river boards, the `boardPairRank` form drops Somers' D against exact equity
 * from 0.721 to 0.627 while this form raises it to 0.723.
 */
function pairBucket(hi: number, lo: number, ctx: BoardContext): HandBucket {
  const b0 = ctx.ranks[0];
  const b1 = ctx.rankCount > 1 ? ctx.ranks[1] : 0;

  if (hi === lo) {
    // A pocket pair matching a board rank is trips or better, so it never
    // reaches here: `hi` is strictly off the board and the comparisons decide.
    if (hi < ctx.boardPair2Rank) return HandBucket.Air;
    if (hi > b0) return HandBucket.Overpair;
    if (hi > b1) return HandBucket.MidPair;
    return HandBucket.WeakPair;
  }

  // The better of the two, since a hole card may pair any board rank.
  const sHi = ctx.rankSlot[hi];
  const sLo = ctx.rankSlot[lo];
  const slot = sHi < sLo ? sHi : sLo;

  if (slot === 255) return HandBucket.Air;
  if (ctx.ranks[slot] < ctx.boardPair2Rank) return HandBucket.Air;
  if (slot === 0) return HandBucket.TopPair;
  if (slot === 1) return HandBucket.MidPair;
  return HandBucket.WeakPair;
}

/**
 * Draw strength, only ever reached while `needed > 0`. Every test here asks
 * whether the HOLE cards are what create the draw: four to a flush on the board
 * alone, or an open-ender the board already has, belongs to the whole field and
 * tells us nothing about this combo.
 */
function drawBucket(
  a: number,
  b: number,
  ra: number,
  rb: number,
  lo: number,
  ctx: BoardContext
): HandBucket {
  let bucket = HandBucket.Air;

  const sa = a & 3;
  const sb = b & 3;
  if (sa === sb) {
    const suited = ctx.suitCount[sa] + 2;
    if (suited >= 4) return HandBucket.StrongDraw;
    // Backdoor flush: three to a suit needs both remaining cards, so it only
    // counts on the flop.
    if (suited === 3 && ctx.needed === 2) bucket = HandBucket.WeakDraw;
  } else if (ctx.suitCount[sa] >= 3 || ctx.suitCount[sb] >= 3) {
    return HandBucket.StrongDraw;
  }

  const handMask = ctx.boardMask | (1 << (ra - 2)) | (1 << (rb - 2));
  if (STRAIGHT[handMask] === 0) {
    let outs = 0;
    for (let r = 2; r <= 14; r++) {
      const bit = 1 << (r - 2);
      // A rank already present cannot be an out — a second copy changes nothing.
      if (handMask & bit) continue;
      // ...and neither can one that completes the board's own straight, which
      // every opponent would make too.
      if (
        STRAIGHT[handMask | bit] !== 0 &&
        STRAIGHT[ctx.boardMask | bit] === 0
      ) {
        outs++;
      }
    }
    // Two or more out-ranks is open-ended or a double gutshot; one is a gutshot.
    if (outs >= 2) return HandBucket.StrongDraw;
    if (outs === 1) bucket = HandBucket.WeakDraw;
  }

  // Two overcards: six outs to a pair that is very likely best, which is more
  // than nothing and less than a draw to a made hand.
  if (lo > ctx.ranks[0] && bucket < HandBucket.WeakDraw) {
    bucket = HandBucket.WeakDraw;
  }

  return bucket;
}
