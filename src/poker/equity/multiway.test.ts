import { describe, expect, it } from "vitest";
import {
  beliefRange,
  finalizeMultiway,
  mergeMultiwayCounts,
  rangesFor,
  remainingPool,
  runMultiway,
  runMultiwayCountsFromCodes,
  type MultiwayCounts,
} from "./multiway";
import { tierOf } from "../bayesian";
import { makeCard, makeDeck, removeCards } from "../cards";
import { decodeCard, encodeCard, encodeCards } from "../core/card";
import { makeRng } from "../core/rng";
import { scoreInts } from "../handEvaluator";
import { classifyAll, makeBoardContext } from "../model/buckets";
import {
  COMBO_COUNT,
  comboCardA,
  comboCardB,
  comboIndex,
  emptyRange,
  type Range,
} from "../model/range";
import { runBeliefCountsFromCodes } from "../monteCarlo";
import { INITIAL_BELIEF } from "../../data/constants";
import type {
  BeliefDistribution,
  RankValue,
  StrengthTier,
  Suit,
} from "../../types";
import type { EquityRequest, MultiwayEquity } from "../table/contract";

// ---- Fixtures -------------------------------------------------------------

const RANKS: Record<string, RankValue> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** "As" -> its 0..51 code. Tests read as poker, the kernel sees integers. */
function code(s: string): number {
  return encodeCard(makeCard(RANKS[s[0]], s[1] as Suit));
}
function codes(...s: string[]): number[] {
  return s.map(code);
}

const TIERS: StrengthTier[] = ["weak", "medium", "strong"];
const UNIFORM: BeliefDistribution = {
  weak: 1 / 3,
  medium: 1 / 3,
  strong: 1 / 3,
};

function seats(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function sameBelief(n: number, b: BeliefDistribution): Record<number, BeliefDistribution> {
  const out: Record<number, BeliefDistribution> = {};
  for (const id of seats(n)) out[id] = b;
  return out;
}

/**
 * A run over an explicit pool. The public request derives the pool from a full
 * deck, which is right for the app but useless for a test that needs a deck
 * small enough to enumerate exhaustively.
 */
function runOverPool(
  hero: number[],
  board: number[],
  pool: number[],
  ranges: Range[],
  sims: number,
  seed: number
): MultiwayEquity {
  const counts = runMultiwayCountsFromCodes(
    Uint8Array.from(hero),
    Uint8Array.from(board),
    Uint8Array.from(pool),
    ranges,
    sims,
    makeRng(seed)
  );
  return finalizeMultiway(counts, seats(ranges.length));
}

/**
 * The production adapter, as a fixture: a three-tier read spread over combos by
 * board-relative bucket. Tests still read as "a loose seat and a tight seat"
 * while the sampler underneath sees 1326 weights.
 */
function readRange(
  belief: BeliefDistribution,
  hero: number[],
  board: number[]
): Range {
  return beliefRange(belief, classifyAll(makeBoardContext(board)), [
    ...hero,
    ...board,
  ]);
}

function readRanges(
  beliefs: BeliefDistribution[],
  hero: number[],
  board: number[]
): Range[] {
  return beliefs.map((b) => readRange(b, hero, board));
}

/**
 * The OLD sampler's law, written out: uniform inside a preflop `tierOf` bucket,
 * each bucket carrying `belief[tier]`. Nothing in production builds this any
 * more, it is here so the heads-up equivalence below can hand the new sampler
 * the exact distribution the old one drew from and compare like with like.
 */
function tierProxyRange(pool: number[], belief: BeliefDistribution): Range {
  const range = emptyRange();
  const byTier: Record<StrengthTier, number[]> = { weak: [], medium: [], strong: [] };
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      byTier[tierOf(decodeCard(pool[i]), decodeCard(pool[j]))].push(
        comboIndex(pool[i], pool[j])
      );
    }
  }
  const nonEmpty = TIERS.filter((t) => byTier[t].length > 0);
  const spill =
    TIERS.filter((t) => byTier[t].length === 0).reduce((s, t) => s + belief[t], 0) /
    nonEmpty.length;
  for (const t of nonEmpty) {
    const w = (belief[t] + spill) / byTier[t].length;
    for (const c of byTier[t]) range[c] = w;
  }
  return range;
}

// ---- Exact enumeration ----------------------------------------------------

interface Exact {
  equity: number;
  pWin: number;
  pTie: number;
  pLoss: number;
  perOpponent: number[];
  /**
   * Probability one whole-tuple proposal is accepted, the total mass the
   * enumeration below found on disjoint tuples. It is exactly the normalizer,
   * and it is what says whether ignoring the sampler's retry bound is honest.
   */
  accept: number;
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/**
 * The exact answer, by walking every branch the sampler could draw.
 *
 * This is the reference the Monte Carlo is checked against, so it reproduces
 * the sampler's *law* rather than an idealised one: each seat proposes a combo
 * with probability proportional to its weight in that seat's range, restricted
 * to combos the pool can actually deal; the field's joint proposal is the
 * product of those; and the whole tuple is kept only if the hands are disjoint.
 * So the weight of a tuple is Π p(hᵢ), no per-seat conditioning, renormalized
 * once at the end over the disjoint tuples alone, which is what whole-tuple
 * rejection converges to. Then uniform over board completions. It shares no
 * code with the kernel beyond `scoreInts` and the combo index, which are what
 * is being assumed rather than tested here.
 *
 * The one thing it does not model is the sampler's bounded-retry fallback, and
 * `accept` is reported so callers can check that omission rather than assume
 * it: each test below asserts `(1 - accept) ** MAX_TUPLE_ATTEMPTS` is
 * negligible, i.e. the fallback is unreachable for that fixture.
 */
function enumerateMultiway(
  hero: number[],
  board: number[],
  pool: number[],
  ranges: Range[]
): Exact {
  const L = pool.length;
  const cc = board.length;
  const needed = 5 - cc;
  const N = ranges.length;
  const handSize = 7;

  // Every combo the pool can deal, as a pair of pool indices, with each seat's
  // normalized proposal mass on it, the kernel's `poolSampler`, enumerated.
  const allCombos: number[][] = [];
  const comboOf: number[] = [];
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      allCombos.push([i, j]);
      comboOf.push(comboIndex(pool[i], pool[j]));
    }
  }
  const mass = ranges.map((range) => {
    const w = comboOf.map((c) => (range[c] > 0 ? range[c] : 0));
    const total = w.reduce((s, x) => s + x, 0);
    // The kernel's fallback for a range this deck leaves nothing of: no read.
    if (!(total > 0)) return w.map(() => 1 / w.length);
    return w.map((x) => x / total);
  });

  const heroHand = new Uint8Array(handSize);
  heroHand[0] = hero[0];
  heroHand[1] = hero[1];
  const oppHands: Uint8Array[] = [];
  for (let o = 0; o < N; o++) oppHands.push(new Uint8Array(handSize));
  for (let k = 0; k < cc; k++) {
    heroHand[2 + k] = board[k];
    for (let o = 0; o < N; o++) oppHands[o][2 + k] = board[k];
  }

  const used = new Uint8Array(L);
  const out: Exact = {
    equity: 0,
    pWin: 0,
    pTie: 0,
    pLoss: 0,
    perOpponent: new Array<number>(N).fill(0),
    accept: 0,
  };

  function leaf(w: number): void {
    const hs = scoreInts(heroHand, handSize);
    let best = -1;
    let tied = 0;
    for (let o = 0; o < N; o++) {
      const sc = scoreInts(oppHands[o], handSize);
      if (sc > best) best = sc;
      if (hs > sc) out.perOpponent[o] += w;
      else if (hs === sc) {
        out.perOpponent[o] += w / 2;
        tied++;
      }
    }
    if (hs > best) {
      out.pWin += w;
      out.equity += w;
    } else if (hs < best) {
      out.pLoss += w;
    } else {
      out.pTie += w;
      out.equity += w / (tied + 1);
    }
  }

  function completeBoard(w: number): void {
    const free: number[] = [];
    for (let i = 0; i < L; i++) if (used[i] === 0) free.push(i);
    const total = choose(free.length, needed);
    const pick: number[] = [];
    const rec = (start: number): void => {
      if (pick.length === needed) {
        for (let d = 0; d < needed; d++) {
          const card = pool[pick[d]];
          heroHand[2 + cc + d] = card;
          for (let o = 0; o < N; o++) oppHands[o][2 + cc + d] = card;
        }
        leaf(w / total);
        return;
      }
      for (let i = start; i < free.length; i++) {
        pick.push(free[i]);
        rec(i + 1);
        pick.pop();
      }
    };
    rec(0);
  }

  // No renormalization here: a seat's proposal does not know what the seats
  // before it took, so the branch keeps its raw proposal mass. Branches that
  // collide are simply not walked, that is the rejection, and what is left
  // sums to the acceptance probability rather than to 1.
  function dealSeat(o: number, w: number): void {
    if (o === N) {
      completeBoard(w);
      return;
    }
    for (let k = 0; k < allCombos.length; k++) {
      const [i, j] = allCombos[k];
      if (used[i] !== 0 || used[j] !== 0) continue;
      const p = mass[o][k];
      if (p === 0) continue;
      used[i] = 1;
      used[j] = 1;
      oppHands[o][0] = pool[i];
      oppHands[o][1] = pool[j];
      dealSeat(o + 1, w * p);
      used[i] = 0;
      used[j] = 0;
    }
  }

  dealSeat(0, 1);

  // One division, at the end, by the mass that survived: conditioning on
  // disjointness after the fact is exactly what the sampler's retry loop does.
  const z = out.pWin + out.pTie + out.pLoss;
  out.accept = z;
  out.pWin /= z;
  out.pTie /= z;
  out.pLoss /= z;
  out.equity /= z;
  for (let o = 0; o < N; o++) out.perOpponent[o] /= z;
  return out;
}

/** Wilson bracket, the same interval the module reports. */
function bracketsWilson(mc: MultiwayEquity, exact: number): boolean {
  return mc.ciWin.lo <= exact && exact <= mc.ciWin.hi;
}

/** Mirrors the module's retry bound; not exported, so restated here. */
const MAX_TUPLE_ATTEMPTS = 256;

/**
 * Chance the sampler exhausts its retries and falls back to a uniform deal on a
 * given sim. The enumeration does not model the fallback, so every fixture
 * compared against it has to make this small enough to be invisible.
 */
function fallbackRate(exact: Exact): number {
  return (1 - exact.accept) ** MAX_TUPLE_ATTEMPTS;
}

// ---- Deterministic showdowns ----------------------------------------------

describe("multiway — a settled board is arithmetic, not sampling", () => {
  it("agrees exactly with a direct showdown when the pool forces both hands", () => {
    // A two-card pool leaves the lone opponent no choice, so with the board
    // already out every simulation replays the same showdown.
    const hero = codes("Ah", "Ad");
    const board = codes("Ks", "7c", "4d", "9h", "2s");
    const pool = codes("Kh", "Kd");
    const r = runOverPool(
      hero, board, pool, readRanges([UNIFORM], hero, board), 500, 7
    );

    const heroScore = scoreInts(Uint8Array.from([...hero, ...board]), 7);
    const oppScore = scoreInts(Uint8Array.from([...pool, ...board]), 7);
    expect(oppScore).toBeGreaterThan(heroScore); // trip kings over aces up

    expect(r.wins).toBe(0);
    expect(r.ties).toBe(0);
    expect(r.losses).toBe(500);
    expect(r.equity).toBe(0);
    expect(r.perOpponent[1]).toBe(0);
  });

  it("splits a three-way chop into exactly a third of the pot", () => {
    // Broadway on the board, blanks all round: nothing in anyone's hand can
    // beat A-K-Q-J-T, and no flush or full house is reachable.
    const hero = codes("2c", "3d");
    const board = codes("As", "Ks", "Qd", "Jh", "Tc");
    const r = runOverPool(
      hero,
      board,
      codes("4c", "4d", "5h", "5s"),
      readRanges([UNIFORM, UNIFORM], hero, board),
      500,
      11
    );
    expect(r.pTie).toBe(1);
    expect(r.pWin).toBe(0);
    expect(r.pLoss).toBe(0);
    // The distinction the module exists for: certain to tie, worth a third.
    expect(r.equity).toBeCloseTo(1 / 3, 12);
    expect(r.perOpponent).toEqual({ 1: 0.5, 2: 0.5 });
  });

  it("reports 1 for the nuts and 0 when every opponent has it beat", () => {
    const royalHero = codes("As", "Ks");
    const royalBoard = codes("Qs", "Js", "Ts", "2d", "3c"); // hero has a royal
    const nuts = runOverPool(
      royalHero,
      royalBoard,
      codes("4h", "5h", "6c", "7d"),
      readRanges([UNIFORM, UNIFORM], royalHero, royalBoard),
      400,
      3
    );
    expect(nuts.equity).toBe(1);
    expect(nuts.pWin).toBe(1);
    expect(nuts.perOpponent).toEqual({ 1: 1, 2: 1 });

    // Four tens in the pool, so both opponents complete the broadway straight
    // whatever the split, and the hero's ace-high never gets there.
    const deadHero = codes("2c", "3d");
    const deadBoard = codes("Ah", "Kd", "Qs", "Jc", "9h");
    const dead = runOverPool(
      deadHero,
      deadBoard,
      codes("Th", "Ts", "Td", "Tc"),
      readRanges([UNIFORM, UNIFORM], deadHero, deadBoard),
      400,
      5
    );
    expect(dead.equity).toBe(0);
    expect(dead.pLoss).toBe(1);
    expect(dead.perOpponent).toEqual({ 1: 0, 2: 0 });
  });
});

// ---- Monte Carlo against exhaustive enumeration ----------------------------

describe("multiway — matches exhaustive enumeration", () => {
  it("one opponent on the turn, over the whole remaining deck", () => {
    const hero = codes("Ah", "Kd");
    const board = codes("Qs", "Jc", "7h", "3d");
    const pool = Array.from(remainingPool(hero, board));
    expect(pool).toHaveLength(46);

    // 1035 combos x 44 rivers, every branch weighted by its exact probability.
    const ranges = readRanges([INITIAL_BELIEF], hero, board);
    const exact = enumerateMultiway(hero, board, pool, ranges);
    const mc = runOverPool(hero, board, pool, ranges, 200_000, 0xe1);

    // One seat can never collide with itself, so every proposal is accepted
    // and the retry loop is dead code on this path.
    expect(exact.accept).toBeCloseTo(1, 10);
    expect(bracketsWilson(mc, exact.pWin)).toBe(true);
    expect(Math.abs(mc.equity - exact.equity)).toBeLessThan(0.005);
    expect(Math.abs(mc.pTie - exact.pTie)).toBeLessThan(0.005);
    expect(Math.abs(mc.perOpponent[1] - exact.perOpponent[0])).toBeLessThan(0.005);
  });

  const SMALL_HERO = codes("Ah", "Kd");
  const SMALL_POOL = codes(
    "As", "Ad", "Ks", "Kh", "Qh", "Jd", "Th", "9s", "8c", "7s", "6d", "5h"
  );

  it("two opponents on a settled board", () => {
    const board = codes("Qs", "Jc", "7h", "3d", "2c");
    const ranges = readRanges([UNIFORM, UNIFORM], SMALL_HERO, board);
    const exact = enumerateMultiway(SMALL_HERO, board, SMALL_POOL, ranges);
    const mc = runOverPool(SMALL_HERO, board, SMALL_POOL, ranges, 200_000, 0xe2);

    expect(fallbackRate(exact)).toBeLessThan(1e-30);
    expect(bracketsWilson(mc, exact.pWin)).toBe(true);
    expect(Math.abs(mc.equity - exact.equity)).toBeLessThan(0.005);
    for (let o = 0; o < 2; o++) {
      expect(Math.abs(mc.perOpponent[o + 1] - exact.perOpponent[o])).toBeLessThan(0.005);
    }
  });

  it("two opponents with a river to come", () => {
    const board = codes("Qs", "Jc", "7h", "3d");
    const ranges = readRanges([UNIFORM, UNIFORM], SMALL_HERO, board);
    const exact = enumerateMultiway(SMALL_HERO, board, SMALL_POOL, ranges);
    const mc = runOverPool(SMALL_HERO, board, SMALL_POOL, ranges, 200_000, 0xe3);

    expect(fallbackRate(exact)).toBeLessThan(1e-30);
    expect(bracketsWilson(mc, exact.pWin)).toBe(true);
    expect(Math.abs(mc.equity - exact.equity)).toBeLessThan(0.005);
    for (let o = 0; o < 2; o++) {
      expect(Math.abs(mc.perOpponent[o + 1] - exact.perOpponent[o])).toBeLessThan(0.005);
    }
  });

  it("three opponents, with asymmetric reads", () => {
    // Different beliefs per seat, so an implementation that shared one belief
    // across the field would land outside the interval.
    const board = codes("Qs", "Jc", "7h", "3d", "2c");
    const beliefs: BeliefDistribution[] = [
      { weak: 0.6, medium: 0.3, strong: 0.1 },
      UNIFORM,
      { weak: 0.15, medium: 0.35, strong: 0.5 },
    ];
    const ranges = readRanges(beliefs, SMALL_HERO, board);
    const exact = enumerateMultiway(SMALL_HERO, board, SMALL_POOL, ranges);
    const mc = runOverPool(SMALL_HERO, board, SMALL_POOL, ranges, 200_000, 0xe4);

    // Three seats over a twelve-card pool is the tightest fixture here, and it
    // still leaves 256 consecutive rejections far below anything observable.
    expect(fallbackRate(exact)).toBeLessThan(1e-30);
    expect(bracketsWilson(mc, exact.pWin)).toBe(true);
    expect(Math.abs(mc.equity - exact.equity)).toBeLessThan(0.006);
    for (let o = 0; o < 3; o++) {
      expect(Math.abs(mc.perOpponent[o + 1] - exact.perOpponent[o])).toBeLessThan(0.006);
    }
    // The reads really do separate the seats: the loose one is easiest to beat.
    expect(exact.perOpponent[0]).toBeGreaterThan(exact.perOpponent[2]);
  });
});

// ---- Invariants -----------------------------------------------------------

describe("multiway — invariants", () => {
  const req = (n: number, sims = 20_000): EquityRequest => ({
    heroHole: codes("Qs", "Qd"),
    board: codes("Jh", "7c", "2d"),
    opponents: seats(n),
    beliefs: sameBelief(n, INITIAL_BELIEF),
    simulations: sims,
    seed: 0x9a,
  });

  it("counts add up and the probabilities sum to one", () => {
    for (const n of [1, 2, 4, 6]) {
      const r = runMultiway(req(n));
      expect(r.simulations).toBe(20_000);
      expect(r.wins + r.ties + r.losses).toBe(20_000);
      expect(r.pWin + r.pTie + r.pLoss).toBeCloseTo(1, 12);
    }
  });

  it("puts equity between pWin and pWin + pTie", () => {
    for (const n of [1, 2, 4, 6]) {
      const r = runMultiway(req(n));
      expect(r.equity).toBeGreaterThanOrEqual(r.pWin);
      expect(r.equity).toBeLessThanOrEqual(r.pWin + r.pTie);
      // A chop is worth at most half a pot, so the upper half is unreachable.
      expect(r.equity).toBeLessThanOrEqual(r.pWin + r.pTie / 2 + 1e-12);
      expect(r.pTie).toBeGreaterThan(0); // this spot really does chop sometimes
      expect(r.equity).toBeGreaterThan(r.pWin);
    }
  });

  it("is a pure function of its inputs and its seed", () => {
    for (const n of [1, 3, 5]) {
      expect(runMultiway(req(n, 4000))).toEqual(runMultiway(req(n, 4000)));
    }
    const a = runMultiway({ ...req(3, 4000), seed: 1 });
    const b = runMultiway({ ...req(3, 4000), seed: 2 });
    expect(a.wins).not.toBe(b.wins);
  });

  it("keys perOpponent by seat id, not by position", () => {
    const r = runMultiway({ ...req(3, 4000), opponents: [4, 0, 9] });
    expect(Object.keys(r.perOpponent).map(Number).sort((x, y) => x - y)).toEqual([0, 4, 9]);
    for (const v of Object.values(r.perOpponent)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gives a seat with no recorded read a flat prior rather than dropping it", () => {
    const withRead = runMultiway({ ...req(2, 8000), beliefs: sameBelief(2, UNIFORM) });
    const noRead = runMultiway({ ...req(2, 8000), beliefs: {} });
    expect(noRead).toEqual(withRead);
    expect(rangesFor({ ...req(2), beliefs: {} })).toEqual(
      rangesFor({ ...req(2), beliefs: sameBelief(2, UNIFORM) })
    );
  });

  it("prefers an explicit range to the belief for the same seat", () => {
    // The migration in one assertion: a seat carries a weight per combo, and
    // the three-tier read is only consulted when nothing better was supplied.
    const base = req(1, 8000);
    const pinned = emptyRange();
    pinned[comboIndex(code("Ah"), code("Ad"))] = 1;

    const viaRange = runMultiway({ ...base, ranges: { 1: pinned } });
    // Aces on J-7-2 against pocket queens: the opponent has exactly one hand,
    // and it is the one that beats the hero every time.
    expect(viaRange.equity).toBeLessThan(0.2);
    expect(viaRange.equity).not.toBeCloseTo(runMultiway(base).equity, 2);
  });

  it("zeroes the hero's cards and the board out of a range it is handed", () => {
    // A caller that forgot card removal must not be able to deal the hero's own
    // ace to an opponent, the request's board and hole cards win.
    const base = req(1);
    const flat = new Float64Array(COMBO_COUNT).fill(1) as Range;
    const dead = [...base.heroHole, ...base.board];
    for (const range of rangesFor({ ...base, ranges: { 1: flat } })) {
      let live = 0;
      for (let c = 0; c < COMBO_COUNT; c++) {
        const clash =
          dead.includes(comboCardA(c)) || dead.includes(comboCardB(c));
        if (clash) expect(range[c]).toBe(0);
        else live += range[c];
      }
      // C(52 - 5, 2) = 1081 combos survive, each still weighted 1.
      expect(live).toBe(1081);
    }
    // ...and the caller's own array is untouched: the copy is not optional.
    expect(flat.every((w) => w === 1)).toBe(true);
  });

  it("refuses a deck too small to deal the hands it was asked for", () => {
    const hero = codes("Ah", "Kd");
    const board = codes("Qs", "Jc", "7h", "3d");
    expect(() =>
      runOverPool(hero, board, codes("2c", "3c", "4c"), readRanges([UNIFORM, UNIFORM], hero, board), 10, 1)
    ).toThrow(/cannot deal/);
  });

  it("merges shard counts by addition, in any order, to the same total", () => {
    const parts: MultiwayCounts[] = [0, 1, 2].map((i) => ({
      sims: 100 + i,
      wins: 10 + i,
      ties: 4 + i,
      losses: 86 - 2 * i,
      tieBySize: [0, 0, 3 + i, 1],
      h2hWins: [20 + i, 30 + i],
      h2hTies: [2, 3],
    }));
    const merged = mergeMultiwayCounts(parts, 2);
    expect(merged).toEqual(mergeMultiwayCounts([...parts].reverse(), 2));
    expect(merged.sims).toBe(303);
    expect(merged.tieBySize).toEqual([0, 0, 12, 3]);
    expect(merged.h2hWins).toEqual([63, 93]);
    expect(merged.h2hTies).toEqual([6, 9]);

    // 12 two-way chops at a half pot and 3 three-way at a third.
    const eq = finalizeMultiway(merged, [7, 8]);
    expect(eq.equity).toBeCloseTo((33 + 12 / 2 + 3 / 3) / 303, 12);
    expect(eq.perOpponent).toEqual({ 7: (63 + 3) / 303, 8: (93 + 4.5) / 303 });
  });

  it("reports nothing rather than dividing by zero on an empty run", () => {
    const eq = finalizeMultiway(mergeMultiwayCounts([], 2), [1, 2]);
    expect(eq.simulations).toBe(0);
    expect(eq.equity).toBe(0);
    expect(eq.perOpponent).toEqual({ 1: 0, 2: 0 });
  });
});

// ---- Equivalence with the heads-up sampler ---------------------------------

describe("multiway — one opponent is the heads-up sampler", () => {
  /**
   * WHAT CHANGED HERE, AND WHY.
   *
   * This assertion used to be exact, `multi.wins === headsUp.wins`, count for
   * count. It could be, because both kernels drew a seat's hand the same way:
   * one `rng.next()` for a tier, one `rng.int()` for a combo inside it. The
   * range sampler spends a single `rng.next()` on an alias-table draw instead,
   * so the two consume the streams differently and every later draw in the sim
   * is offset. The identity is gone and cannot be recovered; keeping it would
   * mean keeping the preflop tier bucketing this migration exists to remove.
   *
   * What survives is the claim the identity was standing in for: hand the new
   * sampler the *distribution* the old one drew from, `tierProxyRange`, the
   * old law written out, and it estimates the same quantity. Measured over the
   * four streets below at 200k sims, |pWin_multi − pWin_headsup| came out
   * 0.0013 / 0.0004 / 0.0014 / 0.0000, against an SE-of-difference of ~0.0014.
   * Three of the four land inside one SE; the bound is 4.
   *
   * The structural half of the old test is unweakened: with one opponent the
   * field result and the head-to-head are the same question, and every tie is a
   * two-way chop. Those are exact and stay exact.
   */
  it("estimates what `runBeliefCounts` estimates, on every street", () => {
    for (const boardSize of [0, 3, 4, 5]) {
      const seed = 0x5a1a + boardSize;
      const deck = makeRng(seed).shuffle(makeDeck());
      const hole = encodeCards(deck.slice(0, 2));
      const community = encodeCards(deck.slice(2, 2 + boardSize));
      const poolCards = removeCards(makeDeck(), deck.slice(0, 2 + boardSize));
      const pool = encodeCards(poolCards);

      const sims = 200_000;
      const headsUp = runBeliefCountsFromCodes(
        hole, community, pool, INITIAL_BELIEF, sims, makeRng(seed)
      );
      const multi = runMultiwayCountsFromCodes(
        hole,
        community,
        pool,
        [tierProxyRange(Array.from(pool), INITIAL_BELIEF)],
        sims,
        makeRng(seed)
      );

      // Two independent estimates of one probability: SE of the difference is
      // sqrt(2 p (1-p) / sims), at most 0.0016 here.
      const p = headsUp.wins / sims;
      const se = Math.sqrt((2 * p * (1 - p)) / sims);
      expect(Math.abs(multi.wins / sims - p)).toBeLessThan(4 * se);
      expect(Math.abs((multi.ties - headsUp.ties) / sims)).toBeLessThan(0.01);
      expect(multi.wins + multi.ties + multi.losses).toBe(sims);

      // With one opponent the field result and the head-to-head are the same
      // question, so these must be the same numbers, exactly.
      expect(multi.h2hWins[0]).toBe(multi.wins);
      expect(multi.h2hTies[0]).toBe(multi.ties);
      // Every tie is heads-up, hence a two-way chop.
      expect(multi.tieBySize[2]).toBe(multi.ties);
    }
  });

  it("collapses equity onto pWin + pTie/2 with a single opponent", () => {
    const r = runMultiway({
      heroHole: codes("Ah", "Kh"),
      board: [],
      opponents: [1],
      beliefs: sameBelief(1, INITIAL_BELIEF),
      simulations: 20_000,
      seed: 0x2b,
    });
    expect(r.equity).toBeCloseTo(r.pWin + r.pTie / 2, 12);
    expect(r.equity).toBeCloseTo(r.perOpponent[1], 12);
  });
});

// ---- The field effect ------------------------------------------------------

describe("multiway — the field effect", () => {
  /**
   * The property the module exists for. `perOpponent` says the hero is a heavy
   * favourite over every single opponent; `equity` says the hero is an underdog
   * to the pot. Both are true, and only the second one is what the chips do -
   * which is why a bot that reasoned pairwise would call off its stack here.
   */
  it("a hand that beats every opponent alone can still lose to the field", () => {
    const base = {
      heroHole: codes("Qs", "Qd"),
      board: [] as number[],
      simulations: 60_000,
      seed: 0x1234,
    };

    const headsUp = runMultiway({ ...base, opponents: [1], beliefs: sameBelief(1, UNIFORM) });
    const field = runMultiway({ ...base, opponents: seats(3), beliefs: sameBelief(3, UNIFORM) });

    const per = seats(3).map((id) => field.perOpponent[id]);
    // Queens are a big favourite against each of the three, one at a time.
    for (const p of per) expect(p).toBeGreaterThan(0.70);
    // And an underdog to all three at once.
    expect(field.equity).toBeLessThan(0.5);
    expect(field.pWin).toBeLessThan(0.5);
    // The gap is the whole point, and it is enormous: ~30 points of equity.
    expect(Math.min(...per) - field.equity).toBeGreaterThan(0.25);

    // The head-to-head number itself does not move; only the field does.
    expect(Math.min(...per)).toBeGreaterThan(headsUp.equity - 0.02);
    expect(field.equity).toBeLessThan(headsUp.equity - 0.25);
  });

  it("holds on a real board too, and decays monotonically with the field", () => {
    // Middle pair on K-7-2: ahead of any one opponent, behind three of them.
    const base = {
      heroHole: codes("8s", "8d"),
      board: codes("Kc", "7h", "2d"),
      simulations: 40_000,
      seed: 0x77,
    };
    const equities = [1, 2, 3, 4].map((n) => {
      const r = runMultiway({
        ...base,
        opponents: seats(n),
        beliefs: sameBelief(n, INITIAL_BELIEF),
      });
      return {
        n,
        equity: r.equity,
        minPer: Math.min(...seats(n).map((id) => r.perOpponent[id])),
      };
    });

    for (const e of equities) expect(e.minPer).toBeGreaterThan(0.5);
    for (let i = 1; i < equities.length; i++) {
      expect(equities[i].equity).toBeLessThan(equities[i - 1].equity);
    }
    expect(equities[0].equity).toBeGreaterThan(0.5); // fine heads-up
    expect(equities[2].equity).toBeLessThan(0.35); // hopeless four-handed
  });
});

// ---- Exchangeability -------------------------------------------------------

describe("multiway — dealing is symmetric in seat order", () => {
  /**
   * Identical reads must produce identical seats, to within sampling noise.
   *
   * This replaces a test that pinned the opposite. Dealing seat by seat and
   * redrawing only the seat that collided conditioned each seat on the ones
   * before it: early seats took strong cards more often, later seats drew from
   * a pool already stripped of them, and `perOpponent` came out monotone in
   * seat order, measured at 400k sims, a spread of 0.0037 / 0.0108 / 0.0184
   * at 2 / 4 / 6 opponents, i.e. 5 / 16 / 27 SE. It was a real number in the
   * analysis UI that meant nothing but the order the array happened to be in.
   *
   * Whole-tuple rejection samples `Π p(hᵢ)` conditioned on disjointness, which
   * is invariant under permuting the seats, so the only spread left is noise.
   * The bounds below are stated in SE because that is the only scale on which
   * "gone" means anything; both are far under what the old sampler produced and
   * far over what this one does.
   */
  it("leaves identical opponents within sampling noise of each other", () => {
    const sims = 400_000;

    // The max-minus-min of n estimates is a range statistic, so its null
    // distribution widens with n even under perfect exchangeability (E[range]
    // of n standard normals: 1.13, 2.06, 2.53 at n = 2, 4, 6). These bounds are
    // ~2.5x that, and every one of them is below what the old sampler produced.
    const rangeBound: Record<number, number> = { 2: 3, 4: 5.5, 6: 6.5 };

    for (const n of [2, 4, 6]) {
      const r = runMultiway({
        heroHole: codes("Qs", "Qd"),
        board: [],
        opponents: seats(n),
        beliefs: sameBelief(n, UNIFORM),
        simulations: sims,
        seed: 0xd21f,
      });
      const per = seats(n).map((id) => r.perOpponent[id]);
      const p = per.reduce((s, x) => s + x, 0) / n;
      const se = Math.sqrt((p * (1 - p)) / sims); // ~0.00068 at p ≈ 0.75

      expect(Math.max(...per) - Math.min(...per)).toBeLessThan(
        rangeBound[n] * se
      );

      // And specifically the direction the old sampler leaned: the last seat
      // dealt was systematically the weakest, by 5 / 15 / 25 SE. Now the sign
      // is a coin flip and the size is noise.
      expect(Math.abs(per[n - 1] - per[0])).toBeLessThan(3 * se);
    }
  });

  /**
   * The same claim without a sampling argument: relabel the seats and the
   * numbers follow the labels, rather than the positions keeping their values.
   */
  it("moves a seat's number with the seat when the reads are permuted", () => {
    const loose: BeliefDistribution = { weak: 0.7, medium: 0.2, strong: 0.1 };
    const tight: BeliefDistribution = { weak: 0.1, medium: 0.2, strong: 0.7 };
    const base = {
      heroHole: codes("Qs", "Qd"),
      board: [] as number[],
      opponents: seats(3),
      simulations: 200_000,
      seed: 0x51e,
    };

    const forward = runMultiway({
      ...base,
      beliefs: { 1: loose, 2: UNIFORM, 3: tight },
    });
    const reversed = runMultiway({
      ...base,
      beliefs: { 1: tight, 2: UNIFORM, 3: loose },
    });

    // The reads really are distinguishable, or the test below proves nothing.
    expect(forward.perOpponent[1] - forward.perOpponent[3]).toBeGreaterThan(0.1);

    // Two independent runs, so ~1.4 SE of noise on each difference; 5 SE is
    // ~0.0035, which is a tenth of the gap the reads themselves create.
    const se = 5 * Math.sqrt(0.25 / base.simulations);
    expect(Math.abs(forward.perOpponent[1] - reversed.perOpponent[3])).toBeLessThan(se);
    expect(Math.abs(forward.perOpponent[3] - reversed.perOpponent[1])).toBeLessThan(se);
    expect(Math.abs(forward.perOpponent[2] - reversed.perOpponent[2])).toBeLessThan(se);
    // Permuting the field cannot change "beat everyone" either.
    expect(Math.abs(forward.equity - reversed.equity)).toBeLessThan(se);
  });
});

// ---- The defect the migration removed ---------------------------------------

describe("multiway — the sampler classifies against the board, not the deal", () => {
  /**
   * WHAT THIS SECTION IS FOR.
   *
   * The kernel used to bucket the pool with `bayesian.tierOf`, a preflop Chen
   * score, and draw uniformly inside the chosen tier. Every equity number the
   * bot acted on was built on that classifier, and the classifier is wrong the
   * moment there is a board: 7-2 on K-7-2-9-4 is two pair and it called it
   * trash; aces on 5-6-7-8-9 are playing the board and it called them a monster.
   *
   * `tierProxyRange` above is that old law, written out, so both readings can be
   * measured on one scale, the numbers below are the old sampler's answer and
   * the new one's for the same read on the same board.
   */
  const TIGHT: BeliefDistribution = { weak: 0.1, medium: 0.2, strong: 0.7 };

  /** Share of a range's weight that sits on combos matching a card predicate. */
  function share(range: Range, pred: (a: number, b: number) => boolean): number {
    let total = 0;
    let hit = 0;
    for (let c = 0; c < COMBO_COUNT; c++) {
      const w = range[c];
      if (!(w > 0)) continue;
      total += w;
      if (pred(comboCardA(c), comboCardB(c))) hit += w;
    }
    return total > 0 ? hit / total : 0;
  }

  const rankOf = (c: number) => (c >> 2) + 2;
  const suitOf = (c: number) => c & 3;
  const isSevenDeuce = (a: number, b: number) => {
    const lo = Math.min(rankOf(a), rankOf(b));
    const hi = Math.max(rankOf(a), rankOf(b));
    return lo === 2 && hi === 7;
  };

  it("moves 7-2 on K-7-2-9-4 from the bottom of the range to the top", () => {
    const hero = codes("Ah", "Ac");
    const board = codes("Ks", "7h", "2d", "9c", "4s");
    const pool = Array.from(remainingPool(hero, board));

    const before = tierProxyRange(pool, TIGHT);
    const after = readRange(TIGHT, hero, board);

    // A tight read files 7-2 under "weak" preflop, so it is nearly excluded;
    // on this board it is two pair and the same read now favours it.
    expect(share(before, isSevenDeuce)).toBeLessThan(0.002);
    expect(share(after, isSevenDeuce)).toBeGreaterThan(0.03);
    expect(share(after, isSevenDeuce)).toBeGreaterThan(
      15 * share(before, isSevenDeuce)
    );

    // ...and the hero's number moves with it: aces are a huge favourite against
    // the preflop reading of this range and barely ahead of the real one.
    const base = { heroHole: hero, board, opponents: [1], simulations: 200_000, seed: 0xf1 };
    const eqBefore = finalizeMultiway(
      runMultiwayCountsFromCodes(
        Uint8Array.from(hero), Uint8Array.from(board), Uint8Array.from(pool),
        [before], base.simulations, makeRng(base.seed)
      ),
      [1]
    );
    const eqAfter = runMultiway({ ...base, ranges: { 1: after } });
    expect(eqBefore.equity).toBeGreaterThan(0.85);
    expect(eqAfter.equity).toBeLessThan(0.65);
  });

  it("stops calling aces a monster when the board is a straight", () => {
    const hero = codes("As", "Ad");
    const board = codes("5s", "6h", "7d", "8c", "9s");
    const pool = Array.from(remainingPool(hero, board));
    const hasTen = (a: number, b: number) => rankOf(a) === 10 || rankOf(b) === 10;

    const before = tierProxyRange(pool, TIGHT);
    const after = readRange(TIGHT, hero, board);

    // Everything but a ten (or better) is playing the board here, so the honest
    // reading of "strong" is "holds a ten" and the preflop one is "holds aces".
    expect(share(after, hasTen)).toBeGreaterThan(2 * share(before, hasTen));

    const eqBefore = finalizeMultiway(
      runMultiwayCountsFromCodes(
        Uint8Array.from(hero), Uint8Array.from(board), Uint8Array.from(pool),
        [before], 200_000, makeRng(0xf2)
      ),
      [1]
    );
    const eqAfter = runMultiway({
      heroHole: hero, board, opponents: [1], ranges: { 1: after },
      simulations: 200_000, seed: 0xf2,
    });
    // The hero never wins outright either way, the best hand available is the
    // board, but how often the chop is taken away moves a long way.
    expect(eqBefore.pWin).toBe(0);
    expect(eqAfter.pWin).toBe(0);
    expect(eqAfter.equity).toBeLessThan(eqBefore.equity - 0.15);
  });

  it("makes a blocked combo impossible, and says where that stops", () => {
    // Three hearts out, and the hero holds the ace of one suit or another. The
    // only difference between the two runs is which ace, so any difference in
    // the answer is the blocker.
    const board = codes("Kh", "7h", "2h", "9c", "4s");
    const twoHearts = (a: number, b: number) => suitOf(a) === 1 && suitOf(b) === 1;
    const nutFlush = (a: number, b: number) =>
      twoHearts(a, b) && (rankOf(a) === 14 || rankOf(b) === 14);

    const measure = (heroCards: string[]) => {
      const hero = codes(...heroCards);
      const range = readRange(TIGHT, hero, board);
      const equity = runMultiway({
        heroHole: hero, board, opponents: [1], ranges: { 1: range },
        simulations: 400_000, seed: 0xf3,
      });
      return {
        flush: share(range, twoHearts),
        nut: share(range, nutFlush),
        equity: equity.equity,
        se: equity.se,
      };
    };

    const blocking = measure(["Ah", "9s"]);
    const not = measure(["Ad", "9s"]);

    // The nut flush is not merely unlikely, it is impossible, and card removal
    // does it, with no blocker rule anywhere in the model.
    expect(blocking.nut).toBe(0);
    expect(not.nut).toBeGreaterThan(0.04);
    // Which thins the flush combos the opponent can hold at all.
    expect(blocking.flush).toBeLessThan(not.flush - 0.03);

    // AND YET THE EQUITY BARELY MOVES, 0.25062 against 0.25059, a fortieth of
    // one SE. That is not a bug here, it is the ceiling on what a three-tier
    // read can express, and it is worth pinning rather than glossing:
    // `beliefRange` sets each tier's TOTAL weight to `belief[tier]`, so deleting
    // the nut flush hands its mass straight back to the other strong combos and
    // P(opponent is strong) never changes. A blocker only reaches the number
    // when the weights are built per combo and never renormalised per tier,
    // which is what `decider.opponentRanges` does, see its own blocker test,
    // where the same spot moves 0.1417 to 0.1509, about 16 SE.
    expect(Math.abs(blocking.equity - not.equity)).toBeLessThan(0.1 * not.se);
  });
});
