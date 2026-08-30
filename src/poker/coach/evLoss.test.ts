import { describe, expect, it } from "vitest";
import type { ActionType, Street } from "../../types";
import { makeRng } from "../core/rng";
import type {
  ActionRecord,
  BotDecision,
  MultiwayEquity,
  SeatResult,
  SyncBotDecider,
  TableHandReport,
} from "../table/contract";
import { createTable, playHandHeadless } from "../table/engine";
import { legalActions } from "../table/rules";
import { toCall } from "../table/state";
import {
  ACTING_STREETS,
  analyzeDecision,
  analyzeHand,
  analyzeHands,
  priceAction,
  type DecisionEvLoss,
} from "./evLoss";

// ---------------------------------------------------------------------------
// Card codes: (rank - 2) * 4 + suit, suits ordered s h d c (see core/card.ts).
// ---------------------------------------------------------------------------

const As = 48;
const Ah = 49;
const Kc = 47;
const c7c = 23;
const c7h = 21;
const c7d = 22;
const c5s = 12;
const c3h = 5;
const c2d = 2;
const c2c = 3;

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface HandSpec {
  seatCount: number;
  button: number;
  hole: Record<number, number[]>;
  board: number[];
  actions: ActionRecord[];
  folded?: number[];
  wentToShowdown?: boolean;
  seed?: number;
}

function hand(spec: HandSpec): TableHandReport {
  const folded = spec.folded ?? [];
  const seats: SeatResult[] = Array.from(
    { length: spec.seatCount },
    (_, id) => ({
      seat: id,
      hole: spec.hole[id] ?? [],
      final: null,
      invested: 0,
      won: 0,
      net: 0,
      status: folded.includes(id) ? ("folded" as const) : ("active" as const),
    })
  );
  return {
    handNumber: 1,
    seed: spec.seed ?? 99,
    button: spec.button,
    seatCount: spec.seatCount,
    board: spec.board,
    seats,
    pots: [{ amount: 0, eligible: [], winners: [] }],
    decisions: [],
    actions: spec.actions,
    endStreet: "showdown",
    wentToShowdown: spec.wentToShowdown ?? true,
  };
}

const A = (
  seat: number,
  street: Street,
  action: ActionType,
  potBefore: number,
  toCallAmt: number,
  cost: number
): ActionRecord => ({
  seat,
  street,
  action,
  cost,
  potBefore,
  toCall: toCallAmt,
});

// Small budgets: the properties under test are structural, not statistical.
const FAST = { simulations: 600, hindsightRunouts: 300 };

// ---------------------------------------------------------------------------
// The pricing formula
// ---------------------------------------------------------------------------

describe("priceAction", () => {
  it("prices folding at zero: the baseline every other line is measured against", () => {
    expect(priceAction("fold", 0, 40, 100, 0.9)).toBe(0);
    expect(priceAction("fold", 0, 40, 100, 0.1)).toBe(0);
  });

  it("prices a check as a free claim on the pot", () => {
    expect(priceAction("check", 0, 0, 100, 0.6)).toBeCloseTo(60, 9);
  });

  it("prices a call as share of the pot minus the losing share of the cost", () => {
    // 0.6 * 100 - 0.4 * 40
    expect(priceAction("call", 40, 40, 100, 0.6)).toBeCloseTo(44, 9);
  });

  it("grows the pot a raise can win by the extra the opponent is assumed to match", () => {
    // cost 90 over a 40 call: extra 50, so the pot in play is 150.
    expect(priceAction("raise", 90, 40, 100, 0.6)).toBeCloseTo(0.6 * 150 - 0.4 * 90, 9);
  });

  it("makes calling with no equity cost exactly the call", () => {
    expect(priceAction("call", 50, 50, 170, 0)).toBe(-50);
  });
});

// ---------------------------------------------------------------------------
// The whole point: model EV and hindsight EV are different questions
// ---------------------------------------------------------------------------

describe("model EV vs hindsight EV", () => {
  /**
   * A correct call that lost.
   *
   * Hero holds A♠A♥ on a 7♥7♦2♣5♠ turn and calls a bet. Against any range the
   * villain's line suggests, that is a large favourite and an easy call. The
   * villain in fact holds 7♣2♦, a flopped full house, so the call was drawing
   * dead and the hand is lost.
   *
   * The model lens says the call made money. The hindsight lens says it lost the
   * whole 50. Both are correct answers to different questions, and only the
   * first one is a lesson.
   */
  const correctCallThatLost = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [As, Ah], 1: [c7c, c2d] },
    board: [c7h, c7d, c2c, c5s, c3h],
    actions: [
      A(0, "preflop", "raise", 15, 5, 20),
      A(1, "preflop", "call", 35, 20, 20),
      A(1, "flop", "check", 60, 0, 0),
      A(0, "flop", "bet", 60, 0, 30),
      A(1, "flop", "call", 90, 30, 30),
      A(1, "turn", "bet", 120, 0, 50),
      A(0, "turn", "call", 170, 50, 50), // index 6, the decision under test
    ],
  });

  const call = analyzeDecision(correctCallThatLost, 6, FAST);

  it("shows a gain under the model lens", () => {
    expect(call.action).toBe("call");
    expect(call.modelEquity).toBeGreaterThan(0.6);
    expect(call.modelEvChosen).toBeGreaterThan(0);
    // Folding was on the table and was clearly worse.
    const fold = call.alternatives.find((a) => a.action === "fold")!;
    expect(fold.modelEv).toBe(0);
    expect(call.modelEvChosen).toBeGreaterThan(fold.modelEv);
  });

  it("shows a loss under the hindsight lens", () => {
    // Drawing dead against the actual cards on the actual runout.
    expect(call.hindsightEquity).toBe(0);
    expect(call.hindsightEvChosen).toBe(-50);
    expect(call.hindsightBestAction).toBe("fold");
    expect(call.hindsightEvLoss).toBe(-50);
  });

  it("draws opposite lessons from the same call", () => {
    // The two lenses do not merely differ in size, they point the other way.
    expect(call.modelEvChosen).toBeGreaterThan(0);
    expect(call.hindsightEvChosen).toBeLessThan(0);

    // Read the hindsight column alone and the lesson is "you should have
    // folded"...
    expect(call.hindsightBestAction).toBe("fold");
    // ...but under the model lens folding was the single WORST line available.
    const foldModelEv = call.alternatives.find((a) => a.action === "fold")!.modelEv;
    const worstModelEv = Math.min(...call.alternatives.map((a) => a.modelEv));
    expect(foldModelEv).toBe(worstModelEv);
    expect(foldModelEv).toBeLessThan(call.modelEvChosen);
  });

  /**
   * The mirror image: a bad call that spiked.
   *
   * Hero limp-calls a raise with 7♣2♦, the worst hand in poker, against A♠A♥,
   * then flops trips on 7♥7♦K♣. The model lens calls it the mistake it was; the
   * hindsight lens congratulates it.
   */
  const badCallThatWon = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [c7c, c2d], 1: [As, Ah] },
    board: [c7h, c7d, Kc, c5s, c3h],
    actions: [
      A(0, "preflop", "call", 15, 5, 5),
      A(1, "preflop", "bet", 20, 0, 45),
      A(0, "preflop", "call", 65, 45, 45), // index 2, the decision under test
    ],
    seed: 4242,
  });

  const spiked = analyzeDecision(badCallThatWon, 2, FAST);

  it("calls the spiked hand a mistake under the model lens", () => {
    expect(spiked.modelEquity).toBeLessThan(0.45);
    expect(spiked.modelEvChosen).toBeLessThan(0);
    expect(spiked.modelBestAction).toBe("fold");
    expect(spiked.modelEvLoss).toBeLessThan(0);
  });

  it("congratulates it under the hindsight lens", () => {
    expect(spiked.hindsightEquity).toBe(1);
    // The call collected the whole 65 it was risking nothing against.
    expect(spiked.hindsightEvChosen).toBe(65);
    // Hindsight rates the call above folding; the model rates it below.
    const foldHindsight = spiked.alternatives.find((a) => a.action === "fold")!;
    expect(spiked.hindsightEvChosen).toBeGreaterThan(foldHindsight.hindsightEv);
    expect(spiked.modelEvChosen).toBeLessThan(0);
    // With the cards face up, the only complaint left is that it was not raised.
    expect(spiked.hindsightBestAction).toBe("raise");
  });

  it("has the two lenses disagree about which line was best, in both directions", () => {
    expect(call.modelBestAction).not.toBe(call.hindsightBestAction);
    expect(spiked.modelBestAction).not.toBe(spiked.hindsightBestAction);
  });

  it("does not let the villain's actual cards leak into the model equity", () => {
    // Same hero, same board, same action history, only the villain's hole
    // cards change. The model lens is public information only, so it must not
    // move; the hindsight lens must.
    const swapped = hand({
      ...{
        seatCount: 2,
        button: 0,
        hole: { 0: [As, Ah], 1: [Kc, c3h] },
        board: [c7h, c7d, c2c, c5s, c2d],
        actions: correctCallThatLost.actions,
      },
    });
    const other = analyzeDecision(swapped, 6, FAST);
    expect(other.modelEquity).toBe(call.modelEquity);
    expect(other.hindsightEquity).not.toBe(call.hindsightEquity);
    expect(other.hindsightEquity).toBe(1); // AA beats K3 on 7-7-2-5-2
  });
});

// ---------------------------------------------------------------------------
// Hindsight when the runout never happened
// ---------------------------------------------------------------------------

describe("hindsight on a hand that ended early", () => {
  it("enumerates the two remaining cards exactly when a hand ends on the flop", () => {
    const foldedFlop = hand({
      seatCount: 2,
      button: 0,
      hole: { 0: [As, Ah], 1: [c7c, c2d] },
      board: [c7h, c7d, Kc],
      actions: [
        A(0, "preflop", "raise", 15, 5, 20),
        A(1, "preflop", "call", 35, 20, 20),
        A(1, "flop", "check", 60, 0, 0),
        A(0, "flop", "bet", 60, 0, 30),
        A(1, "flop", "fold", 90, 30, 0),
      ],
      folded: [1],
      wentToShowdown: false,
    });
    const d = analyzeDecision(foldedFlop, 3, FAST);
    expect(d.hindsightExact).toBe(true);
    // Villain flopped trips; the hero is a big dog but not drawing dead (an ace
    // or running cards get there), so the share is small and strictly positive.
    expect(d.hindsightEquity).toBeGreaterThan(0);
    expect(d.hindsightEquity).toBeLessThan(0.3);
  });

  it("samples, and says so, when a hand ends before a flop", () => {
    const foldedPreflop = hand({
      seatCount: 2,
      button: 0,
      hole: { 0: [As, Ah], 1: [c7c, c2d] },
      board: [],
      actions: [
        A(0, "preflop", "raise", 15, 5, 20),
        A(1, "preflop", "fold", 35, 20, 0),
      ],
      folded: [1],
      wentToShowdown: false,
    });
    const d = analyzeDecision(foldedPreflop, 0, { ...FAST, hindsightRunouts: 2000 });
    expect(d.hindsightExact).toBe(false);
    // AA against 72o is about 88%.
    expect(d.hindsightEquity).toBeGreaterThan(0.8);
    expect(d.hindsightEquity).toBeLessThan(0.95);
  });

  it("is reproducible: the sampled runout is seeded, not random", () => {
    const spec: HandSpec = {
      seatCount: 2,
      button: 0,
      hole: { 0: [As, Ah], 1: [c7c, c2d] },
      board: [],
      actions: [
        A(0, "preflop", "raise", 15, 5, 20),
        A(1, "preflop", "fold", 35, 20, 0),
      ],
      folded: [1],
      wentToShowdown: false,
    };
    const a = analyzeDecision(hand(spec), 0, FAST);
    const b = analyzeDecision(hand(spec), 0, FAST);
    expect(b.hindsightEquity).toBe(a.hindsightEquity);
    expect(b.modelEquity).toBe(a.modelEquity);
  });
});

// ---------------------------------------------------------------------------
// The sign property, over generated hands
// ---------------------------------------------------------------------------

/**
 * A decider that picks uniformly among the legal actions. No equity, no
 * profile, the point is to generate a wide spread of action sequences,
 * including plenty of bad ones, so the sign property is tested against play the
 * bots would never produce.
 */
const NO_EQUITY: MultiwayEquity = {
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
};

function randomDecider(seed: number): SyncBotDecider {
  const rng = makeRng(seed);
  return (state, seat, config): BotDecision => {
    const actions = legalActions(state, seat, config);
    return {
      seat,
      street: state.street,
      action: actions[rng.int(actions.length)],
      potBefore: state.pot,
      toCall: toCall(state, seat),
      equity: NO_EQUITY,
      evByAction: {},
      beliefs: {},
      profile: "professor",
    };
  };
}

function generateHands(count: number, seatCount: number, seed: number) {
  const table = createTable({
    seatCount,
    startingStack: 200,
    smallBlind: 5,
    bigBlind: 10,
    seed,
  });
  const decider = randomDecider(seed ^ 0x5eed);
  const reports: TableHandReport[] = [];
  for (let i = 0; i < count; i++) reports.push(playHandHeadless(table, decider));
  return reports;
}

describe("EV loss is never positive", () => {
  const reports = generateHands(24, 3, 20260801);

  it("generated enough decisions to be worth asserting on", () => {
    const total = reports.reduce((n, r) => n + r.actions.length, 0);
    expect(reports.length).toBe(24);
    expect(total).toBeGreaterThan(80);
  });

  it("holds for every decision of every seat under both lenses", () => {
    let scored = 0;
    for (const report of reports) {
      for (let seat = 0; seat < report.seatCount; seat++) {
        for (const d of analyzeHand(report, seat, FAST).decisions) {
          scored++;
          expect(d.modelEvLoss).toBeLessThanOrEqual(0);
          expect(d.hindsightEvLoss).toBeLessThanOrEqual(0);
          expect(Number.isFinite(d.modelEvLoss)).toBe(true);
          expect(Number.isFinite(d.hindsightEvLoss)).toBe(true);
        }
      }
    }
    expect(scored).toBeGreaterThan(80);
  });

  it("is exactly zero, not merely small, when the best line was taken", () => {
    let bestTaken = 0;
    for (const report of reports) {
      for (let seat = 0; seat < report.seatCount; seat++) {
        for (const d of analyzeHand(report, seat, FAST).decisions) {
          if (d.action === d.modelBestAction) {
            expect(d.modelEvLoss).toBe(0);
            bestTaken++;
          }
          if (d.action === d.hindsightBestAction) {
            expect(d.hindsightEvLoss).toBe(0);
          }
          // ...and a zero loss always means the chosen line matched the best EV.
          if (d.modelEvLoss === 0) {
            expect(d.modelEvChosen).toBe(d.modelEvBest);
          }
        }
      }
    }
    // A uniform decider takes the best line often enough for this to mean
    // something; if it never did, the assertion above would be vacuous.
    expect(bestTaken).toBeGreaterThan(10);
  });

  it("always prices the line that was actually taken", () => {
    for (const report of reports) {
      for (let seat = 0; seat < report.seatCount; seat++) {
        for (const d of analyzeHand(report, seat, FAST).decisions) {
          const chosen = d.alternatives.filter((a) => a.chosen);
          expect(chosen).toHaveLength(1);
          expect(chosen[0].action).toBe(d.action);
          expect(chosen[0].modelEv).toBe(d.modelEvChosen);
          // The best is a member of the same set, so it is reachable.
          expect(
            d.alternatives.some((a) => a.modelEv === d.modelEvBest)
          ).toBe(true);
        }
      }
    }
  });

  it("offers fold/call/raise facing a bet and check/bet facing none", () => {
    for (const report of reports) {
      for (let seat = 0; seat < report.seatCount; seat++) {
        for (const d of analyzeHand(report, seat, FAST).decisions) {
          const kinds = new Set(d.alternatives.map((a) => a.action));
          if (d.toCall > 0) {
            expect(kinds).toEqual(new Set(["fold", "call", "raise"]));
          } else {
            expect(kinds).toEqual(new Set(["check", "bet"]));
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe("aggregation", () => {
  const reports = generateHands(10, 4, 777);

  it("sums the per-decision losses into the hand total", () => {
    for (const report of reports) {
      const analysis = analyzeHand(report, 0, FAST);
      const sum = analysis.decisions.reduce((n, d) => n + d.modelEvLoss, 0);
      expect(analysis.totalModelEvLoss).toBeCloseTo(sum, 9);
      expect(analysis.totalModelEvLoss).toBeLessThanOrEqual(0);
    }
  });

  it("partitions the hand total across the streets", () => {
    for (const report of reports) {
      const analysis = analyzeHand(report, 0, FAST);
      const byStreet = ACTING_STREETS.reduce(
        (n, s) => n + analysis.byStreet[s].model,
        0
      );
      expect(byStreet).toBeCloseTo(analysis.totalModelEvLoss, 9);
      // Each street only holds decisions taken on it.
      for (const s of ACTING_STREETS) {
        const own = analysis.decisions
          .filter((d) => d.street === s)
          .reduce((n, d) => n + d.modelEvLoss, 0);
        expect(analysis.byStreet[s].model).toBeCloseTo(own, 9);
      }
    }
  });

  it("names the single worst decision by the model lens, not the hindsight one", () => {
    for (const report of reports) {
      const analysis = analyzeHand(report, 0, FAST);
      if (analysis.decisions.length === 0) {
        expect(analysis.worst).toBeNull();
        continue;
      }
      const worstLoss = Math.min(
        ...analysis.decisions.map((d: DecisionEvLoss) => d.modelEvLoss)
      );
      expect(analysis.worst!.modelEvLoss).toBe(worstLoss);
    }
  });

  it("rolls a session up out of its hands", () => {
    const session = analyzeHands(reports, 0, FAST);
    expect(session.hands).toHaveLength(reports.length);
    expect(session.totalModelEvLoss).toBeCloseTo(
      session.hands.reduce((n, h) => n + h.totalModelEvLoss, 0),
      9
    );
    expect(session.decisionCount).toBe(
      session.hands.reduce((n, h) => n + h.decisions.length, 0)
    );
    if (session.worst) {
      const all = session.hands.flatMap((h) => h.decisions);
      expect(session.worst.modelEvLoss).toBe(
        Math.min(...all.map((d) => d.modelEvLoss))
      );
    }
  });

  it("returns an empty analysis for a seat that never acted", () => {
    const walked = hand({
      seatCount: 3,
      button: 0,
      hole: { 0: [As, Ah], 1: [c7c, c2d], 2: [Kc, c3h] },
      board: [],
      actions: [
        A(0, "preflop", "fold", 15, 10, 0),
        A(1, "preflop", "fold", 15, 5, 0),
      ],
      folded: [0, 1],
      wentToShowdown: false,
    });
    const analysis = analyzeHand(walked, 2, FAST);
    expect(analysis.decisions).toEqual([]);
    expect(analysis.worst).toBeNull();
    expect(analysis.totalModelEvLoss).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Position and provenance
// ---------------------------------------------------------------------------

describe("decision records", () => {
  it("labels the position the decision was taken from", () => {
    const reports = generateHands(4, 6, 31337);
    for (const report of reports) {
      for (const d of analyzeHand(report, 2, FAST).decisions) {
        expect(d.seat).toBe(2);
        expect(["BTN", "SB", "BB", "UTG", "HJ", "CO"]).toContain(d.position);
        expect(d.handNumber).toBe(report.handNumber);
        expect(report.actions[d.index].seat).toBe(2);
      }
    }
  });

  it("refuses an index that is not an action", () => {
    const reports = generateHands(1, 3, 5);
    expect(() => analyzeDecision(reports[0], 9999, FAST)).toThrow(/no action/);
  });
});
