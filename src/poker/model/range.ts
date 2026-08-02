/**
 * A weighted distribution over every hole-card combination an opponent can hold.
 *
 * The three-tier belief in `../bayesian.ts` says how likely an opponent is to be
 * "strong"; it cannot say *which* hands those are, so it cannot know that the
 * ace of hearts sitting in our own hand makes the nut heart flush impossible for
 * him. A range over all C(52,2) = 1326 combos can: `removeCards` zeroes every
 * combo containing a known card, and blockers fall out of that single operation
 * for free — no special case, no separate blocker model.
 *
 * Layout notes, because this feeds a Monte Carlo hot loop:
 *  - Cards are the 0..51 codes from `../core/card.ts` throughout.
 *  - A range is a bare `Float64Array(1326)`. Weights are unnormalized until
 *    someone asks; nothing here allocates per combo.
 *  - The combo <-> card mapping is table-driven in both directions, so neither
 *    direction costs arithmetic at call time (~8 KB of tables, built once:
 *    1326 bytes each way plus a 52x52 Uint16 reverse index).
 *  - Mutating helpers (`normalizeRange`, `removeCards`) work in place and return
 *    the same array so they chain. Copy with `cloneRange` first if the caller
 *    needs the original.
 */

import { rankChar } from "../cards";
import type { Rng } from "../core/rng";
import type { RankValue } from "../../types";

/** C(52, 2). The only length a `Range` is ever allowed to have. */
export const COMBO_COUNT = 1326;

/** Weight per hole-card combo, indexed by `comboIndex`. */
export type Range = Float64Array;

// ---------------------------------------------------------------------------
// Canonical combo indexing
// ---------------------------------------------------------------------------
//
// For a < b the index is the count of ordered-by-first-card pairs that precede
// it: 51a - a(a-1)/2 + (b - a - 1). That closed form is never evaluated at call
// time — it only builds the tables below, which make both directions a load.

/** Low card code of combo i (the smaller of the two). */
const COMBO_A = new Uint8Array(COMBO_COUNT);
/** High card code of combo i. */
const COMBO_B = new Uint8Array(COMBO_COUNT);
/** `INDEX_OF[a * 52 + b]` for either order; NO_COMBO on the a === b diagonal. */
const INDEX_OF = new Uint16Array(52 * 52);
/** Sentinel for "not a combo" — 1326 indices fit well below it. */
const NO_COMBO = 0xffff;

INDEX_OF.fill(NO_COMBO);
for (let a = 0, i = 0; a < 52; a++) {
  for (let b = a + 1; b < 52; b++) {
    COMBO_A[i] = a;
    COMBO_B[i] = b;
    INDEX_OF[a * 52 + b] = i;
    INDEX_OF[b * 52 + a] = i;
    i++;
  }
}

/**
 * Index of the unordered combo {a, b}. Order-insensitive; throws on a === b or
 * an out-of-range code, because either is a caller bug and a silently wrong
 * combo index would corrupt a whole range.
 */
export function comboIndex(a: number, b: number): number {
  const inRange = a >= 0 && a < 52 && b >= 0 && b < 52;
  const i = inRange ? INDEX_OF[a * 52 + b] : NO_COMBO;
  if (i === NO_COMBO) {
    throw new Error(`comboIndex: not a two-card combo (${a}, ${b})`);
  }
  return i;
}

/**
 * The two card codes of combo i, ascending. Exact inverse of `comboIndex`.
 *
 * Allocates a tuple per call, which is why nothing on a hot path uses it — the
 * per-combo loops read `comboCardA`/`comboCardB` instead. A table of 1326
 * frozen pairs used to live here to make this allocation-free; it cost 255 KB
 * resident to optimise a function with no caller outside the tests.
 */
export function comboCards(i: number): readonly [number, number] {
  if (i < 0 || i >= COMBO_COUNT) throw new Error(`comboCards: bad index ${i}`);
  return [COMBO_A[i], COMBO_B[i]];
}

/** Lower card code of combo i. Unchecked — this is the per-combo loop form. */
export function comboCardA(i: number): number {
  return COMBO_A[i];
}

/** Higher card code of combo i. Unchecked, as above. */
export function comboCardB(i: number): number {
  return COMBO_B[i];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** All weight zero — the starting point for a range built combo by combo. */
export function emptyRange(): Range {
  return new Float64Array(COMBO_COUNT);
}

/**
 * Every combo weighted 1 — "no read at all".
 *
 * Weight 1 rather than 1/1326 so a range reads as a combo count: a grid cell of
 * a uniform range holds exactly the textbook 6 / 4 / 12 combos, and totals stay
 * exact integers under `removeCards`. Normalize when a probability is wanted.
 */
export function uniformRange(): Range {
  const r = new Float64Array(COMBO_COUNT);
  r.fill(1);
  return r;
}

export function cloneRange(range: Range): Range {
  return range.slice();
}

// ---------------------------------------------------------------------------
// Queries and in-place transforms
// ---------------------------------------------------------------------------

export function totalWeight(range: Range): number {
  let sum = 0;
  for (let i = 0; i < COMBO_COUNT; i++) sum += range[i];
  return sum;
}

/** Weight of one combo, bounds-checked. Loops should index `range` directly. */
export function weightOf(range: Range, combo: number): number {
  if (combo < 0 || combo >= COMBO_COUNT) {
    throw new Error(`weightOf: bad combo index ${combo}`);
  }
  return range[combo];
}

/**
 * Scale in place so the weights sum to 1.
 *
 * Throws on an all-zero range rather than falling back to uniform the way
 * `bayesian.normalize` does: a uniform fallback here would resurrect exactly the
 * combos a caller just removed, turning a card-removal bug into a silently
 * impossible opponent holding.
 */
export function normalizeRange(range: Range): Range {
  const total = totalWeight(range);
  if (!(total > 0)) throw new Error("normalizeRange: range has no weight");
  for (let i = 0; i < COMBO_COUNT; i++) range[i] /= total;
  return range;
}

/**
 * Zero every combo containing one of `cards` — the opponent cannot hold a card
 * that is in our hand or on the board.
 *
 * This is the whole blocker story. Removing k distinct cards zeroes exactly
 * C(52,2) - C(52-k,2) combos, and what survives is automatically the range
 * conditioned on what we can see. Touches 51 slots per card, not 1326.
 */
export function removeCards(range: Range, cards: ArrayLike<number>): Range {
  for (let k = 0; k < cards.length; k++) {
    const c = cards[k];
    // `c < 0 || c > 51` alone is false for NaN, undefined and null, all of which
    // then index INDEX_OF as garbage: NaN is a silent no-op, null removes the
    // ace of spades, and a fractional 3.5 zeroes 51 unrelated combos straddling
    // two rows. Card removal that quietly removes the wrong cards is the worst
    // failure this module has, so the check is on the integer, not the bounds.
    if (!Number.isInteger(c) || c < 0 || c > 51) {
      throw new Error(`removeCards: bad card code ${c}`);
    }
    const row = c * 52;
    for (let o = 0; o < 52; o++) {
      if (o === c) continue;
      range[INDEX_OF[row + o]] = 0;
    }
  }
  return range;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * One draw proportional to weight, walking the range directly.
 *
 * O(1326) per draw, so this is for one-off draws and tests. A zero-weight combo
 * subtracts nothing from the running remainder and so can never be the one that
 * drives it negative — that is what makes "never returns an impossible hand" a
 * property of the arithmetic rather than a check.
 */
export function sampleCombo(range: Range, rng: Rng): number {
  const total = totalWeight(range);
  if (!(total > 0)) throw new Error("sampleCombo: range has no weight");

  let r = rng.next() * total;
  for (let i = 0; i < COMBO_COUNT; i++) {
    r -= range[i];
    if (r < 0) return i;
  }
  // Float dust only: the remainder can survive the last combo by ~1e-13. Fall
  // back to the top positive combo rather than to index 0, which may be zero.
  for (let i = COMBO_COUNT - 1; i >= 0; i--) if (range[i] > 0) return i;
  throw new Error("sampleCombo: range has no weight");
}

/**
 * Vose alias table: O(1) per draw after an O(1326) build.
 *
 * The Monte Carlo draws an opponent hand every simulation — tens of thousands
 * per decision — off a range that changes only between decisions. Paying 1326
 * operations once and 1 per draw is the whole point; `sampleCombo` above pays
 * 1326 per draw.
 */
export interface ComboSampler {
  /** Probability of keeping bucket i rather than following its alias. */
  readonly prob: Float64Array;
  /** Where bucket i sends the rest of its mass. */
  readonly alias: Uint16Array;
  /** Total weight of the range this was built from. */
  readonly total: number;
}

export function makeComboSampler(range: Range): ComboSampler {
  const n = COMBO_COUNT;
  const total = totalWeight(range);
  if (!(total > 0)) throw new Error("makeComboSampler: range has no weight");

  const prob = new Float64Array(n);
  const alias = new Uint16Array(n);
  const scaled = new Float64Array(n);
  const small = new Uint16Array(n);
  const large = new Uint16Array(n);
  let ns = 0;
  let nl = 0;
  // Any positive-weight combo, as a landing spot for the dust case below.
  let fallback = -1;

  for (let i = 0; i < n; i++) {
    const s = (range[i] * n) / total;
    scaled[i] = s;
    if (range[i] > 0 && fallback < 0) fallback = i;
    if (s < 1) small[ns++] = i;
    else large[nl++] = i;
  }

  while (ns > 0 && nl > 0) {
    const s = small[--ns];
    const l = large[--nl];
    prob[s] = scaled[s];
    alias[s] = l;
    scaled[l] += scaled[s] - 1;
    if (scaled[l] < 1) small[ns++] = l;
    else large[nl++] = l;
  }

  // Leftovers are exactly-1 buckets modulo rounding. An entry only ever reached
  // `large` with scaled >= 1, so it has real weight and can keep its own mass.
  while (nl > 0) {
    const l = large[--nl];
    prob[l] = 1;
    alias[l] = l;
  }
  // `small` can only be left non-empty by float dust, and the straggler may be a
  // zero-weight combo — giving it prob 1 would make an impossible hand drawable,
  // so send its mass away instead.
  while (ns > 0) {
    const s = small[--ns];
    if (range[s] > 0) {
      prob[s] = 1;
      alias[s] = s;
    } else {
      prob[s] = 0;
      alias[s] = fallback;
    }
  }

  return { prob, alias, total };
}

/**
 * One O(1) draw from an alias table.
 *
 * Splits a single `rng.next()` into a bucket index and a coin flip rather than
 * spending two draws. The coin keeps ~22 bits of the original 32 after the
 * bucket takes its share, which is far finer than any Monte Carlo here can
 * resolve, and halving RNG traffic in the innermost loop is worth more.
 */
export function drawCombo(sampler: ComboSampler, rng: Rng): number {
  const u = rng.next() * COMBO_COUNT;
  const i = u | 0;
  return u - i < sampler.prob[i] ? i : sampler.alias[i];
}

// ---------------------------------------------------------------------------
// 13x13 grid projection
// ---------------------------------------------------------------------------
//
// The standard poker chart. Rows and columns run A, K, Q, ... 2 (rank 14 at
// index 0, rank 2 at index 12), and the cell at `row * 13 + col` holds:
//
//   row === col   pocket pair          6 combos
//   col >  row    suited, row is high  4 combos   (upper-right triangle)
//   col <  row    offsuit, col is high 12 combos  (lower-left triangle)
//
// So AKs sits at (0, 1) and AKo at (1, 0), which is the orientation every
// published range chart uses. 13 * 6 + 78 * 4 + 78 * 12 = 1326.

export const GRID_SIZE = 13;
export const GRID_CELLS = 169;

/** Grid cell of each combo. */
const GRID_OF = new Uint8Array(COMBO_COUNT);

/** Cell labels in grid order: "AA", "AKs", ..., "AKo", ..., "22". */
export const GRID_LABELS: readonly string[] = (() => {
  const labels = new Array<string>(GRID_CELLS);
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const rowRank = rankChar((14 - row) as RankValue);
      const colRank = rankChar((14 - col) as RankValue);
      labels[row * GRID_SIZE + col] =
        row === col
          ? `${rowRank}${rowRank}`
          : row < col
            ? `${rowRank}${colRank}s`
            : `${colRank}${rowRank}o`;
    }
  }
  return Object.freeze(labels);
})();

for (let i = 0; i < COMBO_COUNT; i++) {
  const a = COMBO_A[i];
  const b = COMBO_B[i];
  const ra = (a >> 2) + 2;
  const rb = (b >> 2) + 2;
  const hi = ra > rb ? ra : rb;
  const lo = ra > rb ? rb : ra;
  const suited = (a & 3) === (b & 3);
  // 14 - rank maps ace to row 0 and deuce to row 12.
  GRID_OF[i] =
    hi === lo
      ? (14 - hi) * GRID_SIZE + (14 - hi)
      : suited
        ? (14 - hi) * GRID_SIZE + (14 - lo)
        : (14 - lo) * GRID_SIZE + (14 - hi);
}

/** Which of the 169 chart cells a combo belongs to. */
export function gridCellOf(combo: number): number {
  return GRID_OF[combo];
}

/**
 * Aggregate combo weights into the 169 canonical hand classes.
 *
 * Deliberately not normalized: the projection sums weight, so `toGrid` totals
 * exactly `totalWeight(range)`. A caller wanting percentages normalizes the
 * range first (or divides by the total), and the invariant "the grid conserves
 * weight" stays testable either way.
 */
export function toGrid(range: Range, out?: Float64Array): Float64Array {
  // Float64Array drops out-of-range stores silently, so a short buffer would
  // lose whole cells rather than fail — and the total would stop conserving.
  if (out !== undefined && out.length < GRID_CELLS) {
    throw new Error(`toGrid: out buffer holds ${out.length}, need ${GRID_CELLS}`);
  }
  const grid = out ?? new Float64Array(GRID_CELLS);
  grid.fill(0);
  for (let i = 0; i < COMBO_COUNT; i++) grid[GRID_OF[i]] += range[i];
  return grid;
}
