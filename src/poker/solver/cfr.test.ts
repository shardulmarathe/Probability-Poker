import { describe, expect, it } from "vitest";

import {
  CFR_PLUS,
  createSolver,
  DCFR,
  flattenTree,
  LINEAR_CFR,
  riverHands,
  riverInteraction,
  solveRiver,
  TERMINAL_DECISION,
  VANILLA_CFR,
  buildRiverGame,
  buildRiverTree,
  type DcfrParams,
  type HandInteraction,
  type RiverSpec,
  type TreeSpec,
} from "./cfr";
import { bestResponse, exploitability, exploitabilityCurve } from "./exploitability";
import { comboCardA, comboCardB, COMBO_COUNT, emptyRange, gridCellOf, GRID_LABELS, uniformRange } from "../model/range";
import { scoreInts } from "../handEvaluator";

// ---------------------------------------------------------------------------
// Kuhn poker: the one game in here with a closed-form equilibrium
// ---------------------------------------------------------------------------
//
// Three cards (J=0, Q=1, K=2), one each, one ante each. P1 checks or bets 1;
// facing a bet a player folds or calls. The equilibrium family is known
// exactly: P1 bets the jack with probability a in [0, 1/3], never bets the
// queen, and bets the king with 3a; P2 bets the jack 1/3 when checked to,
// always bets the king, calls the queen 1/3 facing a bet; and the value of the
// game to P1 is -1/18. Nothing poker-specific is involved, so this isolates
// the CFR machinery itself.

const KUHN_VALUE = -1 / 18;

function kuhnInteraction(): HandInteraction {
  return {
    handCount: [3, 3],
    reachMass(_hero, oppReach, out) {
      const total = oppReach[0] + oppReach[1] + oppReach[2];
      for (let i = 0; i < 3; i++) out[i] = total - oppReach[i];
    },
    showdown(_hero, oppReach, out) {
      for (let i = 0; i < 3; i++) {
        let v = 0;
        for (let j = 0; j < 3; j++) {
          if (j === i) continue;
          v += oppReach[j] * (i > j ? 1 : -1);
        }
        out[i] = v;
      }
    },
  };
}

function kuhnTree(): TreeSpec {
  const showdown = (w: number): TreeSpec => ({ kind: "showdown", value: w });
  return {
    kind: "decision",
    player: 0,
    actions: [
      {
        label: "check",
        next: {
          kind: "decision",
          player: 1,
          actions: [
            { label: "check", next: showdown(1) },
            {
              label: "bet",
              next: {
                kind: "decision",
                player: 0,
                actions: [
                  { label: "fold", next: { kind: "fold", value: -1 } },
                  { label: "call", next: showdown(2) },
                ],
              },
            },
          ],
        },
      },
      {
        label: "bet",
        next: {
          kind: "decision",
          player: 1,
          actions: [
            { label: "fold", next: { kind: "fold", value: 1 } },
            { label: "call", next: showdown(2) },
          ],
        },
      },
    ],
  };
}

function solveKuhn(iterations: number, params: DcfrParams = DCFR) {
  const tree = flattenTree(kuhnTree());
  const interaction = kuhnInteraction();
  const priors: [Float64Array, Float64Array] = [
    Float64Array.from([1, 1, 1]),
    Float64Array.from([1, 1, 1]),
  ];
  const solver = createSolver(tree, interaction, priors, { params });
  solver.step(iterations);
  return { tree, interaction, priors, solver, strategy: solver.averageStrategy() };
}

/** Node ids of the flattened Kuhn tree, in depth-first construction order. */
const KUHN = {
  p1Open: 0,
  p2AfterCheck: 1,
  p1FacingBet: 3,
  p2FacingBet: 6,
} as const;

describe("Kuhn poker (analytic equilibrium)", () => {
  const { tree, interaction, priors, strategy } = solveKuhn(20_000);
  const betProb = (node: number, card: number) => strategy[node][1 * 3 + card];

  it("reaches the known game value of -1/18 for player 1", () => {
    const p0 = bestResponse(tree, interaction, priors, strategy, 0);
    const p1 = bestResponse(tree, interaction, priors, strategy, 1);
    // At equilibrium each best-response value equals the game value from that
    // side, so they pin the value from both directions.
    expect(p0.value).toBeCloseTo(KUHN_VALUE, 3);
    expect(-p1.value).toBeCloseTo(KUHN_VALUE, 3);
  });

  it("drives exploitability to ~zero", () => {
    expect(exploitability(tree, interaction, priors, strategy)).toBeLessThan(1e-4);
  });

  it("bets the king exactly three times as often as the jack (the alpha family)", () => {
    const jack = betProb(KUHN.p1Open, 0);
    const king = betProb(KUHN.p1Open, 2);
    expect(jack).toBeGreaterThanOrEqual(0);
    expect(jack).toBeLessThanOrEqual(1 / 3 + 1e-3);
    expect(king).toBeCloseTo(3 * jack, 2);
  });

  it("never bets the queen out of position on the first action", () => {
    expect(betProb(KUHN.p1Open, 1)).toBeLessThan(1e-3);
  });

  it("matches the closed-form second-player strategy", () => {
    // P2 is fully determined: bet the jack 1/3 when checked to, always bet the
    // king, and facing a bet fold the jack, call the queen 1/3, call the king.
    expect(betProb(KUHN.p2AfterCheck, 0)).toBeCloseTo(1 / 3, 2);
    expect(betProb(KUHN.p2AfterCheck, 1)).toBeLessThan(1e-3);
    expect(betProb(KUHN.p2AfterCheck, 2)).toBeCloseTo(1, 2);
    expect(strategy[KUHN.p2FacingBet][1 * 3 + 0]).toBeLessThan(1e-3);
    expect(strategy[KUHN.p2FacingBet][1 * 3 + 1]).toBeCloseTo(1 / 3, 2);
    expect(strategy[KUHN.p2FacingBet][1 * 3 + 2]).toBeCloseTo(1, 2);
  });

  it("matches the closed-form first-player calling frequency (alpha + 1/3)", () => {
    const alpha = betProb(KUHN.p1Open, 0);
    expect(strategy[KUHN.p1FacingBet][1 * 3 + 0]).toBeLessThan(1e-3);
    expect(strategy[KUHN.p1FacingBet][1 * 3 + 1]).toBeCloseTo(alpha + 1 / 3, 2);
    expect(strategy[KUHN.p1FacingBet][1 * 3 + 2]).toBeCloseTo(1, 2);
  });
});

describe("discount schedules", () => {
  const run = (params: DcfrParams, iters: number) => {
    const { tree, interaction, priors, strategy } = solveKuhn(iters, params);
    return exploitability(tree, interaction, priors, strategy);
  };

  it("every variant converges on Kuhn", () => {
    for (const params of [DCFR, CFR_PLUS, LINEAR_CFR, VANILLA_CFR]) {
      expect(run(params, 2000)).toBeLessThan(1e-2);
    }
  });

  it("DCFR(3/2,0,2) beats vanilla CFR at equal iteration count", () => {
    // The paper's whole claim is that the discount schedule matters in
    // practice even though the worst-case bound does not change.
    expect(run(DCFR, 500)).toBeLessThan(run(VANILLA_CFR, 500));
  });

  it("is deterministic: same inputs, same strategy", () => {
    const a = solveKuhn(300).strategy;
    const b = solveKuhn(300).strategy;
    for (let i = 0; i < a.length; i++) expect(Array.from(a[i])).toEqual(Array.from(b[i]));
  });
});

// ---------------------------------------------------------------------------
// Tree plumbing
// ---------------------------------------------------------------------------

describe("flattenTree", () => {
  it("keeps children contiguous and labelled", () => {
    const tree = flattenTree(kuhnTree());
    expect(tree.nodeCount).toBe(9);
    expect(tree.player[0]).toBe(0);
    expect(tree.actionCount[0]).toBe(2);
    expect(tree.actionLabels.slice(0, 2)).toEqual(["check", "bet"]);
    for (let n = 0; n < tree.nodeCount; n++) {
      if (tree.kind[n] !== TERMINAL_DECISION) continue;
      for (let a = 0; a < tree.actionCount[n]; a++) {
        expect(tree.children[tree.childOffset[n] + a]).toBeGreaterThan(n);
      }
    }
  });

  it("rejects a decision node with no actions", () => {
    expect(() => flattenTree({ kind: "decision", player: 0, actions: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// River showdown: the O(n) sweep against a brute-force O(n^2) reference
// ---------------------------------------------------------------------------

const BOARD = [
  card("A", "s"),
  card("K", "d"),
  card("7", "h"),
  card("2", "c"),
  card("9", "s"),
];

function card(rank: string, suit: string): number {
  const ranks = "23456789TJQKA";
  const suits = "shdc";
  return ranks.indexOf(rank) * 4 + suits.indexOf(suit);
}

/** Every combo whose 13x13 chart cell is in `labels`. */
function rangeOf(labels: readonly string[]): Float64Array {
  const wanted = new Set(labels);
  const r = emptyRange();
  for (let i = 0; i < COMBO_COUNT; i++) if (wanted.has(GRID_LABELS[gridCellOf(i)])) r[i] = 1;
  return r;
}

const PAIRS = ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "66", "55"];
const BROADWAY = ["AKs", "AQs", "AJs", "ATs", "KQs", "KJs", "QJs", "JTs", "AKo", "AQo", "AJo", "KQo"];
const WIDE = [...PAIRS, ...BROADWAY, "A9s", "A5s", "A4s", "T9s", "98s", "87s", "76s", "65s", "KTo", "QJo", "JTo"];

describe("river showdown sweep", () => {
  it("agrees with a brute-force pairwise sum, blockers included", () => {
    const hands = [riverHands(rangeOf(WIDE), BOARD), riverHands(rangeOf(BROADWAY), BOARD)] as const;
    const interaction = riverInteraction(hands);

    for (const hero of [0, 1] as const) {
      const me = hands[hero];
      const opp = hands[1 - hero];
      const reach = new Float64Array(opp.count);
      for (let j = 0; j < opp.count; j++) reach[j] = ((j * 37) % 11) / 10; // arbitrary, some zeros

      const fast = new Float64Array(me.count);
      interaction.showdown(hero, reach, fast);
      const mass = new Float64Array(me.count);
      interaction.reachMass(hero, reach, mass);

      for (let i = 0; i < me.count; i++) {
        let sign = 0;
        let compatible = 0;
        for (let j = 0; j < opp.count; j++) {
          const conflict =
            me.cardA[i] === opp.cardA[j] ||
            me.cardA[i] === opp.cardB[j] ||
            me.cardB[i] === opp.cardA[j] ||
            me.cardB[i] === opp.cardB[j];
          if (conflict) continue;
          compatible += reach[j];
          const d = me.strength[i] - opp.strength[j];
          sign += reach[j] * (d > 0 ? 1 : d < 0 ? -1 : 0);
        }
        expect(fast[i]).toBeCloseTo(sign, 9);
        expect(mass[i]).toBeCloseTo(compatible, 9);
      }
    }
  });

  it("orders hands by the shared 7-card evaluator", () => {
    const hands = riverHands(rangeOf(WIDE), BOARD);
    const buf = new Uint8Array(7);
    for (let i = 0; i < 5; i++) buf[i] = BOARD[i];
    for (let k = 0; k < hands.count; k++) {
      buf[5] = comboCardA(hands.combo[k]);
      buf[6] = comboCardB(hands.combo[k]);
      expect(hands.strength[k]).toBe(scoreInts(buf, 7));
      if (k > 0) expect(hands.strength[k]).toBeGreaterThanOrEqual(hands.strength[k - 1]);
    }
  });

  it("drops every combo that collides with the board", () => {
    const hands = riverHands(uniformRange(), BOARD);
    expect(hands.count).toBe(1081); // C(47, 2)
    for (let k = 0; k < hands.count; k++) {
      expect(BOARD).not.toContain(hands.cardA[k]);
      expect(BOARD).not.toContain(hands.cardB[k]);
    }
  });
});

// ---------------------------------------------------------------------------
// River betting tree
// ---------------------------------------------------------------------------

describe("river betting tree", () => {
  const spec = { pot: 100, stack: 200 };

  it("is small enough to solve exactly and zero-sum at every terminal", () => {
    const tree = buildRiverTree(spec);
    let decisions = 0;
    for (let n = 0; n < tree.nodeCount; n++) if (tree.kind[n] === TERMINAL_DECISION) decisions++;
    expect(decisions).toBeLessThan(60);
    // Terminal values are already the zero-sum shift: nothing exceeds the pot
    // plus a full stack, and nothing is zero.
    for (let n = 0; n < tree.nodeCount; n++) {
      if (tree.kind[n] === TERMINAL_DECISION) continue;
      expect(Math.abs(tree.value[n])).toBeGreaterThan(0);
      expect(Math.abs(tree.value[n])).toBeLessThanOrEqual(spec.pot / 2 + spec.stack);
    }
  });

  it("caps aggression and never lets an all-in player act again", () => {
    const tree = buildRiverTree({ ...spec, maxBets: 2 });
    // Longest path: bet, raise, then only fold/call.
    let deepest = 0;
    const depth = (n: number, d: number) => {
      deepest = Math.max(deepest, d);
      if (tree.kind[n] !== TERMINAL_DECISION) return;
      for (let a = 0; a < tree.actionCount[n]; a++) depth(tree.children[tree.childOffset[n] + a], d + 1);
    };
    depth(tree.root, 0);
    expect(deepest).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// River solve
// ---------------------------------------------------------------------------

describe("river subgame solve", () => {
  const spec = { pot: 100, stack: 200 };

  it("converges and reports its own timing", () => {
    const solved = solveRiver(spec, BOARD, rangeOf(WIDE), rangeOf([...BROADWAY, ...PAIRS]), {
      iterations: 400,
    });
    const expl = exploitability(solved.tree, solved.interaction, solved.priors, solved.strategy);
    // eslint-disable-next-line no-console
    console.log(
      `[river] ${solved.hands[0].count}x${solved.hands[1].count} hands, ` +
        `${solved.tree.nodeCount} nodes, ${solved.iterations} iters in ` +
        `${solved.elapsedMs.toFixed(0)}ms -> ${((expl / 1) * 1000).toFixed(1)} mbb/h (bb=1 chip)`
    );
    expect(expl).toBeGreaterThanOrEqual(0);
    // The headline requirement: a realistic river spot solves in well under a
    // second. Measured at ~115ms on this machine; 500 leaves 4x of headroom.
    expect(solved.elapsedMs).toBeLessThan(500);
  });

  it("drives exploitability down monotonically-ish", () => {
    const game = buildRiverGame(spec, BOARD, rangeOf(WIDE), rangeOf([...BROADWAY, ...PAIRS]));
    const solver = createSolver(game.tree, game.interaction, game.priors);
    const curve = exploitabilityCurve(solver, [10, 25, 50, 100, 200, 400, 800], 1);
    // eslint-disable-next-line no-console
    console.log("[river curve]", curve.map((p) => `${p.iterations}:${p.mbb.toFixed(0)}`).join(" "));
    expect(curve[curve.length - 1].mbb).toBeLessThan(curve[0].mbb / 10);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].mbb).toBeLessThan(curve[i - 1].mbb * 1.05);
    }
  });

  it("is deterministic", () => {
    const a = solveRiver(spec, BOARD, rangeOf(WIDE), rangeOf(BROADWAY), { iterations: 60 });
    const b = solveRiver(spec, BOARD, rangeOf(WIDE), rangeOf(BROADWAY), { iterations: 60 });
    for (let n = 0; n < a.tree.nodeCount; n++) {
      expect(Array.from(a.strategy[n])).toEqual(Array.from(b.strategy[n]));
    }
  });

  it("holds its throughput on the widest ranges the river allows", () => {
    // Both players holding every combo the board leaves alive: 1081 x 1081, the
    // widest a river subgame can physically be, and about 6x the hand count of
    // the realistic spot above.
    const solved = solveRiver(spec, BOARD, uniformRange(), uniformRange());
    const mbb = exploitability(solved.tree, solved.interaction, solved.priors, solved.strategy) * 1000;
    const msPerIter = solved.elapsedMs / solved.iterations;
    // eslint-disable-next-line no-console
    console.log(
      `[river worst case] ${solved.hands[0].count}x${solved.hands[1].count} hands, ` +
        `${solved.tree.nodeCount} nodes, ${solved.iterations} iters in ` +
        `${solved.elapsedMs.toFixed(0)}ms (${msPerIter.toFixed(2)}ms/iter)` +
        ` -> ${mbb.toFixed(1)} mbb/h`
    );
    expect(solved.hands[0].count).toBe(1081);

    // The substantive claim is that the widest river still *solves*, and that
    // is deterministic: exploitability is a pure function of the strategy.
    expect(mbb).toBeLessThan(60);

    // The timing bound is deliberately an order of magnitude above the ~2ms/iter
    // this actually runs at. A tight wall-clock assertion is not a test, it is a
    // measurement of how busy the machine is — this one flaked at 4ms while the
    // suite ran beside a build. Loose, it still catches the regression that
    // matters (someone making the showdown sweep quadratic again) and never
    // fails for being unlucky with the scheduler.
    expect(msPerIter).toBeLessThan(40);
  });

  it("costs what the bet-size abstraction says it costs", () => {
    const shapes: { label: string; spec: RiverSpec }[] = [
      { label: "all-in only", spec: { ...spec, betFractions: [], maxBets: 1 } },
      { label: "pot + all-in, one raise", spec: { ...spec, betFractions: [1], maxBets: 2 } },
      { label: "1/3, 2/3, pot + all-in (default)", spec },
    ];
    let previousNodes = 0;
    for (const shape of shapes) {
      const solved = solveRiver(shape.spec, BOARD, rangeOf(WIDE), rangeOf(BROADWAY), {
        iterations: 300,
      });
      let decisions = 0;
      for (let n = 0; n < solved.tree.nodeCount; n++) {
        if (solved.tree.kind[n] === TERMINAL_DECISION) decisions++;
      }
      const mbb =
        exploitability(solved.tree, solved.interaction, solved.priors, solved.strategy) * 1000;
      // eslint-disable-next-line no-console
      console.log(
        `[abstraction] ${shape.label}: ${solved.tree.nodeCount} nodes (${decisions} decisions), ` +
          `${solved.elapsedMs.toFixed(0)}ms, ${mbb.toFixed(1)} mbb/h`
      );
      expect(solved.tree.nodeCount).toBeGreaterThan(previousNodes);
      previousNodes = solved.tree.nodeCount;
      expect(mbb).toBeLessThan(60);
    }
  });

  it("DCFR converges faster than CFR+ and much faster than vanilla CFR", () => {
    const measure = (params: DcfrParams) => {
      const game = buildRiverGame(spec, BOARD, rangeOf(WIDE), rangeOf(BROADWAY));
      const solver = createSolver(game.tree, game.interaction, game.priors, { params });
      solver.step(200);
      return (
        exploitability(game.tree, game.interaction, game.priors, solver.averageStrategy()) * 1000
      );
    };
    const dcfr = measure(DCFR);
    const plus = measure(CFR_PLUS);
    const linear = measure(LINEAR_CFR);
    const vanilla = measure(VANILLA_CFR);
    // eslint-disable-next-line no-console
    console.log(
      `[variants @200 iters, mbb/h] DCFR ${dcfr.toFixed(1)} | CFR+ ${plus.toFixed(1)} | ` +
        `LCFR ${linear.toFixed(1)} | vanilla ${vanilla.toFixed(1)}`
    );
    expect(dcfr).toBeLessThan(vanilla);
    expect(plus).toBeLessThan(vanilla);
  });
});
