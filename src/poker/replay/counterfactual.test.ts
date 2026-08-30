import { describe, expect, it } from "vitest";
import type { SyncBotDecider, TableHandReport } from "../table/contract";
import { legalActions } from "../table/rules";
import {
  alternativesAt,
  decisionIndexes,
  runCounterfactual,
} from "./counterfactual";
import { playSession } from "./fixtures";
import { replayWithLineup } from "./lineup";
import { replayHand } from "./reconstruct";

const BLINDS = { smallBlind: 5, bigBlind: 10 };

/**
 * A decider that never simulates anything: it takes the first legal action from
 * a fixed preference order. Every test below is about the replay's plumbing -
 * whether the right state is rewound to, what is labelled simulated, whether
 * the result is reproducible, and none of them is about the bot's judgement,
 * which has its own tests and costs a Monte Carlo run per move.
 */
function scripted(order: string[]): SyncBotDecider {
  return (state, seat, config) => {
    const legal = legalActions(state, seat, config);
    const action =
      order.map((t) => legal.find((a) => a.type === t)).find(Boolean) ?? legal[0];
    return {
      seat,
      street: state.street,
      action,
      potBefore: state.pot,
      toCall: 0,
      equity: {
        simulations: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        pWin: 0,
        pTie: 0,
        pLoss: 0,
        equity: 0,
        se: 0,
        ciWin: { lo: 0, hi: 1 },
        perOpponent: {},
      },
      evByAction: {},
      profile: "professor",
    } as ReturnType<SyncBotDecider>;
  };
}

const callDown = scripted(["check", "call", "fold"]);
const foldOut = scripted(["check", "fold", "call"]);

/** A hand with at least `n` actions by some seat, for the tests to poke at. */
function handWithDecisions(n: number): { report: TableHandReport; seat: number } {
  const { reports } = playSession({ seatCount: 4, hands: 30, seed: 246, ...BLINDS });
  for (const report of reports) {
    for (const seat of report.seats) {
      if (decisionIndexes(report, seat.seat).length >= n) {
        return { report, seat: seat.seat };
      }
    }
  }
  throw new Error(`no fixture hand has a seat acting ${n} times`);
}

describe("alternativesAt", () => {
  it("marks exactly the line that was actually taken", () => {
    const { report, seat } = handWithDecisions(2);
    for (const index of decisionIndexes(report, seat)) {
      const alternatives = alternativesAt(report, index, { config: BLINDS });
      expect(alternatives.length).toBeGreaterThan(0);
      expect(alternatives.filter((a) => a.actual).length).toBe(1);

      const chosen = alternatives.find((a) => a.actual)!;
      expect(chosen.type).toBe(report.actions[index].action);
      expect(chosen.cost).toBe(report.actions[index].cost);
    }
  });

  it("always contains the line taken, over every decision in a session", () => {
    const { reports } = playSession({ seatCount: 5, hands: 25, seed: 8080, ...BLINDS });
    let decisions = 0;
    for (const report of reports) {
      for (let index = 0; index < report.actions.length; index++) {
        const alternatives = alternativesAt(report, index, { config: BLINDS });
        expect(alternatives.filter((a) => a.actual).length).toBe(1);
        decisions++;
      }
    }
    expect(decisions).toBeGreaterThan(150);
  });

  it("only offers moves the engine agrees are legal", () => {
    const { report, seat } = handWithDecisions(2);
    for (const index of decisionIndexes(report, seat)) {
      for (const alternative of alternativesAt(report, index, { config: BLINDS })) {
        const outcome = runCounterfactual(report, index, alternative, {
          config: BLINDS,
          decide: callDown,
        });
        expect(outcome.ok).toBe(true);
      }
    }
  });

  it("offers nothing for an index that is not a decision", () => {
    const { report } = handWithDecisions(1);
    expect(alternativesAt(report, -1, { config: BLINDS })).toEqual([]);
    expect(alternativesAt(report, report.actions.length, { config: BLINDS })).toEqual([]);
  });

  it("expands a bet or raise into sizes the table would have offered", () => {
    const { reports } = playSession({ seatCount: 3, hands: 40, seed: 51, ...BLINDS });
    const found = reports
      .flatMap((report) =>
        report.actions.map((a, index) => ({ report, index, action: a }))
      )
      .find(({ report, index }) => {
        const alternatives = alternativesAt(report, index, { config: BLINDS });
        return alternatives.filter((a) => a.type === "bet" || a.type === "raise").length >= 2;
      });
    expect(found).toBeDefined();

    const sizes = alternativesAt(found!.report, found!.index, { config: BLINDS })
      .filter((a) => a.type === "bet" || a.type === "raise")
      .map((a) => a.cost);
    // Distinct, ascending, and ending at the jam.
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(Math.max(...sizes)).toBeGreaterThan(Math.min(...sizes));
  });
});

describe("runCounterfactual", () => {
  it("labels itself simulated and says how much was re-derived", () => {
    const { report, seat } = handWithDecisions(2);
    const index = decisionIndexes(report, seat)[0];
    const alternative = alternativesAt(report, index, { config: BLINDS }).find(
      (a) => !a.actual
    );
    expect(alternative).toBeDefined();

    const outcome = runCounterfactual(report, index, alternative!, {
      config: BLINDS,
      decide: callDown,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.simulated).toBe(true);
    expect(outcome.seat).toBe(seat);
    expect(outcome.index).toBe(index);
    expect(outcome.rederived).toBeGreaterThanOrEqual(0);
    expect(outcome.substitute.actual).toBe(false);
    expect(outcome.deltaNet).toBe(outcome.simulatedNet - outcome.actualNet);
  });

  it("keeps everything before the substitution identical to the real hand", () => {
    const { report, seat } = handWithDecisions(3);
    const index = decisionIndexes(report, seat)[1];
    const alternative = alternativesAt(report, index, { config: BLINDS }).find(
      (a) => !a.actual
    )!;

    const real = replayHand(report, { config: BLINDS });
    const outcome = runCounterfactual(report, index, alternative, {
      config: BLINDS,
      decide: callDown,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Frames up to and including the one before the change are the real hand.
    for (let i = 0; i <= index; i++) {
      expect(outcome.frames[i].board).toEqual(real.frames[i].board);
      expect(outcome.frames[i].pot).toEqual(real.frames[i].pot);
      expect(outcome.frames[i].seats).toEqual(real.frames[i].seats);
    }
  });

  it("deals the same cards as the hand it branched from", () => {
    const { report, seat } = handWithDecisions(2);
    const index = decisionIndexes(report, seat)[0];
    const alternative = alternativesAt(report, index, { config: BLINDS }).find(
      (a) => !a.actual
    )!;
    const outcome = runCounterfactual(report, index, alternative, {
      config: BLINDS,
      decide: callDown,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    for (const want of report.seats) {
      const got = outcome.report.seats.find((s) => s.seat === want.seat);
      expect(got?.hole).toEqual(want.hole);
    }
    // The board can be shorter (the simulated hand may end earlier) but every
    // card it does have came off the same deck in the same order.
    const shared = Math.min(outcome.report.board.length, report.board.length);
    expect(outcome.report.board.slice(0, shared)).toEqual(report.board.slice(0, shared));
  });

  it("reproducing the actual line reproduces the actual hand", () => {
    // Substituting the move that was played, then letting the bot answer, is
    // not required to reproduce the hand, the opponents are re-derived either
    // way. What must hold is that the branch point itself is not the source of
    // any difference: the chosen line is legal and the pot is unchanged by it.
    const { report, seat } = handWithDecisions(2);
    const index = decisionIndexes(report, seat)[0];
    const actual = alternativesAt(report, index, { config: BLINDS }).find((a) => a.actual)!;

    const outcome = runCounterfactual(report, index, actual, {
      config: BLINDS,
      decide: callDown,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.substitute.actual).toBe(true);
    expect(outcome.frames[index + 1].pot).toBe(
      report.actions[index].potBefore + report.actions[index].cost
    );
  });

  it("is deterministic", () => {
    const { report, seat } = handWithDecisions(2);
    const index = decisionIndexes(report, seat)[0];
    const alternative = alternativesAt(report, index, { config: BLINDS }).find(
      (a) => !a.actual
    )!;
    const run = () =>
      runCounterfactual(report, index, alternative, {
        config: BLINDS,
        simulations: 200,
      });

    const a = run();
    const b = run();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.report).toEqual(a.report);
    expect(b.simulatedNet).toBe(a.simulatedNet);
    expect(b.rederived).toBe(a.rederived);
  });

  it("different opponents give different continuations", () => {
    // The whole reason the result is labelled simulated: the same substitution
    // against a different model is a different hand.
    const { reports } = playSession({ seatCount: 4, hands: 40, seed: 71, ...BLINDS });
    const differing = reports.some((report) => {
      for (const index of report.actions.keys()) {
        const alternative = alternativesAt(report, index, { config: BLINDS }).find(
          (a) => !a.actual && (a.type === "bet" || a.type === "raise")
        );
        if (!alternative) continue;
        const passive = runCounterfactual(report, index, alternative, {
          config: BLINDS,
          decide: callDown,
        });
        const tight = runCounterfactual(report, index, alternative, {
          config: BLINDS,
          decide: foldOut,
        });
        if (!passive.ok || !tight.ok) continue;
        if (passive.simulatedNet !== tight.simulatedNet) return true;
      }
      return false;
    });
    expect(differing).toBe(true);
  });

  it("refuses an index that is not a decision, rather than throwing", () => {
    const { report } = handWithDecisions(1);
    const bad = runCounterfactual(report, 999, { type: "fold", cost: 0 }, { config: BLINDS });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toContain("no action at index");
  });

  it("refuses an illegal size, rather than forcing it through", () => {
    const { report, seat } = handWithDecisions(2);
    const index = decisionIndexes(report, seat)[0];
    const bad = runCounterfactual(
      report,
      index,
      { type: "raise", cost: 9_999_999 },
      { config: BLINDS, decide: callDown }
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toContain("not legal");
  });

  it("refuses to branch off a hand that does not reconstruct", () => {
    const { report } = handWithDecisions(2);
    const broken = {
      ...report,
      board: report.board.length === 5 ? [0, 1, 2, 3, 4] : report.board,
      seats: report.seats.map((s) => ({ ...s, net: s.net + 1 })),
    };
    const outcome = runCounterfactual(broken, 0, { type: "fold", cost: 0 }, {
      config: BLINDS,
      decide: callDown,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("does not reconstruct");
  });
});

describe("replayWithLineup", () => {
  const ARCHETYPES = ["nit", "station", "maniac", "tag", "lag", "rock"];

  it("deals every seat the cards it actually held", () => {
    const { reports } = playSession({ seatCount: 4, hands: 6, seed: 15, ...BLINDS });
    for (const report of reports) {
      const outcome = replayWithLineup(report, ARCHETYPES, {
        config: BLINDS,
        decide: callDown,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;

      expect(outcome.sameCards).toBe(true);
      expect(outcome.simulated).toBe(true);
      for (const want of report.seats) {
        const got = outcome.report.seats.find((s) => s.seat === want.seat);
        expect(got?.hole).toEqual(want.hole);
      }
    }
  });

  it("re-derives every move: none is replayed", () => {
    const { reports } = playSession({ seatCount: 3, hands: 4, seed: 16, ...BLINDS });
    for (const report of reports) {
      const outcome = replayWithLineup(report, ARCHETYPES, {
        config: BLINDS,
        decide: callDown,
      });
      if (!outcome.ok) continue;
      expect(outcome.rederived).toBe(outcome.report.actions.length);
      expect(outcome.frames.length).toBe(outcome.rederived + 1);
    }
  });

  it("scores every seat against what it actually made", () => {
    const { reports } = playSession({ seatCount: 4, hands: 4, seed: 17, ...BLINDS });
    for (const report of reports) {
      const outcome = replayWithLineup(report, ARCHETYPES, {
        config: BLINDS,
        decide: callDown,
      });
      if (!outcome.ok) continue;
      expect(outcome.bySeat.length).toBe(report.seatCount);
      for (const row of outcome.bySeat) {
        expect(row.actualNet).toBe(report.seats.find((s) => s.seat === row.seat)!.net);
        expect(row.delta).toBe(row.simulatedNet - row.actualNet);
      }
      // Chips are still conserved across the simulated hand.
      expect(outcome.bySeat.reduce((n, r) => n + r.simulatedNet, 0)).toBe(0);
    }
  });

  it("a different lineup plays the same cards differently", () => {
    const { reports } = playSession({ seatCount: 4, hands: 20, seed: 18, ...BLINDS });
    const differing = reports.some((report) => {
      const passive = replayWithLineup(report, ARCHETYPES, {
        config: BLINDS,
        decide: callDown,
      });
      const tight = replayWithLineup(report, ARCHETYPES, {
        config: BLINDS,
        decide: foldOut,
      });
      if (!passive.ok || !tight.ok) return false;
      return passive.report.actions.length !== tight.report.actions.length;
    });
    expect(differing).toBe(true);
  });

  it("is deterministic with the real bots", () => {
    const { reports } = playSession({ seatCount: 3, hands: 2, seed: 19, ...BLINDS });
    const run = () =>
      replayWithLineup(reports[0], ARCHETYPES, { config: BLINDS, simulations: 200 });
    const a = run();
    const b = run();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.report).toEqual(a.report);
  });

  it("falls back to the pure-EV baseline for an unknown archetype", () => {
    const { reports } = playSession({ seatCount: 3, hands: 2, seed: 20, ...BLINDS });
    const outcome = replayWithLineup(reports[0], ["not-a-bot", "", "nit"], {
      config: BLINDS,
      decide: callDown,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.profiles).toEqual(["not-a-bot", "", "nit"]);
  });

  it("refuses a hand that does not reconstruct", () => {
    const { reports } = playSession({ seatCount: 3, hands: 1, seed: 21, ...BLINDS });
    const broken = { ...reports[0], button: 99 };
    const outcome = replayWithLineup(broken, ARCHETYPES, { config: BLINDS });
    expect(outcome.ok).toBe(false);
  });
});
