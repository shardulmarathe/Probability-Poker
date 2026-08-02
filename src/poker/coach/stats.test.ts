import { describe, expect, it } from "vitest";
import type { ActionType, Street } from "../../types";
import type {
  ActionRecord,
  PotRecord,
  SeatResult,
  TableHandReport,
} from "../table/contract";
import {
  computeStats,
  emptyCounters,
  mergeCounters,
  mergeStats,
  percent,
  rate,
  scanHand,
  toPlayerStatsRow,
} from "./stats";

// ---------------------------------------------------------------------------
// Fixtures
//
// Hand-built rather than played, so every count in a test can be verified by
// reading the action list. The engine's own reports are exercised in
// evLoss.test.ts and archetype.test.ts; here the point is that a *known* action
// sequence produces a *known* number.
// ---------------------------------------------------------------------------

/** `toCall` is the only numeric field any stat reads; the rest is padding. */
function act(
  seat: number,
  street: Street,
  action: ActionType,
  toCall = 0
): ActionRecord {
  const cost = action === "fold" || action === "check" ? 0 : Math.max(toCall, 10);
  return { seat, street, action, cost, potBefore: 30, toCall };
}

interface HandSpec {
  seatCount: number;
  button: number;
  actions: ActionRecord[];
  board?: number[];
  wentToShowdown?: boolean;
  /** Seats whose final status is "folded". Defaults to whoever folded. */
  folded?: number[];
  winners?: number[];
  net?: Record<number, number>;
  /** Seats dealt cards. Defaults to every seat. */
  dealt?: number[];
  handNumber?: number;
}

const FLOP = [0, 5, 21];
const RIVER = [0, 5, 21, 34, 47];

function hand(spec: HandSpec): TableHandReport {
  const {
    seatCount,
    button,
    actions,
    board = [],
    wentToShowdown = false,
    winners = [],
    net = {},
    handNumber = 1,
  } = spec;
  const dealt = spec.dealt ?? Array.from({ length: seatCount }, (_, i) => i);
  const folded =
    spec.folded ??
    actions.filter((a) => a.action === "fold").map((a) => a.seat);

  const seats: SeatResult[] = Array.from({ length: seatCount }, (_, id) => ({
    seat: id,
    hole: dealt.includes(id) ? [2 * id, 2 * id + 1] : [],
    final: null,
    invested: 10,
    won: winners.includes(id) ? 40 : 0,
    net: net[id] ?? 0,
    status: folded.includes(id) ? ("folded" as const) : ("active" as const),
  }));

  const eligible = seats
    .filter((s) => s.hole.length === 2 && s.status !== "folded")
    .map((s) => s.seat);
  const pots: PotRecord[] = [{ amount: 100, eligible, winners }];

  return {
    handNumber,
    seed: 1234,
    button,
    seatCount,
    board,
    seats,
    pots,
    decisions: [],
    actions,
    endStreet: board.length === 5 ? "showdown" : board.length >= 3 ? "flop" : "preflop",
    wentToShowdown,
  };
}

// ---------------------------------------------------------------------------
// VPIP — the traps
// ---------------------------------------------------------------------------

describe("VPIP", () => {
  it("does not count a posted blind", () => {
    // 3-handed, button 0: SB is seat 1, BB is seat 2. Both put chips in before
    // acting, and neither did so voluntarily. Seats 0 and 1 fold; seat 2 never
    // acts at all — the classic walk.
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [act(0, "preflop", "fold", 10), act(1, "preflop", "fold", 5)],
      folded: [0, 1],
    });

    const bb = scanHand(report, 2)!;
    expect(bb.hands).toBe(1);
    expect(bb.vpip).toEqual({ n: 0, d: 1 });
    expect(bb.pfr).toEqual({ n: 0, d: 1 });

    // ...and the small blind, which also had chips in the pot involuntarily.
    expect(scanHand(report, 1)!.vpip).toEqual({ n: 0, d: 1 });
  });

  it("treats a walk in the big blind as no action at all, not as a fold", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [act(0, "preflop", "fold", 10), act(1, "preflop", "fold", 5)],
      folded: [0, 1],
    });

    const bb = scanHand(report, 2)!;
    // A fold would show up in the aggression denominator and in a fold-to-3bet
    // opportunity; a walk shows up in neither, because the seat never acted.
    expect(bb.afq).toEqual({ n: 0, d: 0 });
    expect(bb.af).toEqual({ n: 0, d: 0 });
    expect(bb.foldToThreeBet).toEqual({ n: 0, d: 0 });
    expect(bb.threeBet).toEqual({ n: 0, d: 0 });
    // No flop was dealt, so there is no showdown opportunity either.
    expect(bb.wtsd).toEqual({ n: 0, d: 0 });
  });

  it("does not count the big blind checking its option", () => {
    // Everyone limps, the big blind checks. Chips went in, none voluntarily.
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "call", 10),
        act(1, "preflop", "call", 5),
        act(2, "preflop", "check", 0),
        act(1, "flop", "check"),
        act(2, "flop", "check"),
        act(0, "flop", "check"),
      ],
      board: FLOP,
    });

    expect(scanHand(report, 2)!.vpip).toEqual({ n: 0, d: 1 });
    // The limpers did put money in by choice.
    expect(scanHand(report, 0)!.vpip).toEqual({ n: 1, d: 1 });
    expect(scanHand(report, 1)!.vpip).toEqual({ n: 1, d: 1 });
    // Unlike the walk, this seat saw a flop.
    expect(scanHand(report, 2)!.wtsd.d).toBe(1);
  });

  it("counts a completing small blind and a raising big blind", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "fold", 10),
        act(1, "preflop", "call", 5),
        act(2, "preflop", "bet", 0), // BB raising over limpers is a `bet` here
        act(1, "preflop", "call", 20),
      ],
      folded: [0],
      board: FLOP,
    });

    expect(scanHand(report, 1)!.vpip).toEqual({ n: 1, d: 1 });
    expect(scanHand(report, 2)!.vpip).toEqual({ n: 1, d: 1 });
    // The big blind's opening `bet` is a raise in every sense but the label.
    expect(scanHand(report, 2)!.pfr).toEqual({ n: 1, d: 1 });
    expect(scanHand(report, 1)!.pfr).toEqual({ n: 0, d: 1 });
  });

  it("counts a hand only once however many times the seat acts", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "call", 25),
        act(2, "preflop", "raise", 20),
        act(0, "preflop", "call", 60),
        act(1, "preflop", "call", 60),
      ],
      board: FLOP,
    });
    expect(scanHand(report, 0)!.vpip).toEqual({ n: 1, d: 1 });
    expect(scanHand(report, 0)!.pfr).toEqual({ n: 1, d: 1 });
  });
});

// ---------------------------------------------------------------------------
// 3-bet and fold to 3-bet
// ---------------------------------------------------------------------------

describe("3-bet", () => {
  // 6-handed, button 0 => SB 1, BB 2, UTG 3, HJ 4, CO 5. Preflop order is
  // 3, 4, 5, 0, 1, 2. UTG opens, HJ folds, CO 3-bets, everyone else folds,
  // UTG folds to the 3-bet.
  const threeBetPot = hand({
    seatCount: 6,
    button: 0,
    actions: [
      act(3, "preflop", "raise", 10),
      act(4, "preflop", "fold", 30),
      act(5, "preflop", "raise", 30),
      act(0, "preflop", "fold", 90),
      act(1, "preflop", "fold", 85),
      act(2, "preflop", "fold", 80),
      act(3, "preflop", "fold", 60),
    ],
  });

  it("counts the re-raise over an open", () => {
    expect(scanHand(threeBetPot, 5)!.threeBet).toEqual({ n: 1, d: 1 });
  });

  it("counts the opportunity when a seat facing the open does not take it", () => {
    // HJ folded facing exactly one raise: an opportunity declined.
    expect(scanHand(threeBetPot, 4)!.threeBet).toEqual({ n: 0, d: 1 });
  });

  it("gives the opener no opportunity, and never counts a 4-bet spot", () => {
    // UTG's only action facing one raise would be facing its own.
    expect(scanHand(threeBetPot, 3)!.threeBet).toEqual({ n: 0, d: 0 });
    // BTN/SB/BB all acted with two raises standing — that is a 4-bet spot.
    for (const seat of [0, 1, 2]) {
      expect(scanHand(threeBetPot, seat)!.threeBet).toEqual({ n: 0, d: 0 });
    }
  });

  it("scores the opener's answer to the 3-bet", () => {
    expect(scanHand(threeBetPot, 3)!.foldToThreeBet).toEqual({ n: 1, d: 1 });
    // Nobody else was 3-bet, so nobody else has the opportunity.
    for (const seat of [0, 1, 2, 4, 5]) {
      expect(scanHand(threeBetPot, seat)!.foldToThreeBet).toEqual({ n: 0, d: 0 });
    }
  });

  it("scores a 4-bet as a non-fold, and stops there", () => {
    const fourBet = hand({
      seatCount: 6,
      button: 0,
      actions: [
        act(3, "preflop", "raise", 10),
        act(5, "preflop", "raise", 30),
        act(3, "preflop", "raise", 60), // 4-bet: not a fold to the 3-bet
        act(5, "preflop", "raise", 120), // 5-bet
        act(3, "preflop", "fold", 200), // folding to the 5-bet, not the 3-bet
      ],
    });
    expect(scanHand(fourBet, 3)!.foldToThreeBet).toEqual({ n: 0, d: 1 });
  });

  it("gives a limper who later faces the open a 3-bet opportunity", () => {
    // Seat 3 limps, seat 5 opens, seat 3 re-raises: that is the third bet.
    const limpRaise = hand({
      seatCount: 6,
      button: 0,
      actions: [
        act(3, "preflop", "call", 10),
        act(5, "preflop", "raise", 10),
        act(3, "preflop", "raise", 30),
      ],
    });
    expect(scanHand(limpRaise, 3)!.threeBet).toEqual({ n: 1, d: 1 });
  });

  it("gives nobody an opportunity in a limped pot", () => {
    const limped = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "call", 10),
        act(1, "preflop", "call", 5),
        act(2, "preflop", "check", 0),
      ],
      board: FLOP,
    });
    for (const seat of [0, 1, 2]) {
      expect(scanHand(limped, seat)!.threeBet).toEqual({ n: 0, d: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// Aggression
// ---------------------------------------------------------------------------

describe("AF and AFq", () => {
  it("is (bets + raises) / calls over postflop actions only", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        // Preflop aggression must not leak into AF.
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "call", 25),
        act(2, "preflop", "call", 20),
        act(1, "flop", "check"),
        act(2, "flop", "check"),
        act(0, "flop", "bet"),
        act(1, "flop", "call", 20),
        act(2, "flop", "raise", 20),
        act(0, "flop", "call", 40),
        act(1, "flop", "fold", 40),
        act(1, "turn", "check"),
      ],
      board: RIVER,
    });

    // Seat 0: postflop bet + call => 1 aggressive, 1 call.
    expect(scanHand(report, 0)!.af).toEqual({ n: 1, d: 1 });
    expect(rate(scanHand(report, 0)!.af)).toBe(1);
    // Seat 2: one raise, no calls. AF is undefined, not infinite.
    expect(scanHand(report, 2)!.af).toEqual({ n: 1, d: 0 });
    expect(rate(scanHand(report, 2)!.af)).toBeNull();
    // Seat 1: one call, no aggression.
    expect(scanHand(report, 1)!.af).toEqual({ n: 0, d: 1 });
  });

  it("excludes checks from both AF terms but counts folds in AFq", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "call", 25),
        act(2, "preflop", "call", 20),
        act(1, "flop", "check"),
        act(2, "flop", "check"),
        act(0, "flop", "bet"),
        act(1, "flop", "fold", 20),
        act(2, "flop", "call", 20),
      ],
      board: RIVER,
    });

    // Seat 1: one check + one fold. AF sees nothing at all…
    expect(scanHand(report, 1)!.af).toEqual({ n: 0, d: 0 });
    // …but AFq counts the fold as a passive decision.
    expect(scanHand(report, 1)!.afq).toEqual({ n: 0, d: 1 });
    // Seat 2: check (ignored), call. Seat 0: bet.
    expect(scanHand(report, 2)!.afq).toEqual({ n: 0, d: 1 });
    expect(scanHand(report, 0)!.afq).toEqual({ n: 1, d: 1 });
  });

  it("counts an all-in call as a call", () => {
    // The engine clamps `toCall` to the stack, so an all-in call looks like any
    // other call: same action type, cost equal to what was left.
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "call", 25),
        act(2, "preflop", "fold", 20),
        act(1, "flop", "check"),
        act(0, "flop", "bet"),
        { seat: 1, street: "flop", action: "call", cost: 37, potBefore: 120, toCall: 37 },
      ],
      board: RIVER,
      folded: [2],
    });
    expect(scanHand(report, 1)!.af).toEqual({ n: 0, d: 1 });
    expect(scanHand(report, 1)!.afq).toEqual({ n: 0, d: 1 });
  });
});

// ---------------------------------------------------------------------------
// Showdown
// ---------------------------------------------------------------------------

describe("WTSD and W$SD", () => {
  const showdown = hand({
    seatCount: 3,
    button: 0,
    actions: [
      act(0, "preflop", "raise", 10),
      act(1, "preflop", "fold", 25),
      act(2, "preflop", "call", 20),
      act(2, "flop", "check"),
      act(0, "flop", "check"),
      act(2, "turn", "check"),
      act(0, "turn", "check"),
      act(2, "river", "check"),
      act(0, "river", "check"),
    ],
    board: RIVER,
    wentToShowdown: true,
    folded: [1],
    winners: [2],
  });

  it("counts showdowns over flops seen", () => {
    expect(scanHand(showdown, 0)!.wtsd).toEqual({ n: 1, d: 1 });
    expect(scanHand(showdown, 2)!.wtsd).toEqual({ n: 1, d: 1 });
    // Seat 1 folded preflop, so it never saw a flop: no denominator.
    expect(scanHand(showdown, 1)!.wtsd).toEqual({ n: 0, d: 0 });
  });

  it("counts only the seat that actually won a pot", () => {
    expect(scanHand(showdown, 2)!.wsd).toEqual({ n: 1, d: 1 });
    expect(scanHand(showdown, 0)!.wsd).toEqual({ n: 0, d: 1 });
    expect(scanHand(showdown, 1)!.wsd).toEqual({ n: 0, d: 0 });
  });

  it("counts a chopped pot as won", () => {
    const chop = hand({
      ...{
        seatCount: 3,
        button: 0,
        actions: showdown.actions,
        board: RIVER,
        wentToShowdown: true,
        folded: [1],
        winners: [0, 2],
      },
    });
    expect(scanHand(chop, 0)!.wsd).toEqual({ n: 1, d: 1 });
    expect(scanHand(chop, 2)!.wsd).toEqual({ n: 1, d: 1 });
  });

  it("does not credit a showdown to a seat that folded on the river", () => {
    const foldedRiver = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "call", 25),
        act(2, "preflop", "call", 20),
        act(1, "river", "fold", 40),
      ],
      board: RIVER,
      wentToShowdown: true,
      folded: [1],
      winners: [0],
    });
    // Saw the flop, so the denominator is there; did not reach showdown.
    expect(scanHand(foldedRiver, 1)!.wtsd).toEqual({ n: 0, d: 1 });
    expect(scanHand(foldedRiver, 1)!.wsd).toEqual({ n: 0, d: 0 });
  });

  it("counts a seat run out all-in as having seen the flop and shown down", () => {
    const jammed = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "fold", 25),
        act(2, "preflop", "call", 20),
      ],
      board: RIVER,
      wentToShowdown: true,
      folded: [1],
      winners: [0],
    });
    // No postflop actions at all — both seats were all-in preflop.
    expect(scanHand(jammed, 2)!.wtsd).toEqual({ n: 1, d: 1 });
    expect(scanHand(jammed, 0)!.wsd).toEqual({ n: 1, d: 1 });
  });
});

// ---------------------------------------------------------------------------
// Continuation betting
// ---------------------------------------------------------------------------

describe("c-bet and fold to c-bet", () => {
  it("counts the preflop raiser betting the flop", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "fold", 25),
        act(2, "preflop", "call", 20),
        act(2, "flop", "check"),
        act(0, "flop", "bet"),
        act(2, "flop", "fold", 30),
      ],
      board: FLOP,
      folded: [1, 2],
      winners: [0],
    });

    expect(scanHand(report, 0)!.cbet).toEqual({ n: 1, d: 1 });
    expect(scanHand(report, 2)!.foldToCbet).toEqual({ n: 1, d: 1 });
    // The seat that folded preflop is in neither.
    expect(scanHand(report, 1)!.foldToCbet).toEqual({ n: 0, d: 0 });
  });

  it("counts a checked flop as a missed c-bet", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "fold", 25),
        act(2, "preflop", "call", 20),
        act(2, "flop", "check"),
        act(0, "flop", "check"),
      ],
      board: FLOP,
      folded: [1],
    });
    expect(scanHand(report, 0)!.cbet).toEqual({ n: 0, d: 1 });
    // Nobody bet, so there is nothing to fold to.
    expect(scanHand(report, 2)!.foldToCbet).toEqual({ n: 0, d: 0 });
  });

  it("gives no c-bet opportunity when a donk bet lands first", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "fold", 25),
        act(2, "preflop", "call", 20),
        act(2, "flop", "bet"), // out of position, into the raiser
        act(0, "flop", "call", 30),
      ],
      board: FLOP,
      folded: [1],
    });
    expect(scanHand(report, 0)!.cbet).toEqual({ n: 0, d: 0 });
    // Seat 2 was not the preflop aggressor, so its bet is not a c-bet either.
    expect(scanHand(report, 0)!.foldToCbet).toEqual({ n: 0, d: 0 });
  });

  it("gives no opportunity in a limped pot: there is no preflop aggressor", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "call", 10),
        act(1, "preflop", "call", 5),
        act(2, "preflop", "check", 0),
        act(1, "flop", "bet"),
        act(2, "flop", "fold", 20),
        act(0, "flop", "fold", 20),
      ],
      board: FLOP,
      folded: [0, 2],
    });
    for (const seat of [0, 1, 2]) {
      expect(scanHand(report, seat)!.cbet).toEqual({ n: 0, d: 0 });
      expect(scanHand(report, seat)!.foldToCbet).toEqual({ n: 0, d: 0 });
    }
  });

  it("counts a call of a c-bet as a non-fold", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "fold", 25),
        act(2, "preflop", "call", 20),
        act(2, "flop", "check"),
        act(0, "flop", "bet"),
        act(2, "flop", "call", 30),
      ],
      board: FLOP,
      folded: [1],
    });
    expect(scanHand(report, 2)!.foldToCbet).toEqual({ n: 0, d: 1 });
  });
});

// ---------------------------------------------------------------------------
// Seats not dealt in
// ---------------------------------------------------------------------------

describe("seats not in the hand", () => {
  it("contributes nothing for a seat with no cards", () => {
    const report = hand({
      seatCount: 3,
      button: 0,
      actions: [act(0, "preflop", "fold", 10)],
      dealt: [0, 1],
    });
    expect(scanHand(report, 2)).toBeNull();
    expect(computeStats([report], 2).total.hands).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Position slicing
// ---------------------------------------------------------------------------

describe("position slicing", () => {
  it("files each hand under the seat's position for that hand", () => {
    // Same seat, button moving: seat 0 is BTN, then BB, then SB across three
    // hands at a 3-handed table (button 0 -> SB 1, BB 2).
    const raiseFromButton = hand({
      seatCount: 3,
      button: 0,
      handNumber: 1,
      actions: [act(0, "preflop", "raise", 10)],
    });
    const foldFromBigBlind = hand({
      seatCount: 3,
      button: 1,
      handNumber: 2,
      actions: [act(0, "preflop", "fold", 30)],
    });
    const foldFromSmallBlind = hand({
      seatCount: 3,
      button: 2,
      handNumber: 3,
      actions: [act(0, "preflop", "fold", 25)],
    });

    const stats = computeStats(
      [raiseFromButton, foldFromBigBlind, foldFromSmallBlind],
      0
    );
    expect(stats.total.hands).toBe(3);
    expect(stats.byPosition.BTN.vpip).toEqual({ n: 1, d: 1 });
    expect(stats.byPosition.BB.vpip).toEqual({ n: 0, d: 1 });
    expect(stats.byPosition.SB.vpip).toEqual({ n: 0, d: 1 });
    expect(stats.byPosition.UTG.hands).toBe(0);
    // The slices partition the total.
    const sliced = [
      stats.byPosition.BTN.hands,
      stats.byPosition.SB.hands,
      stats.byPosition.BB.hands,
    ].reduce((a, b) => a + b, 0);
    expect(sliced).toBe(stats.total.hands);
  });
});

// ---------------------------------------------------------------------------
// Merging — the reason counters are pairs
// ---------------------------------------------------------------------------

describe("merging", () => {
  const sessionA = [
    hand({
      seatCount: 3,
      button: 0,
      handNumber: 1,
      actions: [
        act(0, "preflop", "raise", 10),
        act(1, "preflop", "call", 25),
        act(2, "preflop", "fold", 20),
        act(1, "flop", "check"),
        act(0, "flop", "bet"),
        act(1, "flop", "call", 20),
      ],
      board: RIVER,
      wentToShowdown: true,
      folded: [2],
      winners: [0],
      net: { 0: 40, 1: -40 },
    }),
    hand({
      seatCount: 3,
      button: 1,
      handNumber: 2,
      actions: [
        act(2, "preflop", "raise", 10),
        act(0, "preflop", "fold", 30),
        act(1, "preflop", "fold", 25),
      ],
      folded: [0, 1],
      net: { 0: -5 },
    }),
  ];
  const sessionB = [
    hand({
      seatCount: 3,
      button: 2,
      handNumber: 3,
      actions: [
        act(0, "preflop", "call", 10),
        act(1, "preflop", "raise", 10),
        act(0, "preflop", "raise", 30),
        act(1, "preflop", "fold", 60),
      ],
      folded: [1],
      net: { 0: 25 },
    }),
  ];

  it("adds numerators and denominators across sessions", () => {
    const merged = mergeStats(
      computeStats(sessionA, 0),
      computeStats(sessionB, 0)
    );
    const together = computeStats([...sessionA, ...sessionB], 0);
    expect(merged).toEqual(together);
  });

  it("agrees with recomputation for every position slice", () => {
    for (let seat = 0; seat < 3; seat++) {
      const merged = mergeStats(
        computeStats(sessionA, seat),
        computeStats(sessionB, seat)
      );
      expect(merged).toEqual(computeStats([...sessionA, ...sessionB], seat));
    }
  });

  it("is what a percentage could not do", () => {
    // 1/1 merged with 0/2 is 1/3 = 33%, not the average of 100% and 0%.
    const a = emptyCounters();
    a.vpip = { n: 1, d: 1 };
    const b = emptyCounters();
    b.vpip = { n: 0, d: 2 };
    const merged = mergeCounters(a, b);
    expect(merged.vpip).toEqual({ n: 1, d: 3 });
    expect(percent(merged.vpip)).toBeCloseTo(33.333, 3);
    expect(percent(merged.vpip)).not.toBeCloseTo(50, 3);
  });

  it("sums net chips", () => {
    const merged = mergeStats(
      computeStats(sessionA, 0),
      computeStats(sessionB, 0)
    );
    expect(merged.total.net).toBe(40 - 5 + 25);
  });
});

// ---------------------------------------------------------------------------
// Persistence shape
// ---------------------------------------------------------------------------

describe("player_stats row", () => {
  it("maps onto the migration's column names and pair shape", () => {
    const stats = computeStats(
      [
        hand({
          seatCount: 3,
          button: 0,
          actions: [
            act(0, "preflop", "raise", 10),
            act(1, "preflop", "raise", 30),
            act(0, "preflop", "call", 60),
            act(1, "flop", "bet"),
            act(0, "flop", "call", 40),
            act(1, "turn", "bet"),
            act(0, "turn", "raise", 60),
            act(1, "turn", "call", 120),
            act(1, "river", "bet"),
            act(0, "river", "call", 80),
          ],
          board: RIVER,
          wentToShowdown: true,
          winners: [0],
          net: { 0: 200 },
        }),
      ],
      0
    );

    const row = toPlayerStatsRow(stats, 10, -35);
    expect(row).toEqual({
      hands: 1,
      vpip_n: 1,
      vpip_d: 1,
      pfr_n: 1,
      pfr_d: 1,
      threebet_n: 0,
      threebet_d: 0,
      // Seat 0 postflop: call (flop), raise (turn), call (river). The preflop
      // raise and preflop call are excluded by definition.
      af_aggressive: 1,
      af_passive: 2,
      wtsd_n: 1,
      wtsd_d: 1,
      wsd_n: 1,
      wsd_d: 1,
      net_bb: 20,
      ev_lost_bb: -3.5,
    });
  });

  it("rejects a nonsensical big blind rather than dividing by zero", () => {
    expect(() => toPlayerStatsRow(computeStats([], 0), 0)).toThrow(/bigBlind/);
  });
});

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

describe("rate", () => {
  it("returns null rather than zero when nothing was observed", () => {
    expect(rate({ n: 0, d: 0 })).toBeNull();
    expect(percent({ n: 0, d: 0 })).toBeNull();
    expect(rate({ n: 0, d: 4 })).toBe(0);
  });
});
