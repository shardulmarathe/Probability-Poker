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
  aggregateLeaks,
  analyzeDecision,
  analyzeHand,
  analyzeHands,
  classifyLeak,
  LEAK_KINDS,
  mistakeThreshold,
  NOT_A_LEAK,
  priceAction,
  PRICE_MARGIN,
  type DecisionEvLoss,
  type LeakKind,
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
const Ac = 51;
const Qh = 41;
const Jh = 37;
const Ts = 32;
const c9s = 28;
const c8s = 24;
const c6s = 16;
const c4h = 9;

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

// ---------------------------------------------------------------------------
// The error taxonomy
// ---------------------------------------------------------------------------
//
// Every kind gets a fixture that IS it and a fixture that is NOT, and the pairs
// are built to differ in one thing only: the price, the action, the number of
// opponents, or who made the bet. A classifier that cannot fail is not a
// classifier, and a pair that changes two things at once cannot show which one
// did the work.

/** Ts 7h 2c 4h Ac. Hero's 9s8s makes ace high and nothing else. */
const DRY_BOARD = [Ts, c7h, c2c, c4h, Ac];

describe("taxonomy: called below the price", () => {
  /**
   * Hero holds 9♠8♠ and owes 90 into 105, so the pot lays 90/195 = 46.2% and
   * hero has about 38% against the range a preflop raise suggests. Calling is
   * the mistake; folding at the identical price is not.
   */
  const steep = (act: ActionType) =>
    hand({
      seatCount: 2,
      button: 0,
      hole: { 0: [c9s, c8s], 1: [Kc, c3h] },
      board: DRY_BOARD,
      actions: [
        A(1, "preflop", "raise", 15, 10, 90),
        A(0, "preflop", act, 105, 90, act === "fold" ? 0 : 90),
      ],
      folded: act === "fold" ? [0] : [],
    });

  const called = analyzeDecision(steep("call"), 1, FAST);
  const folded = analyzeDecision(steep("fold"), 1, FAST);

  it("names the call", () => {
    expect(called.kind).toBe("call-below-price");
  });

  it("states the price it was called below", () => {
    expect(called.requiredEquity).toBeCloseTo(90 / 195, 9);
    expect(called.modelEquity + PRICE_MARGIN).toBeLessThan(
      called.requiredEquity!
    );
    // The price is exactly the equity a call breaks even at, which is what makes
    // it the right threshold rather than a tuned one.
    expect(
      priceAction("call", 90, 90, 105, called.requiredEquity!)
    ).toBeCloseTo(0, 9);
  });

  it("does not name the fold at the same price", () => {
    // Only the action changed. Same hero, same board, same 90 into 105.
    expect(folded.modelEquity).toBe(called.modelEquity);
    expect(folded.requiredEquity).toBe(called.requiredEquity);
    expect(folded.modelEvLoss).toBe(0);
    expect(folded.kind).toBeNull();
  });
});

describe("taxonomy: folded above the price", () => {
  /**
   * Hero holds A♠A♥ and folds a 20 into 60 turn bet: the pot lays 25% and hero
   * is about 80%. On the turn, so no continuation bet can be involved.
   */
  const foldTurn = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [As, Ah], 1: [Kc, c3h] },
    board: DRY_BOARD,
    actions: [
      A(0, "preflop", "raise", 15, 5, 20),
      A(1, "preflop", "call", 35, 20, 20),
      A(1, "flop", "check", 60, 0, 0),
      A(0, "flop", "check", 60, 0, 0),
      A(1, "turn", "bet", 60, 0, 20),
      A(0, "turn", "fold", 80, 20, 0),
    ],
    folded: [0],
  });

  /** The same fold with a hand that has no business continuing. */
  const weakFold = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [c9s, c8s], 1: [Kc, c3h] },
    board: DRY_BOARD,
    actions: [
      A(0, "preflop", "raise", 15, 5, 20),
      A(1, "preflop", "call", 35, 20, 20),
      A(0, "river", "check", 60, 0, 0),
      A(1, "river", "bet", 60, 0, 100),
      A(0, "river", "fold", 160, 100, 0),
    ],
    folded: [0],
  });

  it("names the fold", () => {
    const d = analyzeDecision(foldTurn, 5, FAST);
    expect(d.kind).toBe("fold-above-price");
    expect(d.facingCbet).toBe(false);
    expect(d.requiredEquity).toBeCloseTo(20 / 100, 9);
    expect(d.modelEquity).toBeGreaterThan(d.requiredEquity! + PRICE_MARGIN);
  });

  it("does not name a fold the price does not cover", () => {
    const d = analyzeDecision(weakFold, 4, FAST);
    expect(d.action).toBe("fold");
    expect(d.requiredEquity).toBeCloseTo(100 / 260, 9);
    expect(d.modelEquity).toBeLessThan(d.requiredEquity!);
    expect(d.modelEvLoss).toBe(0);
    expect(d.kind).toBeNull();
  });
});

describe("taxonomy: folded to a continuation bet", () => {
  /**
   * The same A♠A♥ fold to the same 20 into 60, on the flop, from the seat that
   * raised preflop. The only thing separating the two fixtures below is who
   * bet the flop, which is the entire content of the word "continuation".
   */
  const cbet = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [As, Ah], 1: [Kc, c3h] },
    board: DRY_BOARD,
    actions: [
      A(1, "preflop", "raise", 15, 5, 20),
      A(0, "preflop", "call", 35, 20, 20),
      A(0, "flop", "check", 60, 0, 0),
      A(1, "flop", "bet", 60, 0, 20), // the preflop raiser continues
      A(0, "flop", "fold", 80, 20, 0),
    ],
    folded: [0],
  });

  const notCbet = hand({
    seatCount: 3,
    button: 0,
    hole: { 0: [As, Ah], 1: [Kc, c3h], 2: [Qh, Jh] },
    board: DRY_BOARD,
    actions: [
      A(1, "preflop", "raise", 15, 5, 20),
      A(0, "preflop", "call", 35, 20, 20),
      A(2, "preflop", "call", 55, 20, 20),
      A(2, "flop", "bet", 75, 0, 20), // a caller leads, seat 1 raised preflop
      A(0, "flop", "fold", 95, 20, 0),
    ],
    folded: [0],
  });

  it("names the fold when the bettor was the preflop aggressor", () => {
    const d = analyzeDecision(cbet, 4, FAST);
    expect(d.facingCbet).toBe(true);
    expect(d.kind).toBe("fold-to-cbet");
  });

  it("falls back to the general kind when the bettor was not", () => {
    const d = analyzeDecision(notCbet, 4, FAST);
    expect(d.facingCbet).toBe(false);
    // Still a mistaken fold above the price, just not a continuation bet.
    expect(d.kind).toBe("fold-above-price");
  });

  it("never calls a decision that owes nothing a fold to a c-bet", () => {
    const d = analyzeDecision(cbet, 2, FAST); // hero checks the flop
    expect(d.toCall).toBe(0);
    expect(d.facingCbet).toBe(false);
    expect(d.requiredEquity).toBeNull();
  });
});

describe("taxonomy: treated multiway as heads-up", () => {
  /**
   * The pair this kind exists for.
   *
   * Hero holds 9♠8♠ and calls 50 into 100, a 25% price. Against any one of the
   * three opponents alone hero is 37 to 46%, comfortably above it. Against all
   * three at once hero is about 22%, below it. Nothing about the holding
   * changed; the field did.
   */
  const multiway = hand({
    seatCount: 4,
    button: 0,
    hole: { 0: [c9s, c8s], 1: [Kc, c3h], 2: [Qh, Jh], 3: [c6s, c5s] },
    board: DRY_BOARD,
    actions: [
      A(1, "preflop", "raise", 15, 10, 85),
      A(2, "preflop", "call", 100, 50, 50),
      A(0, "preflop", "call", 150, 50, 50),
    ],
  });

  const headsUp = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [c9s, c8s], 1: [Kc, c3h] },
    board: DRY_BOARD,
    actions: [
      A(1, "preflop", "raise", 15, 10, 85),
      A(0, "preflop", "call", 100, 50, 50),
    ],
  });

  const field = analyzeDecision(multiway, 2, FAST);
  const solo = analyzeDecision(headsUp, 1, FAST);

  it("names the call", () => {
    expect(field.kind).toBe("multiway-as-heads-up");
    expect(field.opponentCount).toBe(3);
  });

  it("shows the arithmetic the name refers to", () => {
    const heads = Object.values(field.modelEquityPerOpponent);
    expect(heads).toHaveLength(3);
    // Ahead of each of them...
    expect(Math.min(...heads)).toBeGreaterThan(
      field.requiredEquity! + PRICE_MARGIN
    );
    // ...and behind all of them.
    expect(field.modelEquity + PRICE_MARGIN).toBeLessThan(field.requiredEquity!);
    expect(field.modelEquity).toBeLessThan(Math.min(...heads));
  });

  it("keys the per-opponent shares by the seats that were still in", () => {
    expect(Object.keys(field.modelEquityPerOpponent).map(Number).sort()).toEqual([
      1, 2, 3,
    ]);
  });

  it("does not name the same holding at a similar price heads-up", () => {
    // One opponent instead of three, and the call becomes correct.
    expect(solo.opponentCount).toBe(1);
    expect(solo.modelEquity).toBeGreaterThan(solo.requiredEquity!);
    expect(solo.modelEvLoss).toBe(0);
    expect(solo.kind).not.toBe("multiway-as-heads-up");
  });

  it("never names it when there is only one opponent to be ahead of", () => {
    const reports = generateHands(20, 2, 4711);
    for (const report of reports) {
      for (let seat = 0; seat < report.seatCount; seat++) {
        for (const d of analyzeHand(report, seat, FAST).decisions) {
          expect(d.kind).not.toBe("multiway-as-heads-up");
        }
      }
    }
  });
});

describe("taxonomy: passed on value", () => {
  const checkedRiver = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [As, Ah], 1: [Kc, c3h] },
    board: DRY_BOARD,
    actions: [
      A(0, "preflop", "raise", 15, 5, 20),
      A(1, "preflop", "call", 35, 20, 20),
      A(1, "flop", "check", 60, 0, 0),
      A(0, "flop", "check", 60, 0, 0),
      A(1, "turn", "check", 60, 0, 0),
      A(0, "turn", "check", 60, 0, 0),
      A(1, "river", "check", 60, 0, 0),
      A(0, "river", "check", 60, 0, 0), // index 7: hero checks back the nuts
    ],
  });

  /**
   * The mirror claim, and the one the taxonomy refuses to make. Hero bets 10
   * into 20 with 7♣2♦ on K♠9♠5♠4♥T♥, which the model scores as a loss because
   * `priceAction` has no fold-equity term and therefore prices the bet as
   * certain to be called. Naming that a leak would file every bluff ever made
   * under mistakes, so the decision stays unclassified.
   */
  const bluffedRiver = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [c7c, c2d], 1: [As, Ah] },
    board: [44, 28, 12, c4h, 33], // K♠ 9♠ 5♠ 4♥ T♥
    actions: [
      A(0, "preflop", "call", 15, 5, 5),
      A(1, "preflop", "check", 20, 0, 0),
      A(1, "flop", "check", 20, 0, 0),
      A(0, "flop", "check", 20, 0, 0),
      A(1, "turn", "check", 20, 0, 0),
      A(0, "turn", "check", 20, 0, 0),
      A(1, "river", "check", 20, 0, 0),
      A(0, "river", "bet", 20, 0, 10), // index 7
    ],
  });

  it("names a check the model wanted to be a bet", () => {
    const d = analyzeDecision(checkedRiver, 7, FAST);
    expect(d.action).toBe("check");
    expect(d.modelBestAction).toBe("bet");
    expect(d.modelEquity).toBeGreaterThan(0.9);
    expect(d.kind).toBe("missed-value");
  });

  it("refuses to name a bet the model wanted to be a check", () => {
    const d = analyzeDecision(bluffedRiver, 7, FAST);
    expect(d.action).toBe("bet");
    expect(d.modelBestAction).toBe("check");
    // A real loss under a model that cannot see fold equity, and therefore not
    // a finding this module is willing to put a name to.
    expect(d.modelEvLoss).toBeLessThan(-mistakeThreshold(d.potBefore));
    expect(d.kind).toBeNull();
  });
});

describe("taxonomy: results-oriented", () => {
  /**
   * The kind that is not a leak.
   *
   * Hero holds 9♠8♠, calls 50 into 100 heads-up at a 33% price with about 38%,
   * and loses. The model lens puts the loss at exactly zero: there was no
   * mistake. The hindsight lens takes the whole 50.
   */
  const lost = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [c9s, c8s], 1: [Kc, c3h] },
    board: DRY_BOARD,
    actions: [
      A(1, "preflop", "raise", 15, 10, 85),
      A(0, "preflop", "call", 100, 50, 50),
    ],
  });

  /**
   * The same call, against a villain hero beats. Every model number is
   * identical, because the model lens never sees the villain's cards, and the
   * hindsight loss is the same size: with the cards face up the omniscient line
   * is the biggest raise, so a WINNER also shows a hindsight loss. That shared
   * sign is why the classifier tests `hindsightBestAction` and not the gap
   * alone.
   */
  const won = hand({
    seatCount: 2,
    button: 0,
    hole: { 0: [c9s, c8s], 1: [c6s, c5s] },
    board: DRY_BOARD,
    actions: [
      A(1, "preflop", "raise", 15, 10, 85),
      A(0, "preflop", "call", 100, 50, 50),
    ],
  });

  const punished = analyzeDecision(lost, 1, FAST);
  const rewarded = analyzeDecision(won, 1, FAST);

  it("names a correct call the cards took the chips from", () => {
    expect(punished.modelEvLoss).toBe(0);
    expect(punished.hindsightEvLoss).toBe(-50);
    expect(punished.hindsightBestAction).toBe("fold");
    expect(punished.kind).toBe("results-oriented");
    expect(punished.kind).toBe(NOT_A_LEAK);
  });

  it("does not name the identical call that won", () => {
    // Same read, same price, same action, same size of hindsight loss.
    expect(rewarded.modelEquity).toBe(punished.modelEquity);
    expect(rewarded.modelEvLoss).toBe(0);
    expect(rewarded.hindsightEvLoss).toBeLessThan(-25);
    // What differs is the direction hindsight points: away from the pot, or
    // further into it.
    expect(rewarded.hindsightBestAction).toBe("raise");
    expect(rewarded.kind).toBeNull();
  });

  it("does not name a call that was a mistake in the first place", () => {
    // A model mistake is a leak, whatever the cards then did; the two claims
    // are mutually exclusive by construction.
    const mistake = analyzeDecision(
      hand({
        seatCount: 2,
        button: 0,
        hole: { 0: [c9s, c8s], 1: [Kc, c3h] },
        board: DRY_BOARD,
        actions: [
          A(1, "preflop", "raise", 15, 10, 90),
          A(0, "preflop", "call", 105, 90, 90),
        ],
      }),
      1,
      FAST
    );
    expect(mistake.modelEvLoss).toBeLessThan(0);
    expect(mistake.hindsightEvLoss).toBe(-90);
    expect(mistake.kind).not.toBe("results-oriented");
  });

  it("holds its side of the bargain on generated hands: no model mistake", () => {
    const reports = generateHands(16, 3, 606060);
    let found = 0;
    for (const report of reports) {
      for (let seat = 0; seat < report.seatCount; seat++) {
        for (const d of analyzeHand(report, seat, FAST).decisions) {
          if (d.kind !== NOT_A_LEAK) continue;
          found++;
          expect(d.modelEvLoss).toBeGreaterThan(-mistakeThreshold(d.potBefore));
          expect(d.hindsightBestAction).toBe("fold");
          expect(d.hindsightEvLoss).toBeLessThan(d.modelEvLoss);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("classifyLeak", () => {
  const reports = generateHands(12, 3, 8181);
  const decisions = reports.flatMap((r) =>
    Array.from({ length: r.seatCount }, (_, s) => s).flatMap(
      (s) => analyzeHand(r, s, FAST).decisions
    )
  );

  it("is a pure function of the evidence the decision already carries", () => {
    // Feeding a scored decision back through the classifier must return its own
    // label, which is what pins `LeakEvidence` as complete.
    for (const d of decisions) expect(classifyLeak(d)).toBe(d.kind);
  });

  it("only ever emits a kind from the published vocabulary", () => {
    for (const d of decisions) {
      if (d.kind !== null) expect(LEAK_KINDS).toContain(d.kind);
    }
  });

  it("labels nothing that is not a mistake, except the kind that is not a leak", () => {
    for (const d of decisions) {
      if (d.kind === null || d.kind === NOT_A_LEAK) continue;
      expect(d.modelEvLoss).toBeLessThan(-mistakeThreshold(d.potBefore));
    }
  });

  it("declines to label rather than guessing", () => {
    // The null bucket must be genuinely populated: a classifier that names
    // everything has stopped being one.
    expect(decisions.filter((d) => d.kind === null).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Ranking by frequency x cost
// ---------------------------------------------------------------------------

describe("aggregateLeaks", () => {
  const reports = generateHands(16, 4, 909090);
  const session = analyzeHands(reports, 0, FAST);
  const decisions = session.hands.flatMap((h) => h.decisions);

  /** A scored decision with its label and cost overridden, nothing else. */
  const template = decisions[0];
  const synthetic = (
    kind: LeakKind | null,
    modelEvLoss: number,
    index: number
  ): DecisionEvLoss => ({ ...template, index, kind, modelEvLoss });

  it("ranks a frequent cheap habit above one disastrous hand", () => {
    const habit = Array.from({ length: 40 }, (_, i) =>
      synthetic("call-below-price", -10, i)
    );
    const disaster = [synthetic("fold-above-price", -300, 100)];
    const ranked = aggregateLeaks([...habit, ...disaster]);

    expect(ranked[0].kind).toBe("call-below-price");
    expect(ranked[0].count).toBe(40);
    expect(ranked[0].totalModelEvLoss).toBeCloseTo(-400, 9);
    expect(ranked[0].meanModelEvLoss).toBeCloseTo(-10, 9);

    expect(ranked[1].kind).toBe("fold-above-price");
    expect(ranked[1].count).toBe(1);
    expect(ranked[1].meanModelEvLoss).toBeCloseTo(-300, 9);

    // The single most expensive decision in the set belongs to the kind that
    // ranks SECOND. Ranking by cost alone would inverse this whole list.
    const worst = [...habit, ...disaster].reduce((a, b) =>
      b.modelEvLoss < a.modelEvLoss ? b : a
    );
    expect(worst.modelEvLoss).toBe(-300);
    expect(worst.kind).toBe(ranked[1].kind);
  });

  it("reports the mean next to the total, so the two orderings stay visible", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      synthetic("call-below-price", -10, i)
    );
    const few = Array.from({ length: 4 }, (_, i) =>
      synthetic("fold-above-price", -25, 100 + i)
    );
    const ranked = aggregateLeaks([...many, ...few]);
    const cheap = ranked.find((l) => l.kind === "call-below-price")!;
    const dear = ranked.find((l) => l.kind === "fold-above-price")!;

    expect(cheap.totalModelEvLoss).toBeLessThan(dear.totalModelEvLoss);
    expect(cheap.meanModelEvLoss).toBeGreaterThan(dear.meanModelEvLoss);
    expect(ranked[0].kind).toBe("call-below-price");
  });

  it("breaks a tie in total toward the more frequent kind", () => {
    const ranked = aggregateLeaks([
      ...Array.from({ length: 6 }, (_, i) => synthetic("call-below-price", -10, i)),
      ...Array.from({ length: 2 }, (_, i) => synthetic("fold-above-price", -30, 50 + i)),
    ]);
    expect(ranked[0].totalModelEvLoss).toBeCloseTo(ranked[1].totalModelEvLoss, 9);
    expect(ranked[0].count).toBeGreaterThan(ranked[1].count);
  });

  it("keeps the unclassified decisions as their own bucket", () => {
    const ranked = aggregateLeaks([
      synthetic(null, -50, 0),
      synthetic("missed-value", -5, 1),
    ]);
    const unclassified = ranked.find((l) => l.kind === null);
    expect(unclassified).toBeDefined();
    expect(unclassified!.count).toBe(1);
    expect(unclassified!.totalModelEvLoss).toBeCloseTo(-50, 9);
  });

  it("drops kinds nobody committed rather than listing them at zero", () => {
    const ranked = aggregateLeaks([synthetic("missed-value", -5, 0)]);
    expect(ranked).toHaveLength(1);
    expect(ranked.every((l) => l.count > 0)).toBe(true);
  });

  it("returns nothing at all for no decisions", () => {
    expect(aggregateLeaks([])).toEqual([]);
  });

  it("partitions the decisions exactly once each", () => {
    const total = session.leaks.reduce((n, l) => n + l.count, 0);
    expect(total).toBe(decisions.length);
    const sum = session.leaks.reduce((n, l) => n + l.totalModelEvLoss, 0);
    expect(sum).toBeCloseTo(session.totalModelEvLoss, 9);
    const hindsight = session.leaks.reduce(
      (n, l) => n + l.totalHindsightEvLoss,
      0
    );
    expect(hindsight).toBeCloseTo(session.totalHindsightEvLoss, 9);
  });

  it("never counts more occurrences than there were chances to commit them", () => {
    expect(session.leaks.length).toBeGreaterThan(1);
    for (const leak of session.leaks) {
      expect(leak.opportunities).toBeGreaterThanOrEqual(leak.count);
      expect(leak.rate).toBeCloseTo(leak.count / leak.opportunities, 9);
      expect(leak.rate).toBeLessThanOrEqual(1);
      expect(leak.meanModelEvLoss).toBeCloseTo(
        leak.totalModelEvLoss / leak.count,
        9
      );
      expect(leak.totalModelEvLoss).toBeLessThanOrEqual(0);
      expect(leak.worst!.kind).toBe(leak.kind);
      expect(leak.worst!.modelEvLoss).toBe(
        Math.min(
          ...decisions.filter((d) => d.kind === leak.kind).map((d) => d.modelEvLoss)
        )
      );
    }
  });

  it("counts opportunities against the spots that offered the error, not every decision", () => {
    const price = session.leaks.find((l) => l.kind === "call-below-price")!;
    expect(price).toBeDefined();
    expect(price.opportunities).toBe(decisions.filter((d) => d.toCall > 0).length);
    // Narrower than the decision count, which is the whole point: dividing bad
    // calls by every decision ever taken understates the habit.
    expect(price.opportunities).toBeLessThan(decisions.length);

    const multiway = session.leaks.find(
      (l) => l.kind === "multiway-as-heads-up"
    )!;
    expect(multiway).toBeDefined();
    expect(multiway.opportunities).toBe(
      decisions.filter((d) => d.toCall > 0 && d.opponentCount >= 2).length
    );
    expect(multiway.opportunities).toBeLessThan(price.opportunities);
  });

  it("is ranked most costly first", () => {
    for (let i = 1; i < session.leaks.length; i++) {
      expect(session.leaks[i - 1].totalModelEvLoss).toBeLessThanOrEqual(
        session.leaks[i].totalModelEvLoss
      );
    }
  });

  it("cannot let correct play outrank a real leak", () => {
    const correct = session.leaks.find((l) => l.kind === NOT_A_LEAK)!;
    const leaks = session.leaks.filter((l) => l.kind !== NOT_A_LEAK);
    expect(correct).toBeDefined();
    expect(leaks.length).toBeGreaterThan(0);

    // Its model loss is bounded by the mistake threshold per decision, so no
    // number of occurrences can push it above a kind that costs real chips.
    expect(correct.totalModelEvLoss).toBeGreaterThan(
      Math.min(...leaks.map((l) => l.totalModelEvLoss))
    );
    expect(session.leaks[session.leaks.length - 1].kind).toBe(NOT_A_LEAK);
    // The number worth showing for it is the hindsight one.
    expect(correct.totalHindsightEvLoss).toBeLessThan(correct.totalModelEvLoss);
  });

  it("is not attached to a single hand, where a frequency would be meaningless", () => {
    const single = analyzeHand(reports[0], 0, FAST);
    expect(single).not.toHaveProperty("leaks");
  });
});
