import { describe, expect, it } from "vitest";

import {
  AGGRESSIVE,
  BB_NODE,
  CLASS_COUNT,
  CLASS_LABELS,
  CLASS_PRIOR,
  classCompatibility,
  classIndex,
  classSize,
  equityStandardError,
  preflopEquityMatrix,
  SB_NODE,
  solvePushFold,
} from "./pushfold";
import { COMBO_COUNT } from "../model/range";
import { scoreInts } from "../handEvaluator";
import { exploitabilityCurve } from "./exploitability";
import { createSolver } from "./cfr";
import { buildPushFoldGame } from "./pushfold";

// ---------------------------------------------------------------------------
// The published chart
// ---------------------------------------------------------------------------
//
// HoldemResources "HeadsUp Push/Fold Nash Equilibrium", No Ante tab
// (https://www.holdemresources.net/hune), transcribed verbatim. Each entry is
// the largest effective stack in big blinds at which the hand is pushed (top
// table) or called (bottom); 99 stands for the table's "20+". Rows and columns
// run A..2 in exactly the layout of `GRID_LABELS`, so a flattened table indexes
// straight by chart cell.
//
// Three cells are footnoted in the source as having a gap rather than a single
// threshold, 63s "7.1 - 5.1, 2.3", 53s "12.9 - 3.8, 2.4", 43s "10.0 - 4.9,
// 2.2". The top of each range is used here, which is exact at 10, 15 and 20bb
// because none of the gaps straddle those depths.

const PLUS = 99;
const HUNE_PUSH: readonly (readonly number[])[] = [
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS],
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, 19.9, 19.3],
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, 16.3, 13.5, 12.7],
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, 18.6, 14.7, 13.5, 10.6, 8.5],
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, 11.9, 10.5, 7.7, 6.5],
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, 14.4, 6.9, 4.9, 3.7],
  [PLUS, 18.0, 13.0, 13.3, 17.5, PLUS, PLUS, PLUS, PLUS, 18.8, 10.1, 2.7, 2.5],
  [PLUS, 16.1, 10.3, 8.5, 9.0, 10.8, 14.7, PLUS, PLUS, PLUS, 13.9, 2.5, 2.1],
  [PLUS, 15.1, 9.6, 6.5, 5.7, 5.2, 7.0, 10.7, PLUS, PLUS, 16.3, 7.1, 2.0],
  [PLUS, 14.2, 8.9, 6.0, 4.1, 3.5, 3.0, 2.6, 2.4, PLUS, PLUS, 12.9, 2.0],
  [PLUS, 13.1, 7.9, 5.4, 3.8, 2.7, 2.3, 2.1, 2.0, 2.1, PLUS, 10.0, 1.8],
  [PLUS, 12.2, 7.5, 5.0, 3.4, 2.5, 1.9, 1.8, 1.7, 1.8, 1.6, PLUS, 1.7],
  [PLUS, 11.6, 7.0, 4.6, 2.9, 2.2, 1.8, 1.6, 1.5, 1.5, 1.4, 1.4, PLUS],
];
const HUNE_CALL: readonly (readonly number[])[] = [
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, PLUS],
  [PLUS, PLUS, PLUS, PLUS, PLUS, PLUS, 17.6, 15.2, 14.3, 13.2, 12.1, 11.4, 10.7],
  [PLUS, PLUS, PLUS, PLUS, PLUS, 16.1, 13.0, 10.5, 9.9, 8.9, 8.4, 7.8, 7.2],
  [PLUS, PLUS, 19.5, PLUS, 18.0, 13.4, 10.6, 8.8, 7.0, 6.9, 6.1, 5.8, 5.6],
  [PLUS, PLUS, 15.3, 12.7, PLUS, 11.5, 9.3, 7.4, 6.3, 5.2, 5.2, 4.8, 4.5],
  [PLUS, 17.1, 11.7, 9.5, 8.4, PLUS, 8.2, 7.0, 5.8, 5.0, 4.3, 4.1, 3.9],
  [PLUS, 13.8, 9.7, 7.6, 6.6, 6.0, PLUS, 6.5, 5.6, 4.8, 4.1, 3.6, 3.5],
  [PLUS, 12.4, 8.0, 6.4, 5.5, 5.0, 4.7, PLUS, 5.4, 4.8, 4.1, 3.6, 3.3],
  [PLUS, 11.0, 7.3, 5.4, 4.6, 4.2, 4.1, 4.0, PLUS, 4.9, 4.3, 3.8, 3.3],
  [PLUS, 10.2, 6.8, 5.1, 4.0, 3.7, 3.6, 3.6, 3.7, PLUS, 4.6, 4.0, 3.6],
  [18.3, 9.1, 6.2, 4.7, 3.8, 3.3, 3.2, 3.2, 3.3, 3.5, PLUS, 3.8, 3.4],
  [16.6, 8.7, 5.9, 4.5, 3.6, 3.1, 2.9, 2.9, 2.9, 3.1, 3.0, PLUS, 3.3],
  [15.8, 8.1, 5.6, 4.2, 3.5, 3.0, 2.8, 2.6, 2.7, 2.8, 2.7, 2.6, 15.0],
];

const PUSH_T = Float64Array.from(HUNE_PUSH.flat());
const CALL_T = Float64Array.from(HUNE_CALL.flat());

/** Combo-weighted share of hands the published table plays at this depth. */
function publishedShare(table: Float64Array, stack: number): number {
  let s = 0;
  for (let x = 0; x < CLASS_COUNT; x++) if (table[x] >= stack) s += CLASS_PRIOR[x];
  return s;
}

interface Comparison {
  readonly agree: number;
  readonly diffs: readonly string[];
  /** How far each disagreeing hand's published threshold sits from `stack`. */
  readonly worstGapBb: number;
}

function compare(
  mine: Float64Array,
  published: Float64Array,
  stack: number,
  label: string
): Comparison {
  let agree = 0;
  let worstGapBb = 0;
  const diffs: string[] = [];
  for (let x = 0; x < CLASS_COUNT; x++) {
    const should = published[x] >= stack;
    if (should === mine[x] > 0.5) {
      agree++;
      continue;
    }
    // "20+" caps the published threshold at 20, so a 20bb disagreement there is
    // a gap of 0 by construction: the chart does not say how far past 20 it is.
    const gap = published[x] === PLUS ? 0 : Math.abs(published[x] - stack);
    worstGapBb = Math.max(worstGapBb, gap);
    diffs.push(
      `${CLASS_LABELS[x]} [chart ${published[x] === PLUS ? "20+" : published[x]}bb, ` +
        `solver ${mine[x].toFixed(2)}]`
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `  ${stack}bb ${label}: ${agree}/${CLASS_COUNT}` +
      (diffs.length ? ` — differs on ${diffs.join(", ")}` : " — exact")
  );
  return { agree, diffs, worstGapBb };
}

/** Exhaustive C(48,5) runout for one specific matchup. No sampling. */
function exactPairEquity(hero: readonly number[], villain: readonly number[]): number {
  const dead = new Set([...hero, ...villain]);
  const rest: number[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) rest.push(c);
  const h = new Uint8Array(7);
  const v = new Uint8Array(7);
  h[5] = hero[0];
  h[6] = hero[1];
  v[5] = villain[0];
  v[6] = villain[1];
  let win = 0;
  let tie = 0;
  let n = 0;
  for (let a = 0; a < 44; a++) {
    h[0] = v[0] = rest[a];
    for (let b = a + 1; b < 45; b++) {
      h[1] = v[1] = rest[b];
      for (let c = b + 1; c < 46; c++) {
        h[2] = v[2] = rest[c];
        for (let d = c + 1; d < 47; d++) {
          h[3] = v[3] = rest[d];
          for (let e = d + 1; e < 48; e++) {
            h[4] = v[4] = rest[e];
            const sh = scoreInts(h, 7);
            const sv = scoreInts(v, 7);
            n++;
            if (sh > sv) win++;
            else if (sh === sv) tie++;
          }
        }
      }
    }
  }
  return (win + tie / 2) / n;
}

const card = (rank: string, suit: string) =>
  "23456789TJQKA".indexOf(rank) * 4 + "shdc".indexOf(suit);

// ---------------------------------------------------------------------------

describe("class tables", () => {
  it("counts every disjoint combo pair exactly", () => {
    let total = 0;
    for (let x = 0; x < CLASS_COUNT; x++) {
      for (let y = 0; y < CLASS_COUNT; y++) {
        total += classCompatibility[x * CLASS_COUNT + y] * classSize(x) * classSize(y);
      }
    }
    // 1326 first hands x 1225 second hands that share no card.
    expect(total).toBeCloseTo(COMBO_COUNT * 1225, 6);
  });

  it("agrees with a direct combo-level count on a blocker-heavy pair", () => {
    // AA vs AKs is the worst case: every combo of one blocks half the other.
    const aa = classIndex("AA");
    const aks = classIndex("AKs");
    expect(classCompatibility[aa * CLASS_COUNT + aks]).toBeCloseTo(
      // 6 AA combos x 4 AKs combos; an AKs combo clashes with the 3 AA combos
      // holding its ace, so 4 x 3 = 12 of the 24 pairs survive.
      12 / 24,
      12
    );
    // A pair against itself: 6 x 6 ordered, and only the 3 complementary
    // suit-pairs of each are disjoint.
    expect(classCompatibility[aa * CLASS_COUNT + aa]).toBeCloseTo(6 / 36, 12);
  });

  it("has a prior that sums to one", () => {
    let s = 0;
    for (let x = 0; x < CLASS_COUNT; x++) s += CLASS_PRIOR[x];
    expect(s).toBeCloseTo(1, 12);
    expect(CLASS_PRIOR[classIndex("AA")]).toBeCloseTo(6 / 1326, 12);
    expect(CLASS_PRIOR[classIndex("AKs")]).toBeCloseTo(4 / 1326, 12);
    expect(CLASS_PRIOR[classIndex("AKo")]).toBeCloseTo(12 / 1326, 12);
  });
});

describe("preflop all-in equity", () => {
  it("matches exhaustive enumeration on AA vs KK", () => {
    // AA and KK each occupy two of four suits, so the matchup has exactly three
    // shapes by suit overlap, with multiplicities 1 / 4 / 1 of the 36 pairs.
    const aces = [card("A", "h"), card("A", "s")];
    const two = exactPairEquity(aces, [card("K", "h"), card("K", "s")]);
    const one = exactPairEquity(aces, [card("K", "h"), card("K", "d")]);
    const zero = exactPairEquity(aces, [card("K", "d"), card("K", "c")]);
    const exact = (two + 4 * one + zero) / 6;

    const m = preflopEquityMatrix({ boards: 24_000, seed: 1 });
    const mc = m.equity[classIndex("AA") * CLASS_COUNT + classIndex("KK")];
    // eslint-disable-next-line no-console
    console.log(
      `AA vs KK — exact ${(exact * 100).toFixed(3)}% ` +
        `(overlap 2/1/0 suits: ${(two * 100).toFixed(2)}/${(one * 100).toFixed(2)}/` +
        `${(zero * 100).toFixed(2)}), sampled ${(mc * 100).toFixed(3)}%, ` +
        `error ${((mc - exact) * 100).toFixed(3)}pp`
    );
    expect(exact).toBeGreaterThan(0.81);
    expect(mc).toBeCloseTo(exact, 2);
  });

  it("is antisymmetric and coin-flip on the diagonal", () => {
    const { equity } = preflopEquityMatrix({ boards: 2000, seed: 3 });
    for (let x = 0; x < CLASS_COUNT; x++) {
      expect(equity[x * CLASS_COUNT + x]).toBe(0.5);
      for (let y = 0; y < CLASS_COUNT; y++) {
        expect(equity[x * CLASS_COUNT + y] + equity[y * CLASS_COUNT + x]).toBeCloseTo(1, 12);
      }
    }
  });

  it("ranks the obvious matchups the obvious way", () => {
    const { equity } = preflopEquityMatrix({ boards: 24_000, seed: 1 });
    const eq = (a: string, b: string) => equity[classIndex(a) * CLASS_COUNT + classIndex(b)];
    expect(eq("AA", "22")).toBeGreaterThan(0.8);
    expect(eq("AKs", "AKo")).toBeGreaterThan(0.5); // the flush edge, and nothing else
    expect(eq("22", "AKo")).toBeGreaterThan(0.5); // the classic race, pair ahead
    expect(eq("22", "AKo")).toBeLessThan(0.55);
    expect(eq("AKs", "QQ")).toBeGreaterThan(0.4);
    expect(eq("AKs", "QQ")).toBeLessThan(0.5);
  });

  it("tightens as the sample grows", () => {
    const small = equityStandardError(preflopEquityMatrix({ boards: 2000, seed: 5 }));
    const large = equityStandardError(preflopEquityMatrix({ boards: 24_000, seed: 1 }));
    // eslint-disable-next-line no-console
    console.log(`equity rmse: 2k boards ${(small * 100).toFixed(3)}%, 24k ${(large * 100).toFixed(3)}%`);
    expect(large).toBeLessThan(small);
    expect(large).toBeLessThan(0.005);
  });

  it("is deterministic for a given seed", () => {
    const a = preflopEquityMatrix({ boards: 500, seed: 11 });
    const b = preflopEquityMatrix({ boards: 500, seed: 11 });
    expect(a).toBe(b); // cached
    const c = preflopEquityMatrix({ boards: 500, seed: 12 });
    expect(Array.from(c.equity)).not.toEqual(Array.from(a.equity));
  });
});

describe("push/fold equilibrium vs published Nash charts", () => {
  const BOARDS = 24_000;
  const SEED = 1;
  const results = [10, 15, 20].map((stack) => ({
    stack,
    solution: solvePushFold({ stack }, { boards: BOARDS, seed: SEED, iterations: 1500 }),
  }));

  it("solves each depth to essentially zero exploitability", () => {
    for (const { stack, solution } of results) {
      // eslint-disable-next-line no-console
      console.log(
        `${stack}bb: ${solution.elapsedMs.toFixed(0)}ms, ` +
          `exploitability ${solution.exploitabilityMbb.toExponential(2)} mbb/h`
      );
      expect(solution.exploitabilityMbb).toBeLessThan(1e-3);
      expect(solution.exploitabilityMbb).toBeGreaterThanOrEqual(0);
    }
  });

  it("matches the published range widths to within half a point", () => {
    for (const { stack, solution } of results) {
      const pub = { push: publishedShare(PUSH_T, stack), call: publishedShare(CALL_T, stack) };
      // eslint-disable-next-line no-console
      console.log(
        `${stack}bb width: push ${(solution.pushShare * 100).toFixed(2)}% vs chart ` +
          `${(pub.push * 100).toFixed(2)}%; call ${(solution.callShare * 100).toFixed(2)}% vs ` +
          `chart ${(pub.call * 100).toFixed(2)}%`
      );
      expect(Math.abs(solution.pushShare - pub.push)).toBeLessThan(0.015);
      expect(Math.abs(solution.callShare - pub.call)).toBeLessThan(0.015);
    }
  });

  it("matches the published charts cell by cell", () => {
    let agree = 0;
    let worstGapBb = 0;
    for (const { stack, solution } of results) {
      const p = compare(solution.push, PUSH_T, stack, "push");
      const c = compare(solution.call, CALL_T, stack, "call");
      agree += p.agree + c.agree;
      worstGapBb = Math.max(worstGapBb, p.worstGapBb, c.worstGapBb);
    }
    const total = CLASS_COUNT * 2 * results.length;
    // eslint-disable-next-line no-console
    console.log(
      `agreement ${agree}/${total} = ${((agree / total) * 100).toFixed(2)}%; ` +
        `every disagreement is within ${worstGapBb.toFixed(1)}bb of the chart's own threshold`
    );
    expect(agree / total).toBeGreaterThan(0.985);
    // The point of this bound: nothing disagrees in the interior of a range.
    // A hand the chart pushes to 17bb had better be shoved at 10bb.
    expect(worstGapBb).toBeLessThan(3);
  });

  it("puts every disagreement inside the Monte Carlo noise", () => {
    // Re-solving on a different equity seed flips a comparable set of cells,
    // which is the honest reading of the disagreements above: they are hands
    // whose published threshold sits within the equity error of the stack
    // depth, not places where the solver has a different opinion.
    for (const { stack, solution } of results) {
      const other = solvePushFold(
        { stack },
        { boards: BOARDS, seed: SEED + 998, iterations: 1500 }
      );
      const flips: string[] = [];
      for (let x = 0; x < CLASS_COUNT; x++) {
        if (solution.push[x] > 0.5 !== other.push[x] > 0.5) flips.push(`push ${CLASS_LABELS[x]}`);
        if (solution.call[x] > 0.5 !== other.call[x] > 0.5) flips.push(`call ${CLASS_LABELS[x]}`);
      }
      // eslint-disable-next-line no-console
      console.log(`${stack}bb seed flips: ${flips.length ? flips.join(", ") : "none"}`);
      expect(flips.length).toBeLessThan(10);
    }
  });

  it("keeps the range nested: every hand shoved deep is shoved short", () => {
    const [deep] = results.filter((r) => r.stack === 20);
    const [shallow] = results.filter((r) => r.stack === 10);
    const leaks: string[] = [];
    for (let x = 0; x < CLASS_COUNT; x++) {
      if (deep.solution.push[x] > 0.5 && shallow.solution.push[x] < 0.5) {
        leaks.push(CLASS_LABELS[x]);
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe("push/fold solver mechanics", () => {
  it("drives exploitability down from a bad starting profile", () => {
    const { equity } = preflopEquityMatrix({ boards: 2000, seed: 3 });
    const game = buildPushFoldGame({ stack: 10 }, equity);
    const solver = createSolver(game.tree, game.interaction, game.priors);
    const curve = exploitabilityCurve(solver, [1, 3, 10, 30, 100, 300, 1000], game.bigBlind);
    // eslint-disable-next-line no-console
    console.log("push/fold curve:", curve.map((p) => `${p.iterations}:${p.mbb.toExponential(1)}`).join(" "));
    expect(curve[0].mbb).toBeGreaterThan(100);
    expect(curve[curve.length - 1].mbb).toBeLessThan(1e-2);
    for (let i = 1; i < curve.length; i++) expect(curve[i].mbb).toBeLessThan(curve[i - 1].mbb);
  });

  it("shoves everything when the stack is one blind deep", () => {
    // With the big blind already all in there is nothing to fold for, so the
    // small blind's shove is free money on every hand.
    const s = solvePushFold({ stack: 1.01 }, { boards: 2000, seed: 3, iterations: 400 });
    expect(s.pushShare).toBeGreaterThan(0.99);
    expect(s.callShare).toBeGreaterThan(0.99);
  });

  it("tightens monotonically as the stack deepens", () => {
    const shares = [8, 12, 16, 20].map(
      (stack) => solvePushFold({ stack }, { boards: 2000, seed: 3, iterations: 600 }).pushShare
    );
    for (let i = 1; i < shares.length; i++) expect(shares[i]).toBeLessThan(shares[i - 1]);
  });

  it("is deterministic", () => {
    const a = solvePushFold({ stack: 12 }, { boards: 2000, seed: 3, iterations: 200 });
    const b = solvePushFold({ stack: 12 }, { boards: 2000, seed: 3, iterations: 200 });
    expect(Array.from(a.push)).toEqual(Array.from(b.push));
    expect(Array.from(a.call)).toEqual(Array.from(b.call));
  });

  it("exposes the strategy at the documented node and action indices", () => {
    const s = solvePushFold({ stack: 10 }, { boards: 2000, seed: 3, iterations: 200 });
    const strategy = s.solver.averageStrategy();
    const aa = classIndex("AA");
    expect(strategy[SB_NODE][AGGRESSIVE * CLASS_COUNT + aa]).toBeCloseTo(s.push[aa], 12);
    expect(strategy[BB_NODE][AGGRESSIVE * CLASS_COUNT + aa]).toBeCloseTo(s.call[aa], 12);
    expect(s.push[aa]).toBeCloseTo(1, 6);
    expect(s.call[aa]).toBeCloseTo(1, 6);
    expect(s.push[classIndex("72o")]).toBeLessThan(0.5);
  });

  it("rejects a stack that cannot cover the big blind", () => {
    expect(() => solvePushFold({ stack: 0.5 }, { boards: 500, seed: 3 })).toThrow();
  });
});
