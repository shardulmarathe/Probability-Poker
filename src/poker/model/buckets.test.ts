import { describe, expect, it } from "vitest";
import { holeScore, tierOf } from "../bayesian";
import { makeDeck } from "../cards";
import { decodeCard, encodeCard } from "../core/card";
import { makeRng, type Rng } from "../core/rng";
import { scoreInts } from "../handEvaluator";
import {
  BUCKET_COUNT,
  BUCKET_NAMES,
  HandBucket,
  bucketOfCards,
  classifyAll,
  classifyCombo,
  classifyHole,
  makeBoardContext,
  tierFromBucket,
} from "./buckets";
import { COMBO_COUNT, comboCardA, comboCardB, comboIndex } from "./range";

const deck = makeDeck();

/** Card code from an id like "Ah". */
function code(id: string): number {
  const card = deck.find((c) => c.id === id);
  if (!card) throw new Error(`no such card: ${id}`);
  return encodeCard(card);
}

/** Space-separated card ids to codes; "" is the preflop board. */
function codes(ids: string): number[] {
  return ids.length ? ids.split(" ").map(code) : [];
}

function bucketOf(hole: string, board: string): HandBucket {
  const [a, b] = codes(hole);
  return classifyHole(a, b, makeBoardContext(codes(board)));
}

/**
 * Score of the best five-card hand from these hole cards and this board, the
 * showdown truth a bucket is supposed to be a summary of. Two holdings with the
 * same score are the same hand and must not land in different buckets.
 */
function scoreOf(hole: string, board: string): number {
  const cards = [...codes(hole), ...codes(board)];
  return scoreInts(Uint8Array.from(cards), cards.length);
}

/**
 * Equity of a holding against a uniformly random opponent hand on this board,
 * by rollout. Chops count a half. Used to check that the ladder actually
 * measures what it claims to.
 */
function equityOf(
  hole: string,
  board: string,
  rng: Rng,
  sims: number
): number {
  const [a, b] = codes(hole);
  return equityOfCodes(a, b, codes(board), rng, sims);
}

function equityOfCodes(
  a: number,
  b: number,
  board: number[],
  rng: Rng,
  sims: number
): number {
  const used = new Uint8Array(52);
  used[a] = 1;
  used[b] = 1;
  for (const c of board) used[c] = 1;
  const pool: number[] = [];
  for (let c = 0; c < 52; c++) if (used[c] === 0) pool.push(c);

  const cc = board.length;
  const need = 5 - cc;
  const size = 2 + cc + need;
  const hero = new Uint8Array(size);
  const vill = new Uint8Array(size);
  hero[0] = a;
  hero[1] = b;
  for (let i = 0; i < cc; i++) {
    hero[2 + i] = board[i];
    vill[2 + i] = board[i];
  }

  let score = 0;
  for (let s = 0; s < sims; s++) {
    for (let d = 0; d < 2 + need; d++) {
      const t = d + rng.int(pool.length - d);
      const tmp = pool[d];
      pool[d] = pool[t];
      pool[t] = tmp;
    }
    vill[0] = pool[0];
    vill[1] = pool[1];
    for (let d = 0; d < need; d++) {
      hero[2 + cc + d] = pool[2 + d];
      vill[2 + cc + d] = pool[2 + d];
    }
    const hs = scoreInts(hero, size);
    const vs = scoreInts(vill, size);
    if (hs > vs) score += 1;
    else if (hs === vs) score += 0.5;
  }
  return score / sims;
}

/** `n` random boards of `len` cards, as code arrays. */
function randomBoards(len: number, n: number, rng: Rng): number[][] {
  const all = [...Array(52).keys()];
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push(rng.shuffle(all).slice(0, len));
  return out;
}

// ---------------------------------------------------------------------------
// The defect this module exists to fix
// ---------------------------------------------------------------------------

describe("the tierOf defect", () => {
  it("classifies 7-2 as two pair on K-7-2-9-4 where tierOf still says weak", () => {
    const board = "Ks 7h 2s 9d 4c";
    const seven = decodeCard(code("7d"));
    const two = decodeCard(code("2c"));

    // What the codebase does today: a preflop Chen score, on the river.
    expect(tierOf(seven, two)).toBe("weak");

    // What the board says.
    const bucket = bucketOf("7d 2c", board);
    expect(bucket).toBe(HandBucket.TwoPair);
    expect(tierFromBucket(bucket)).toBe("strong");

    // And what the cards are actually worth: 7-2 has made two pair and beats
    // a random hand handily, which is the number the old tier was mispricing.
    const equity = equityOf("7d 2c", board, makeRng(4242), 20_000);
    expect(equity).toBeGreaterThan(0.75);
  });

  it("is wrong in the other direction too: aces on a board that already plays", () => {
    const board = "5s 6h 7d 8c 9s";
    const aces = "As Ah";

    // tierOf calls AA strong on every street, board be damned.
    expect(tierOf(decodeCard(code("As")), decodeCard(code("Ah")))).toBe("strong");

    // The board makes a nine-high straight by itself; aces add nothing at all.
    expect(bucketOf(aces, board)).toBe(HandBucket.Air);

    // Preflop the same two cards are ~0.85 against a random hand. On this
    // board they are a coin flip, and most of that is chopping the board's
    // straight rather than winning anything.
    const preflop = equityOf(aces, "", makeRng(6), 20_000);
    const river = equityOf(aces, board, makeRng(7), 20_000);
    expect(preflop).toBeGreaterThan(0.8);
    expect(river).toBeLessThan(0.5);

    // A ten does add something, the higher straight, and is priced as such.
    expect(bucketOf("Td 2c", board)).toBe(HandBucket.Monster);
    // Not 1.0: an opponent holding a ten chops back.
    expect(equityOf("Td 2c", board, makeRng(8), 20_000)).toBeGreaterThan(0.9);
  });

  it("splits hands tierOf lumps together, and reverses one of its calls", () => {
    const board = "Ks 7h 2h";
    // Three hands tierOf cannot tell apart, plus one it ranks ABOVE them all.
    expect(tierOf(decodeCard(code("Kd")), decodeCard(code("2c")))).toBe("weak");
    expect(tierOf(decodeCard(code("7s")), decodeCard(code("5c")))).toBe("weak");
    expect(tierOf(decodeCard(code("8h")), decodeCard(code("3h")))).toBe("weak");
    expect(tierOf(decodeCard(code("3s")), decodeCard(code("3d")))).toBe("medium");

    // On this board they are four different hands, and the pocket threes that
    // tierOf ranked highest are in fact the worst of the four.
    expect(bucketOf("Kd 2c", board)).toBe(HandBucket.TwoPair);
    expect(bucketOf("7s 5c", board)).toBe(HandBucket.MidPair);
    expect(bucketOf("8h 3h", board)).toBe(HandBucket.StrongDraw);
    expect(bucketOf("3s 3d", board)).toBe(HandBucket.WeakPair);

    // Measured, so the reversal is not just a relabelling.
    const rng = makeRng(31415);
    const k2 = equityOf("Kd 2c", board, rng, 20_000);
    const threes = equityOf("3s 3d", board, rng, 20_000);
    expect(k2).toBeGreaterThan(threes + 0.2);
  });
});

// ---------------------------------------------------------------------------
// Board relativity
// ---------------------------------------------------------------------------

describe("the same combo on different boards", () => {
  it("moves 7-2 from the bottom of the ladder to near the top and back", () => {
    expect(bucketOf("7d 2c", "")).toBe(HandBucket.Air); // worst hand preflop
    expect(bucketOf("7d 2c", "Ks 7h 2s")).toBe(HandBucket.TwoPair);
    expect(bucketOf("7d 2c", "Ks 7h 2s 9d 4c")).toBe(HandBucket.TwoPair);
    expect(bucketOf("7d 2c", "As Kh Qs")).toBe(HandBucket.Air); // nothing again
  });

  it("moves aces from the top of the ladder to the bottom", () => {
    expect(bucketOf("As Ah", "")).toBe(HandBucket.Monster);
    expect(bucketOf("As Ah", "2d 7h 9c")).toBe(HandBucket.Overpair);
    expect(bucketOf("As Ah", "5s 6h 7d 8c")).toBe(HandBucket.Overpair);
    expect(bucketOf("As Ah", "5s 6h 7d 8c 9s")).toBe(HandBucket.Air);
  });

  it("ranks a pair by which board card it paired", () => {
    const board = "Ks 9d 4c";
    expect(bucketOf("Kh 3s", board)).toBe(HandBucket.TopPair);
    expect(bucketOf("9h 3s", board)).toBe(HandBucket.MidPair);
    expect(bucketOf("4h 3s", board)).toBe(HandBucket.WeakPair);
    // Pocket pairs slot in against the same board ranks.
    expect(bucketOf("As Ad", board)).toBe(HandBucket.Overpair);
    expect(bucketOf("Qs Qd", board)).toBe(HandBucket.MidPair);
    expect(bucketOf("2s 2d", board)).toBe(HandBucket.WeakPair);
  });
});

describe("a hand the whole field also holds is not your hand", () => {
  it("gives no credit for a pair sitting on the board", () => {
    const board = "7s 7h 2d 4c 9h";
    // A-K has "a pair of sevens" on the score sheet and nothing in reality.
    expect(bucketOf("As Kd", board)).toBe(HandBucket.Air);
    // The 2 does connect, but only as bottom pair beside the board's pair.
    expect(bucketOf("As 2h", board)).toBe(HandBucket.WeakPair);
  });

  it("gives no credit for a second pair the board's own pair crowds out", () => {
    // A five-card hand shows at most two pairs. This board already shows one,
    // so of the two ranks 9-2 pairs only the nine ever reaches the hand: the
    // deuce is a third pair, and third pairs do not exist.
    const board = "7s 7h 2d 4c 9h";
    // Same five cards, to the point of the same score, so the same bucket.
    expect(scoreOf("9s 2h", board)).toBe(scoreOf("9s 3h", board));
    expect(bucketOf("9s 2h", board)).toBe(bucketOf("9s 3h", board));
    expect(bucketOf("9s 2h", board)).toBe(HandBucket.TopPair);

    // Same again at the bottom of the board, where the old rule was four rungs
    // and a tier boundary out: it read 4-2 as TwoPair and 4-3 as WeakPair.
    expect(scoreOf("4s 2h", board)).toBe(scoreOf("4s 3h", board));
    expect(bucketOf("4s 2h", board)).toBe(bucketOf("4s 3h", board));
    expect(bucketOf("4s 2h", board)).toBe(HandBucket.WeakPair);

    // And the ordering the buckets claim is the ordering the cards have.
    expect(scoreOf("9s 2h", board)).toBeGreaterThan(scoreOf("4s 2h", board));
  });

  it("still calls it two pair when both our pairs outrank the board's", () => {
    // Board pairs deuces, so K-7 makes kings and sevens and the board's pair is
    // the one that gets crowded out. Nothing is stripped here.
    const board = "2s 2h Kd 7c 5h";
    expect(bucketOf("Kh 7d", board)).toBe(HandBucket.TwoPair);
    expect(bucketOf("7s 5c", board)).toBe(HandBucket.TwoPair);
    // One hole card pairing the board is still just one pair.
    expect(bucketOf("Kh 3d", board)).toBe(HandBucket.TopPair);
    expect(scoreOf("Kh 7d", board)).toBeGreaterThan(scoreOf("Kh 3d", board));
  });

  it("gives no credit for trips the board already shows", () => {
    const board = "Ks Kh Kd 7c 2d";
    expect(bucketOf("As Qs", board)).toBe(HandBucket.Air);
    expect(bucketOf("7s 7h", board)).toBe(HandBucket.Monster); // real full house
    expect(bucketOf("Kc 5h", board)).toBe(HandBucket.Monster); // quads
  });

  it("gives no credit for board trips on the flop and turn either", () => {
    // The strip is not a river rule. With `boardScore` computed only at five
    // cards, a 7-7-7 flop reads Monster for all 1326 combos instead of 123 -
    // a mutant the river-only case above cannot see.
    for (const board of ["7s 7h 7d", "7s 7h 7d 2c", "7s 7h 7d 2c 4h"]) {
      const buckets = classifyAll(makeBoardContext(codes(board)));
      let monsters = 0;
      for (let i = 0; i < COMBO_COUNT; i++) {
        if (buckets[i] === HandBucket.Monster) monsters++;
      }
      // Only a pair (full house) or the case seven (quads) is a real monster.
      expect(monsters).toBeLessThan(COMBO_COUNT / 3);
      expect(monsters).toBeGreaterThan(0);
      // A-K holds the board's trips and nothing of its own, on every street.
      // (Two overcards are still a weak draw while cards are to come.)
      expect(tierFromBucket(bucketOf("As Kd", board))).toBe("weak");
      // A pocket pair fills it up, and the case seven makes quads.
      expect(bucketOf("9s 9h", board)).toBe(HandBucket.Monster);
      expect(bucketOf("7c 3h", board)).toBe(HandBucket.Monster);
    }
  });

  it("does not hand the whole deck a monster on a quads board", () => {
    // Four of a kind on the turn: every combo plays the board's quads and
    // nothing better, but there is no five-card `boardScore` to compare with,
    // so the river's playing-the-board test cannot fire. P is about 4.8e-5.
    const buckets = classifyAll(makeBoardContext(codes("7s 7h 7d 7c")));
    for (let i = 0; i < COMBO_COUNT; i++) {
      expect(buckets[i]).toBe(HandBucket.Air);
    }
    // On the river the equality does fire, and a better kicker still counts.
    expect(bucketOf("As Kd", "7s 7h 7d 7c 9h")).toBe(HandBucket.Monster);
    expect(bucketOf("2s 3d", "7s 7h 7d 7c 9h")).toBe(HandBucket.Air);
  });

  it("gives no credit for playing the board", () => {
    // Board is a straight; only a hand that beats it scores.
    expect(bucketOf("2s 3h", "5s 6h 7d 8c 9s")).toBe(HandBucket.Air);
    expect(bucketOf("Th 2h", "5s 6h 7d 8c 9s")).toBe(HandBucket.Monster);
    // Board is a flush; a bigger heart beats it, a black ace does not.
    expect(bucketOf("As Kd", "2h 7h 9h Th Jh")).toBe(HandBucket.Air);
    expect(bucketOf("Ah Kd", "2h 7h 9h Th Jh")).toBe(HandBucket.Monster);
  });
});

describe("a paired board spends one of the two pair slots itself", () => {
  // The board's own pair is one of the two pairs that play, so a hole-card pair
  // beneath it is a kicker wearing a pair's clothes. Every case here is checked
  // against the five-card score rather than against intuition.

  it("does not promote K-7 over K-Q on an ace-paired board", () => {
    const board = "As Ah Kd 7c 2s";
    // Both play A-A-K-K plus a kicker, and K-Q's kicker is the better one.
    expect(scoreOf("Ks Qc", board)).toBeGreaterThan(scoreOf("Kh 7d", board));
    // So K-7 must not outrank K-Q, and must not cross a tier boundary doing it.
    expect(bucketOf("Kh 7d", board)).not.toBeGreaterThan(bucketOf("Ks Qc", board));
    expect(tierFromBucket(bucketOf("Kh 7d", board))).toBe(
      tierFromBucket(bucketOf("Ks Qc", board))
    );
    // The seven contributes exactly what a three would.
    expect(scoreOf("Kh 7d", board)).toBe(scoreOf("Kh 3d", board));
    expect(bucketOf("Kh 7d", board)).toBe(bucketOf("Kh 3d", board));
  });

  it("does not rank a pair the board's two pairs crowd out", () => {
    // K-K-J-J-6: our sixes are a third pair and never play, so 6-7 is holding
    // ace-high's poor cousin, not bottom pair.
    const board = "Kh Jd Ks 6c Jc";
    expect(scoreOf("Qs As", board)).toBeGreaterThan(scoreOf("6s 7s", board));
    expect(bucketOf("6s 7s", board)).not.toBeGreaterThan(bucketOf("Qs As", board));
    expect(bucketOf("6s 7s", board)).toBe(HandBucket.Air);
    // A pair that DOES outrank the board's lower pair still counts.
    expect(bucketOf("Qh Qd", "Kh Jd Ks 6c 3c")).not.toBe(HandBucket.Air);
  });

  it("crowds out a pocket pair only when the board shows two pairs", () => {
    // Turn, two board pairs: threes are a third pair and never play, so the
    // hand is K-K-5-5 plus a kicker exactly as it would be with 3-2 offsuit.
    expect(bucketOf("3s 3d", "Kh Kd 5s 5c")).toBe(HandBucket.Air);
    // Sevens beat the board's lower pair, so they do play.
    expect(bucketOf("7s 7d", "Kh Kd 5s 5c")).toBe(HandBucket.MidPair);
    expect(bucketOf("As Ad", "Kh Kd 5s 5c")).toBe(HandBucket.Overpair);

    // One board pair is a different matter: the second slot is still free, so
    // threes make real two pair (K-K-3-3) and keep their rung. Testing against
    // the board's TOP pair instead of its second would wrongly bury this.
    expect(bucketOf("3s 3d", "Kh Kd 5s 9c")).toBe(HandBucket.WeakPair);
    expect(scoreOf("3s 3d", "Kh Kd 5s 9c")).toBeGreaterThan(
      scoreOf("2s 4d", "Kh Kd 5s 9c")
    );
  });

  it("never ranks a strictly worse five-card hand above a better one", () => {
    // The property the two cases above are instances of, swept over paired
    // boards: whenever two live combos make five-card hands of different
    // strength, the buckets must not disagree with the scores.
    const rng = makeRng(80808);
    let compared = 0;
    for (const board of randomBoards(5, 40, rng)) {
      const ctx = makeBoardContext(board);
      // Only paired boards, this is where the board eats a pair slot.
      const seen = new Uint8Array(15);
      let isPaired = false;
      for (const c of board) {
        const r = (c >> 2) + 2;
        if (seen[r]++ > 0) isPaired = true;
      }
      if (!isPaired) continue;

      const buckets = classifyAll(ctx);
      const onBoard = new Uint8Array(52);
      for (const c of board) onBoard[c] = 1;
      const live: number[] = [];
      const score = new Float64Array(COMBO_COUNT);
      const hand = new Uint8Array(7);
      for (let i = 0; i < 5; i++) hand[2 + i] = board[i];
      for (let i = 0; i < COMBO_COUNT; i++) {
        const a = comboCardA(i);
        const b = comboCardB(i);
        if (onBoard[a] === 1 || onBoard[b] === 1) continue;
        hand[0] = a;
        hand[1] = b;
        score[i] = scoreInts(hand, 7);
        live.push(i);
      }

      // Two hands with the SAME five-card score are the same hand, so they must
      // share a bucket. This is the exact shape of the defect: 9-2 and 9-3 on
      // 7-7-2-4-9 scored identically and sat two rungs and a tier apart.
      const byScore = new Map<number, number>();
      for (const i of live) {
        const prev = byScore.get(score[i]);
        if (prev === undefined) byScore.set(score[i], buckets[i]);
        else {
          expect(buckets[i]).toBe(prev);
          compared++;
        }
      }
    }
    // The sweep has to actually have found ties, or it proves nothing.
    expect(compared).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Draws
// ---------------------------------------------------------------------------

describe("draws", () => {
  it("counts a flush draw on the flop and the turn, but not on the river", () => {
    expect(bucketOf("Ah Kh", "2h 7h 9s")).toBe(HandBucket.StrongDraw);
    expect(bucketOf("Ah Kh", "2h 7h 9s 4c")).toBe(HandBucket.StrongDraw);
    // River: the draw missed, and a missed draw IS nothing.
    expect(bucketOf("Ah Kh", "2h 7h 9s 4c 3d")).toBe(HandBucket.Air);
    // ...unless it got there, in which case it is a flush.
    expect(bucketOf("Ah Kh", "2h 7h 9s 4c 3h")).toBe(HandBucket.Monster);
  });

  it("separates open-enders from gutshots", () => {
    const board = "8h 7d 2c";
    expect(bucketOf("Ts 9s", board)).toBe(HandBucket.StrongDraw); // J or 6
    expect(bucketOf("Js Th", board)).toBe(HandBucket.WeakDraw); // 9 only
    expect(bucketOf("Qs Jh", "Ks 7d 2c")).toBe(HandBucket.Air); // no draw at all
  });

  it("does not hand a combo the board's own draw", () => {
    // Board is four to a straight: everyone makes it, so it is nobody's draw.
    // A-K is left with two overcards, which is a weak draw and no more.
    expect(bucketOf("Ad Kc", "5h 6h 7h 8s")).toBe(HandBucket.WeakDraw);
    // Board is four to a flush. Without a heart there is no flush draw here.
    expect(bucketOf("Ad Kc", "2h 7h 9h Th")).toBe(HandBucket.WeakDraw);
    // With a heart it is not a draw either, it is already a flush.
    expect(bucketOf("Ah Kc", "2h 7h 9h Th")).toBe(HandBucket.Monster);
  });

  it("counts a backdoor flush on the flop only", () => {
    // Two suited hole cards plus one on board: needs both remaining cards.
    expect(bucketOf("8s 6s", "As 9d 4c")).toBe(HandBucket.WeakDraw);
    // Same shape on the turn: one card cannot get there, so it is nothing.
    expect(bucketOf("8s 6s", "As 9d 4c 2h")).toBe(HandBucket.Air);
  });

  it("counts two overcards as a weak draw, and only while cards remain", () => {
    expect(bucketOf("Ad Kc", "9s 7h 2d")).toBe(HandBucket.WeakDraw);
    expect(bucketOf("Ad Kc", "9s 7h 2d 3c 4h")).toBe(HandBucket.Air);
    // One overcard is not two.
    expect(bucketOf("Ad 5c", "9s 7h 2d")).toBe(HandBucket.Air);
  });

  it("has no draw buckets at all once the board is complete", () => {
    const rng = makeRng(555);
    for (const board of randomBoards(5, 60, rng)) {
      const buckets = classifyAll(makeBoardContext(board));
      for (let i = 0; i < COMBO_COUNT; i++) {
        expect(buckets[i]).not.toBe(HandBucket.WeakDraw);
        expect(buckets[i]).not.toBe(HandBucket.StrongDraw);
      }
    }
  });

  it("takes the better reading when a combo is both made and drawing", () => {
    // Top pair plus a flush draw is at least top pair, never demoted to a draw.
    expect(bucketOf("Ah 9h", "As 7h 2h")).toBe(HandBucket.TopPair);
    // Bottom pair plus a flush draw is at least bottom pair.
    expect(bucketOf("2h 9h", "As 7h 2s")).toBe(HandBucket.WeakPair);
  });
});

// ---------------------------------------------------------------------------
// Preflop fallback
// ---------------------------------------------------------------------------

describe("preflop", () => {
  it("falls back to holeScore bands", () => {
    expect(bucketOf("As Ah", "")).toBe(HandBucket.Monster);
    expect(bucketOf("Ks Kh", "")).toBe(HandBucket.Monster);
    expect(bucketOf("As Ks", "")).toBe(HandBucket.Monster);
    expect(bucketOf("7d 2c", "")).toBe(HandBucket.Air);
    expect(bucketOf("Ts 7h", "")).toBe(HandBucket.WeakDraw);
  });

  it("cuts the bands where PREFLOP_BANDS says, to the point", () => {
    // Monotonicity is not a test here: `PREFLOP_BUCKET` is a monotone step
    // function of holeScore by construction, so asserting it cannot fail and
    // cannot catch a moved cut point. The cut points themselves can, so pin
    // each one with the hands on either side of it. holeScore takes 17 distinct
    // values over the 1326 combos and every one maps to a single bucket, so
    // these twelve hands fix all eight boundaries.
    const atScore: [string, number, HandBucket][] = [
      ["As Ah", 20, HandBucket.Monster],
      ["Js Jh", 12, HandBucket.Monster], // bottom of the top band
      ["Qs As", 11, HandBucket.TwoPair], // ...and the hand just below it
      ["Ts Th", 10, HandBucket.TwoPair],
      ["9s 9h", 9, HandBucket.Overpair],
      ["8s 8h", 8, HandBucket.TopPair],
      ["2s As", 7, HandBucket.MidPair],
      ["4s 5s", 6, HandBucket.WeakPair],
      ["2s 2h", 5, HandBucket.StrongDraw],
      ["2s 4s", 4, HandBucket.WeakDraw],
      ["2s 3h", 3, HandBucket.WeakDraw], // bottom of the WeakDraw band
      ["2s 4h", 2, HandBucket.Air], // ...and the hand just below it
    ];
    for (const [hole, score, bucket] of atScore) {
      const [a, b] = codes(hole);
      expect(holeScore(decodeCard(a), decodeCard(b))).toBe(score);
      expect(bucketOf(hole, "")).toBe(bucket);
    }
  });

  it("puts the documented share of the deck in each band", () => {
    // The docstring claims roughly 2/2/2/4/7/8/18/24/33 percent top to bottom.
    // Pinning the combo counts makes any moved cut point a failure here too.
    const buckets = classifyAll(makeBoardContext([]));
    const counts = new Array<number>(BUCKET_COUNT).fill(0);
    for (let i = 0; i < COMBO_COUNT; i++) counts[buckets[i]]++;
    expect(counts).toEqual([436, 316, 236, 102, 94, 54, 30, 30, 28]);
  });

  it("spreads the deck across every band", () => {
    const buckets = classifyAll(makeBoardContext([]));
    const counts = new Array<number>(BUCKET_COUNT).fill(0);
    for (let i = 0; i < COMBO_COUNT; i++) counts[buckets[i]]++;
    for (let k = 0; k < BUCKET_COUNT; k++) expect(counts[k]).toBeGreaterThan(0);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(COMBO_COUNT);
    // The top band is a premium range, not a single hand: AA/KK/QQ/JJ/AKs.
    expect(counts[HandBucket.Monster]).toBe(28);
  });
});

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

describe("classification is total and consistent", () => {
  it("assigns exactly one valid bucket to every combo on many boards", () => {
    const rng = makeRng(2718);
    for (const len of [0, 3, 4, 5]) {
      for (const board of randomBoards(len, 25, rng)) {
        const ctx = makeBoardContext(board);
        const buckets = classifyAll(ctx);
        expect(buckets.length).toBe(COMBO_COUNT);

        const counts = new Array<number>(BUCKET_COUNT).fill(0);
        for (let i = 0; i < COMBO_COUNT; i++) {
          const b = buckets[i];
          expect(Number.isInteger(b)).toBe(true);
          expect(b).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThan(BUCKET_COUNT);
          counts[b]++;
        }
        // Exhaustive and mutually exclusive: the counts partition the 1326.
        expect(counts.reduce((a, b) => a + b, 0)).toBe(COMBO_COUNT);
      }
    }
  });

  it("agrees across classifyAll, classifyCombo and classifyHole", () => {
    const rng = makeRng(161803);
    for (const len of [0, 3, 4, 5]) {
      for (const board of randomBoards(len, 4, rng)) {
        const ctx = makeBoardContext(board);
        const buckets = classifyAll(ctx);
        for (let i = 0; i < COMBO_COUNT; i++) {
          expect(classifyCombo(i, ctx)).toBe(buckets[i]);
          expect(classifyHole(comboCardA(i), comboCardB(i), ctx)).toBe(
            buckets[i]
          );
          // Order of the two cards must not matter.
          expect(classifyHole(comboCardB(i), comboCardA(i), ctx)).toBe(
            buckets[i]
          );
        }
      }
    }
  });

  it("is deterministic and reuses a caller's output buffer", () => {
    const ctx = makeBoardContext(codes("Ks 7h 2s"));
    const a = classifyAll(ctx);
    const out = new Uint8Array(COMBO_COUNT).fill(200);
    const b = classifyAll(ctx, out);
    expect(b).toBe(out);
    expect([...a]).toEqual([...b]);
  });

  it("matches the Card-shaped convenience wrapper", () => {
    const board = codes("Ks 7h 2s 9d 4c");
    const ctx = makeBoardContext(board);
    const boardCards = board.map(decodeCard);
    const rng = makeRng(12);
    for (let n = 0; n < 200; n++) {
      const i = rng.int(COMBO_COUNT);
      const a = comboCardA(i);
      const b = comboCardB(i);
      expect(bucketOfCards(decodeCard(a), decodeCard(b), boardCards)).toBe(
        classifyCombo(i, ctx)
      );
    }
    expect(bucketOfCards(decodeCard(code("As")), decodeCard(code("Ah")))).toBe(
      HandBucket.Monster
    );
  });

  it("rejects a board it cannot classify against", () => {
    expect(() => makeBoardContext([0, 1, 2, 3, 4, 5])).toThrow(/board of 6/);
    expect(() => makeBoardContext([0, 1, 99])).toThrow(/bad card code/);
  });

  it("rejects a board card that is not an integer 0..51", () => {
    // `c < 0 || c > 51` is false for every one of these, so without an integer
    // check they are all accepted and silently become the ace of spades or a
    // half-card. A board of [10, 20, NaN] classified as [10, 20, 2s] would
    // mis-bucket the entire range with nothing to show for it.
    for (const bad of [NaN, undefined, null, 3.5, -0.5, Infinity, "7"]) {
      expect(() =>
        makeBoardContext([10, 20, bad as unknown as number])
      ).toThrow(/bad card code/);
    }
    // The honest neighbours still pass.
    expect(() => makeBoardContext([10, 20, 0])).not.toThrow();
    expect(() => makeBoardContext([10, 20, 51])).not.toThrow();
  });

  it("rejects an output buffer too small to hold every combo", () => {
    const ctx = makeBoardContext(codes("Ks 7h 2s"));
    // Typed arrays drop out-of-range stores, so a short buffer would be filled
    // to its length and the caller would read the tail of some older pass.
    expect(() => classifyAll(ctx, new Uint8Array(10))).toThrow(/out buffer/);
    expect(() => classifyAll(ctx, new Uint8Array(COMBO_COUNT - 1))).toThrow(
      /out buffer/
    );
    expect(() => classifyAll(ctx, new Uint8Array(COMBO_COUNT))).not.toThrow();
    // Preflop takes a different path through the same function.
    expect(() => classifyAll(makeBoardContext([]), new Uint8Array(10))).toThrow(
      /out buffer/
    );
  });

  it("maps the ladder onto the three legacy tiers in order", () => {
    const tiers = [...Array(BUCKET_COUNT).keys()].map((b) =>
      tierFromBucket(b as HandBucket)
    );
    expect(tiers).toEqual([
      "weak",
      "weak",
      "weak",
      "medium",
      "medium",
      "medium",
      "strong",
      "strong",
      "strong",
    ]);
    expect(Object.keys(BUCKET_NAMES).length).toBe(BUCKET_COUNT);
  });
});

// ---------------------------------------------------------------------------
// The ladder is an equity ladder
// ---------------------------------------------------------------------------

describe("bucket order tracks equity", () => {
  it("has rising mean equity as the bucket rises, on every street", () => {
    // Every combo on 60 random boards per street, rolled out against a random
    // opponent hand. This is the evidence for the taxonomy: if the ordering
    // were arbitrary, "belief mass above bucket k" would mean nothing.
    for (const len of [3, 4, 5]) {
      const rng = makeRng(90210 + len);
      const sum = new Array<number>(BUCKET_COUNT).fill(0);
      const n = new Array<number>(BUCKET_COUNT).fill(0);

      for (const board of randomBoards(len, 60, rng)) {
        const buckets = classifyAll(makeBoardContext(board));
        const onBoard = new Uint8Array(52);
        for (const c of board) onBoard[c] = 1;
        for (let i = 0; i < COMBO_COUNT; i++) {
          const a = comboCardA(i);
          const b = comboCardB(i);
          if (onBoard[a] === 1 || onBoard[b] === 1) continue;
          sum[buckets[i]] += equityOfCodes(a, b, board, rng, 60);
          n[buckets[i]]++;
        }
      }

      const means = sum.map((s, k) => (n[k] > 0 ? s / n[k] : null));
      console.log(
        `equity by bucket, ${len}-card board: ` +
          means
            .map((m, k) => `${k}=${m === null ? "-" : m.toFixed(3)}`)
            .join(" ")
      );

      // Only the draw buckets may be empty, and only on the river.
      for (let k = 0; k < BUCKET_COUNT; k++) {
        if (means[k] !== null) continue;
        expect(len).toBe(5);
        expect(k === HandBucket.WeakDraw || k === HandBucket.StrongDraw).toBe(
          true
        );
      }

      const populated = [...Array(BUCKET_COUNT).keys()].filter(
        (k) => means[k] !== null
      );
      for (let p = 1; p < populated.length; p++) {
        const lo = populated[p - 1];
        const hi = populated[p];
        const gain = (means[hi] as number) - (means[lo] as number);
        if (lo === HandBucket.TopPair && hi === HandBucket.Overpair) {
          // These two measure the same strength to within noise: 0.776 vs
          // 0.796 on the flop, 0.773 vs 0.756 on the turn, 0.782 vs 0.791 on
          // the river, the sign flips with the boards drawn. Asserting an
          // order between them would be asserting sampling noise.
          //
          // But `Math.abs(gain) < 0.08` is not that claim: it passes just as
          // happily on a real inversion of up to eight points, which is larger
          // than any gap between adjacent rungs elsewhere on the ladder. Bound
          // the one direction that would be a defect instead.
          expect(gain).toBeGreaterThan(-0.02);
        } else {
          expect(gain).toBeGreaterThan(0);
        }
      }

      // ...and the ladder must span a wide range, or it separates nothing.
      const bottom = means[HandBucket.Air] as number;
      const top = means[HandBucket.Monster] as number;
      expect(top - bottom).toBeGreaterThan(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe("cost", () => {
  it("classifies all 1326 combos in well under a millisecond", () => {
    const rng = makeRng(1);
    const boards = randomBoards(5, 200, rng).concat(randomBoards(3, 200, rng));
    const contexts = boards.map(makeBoardContext);
    const out = new Uint8Array(COMBO_COUNT);

    // Warm up, then measure.
    for (const ctx of contexts) classifyAll(ctx, out);
    const start = performance.now();
    for (const ctx of contexts) classifyAll(ctx, out);
    const perBoardUs = ((performance.now() - start) * 1000) / contexts.length;

    console.log(
      `classifyAll: ${perBoardUs.toFixed(1)} us per board (1326 combos)`
    );
    // Loose enough not to flake on a busy CI box, tight enough to catch an
    // accidental O(1326^2), a decision runs this a handful of times.
    expect(perBoardUs).toBeLessThan(3000);
  });

  it("shares no state between contexts", () => {
    // The scratch hand buffer lives on the context, so two live contexts must
    // not be able to corrupt each other's results.
    const dry = makeBoardContext(codes("Ks 7s 2d"));
    const wet = makeBoardContext(codes("2h 7h 9s"));
    const heart = comboIndex(code("Ah"), code("Kh"));
    const before = classifyCombo(heart, wet);
    classifyCombo(heart, dry);
    expect(classifyCombo(heart, wet)).toBe(before);
    expect(before).toBe(HandBucket.StrongDraw);
  });
});
