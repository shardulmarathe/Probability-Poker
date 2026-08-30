/**
 * Hand-strength distributions, what a combo's final equity looks like across
 * every way the board can still run out, not just its average.
 *
 * `buckets.ts` orders its classes by equity against a random hand: expected
 * hand strength, EHS. Ganzfried & Sandholm state the defect of that metric
 * exactly (Potential-Aware Imperfect-Recall Abstraction with Earth Mover's
 * Distance, AAAI-14, §1): EHS "fails to account for the entire probability
 * distribution of hand strength". Their example is KcQc against 6c6d, with
 * expected hand strengths of "0.634 and 0.633 respectively, which suggests that
 * they have very similar strength", while the distributions behind those two
 * numbers look nothing alike: "6c6d frequently has an equity between 0.5 and
 * 0.7 and rarely has an equity between 0.7 and 0.9, while the reverse is true
 * for KcQc." Johanson et al. (Evaluating State-Space Abstractions in
 * Extensive-Form Games, AAMAS-13, §4) make the same point: "E[HS] summarizes
 * the distribution over possible end-game strengths into a single expected
 * value", which "is unable to distinguish hands with differing potential to
 * improve."
 *
 * So this module computes the histogram rather than the mean, and gives the
 * distance the literature uses to compare two of them. It is measurement
 * apparatus: nothing on the decision hot path imports it, because a histogram
 * costs ~1e3 evaluator calls per runout where a bucket costs one (see the cost
 * note on `allDistributions`).
 *
 * What this is NOT: potential-aware abstraction. Ganzfried & Sandholm draw the
 * line between "distribution aware", histograms over strength at the final
 * round, which is what is built here, and "potential aware", which recurses
 * over histograms of next-round clusters so that two hands realizing the same
 * river distribution at different rates come apart. Doing that needs a cluster
 * assignment per round, which needs k-means with a free cluster count, which is
 * exactly what BUCKET_COUNT being frozen forbids. distribution.test.ts measures
 * how much the existing taxonomy leaves on the table; it cannot collect it.
 */

import type { Rng } from "../core/rng";
import { scoreInts } from "../handEvaluator";
import { COMBO_COUNT, comboIndex } from "./range";

/**
 * Equity bins per histogram.
 *
 * 50, because the literature is 50 and the point of this module is to be
 * comparable to it: "prior work has assumed that the equities are divided into
 * 50 regions of size 0.02" (Ganzfried & Sandholm, AAAI-14, §1), and Johanson et
 * al.'s published EMD table is quoted in those bin units, which is what lets
 * distribution.test.ts check this implementation against their numbers instead
 * of against itself. 0.02 is also finer than the sampling error of any runout
 * count that finishes in reasonable time, so the binning is never the limit on
 * accuracy; the sample count is.
 */
export const DIST_BINS = 50;

/** Equity width of one bin. */
export const BIN_WIDTH = 1 / DIST_BINS;

/**
 * Largest EMD two histograms can have: all mass at bin 0 against all mass at
 * bin 49, i.e. a certain loss against a certain win.
 */
export const EMD_MAX = DIST_BINS - 1;

/**
 * Runouts sampled when the runout space is not being enumerated.
 *
 * The estimator is unbiased at any count; what a count buys is resolution.
 * distribution.test.ts prices this one against the exhaustive flop it can be
 * checked over: 500 runouts put a combo's histogram a mean 0.42 bins from its
 * exact one, worst case 1.4. That is small against the distances the taxonomy
 * questions turn on, adjacent bucket centroids sit 5 to 15 bins apart, and
 * far too large to resolve the 0.001 of EHS between KcQc and 6c6d, which is
 * why `mean` is accumulated off the raw equities instead of the bins.
 */
export const DEFAULT_RUNOUTS = 500;

/**
 * Ask for every runout instead of a sample.
 *
 * Affordable exactly where the runout space is small: one runout on the river,
 * 48 on the turn, C(49,2) = 1176 on the flop. Preflop is C(52,5) = 2,598,960
 * and is refused rather than silently taking an hour.
 */
export const EXACT = 0;

/** Bin holding `equity`. 1.0 lands in the top bin rather than off the end. */
export function binOfEquity(equity: number): number {
  // `equity < 0 || equity > 1` alone is false for NaN, which would then index
  // as bin 0 and quietly record a certain loss.
  if (!(equity >= 0) || !(equity <= 1)) {
    throw new Error(`binOfEquity: equity ${equity} outside [0, 1]`);
  }
  const bin = (equity * DIST_BINS) | 0;
  return bin >= DIST_BINS ? DIST_BINS - 1 : bin;
}

// ---------------------------------------------------------------------------
// Earth Mover's Distance
// ---------------------------------------------------------------------------

/**
 * Earth Mover's Distance between two equity histograms, in bins.
 *
 * "Informally, EMD is the 'minimum cost of turning one pile into the other,
 * where the cost is assumed to be amount of dirt moved times the distance by
 * which it is moved'" (Ganzfried & Sandholm, AAAI-14, §1). For histograms on a
 * line that minimum has a closed form, the L1 distance between the cumulative
 * distributions, so the whole thing is one pass with a running carry, which is
 * the "straightforward linear time procedure that scans the histogram and keeps
 * track of how much dirt needs to be transported between consecutive bins" the
 * same section describes. Multi-dimensional EMD is a transportation LP and is
 * not cheap; this is one-dimensional and is.
 *
 * Why EMD rather than L2 or Kolmogorov-Smirnov: those "measure not only the
 * difference in probability mass, but also how far that mass was moved"
 * (Johanson et al., AAMAS-13, §4), or rather EMD does and they do not. L2 was
 * tried first and "has been shown to be significantly less effective because it
 * does not properly account for how far the 'dirt' needs to be moved (only how
 * much needs to be moved)" (Ganzfried & Sandholm, §1). Two histograms with
 * disjoint support are equidistant under L2 whether the gap is one bin or
 * forty; under EMD they are not, and in poker that gap is the whole question.
 *
 * Units are bins, matching the published tables, multiply by BIN_WIDTH for
 * equity. `emd(a, a) === 0`, and `emd >= |mean(a) - mean(b)| / BIN_WIDTH`
 * always, with equality exactly when one distribution stochastically dominates
 * the other. That inequality is the formal version of the claim this module
 * exists to make: EMD sees everything a difference of means sees, and more.
 */
export function emd(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== DIST_BINS || b.length !== DIST_BINS) {
    throw new Error(
      `emd: histograms of ${a.length} and ${b.length}, need ${DIST_BINS}`
    );
  }
  let carry = 0;
  let work = 0;
  for (let i = 0; i < DIST_BINS; i++) {
    carry += a[i] - b[i];
    work += carry < 0 ? -carry : carry;
  }
  return work;
}

/**
 * Mean equity implied by a histogram, using bin centres.
 *
 * Quantized: it can be off the true E[HS] by up to half a bin (0.01), which is
 * ten times the gap between KcQc and 6c6d. Anything comparing expectations
 * should read the unquantized `mean` off the distribution instead, this is for
 * describing a histogram that arrived without one.
 */
export function histogramMean(h: ArrayLike<number>): number {
  if (h.length !== DIST_BINS) {
    throw new Error(`histogramMean: histogram of ${h.length}, need ${DIST_BINS}`);
  }
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < DIST_BINS; i++) {
    weighted += h[i] * (i + 0.5) * BIN_WIDTH;
    total += h[i];
  }
  return total > 0 ? weighted / total : 0;
}

// ---------------------------------------------------------------------------
// Runout plumbing
// ---------------------------------------------------------------------------

/**
 * Which runouts to walk, given how many cards are still to come.
 *
 * Exhaustive whenever exhaustive is cheap, because a sampled answer that could
 * have been exact is just noise someone will later mistake for a finding: the
 * river has one runout and the turn has fewer than fifty, so both enumerate and
 * `runouts` is ignored there. The flop's 1176 are enumerated only on request
 * (`EXACT`), since walking them costs about a second per board.
 */
interface RunoutPlan {
  readonly passes: number;
  readonly exact: boolean;
  /** `passes * need` card codes when enumerating, null when sampling. */
  readonly cards: Uint8Array | null;
}

function planRunouts(
  need: number,
  pool: Uint8Array,
  poolSize: number,
  runouts: number,
  what: string
): RunoutPlan {
  if (need === 0) return { passes: 1, exact: true, cards: new Uint8Array(0) };
  if (need === 1) {
    return { passes: poolSize, exact: true, cards: pool.slice(0, poolSize) };
  }
  if (runouts === EXACT) {
    if (need !== 2) {
      throw new Error(
        `${what}: exact enumeration needs at most 2 cards to come, not ${need}`
      );
    }
    const passes = (poolSize * (poolSize - 1)) / 2;
    const cards = new Uint8Array(passes * 2);
    let m = 0;
    for (let i = 0; i < poolSize; i++) {
      for (let j = i + 1; j < poolSize; j++) {
        cards[m++] = pool[i];
        cards[m++] = pool[j];
      }
    }
    return { passes, exact: true, cards };
  }
  if (!Number.isInteger(runouts) || runouts < 1) {
    throw new Error(`${what}: runouts must be a positive integer or EXACT`);
  }
  return { passes: runouts, exact: false, cards: null };
}

/** Validate and mark a card, rejecting duplicates as well as bad codes. */
function mark(used: Uint8Array, c: number, what: string): void {
  if (!Number.isInteger(c) || c < 0 || c > 51) {
    throw new Error(`${what}: bad card code ${c}`);
  }
  if (used[c] === 1) throw new Error(`${what}: duplicate card ${c}`);
  used[c] = 1;
}

/** Draw `need` distinct cards into `pool[0..need)` by partial Fisher-Yates. */
function drawRunout(pool: Uint8Array, size: number, need: number, rng: Rng): void {
  for (let d = 0; d < need; d++) {
    const t = d + rng.int(size - d);
    const tmp = pool[d];
    pool[d] = pool[t];
    pool[t] = tmp;
  }
}

// ---------------------------------------------------------------------------
// One combo
// ---------------------------------------------------------------------------

export interface HandStrengthDistribution {
  /** Probability mass per equity bin; sums to 1. */
  readonly histogram: Float64Array;
  /**
   * E[HS] over the same runouts, computed off the raw equities rather than the
   * bins, so it is directly comparable to the published 0.634 / 0.633 without
   * a half-bin of quantization sitting on top of a 0.001 gap.
   */
  readonly mean: number;
  /** Runouts walked. Exhaustive when `needed <= 1`, else the sample count. */
  readonly runouts: number;
  /** True when every possible runout was enumerated. */
  readonly exact: boolean;
}

/**
 * Distribution of this combo's final equity over the ways the board completes.
 *
 * "Hand strength" is the paper's: the probability of beating a hand drawn
 * uniformly from the cards neither player can see, counting a tie as a half,
 * evaluated once the board is complete. Given a runout that inner number is
 * computed exhaustively over all C(45,2) = 990 opponent holdings, so the only
 * approximation anywhere is which runouts get walked.
 */
export function handDistribution(
  a: number,
  b: number,
  board: ArrayLike<number>,
  rng: Rng,
  runouts: number = DEFAULT_RUNOUTS
): HandStrengthDistribution {
  const len = board.length;
  if (len > 5) throw new Error(`handDistribution: board of ${len} cards`);

  const used = new Uint8Array(52);
  mark(used, a, "handDistribution");
  mark(used, b, "handDistribution");

  const full = new Uint8Array(5);
  for (let i = 0; i < len; i++) {
    mark(used, board[i], "handDistribution");
    full[i] = board[i];
  }

  // Cards that can still come. Hero's own two are excluded, so every runout
  // drawn here is one hero can actually see.
  const pool = new Uint8Array(50 - len);
  let poolSize = 0;
  for (let c = 0; c < 52; c++) if (used[c] === 0) pool[poolSize++] = c;

  const need = 5 - len;
  const plan = planRunouts(need, pool, poolSize, runouts, "handDistribution");
  const passes = plan.passes;

  const hist = new Float64Array(DIST_BINS);
  const hero = new Uint8Array(7);
  const vill = new Uint8Array(7);
  hero[0] = a;
  hero[1] = b;
  // Cards left once the board is complete: 52 - 5 - 2 = 45, so C(45,2) = 990
  // opponent holdings per runout.
  const live = new Uint8Array(45);
  const onBoard = new Uint8Array(52);
  let meanSum = 0;

  for (let p = 0; p < passes; p++) {
    if (plan.cards !== null) {
      for (let d = 0; d < need; d++) full[len + d] = plan.cards[p * need + d];
    } else {
      drawRunout(pool, poolSize, need, rng);
      for (let d = 0; d < need; d++) full[len + d] = pool[d];
    }

    onBoard.fill(0);
    for (let i = 0; i < 5; i++) {
      onBoard[full[i]] = 1;
      hero[2 + i] = full[i];
      vill[2 + i] = full[i];
    }
    let liveCount = 0;
    for (let c = 0; c < 52; c++) {
      if (onBoard[c] === 0 && c !== a && c !== b) live[liveCount++] = c;
    }

    const heroScore = scoreInts(hero, 7);
    let worse = 0;
    let tie = 0;
    for (let i = 0; i < liveCount; i++) {
      vill[0] = live[i];
      for (let j = i + 1; j < liveCount; j++) {
        vill[1] = live[j];
        const s = scoreInts(vill, 7);
        if (s < heroScore) worse++;
        else if (s === heroScore) tie++;
      }
    }

    const hs = (worse + 0.5 * tie) / ((liveCount * (liveCount - 1)) / 2);
    hist[binOfEquity(hs)] += 1;
    meanSum += hs;
  }

  for (let i = 0; i < DIST_BINS; i++) hist[i] /= passes;

  return {
    histogram: hist,
    mean: meanSum / passes,
    runouts: passes,
    exact: plan.exact,
  };
}

// ---------------------------------------------------------------------------
// Every combo at once
// ---------------------------------------------------------------------------

export interface DistributionSet {
  /** `COMBO_COUNT * DIST_BINS`; combo i occupies `[i * DIST_BINS, ...)`. */
  readonly bins: Float64Array;
  /** Unquantized E[HS] per combo, over that combo's valid runouts. */
  readonly mean: Float64Array;
  /**
   * Runouts that were valid for each combo, a runout containing one of a
   * combo's own cards is not one that combo can see, so different combos see
   * different subsets of the same sample. Zero means the combo clashes with the
   * board and has no distribution at all; its histogram is all zeros and every
   * caller must skip it.
   */
  readonly samples: Uint32Array;
  /** Runouts drawn in total. */
  readonly runouts: number;
  readonly exact: boolean;
}

/**
 * Distributions for all 1326 combos on one board, sharing runouts.
 *
 * The sharing is the whole design. A runout fixes a five-card board, and on a
 * fixed board the C(47,2) = 1081 possible holdings can be evaluated once and
 * then ranked against each other, so one pass costs 1081 evaluator calls and
 * yields a hand-strength value for all 1081 live combos, instead of 1081
 * separate passes of ~990 calls each. That is the difference between this being
 * a tool and being a weekend.
 *
 * Card removal is handled by rejection rather than by re-drawing: a runout that
 * collides with a combo's own cards simply is not counted for that combo. Since
 * the runouts are uniform, conditioning them on "does not contain hero's cards"
 * leaves exactly the uniform distribution over the runouts hero can see, which
 * is the right conditional and costs nothing but a slightly smaller sample
 * (~92% of draws survive on the flop, ~82% preflop).
 *
 * Cost: ~1081 seven-card evaluations plus ~1081x90 comparisons per runout,
 * measured in distribution.test.ts. This is offline analysis apparatus. It is
 * three to four orders of magnitude past `classifyAll`, which does the whole
 * board in ~190 microseconds, and nothing that has to answer inside a decision
 * should call it.
 */
export function allDistributions(
  board: ArrayLike<number>,
  rng: Rng,
  runouts: number = DEFAULT_RUNOUTS
): DistributionSet {
  const len = board.length;
  if (len > 5) throw new Error(`allDistributions: board of ${len} cards`);

  const used = new Uint8Array(52);
  const full = new Uint8Array(5);
  for (let i = 0; i < len; i++) {
    mark(used, board[i], "allDistributions");
    full[i] = board[i];
  }

  // Runouts are drawn from everything not already on the board, hole cards
  // cannot be excluded here because every combo is a hero in turn.
  const pool = new Uint8Array(52 - len);
  let poolSize = 0;
  for (let c = 0; c < 52; c++) if (used[c] === 0) pool[poolSize++] = c;

  const need = 5 - len;
  const plan = planRunouts(need, pool, poolSize, runouts, "allDistributions");
  const passes = plan.passes;

  const bins = new Float64Array(COMBO_COUNT * DIST_BINS);
  const mean = new Float64Array(COMBO_COUNT);
  const samples = new Uint32Array(COMBO_COUNT);

  const onBoard = new Uint8Array(52);
  const live = new Uint8Array(47);
  const hand = new Uint8Array(7);
  // Score keyed by card pair rather than by combo index, so the blocker sweep
  // below is a plain array load instead of 90 index lookups per combo.
  const byCards = new Float64Array(52 * 52);
  // Exactly C(47,2): `full` always holds five distinct cards, so `liveCount` is
  // always 47 and this fills completely. It has to, `sorted.sort()` sorts the
  // whole buffer, so a short fill would leave zeros sorted to the front and
  // every rank below would be counted against them.
  const sorted = new Float64Array(1081);

  for (let p = 0; p < passes; p++) {
    if (plan.cards !== null) {
      for (let d = 0; d < need; d++) full[len + d] = plan.cards[p * need + d];
    } else {
      drawRunout(pool, poolSize, need, rng);
      for (let d = 0; d < need; d++) full[len + d] = pool[d];
    }

    onBoard.fill(0);
    for (let i = 0; i < 5; i++) {
      onBoard[full[i]] = 1;
      hand[2 + i] = full[i];
    }
    let liveCount = 0;
    for (let c = 0; c < 52; c++) if (onBoard[c] === 0) live[liveCount++] = c;

    // Every holding on this board, scored once and shared by every hero below.
    let m = 0;
    for (let i = 0; i < liveCount; i++) {
      const x = live[i];
      hand[0] = x;
      for (let j = i + 1; j < liveCount; j++) {
        const y = live[j];
        hand[1] = y;
        const s = scoreInts(hand, 7);
        byCards[x * 52 + y] = s;
        byCards[y * 52 + x] = s;
        sorted[m++] = s;
      }
    }
    // Ranking all of them at once turns "how many holdings does hero beat" into
    // two binary searches plus a correction for the ones hero blocks.
    sorted.sort();

    const opponents = ((liveCount - 2) * (liveCount - 3)) / 2;
    for (let i = 0; i < liveCount; i++) {
      const x = live[i];
      const xRow = x * 52;
      for (let j = i + 1; j < liveCount; j++) {
        const y = live[j];
        const yRow = y * 52;
        const s = byCards[xRow + y];

        // Counts over all `m` holdings, hero included.
        let worse = lowerBound(sorted, m, s);
        // ...minus hero itself, which is a tie with itself by construction.
        let tie = upperBound(sorted, m, s) - worse - 1;

        // Hero's own cards block 2 * (liveCount - 2) other holdings, none of
        // which the opponent can hold. Subtracting them is what makes this
        // exact rather than an approximation that ignores blockers.
        for (let k = 0; k < liveCount; k++) {
          const z = live[k];
          if (z === x || z === y) continue;
          const sx = byCards[xRow + z];
          if (sx < s) worse--;
          else if (sx === s) tie--;
          const sy = byCards[yRow + z];
          if (sy < s) worse--;
          else if (sy === s) tie--;
        }

        const hs = (worse + 0.5 * tie) / opponents;
        const combo = comboIndex(x, y);
        bins[combo * DIST_BINS + binOfEquity(hs)] += 1;
        mean[combo] += hs;
        samples[combo]++;
      }
    }
  }

  for (let i = 0; i < COMBO_COUNT; i++) {
    const n = samples[i];
    if (n === 0) continue;
    mean[i] /= n;
    const base = i * DIST_BINS;
    for (let k = 0; k < DIST_BINS; k++) bins[base + k] /= n;
  }

  return { bins, mean, samples, runouts: passes, exact: plan.exact };
}

/** Count of entries strictly below `s` in `sorted[0..n)`. */
function lowerBound(sorted: Float64Array, n: number, s: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Count of entries at or below `s` in `sorted[0..n)`. */
function upperBound(sorted: Float64Array, n: number, s: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A view on one combo's histogram. A view, not a copy, writing through it
 * writes into the set.
 */
export function histogramOf(set: DistributionSet, combo: number): Float64Array {
  if (combo < 0 || combo >= COMBO_COUNT) {
    throw new Error(`histogramOf: bad combo index ${combo}`);
  }
  return set.bins.subarray(combo * DIST_BINS, (combo + 1) * DIST_BINS);
}

/**
 * EMD between two combos of the same set, without materializing either
 * histogram, the pairwise sweeps in the tests run this ~1e6 times.
 */
export function emdOf(set: DistributionSet, i: number, j: number): number {
  if (i < 0 || i >= COMBO_COUNT || j < 0 || j >= COMBO_COUNT) {
    throw new Error(`emdOf: bad combo index (${i}, ${j})`);
  }
  const bins = set.bins;
  const a = i * DIST_BINS;
  const b = j * DIST_BINS;
  let carry = 0;
  let work = 0;
  for (let k = 0; k < DIST_BINS; k++) {
    carry += bins[a + k] - bins[b + k];
    work += carry < 0 ? -carry : carry;
  }
  return work;
}
