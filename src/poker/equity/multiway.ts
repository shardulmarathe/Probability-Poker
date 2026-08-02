/**
 * Multiway equity: one hero against N opponents at once.
 *
 * The heads-up sampler in `../monteCarlo.ts` answers "do I beat him?". This one
 * answers "do I beat all of them?", and the two questions come apart fast: the
 * hero must be strictly best to win outright, so the field's chance of holding
 * *something* compounds with every extra seat. A hand that is 65% against each
 * opponent taken alone can be a clear underdog to three of them together, which
 * is the single biggest way multiway play differs from heads-up and the reason
 * this module exists rather than a loop over pairwise calls.
 *
 * Two consequences shape the code:
 *
 *  - A k-way chop is worth 1/k of the pot, so the value of a holding is
 *    `equity = (wins + Σ 1/k) / sims`, not `pWin`. Both are reported; heads-up
 *    they nearly coincide, multiway they do not.
 *  - Opponents share one deck, so the field is drawn as one object: propose
 *    every seat's hole cards from that seat's own range, and if any two seats
 *    want the same card throw the whole tuple away and start over. The law that
 *    survives is `Π p(hᵢ)` conditioned on the hands being disjoint — symmetric
 *    under relabelling the seats, which is the point. See `MAX_TUPLE_ATTEMPTS`.
 *
 * WHAT A SEAT'S HAND IS DRAWN FROM. A `Range` — one weight for each of the 1326
 * hole-card combinations — and not the three-tier `BeliefDistribution` this
 * module sampled from originally. That version bucketed the pool with
 * `bayesian.tierOf`, a *preflop* Chen score, and drew uniformly inside the
 * chosen tier. On K-7-2-9-4 that calls 7-2 weak when it is two pair, and on
 * 5-6-7-8-9 it calls aces strong when they are playing the board; every equity
 * number the bot acted on was built on that classifier. A range fixes it at the
 * source: `model/buckets.ts` classifies each combo against the actual board,
 * `model/likelihood.ts` reweights it by what the seat has done, and
 * `model/range.ts`'s `removeCards` zeroes what the hero can see — so card
 * removal is arithmetic rather than a special case, and a blocker moves the
 * equity rather than only the chart.
 *
 * `perOpponent` — the hero's head-to-head equity against each seat alone —
 * falls out of the same pass: every comparison it needs was already made to
 * find the best opponent. It costs nothing and never needs a second run.
 *
 * Performance notes mirror the heads-up kernel: 0..51 card codes throughout,
 * `Uint8Array` hand buffers reused across sims, no allocation in the loop, and
 * the hero scored once when the board is already complete. Redrawing the whole
 * field costs what it costs — measured against per-seat rejection it is a wash
 * up to two opponents, 1.1x at four and 1.6x at six with ordinary reads — and
 * the price is paid in the tuple loop, never in the scoring.
 */

import { normalize } from "../bayesian";
import { makeRng, type Rng } from "../core/rng";
import { standardError, wilsonInterval } from "../core/stats";
import { scoreInts } from "../handEvaluator";
import {
  classifyAll,
  makeBoardContext,
  tierFromBucket,
  type HandBucket,
} from "../model/buckets";
import {
  COMBO_COUNT,
  cloneRange,
  comboCardA,
  comboCardB,
  comboIndex,
  drawCombo,
  makeComboSampler,
  removeCards,
  uniformRange,
  type ComboSampler,
  type Range,
} from "../model/range";
import type { BeliefDistribution } from "../../types";
import type { EquityRequest, MultiwayEquity } from "../table/contract";

/** Belief for a seat the caller gave no read on: no information, no lean. */
const UNIFORM_BELIEF: BeliefDistribution = {
  weak: 1 / 3,
  medium: 1 / 3,
  strong: 1 / 3,
};

/**
 * Whole-tuple proposals the field gets before it is dealt uniformly instead.
 *
 * Rejecting the tuple rather than the offending seat is what makes the sampler
 * exchangeable, and the price is paid here: acceptance is the chance that N
 * independent range draws happen to be pairwise disjoint, which falls off fast
 * with the field, and faster the sharper the reads. Measured on this sampler
 * over a 50-card pool: a flat range at every seat accepts 0.920 at two
 * opponents, 0.598 at four and 0.269 at six, and ranges reweighted by three
 * streets of betting accept 0.851 / 0.375 / 0.191 (the last at five, the most
 * seats a table here holds).
 *
 * 256 puts even that sharpest case at 4e-25 per sim, so the bound is not what
 * makes the realistic ones work. It is there for the degenerate one: with two
 * seats pinned on ranges whose only combo is the same combo, no disjoint tuple
 * exists at all and nothing but a bound terminates the loop.
 */
const MAX_TUPLE_ATTEMPTS = 256;

/**
 * Raw outcome counts from a run — the sufficient statistics for everything
 * `MultiwayEquity` reports, handed back unnormalized because a shard is only
 * meaningful once summed with its siblings.
 *
 * Every field is an integer count in a flat array, which is what lets shards
 * merge by addition and normalize exactly once, and what makes the payload
 * structured-clone across a worker boundary for free.
 */
export interface MultiwayCounts {
  sims: number;
  wins: number;
  ties: number;
  losses: number;
  /**
   * Chops by size of the tied set: `tieBySize[k]` counts sims the hero split
   * the pot k ways, so k ≥ 2 and slots 0 and 1 stay empty. Storing the
   * histogram rather than a running Σ1/k keeps the shard integral — a float
   * accumulator would make the merge depend on shard arithmetic order.
   */
  tieBySize: number[];
  /** Sims the hero outright beat opponent i, index-aligned with the request. */
  h2hWins: number[];
  /** Sims the hero tied opponent i. */
  h2hTies: number[];
}

/** The 0..51 codes still unseen: the deck minus the hero's cards and the board. */
export function remainingPool(heroHole: number[], board: number[]): Uint8Array {
  const used = new Uint8Array(52);
  for (let i = 0; i < heroHole.length; i++) used[heroHole[i]] = 1;
  for (let i = 0; i < board.length; i++) used[board[i]] = 1;
  const out = new Uint8Array(52);
  let n = 0;
  for (let c = 0; c < 52; c++) if (used[c] === 0) out[n++] = c;
  return out.slice(0, n);
}

/**
 * A three-tier belief spread over combos, by *board-relative* bucket.
 *
 * The adapter for callers that still speak `BeliefDistribution`. Two things
 * make it more than a type conversion:
 *
 *  - `buckets` comes from `model/buckets.ts`, so "strong" means two pair on
 *    this board rather than a good preflop score. That alone is most of the
 *    defect this migration exists to remove, and it reaches every caller.
 *  - Each tier's *total* weight is set to `belief[tier]` and split evenly
 *    inside it, rather than writing `belief[tier]` into every combo. The weak
 *    tier holds several times the combos the strong one does, so the naive form
 *    turns a 0.40 / 0.35 / 0.25 read into an effective 0.70 / 0.24 / 0.06 — an
 *    opponent four times less likely to hold a real hand than the table
 *    believes.
 *
 * Card removal is applied first, so blockers thin the tier they actually hit.
 */
export function beliefRange(
  belief: BeliefDistribution,
  buckets: Uint8Array,
  dead: ArrayLike<number>
): Range {
  const range = removeCards(uniformRange(), dead);
  const b = normalize(belief);
  const mass = [b.weak, b.medium, b.strong];
  const live = new Float64Array(3);
  const tierIndex = (c: number): number => {
    const tier = tierFromBucket(buckets[c] as HandBucket);
    return tier === "weak" ? 0 : tier === "medium" ? 1 : 2;
  };

  for (let c = 0; c < COMBO_COUNT; c++) if (range[c] > 0) live[tierIndex(c)] += 1;

  let total = 0;
  for (let c = 0; c < COMBO_COUNT; c++) {
    if (range[c] <= 0) continue;
    const t = tierIndex(c);
    range[c] = live[t] > 0 ? mass[t] / live[t] : 0;
    total += range[c];
  }

  // A read that put all its weight on a tier this board leaves empty would
  // otherwise produce a range with nothing in it. Fall back to no read at all.
  if (!(total > 0)) return removeCards(uniformRange(), dead);
  return range;
}

/**
 * One range per opponent, in request order.
 *
 * A seat with an explicit range gets it (copied — the kernel masks in place and
 * a caller's range outlives the call). A seat with only a belief gets that
 * belief spread by board-relative bucket. A seat with neither gets a flat prior
 * rather than being dropped, since an unknown opponent still takes cards out of
 * the deck and still has to be beaten.
 *
 * Card removal is re-applied here in every branch: the request carries a board
 * and a hero holding, and a range that disagrees with them would put impossible
 * hands in the field.
 */
export function rangesFor(req: EquityRequest): Range[] {
  const dead = [...req.heroHole, ...req.board];
  // Built at most once per request, and only if some seat needs the adapter.
  let buckets: Uint8Array | null = null;
  return req.opponents.map((id) => {
    const supplied = req.ranges?.[id];
    if (supplied) return removeCards(cloneRange(supplied), dead);
    if (buckets === null) buckets = classifyAll(makeBoardContext(req.board));
    return beliefRange(req.beliefs?.[id] ?? UNIFORM_BELIEF, buckets, dead);
  });
}

/**
 * Mask a range onto what the deck still holds and build its O(1) draw table.
 *
 * The pool is the authority, not the range: a caller that forgets to remove a
 * card would otherwise have a seat draw a card the hero is holding, and the
 * kernel's availability permutation has no slot to take it from. Masking here
 * costs one pass over 1326 weights per seat per call — nothing next to the run
 * it feeds — and makes the kernel correct on its own inputs rather than on a
 * promise about them.
 */
function poolSampler(
  range: Range,
  pool: Uint8Array,
  poolIndex: Int16Array
): ComboSampler {
  const masked = new Float64Array(COMBO_COUNT);
  let total = 0;
  for (let c = 0; c < COMBO_COUNT; c++) {
    const w = range[c];
    if (!(w > 0)) continue;
    if (poolIndex[comboCardA(c)] < 0 || poolIndex[comboCardB(c)] < 0) continue;
    masked[c] = w;
    total += w;
  }
  // A read this deck leaves nothing of — every combo it liked is already on the
  // board or in the hero's hand. Fall back to no read at all rather than to an
  // empty range, which has no draw to make. Mirrors `beliefRange`'s fallback.
  if (!(total > 0)) {
    const L = pool.length;
    for (let i = 0; i < L; i++) {
      for (let j = i + 1; j < L; j++) masked[comboIndex(pool[i], pool[j])] = 1;
    }
  }
  return makeComboSampler(masked);
}

/**
 * The kernel, on 0..51 card codes. `ranges` is index-aligned with the
 * opponents, so this never needs to know what a seat id is.
 */
export function runMultiwayCountsFromCodes(
  heroHole: Uint8Array,
  board: Uint8Array,
  pool: Uint8Array,
  ranges: Range[],
  sims: number,
  rng: Rng
): MultiwayCounts {
  const L = pool.length;
  const cc = board.length;
  const needed = 5 - cc;
  const N = ranges.length;

  if (cc > 5) throw new Error(`multiway: board of ${cc} cards`);
  // The uniform fallback below is only guaranteed to terminate because the deck
  // provably holds enough cards; check it once here rather than per draw.
  if (L < 2 * N + needed) {
    throw new Error(
      `multiway: pool of ${L} cannot deal ${N} hands and ${needed} board cards`
    );
  }

  // Card code -> its slot in the pool, -1 for a card nobody can be dealt. The
  // sampler speaks card codes and the availability permutation below speaks
  // pool indices; this is the one place the two meet.
  const poolIndex = new Int16Array(52).fill(-1);
  for (let i = 0; i < L; i++) poolIndex[pool[i]] = i;

  // One alias table per seat, built once per call: O(1326) to build, O(1) per
  // draw, and the tuple loop draws a combo per seat per attempt.
  const samplers: ComboSampler[] = [];
  for (let o = 0; o < N; o++) {
    samplers.push(poolSampler(ranges[o], pool, poolIndex));
  }

  // Reusable code buffers: [hole, hole, ...board, ...drawn], always 7 long.
  const handSize = 2 + cc + needed;
  const heroHand = new Uint8Array(handSize);
  heroHand[0] = heroHole[0];
  heroHand[1] = heroHole[1];
  const oppHands: Uint8Array[] = [];
  for (let o = 0; o < N; o++) oppHands.push(new Uint8Array(handSize));
  for (let k = 0; k < cc; k++) {
    heroHand[2 + k] = board[k];
    for (let o = 0; o < N; o++) oppHands[o][2 + k] = board[k];
  }

  // The hero's hand is fixed once the board is complete: score it just once.
  // -1 is not a reachable score, so it doubles as "not fixed".
  const fixedHeroScore = needed === 0 ? scoreInts(heroHand, handSize) : -1;

  // Card removal as a permutation with two cursors: `avail[lo..hi)` is what is
  // still live, `pos` inverts it so availability is a single comparison. Hole
  // cards leave through the top, board cards through the bottom. The bottom
  // cursor is not arbitrary — advancing `lo` makes the board draw arithmetically
  // identical to the heads-up sampler's partial Fisher-Yates.
  const avail = new Uint8Array(L);
  const pos = new Uint8Array(L);
  for (let i = 0; i < L; i++) {
    avail[i] = i;
    pos[i] = i;
  }
  let lo = 0;
  let hi = L;

  // The tuple under construction, as card codes: seat o proposes `cand[2o]`,
  // `cand[2o+1]`. Disjointness is checked against `mark`, which is stamped
  // rather than cleared — an attempt writes its own stamp, so the previous
  // attempt's marks go stale for free. `stamp` is local to this call and
  // advances at most MAX_TUPLE_ATTEMPTS per sim, far short of wrapping.
  const cand = new Uint8Array(2 * N);
  const mark = new Int32Array(52);
  let stamp = 0;

  // Swap journal. Undoing this sim's swaps in reverse restores the identity
  // permutation in ≤ 2N+5 steps instead of rewriting all L slots, and restores
  // it *exactly*, which the one-opponent equivalence depends on. Each seat
  // performs exactly two swaps and each board card one, so the size is tight.
  const jA = new Uint8Array(2 * N + needed);
  const jB = new Uint8Array(2 * N + needed);
  let nj = 0;

  function swapAt(i: number, j: number): void {
    const x = avail[i];
    const y = avail[j];
    avail[i] = y;
    avail[j] = x;
    pos[y] = i;
    pos[x] = j;
    jA[nj] = i;
    jB[nj] = j;
    nj++;
  }

  const tieBySize = new Array<number>(N + 2).fill(0);
  const h2hWins = new Array<number>(N).fill(0);
  const h2hTies = new Array<number>(N).fill(0);
  let wins = 0;
  let ties = 0;
  let losses = 0;

  for (let s = 0; s < sims; s++) {
    lo = 0;
    hi = L;
    nj = 0;

    // Propose the whole field, and keep it only if no two seats want the same
    // card. Redrawing just the offending seat would condition it on the seats
    // dealt before it, which is exactly the seat-order artifact this avoids.
    let dealt = false;
    for (let t = 0; t < MAX_TUPLE_ATTEMPTS; t++) {
      stamp++;
      dealt = true;
      for (let o = 0; o < N; o++) {
        const combo = drawCombo(samplers[o], rng);
        const a = comboCardA(combo);
        const b = comboCardB(combo);
        // Abandon at the first collision instead of finishing the tuple: the
        // accepted tuples and their relative weights are identical either way,
        // and six-handed most collisions land before the last seat.
        if (mark[a] === stamp || mark[b] === stamp) {
          dealt = false;
          break;
        }
        mark[a] = stamp;
        mark[b] = stamp;
        cand[2 * o] = a;
        cand[2 * o + 1] = b;
      }
      if (dealt) break;
    }

    if (dealt) {
      for (let o = 0; o < N; o++) {
        const a = cand[2 * o];
        const b = cand[2 * o + 1];
        // Read `pos[·]` after the first swap — b moves if it sat at the top.
        swapAt(pos[poolIndex[a]], hi - 1);
        hi--;
        swapAt(pos[poolIndex[b]], hi - 1);
        hi--;
        const hand = oppHands[o];
        hand[0] = a;
        hand[1] = b;
      }
    } else {
      // Documented fallback: give up on the ranges and deal the whole field
      // uniformly at random from what is live. It cannot fail — the pool-size
      // guard reserves two cards per seat — which is what makes this loop
      // terminate rather than merely usually terminate, and it is exchangeable,
      // so the escape hatch does not smuggle the seat-order artifact back in.
      for (let o = 0; o < N; o++) {
        const i1 = lo + rng.int(hi - lo);
        const a = avail[i1];
        swapAt(i1, hi - 1);
        hi--;
        const i2 = lo + rng.int(hi - lo);
        const b = avail[i2];
        swapAt(i2, hi - 1);
        hi--;
        const hand = oppHands[o];
        hand[0] = pool[a];
        hand[1] = pool[b];
      }
    }

    for (let d = 0; d < needed; d++) {
      const t = lo + rng.int(hi - lo);
      swapAt(lo, t);
      const card = pool[avail[lo]];
      lo++;
      heroHand[2 + cc + d] = card;
      for (let o = 0; o < N; o++) oppHands[o][2 + cc + d] = card;
    }

    const heroScore =
      fixedHeroScore >= 0 ? fixedHeroScore : scoreInts(heroHand, handSize);

    // One pass gives both answers: the hero beats the field iff it beats the
    // best opponent, and each comparison made along the way *is* the heads-up
    // result against that seat. This is why `perOpponent` is free.
    let bestOpp = -1;
    let tiedWithHero = 0;
    for (let o = 0; o < N; o++) {
      const sc = scoreInts(oppHands[o], handSize);
      if (sc > bestOpp) bestOpp = sc;
      if (heroScore > sc) h2hWins[o]++;
      else if (heroScore === sc) {
        h2hTies[o]++;
        tiedWithHero++;
      }
    }

    if (heroScore > bestOpp) wins++;
    else if (heroScore < bestOpp) losses++;
    else {
      ties++;
      tieBySize[tiedWithHero + 1]++;
    }

    // A swap is its own inverse, so replaying the journal backwards restores
    // the identity permutation the next sim starts from.
    for (let k = nj - 1; k >= 0; k--) {
      const i = jA[k];
      const j = jB[k];
      const x = avail[i];
      const y = avail[j];
      avail[i] = y;
      avail[j] = x;
      pos[y] = i;
      pos[x] = j;
    }
  }

  return { sims, wins, ties, losses, tieBySize, h2hWins, h2hTies };
}

/** One unsharded stream over a whole `EquityRequest`. */
export function runMultiwayCounts(
  req: EquityRequest,
  rng: Rng = makeRng(req.seed)
): MultiwayCounts {
  return runMultiwayCountsFromCodes(
    Uint8Array.from(req.heroHole),
    Uint8Array.from(req.board),
    remainingPool(req.heroHole, req.board),
    rangesFor(req),
    req.simulations,
    rng
  );
}

/** The same run, normalized. The single-stream counterpart to the pool's
 * sharded entry points; those exist for latency, this one for callers that do
 * not care (tests, offline scripts). */
export function runMultiway(req: EquityRequest): MultiwayEquity {
  return finalizeMultiway(runMultiwayCounts(req), req.opponents);
}

/**
 * Sum shard counts. Integer addition taken in the order given rather than in
 * completion order, so the total cannot depend on which worker finished first.
 * `opponentCount` is passed rather than inferred so an empty run (zero sims,
 * hence zero shards) still produces correctly shaped arrays.
 */
export function mergeMultiwayCounts(
  parts: MultiwayCounts[],
  opponentCount: number
): MultiwayCounts {
  const total: MultiwayCounts = {
    sims: 0,
    wins: 0,
    ties: 0,
    losses: 0,
    tieBySize: new Array<number>(opponentCount + 2).fill(0),
    h2hWins: new Array<number>(opponentCount).fill(0),
    h2hTies: new Array<number>(opponentCount).fill(0),
  };
  for (const p of parts) {
    total.sims += p.sims;
    total.wins += p.wins;
    total.ties += p.ties;
    total.losses += p.losses;
    for (let k = 0; k < total.tieBySize.length; k++) {
      total.tieBySize[k] += p.tieBySize[k] ?? 0;
    }
    for (let o = 0; o < opponentCount; o++) {
      total.h2hWins[o] += p.h2hWins[o] ?? 0;
      total.h2hTies[o] += p.h2hTies[o] ?? 0;
    }
  }
  return total;
}

/**
 * Normalize raw counts into the reported result. Pure, so merged shard totals
 * go through exactly the same arithmetic a single run would.
 *
 * `opponents` supplies the seat ids for `perOpponent`; the counts themselves
 * are positional.
 */
export function finalizeMultiway(
  c: MultiwayCounts,
  opponents: number[]
): MultiwayEquity {
  const { sims, wins, ties, losses } = c;

  // Σ over chop sizes in fixed ascending order — the only float sum here, and
  // it happens once per merged run rather than once per shard.
  let tieShare = 0;
  for (let k = 2; k < c.tieBySize.length; k++) tieShare += c.tieBySize[k] / k;

  const perOpponent: Record<number, number> = {};
  for (let o = 0; o < opponents.length; o++) {
    const w = c.h2hWins[o] ?? 0;
    const t = c.h2hTies[o] ?? 0;
    perOpponent[opponents[o]] = sims > 0 ? (w + t / 2) / sims : 0;
  }

  const pWin = sims > 0 ? wins / sims : 0;
  return {
    simulations: sims,
    wins,
    ties,
    losses,
    pWin,
    pTie: sims > 0 ? ties / sims : 0,
    pLoss: sims > 0 ? losses / sims : 0,
    equity: sims > 0 ? (wins + tieShare) / sims : 0,
    se: standardError(pWin, sims),
    ciWin: wilsonInterval(wins, sims),
    perOpponent,
  };
}
