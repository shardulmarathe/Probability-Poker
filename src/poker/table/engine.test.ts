import { describe, expect, it } from "vitest";
import { makeRng } from "../core/rng";
import type {
  BotDecision,
  MultiwayEquity,
  SyncBotDecider,
  TableHandReport,
} from "./contract";
import {
  applyAction,
  createTable,
  playHandHeadless,
  startHand,
  type Table,
  type TableSetup,
} from "./engine";
import { legalActions, type TableAction, type TableConfig } from "./rules";
import { toCall, totalChips, type TableState } from "./state";
import type { ActionType } from "../../types";

const BLINDS: TableConfig = { smallBlind: 5, bigBlind: 10 };

function table(overrides: Partial<TableSetup> & { seatCount: number }): Table {
  return createTable({
    startingStack: 200,
    seed: 12345,
    ...BLINDS,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Scripted deciders
//
// None of these consult equity or a bot profile, the whole point of the
// injected decider is that the lifecycle can be driven by rules alone.
// ---------------------------------------------------------------------------

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

function decision(
  state: TableState,
  seat: number,
  action: TableAction
): BotDecision {
  return {
    seat,
    street: state.street,
    action,
    potBefore: state.pot,
    toCall: toCall(state, seat),
    equity: NO_EQUITY,
    evByAction: {},
    beliefs: {},
    profile: "tag",
  };
}

function pick(legal: TableAction[], ...types: ActionType[]): TableAction {
  for (const type of types) {
    const found = legal.find((a) => a.type === type);
    if (found) return found;
  }
  throw new Error(`none of ${types.join("/")} is legal`);
}

/** Never folds, never raises. */
const callDown: SyncBotDecider = (state, seat, config) =>
  decision(state, seat, pick(legalActions(state, seat, config), "check", "call"));

/** Folds whenever it is facing a bet. */
const foldToBets: SyncBotDecider = (state, seat, config) =>
  decision(state, seat, pick(legalActions(state, seat, config), "check", "fold"));

/** Shoves at every opportunity, manufactures all-ins and side pots. */
const jam: SyncBotDecider = (state, seat, config) => {
  const legal = legalActions(state, seat, config);
  const aggressive = legal.find((a) => a.type === "bet" || a.type === "raise");
  if (aggressive) {
    return decision(state, seat, sized(aggressive, aggressive.max as number));
  }
  return decision(state, seat, pick(legal, "check", "call"));
};

/** Raises the minimum every time, the longest legal betting rounds there are. */
const grind: SyncBotDecider = (state, seat, config) => {
  const legal = legalActions(state, seat, config);
  const aggressive = legal.find((a) => a.type === "bet" || a.type === "raise");
  if (aggressive) return decision(state, seat, aggressive);
  return decision(state, seat, pick(legal, "check", "call"));
};

/** Uniform over the legal set, with a uniform size inside the legal range. */
function shuffleBot(seed: number): SyncBotDecider {
  const rng = makeRng(seed);
  return (state, seat, config) => {
    const legal = legalActions(state, seat, config);
    const choice = legal[rng.int(legal.length)];
    if (choice.min === undefined || choice.max === undefined) {
      return decision(state, seat, choice);
    }
    return decision(
      state,
      seat,
      sized(choice, choice.min + rng.int(choice.max - choice.min + 1))
    );
  };
}

function sized(action: TableAction, cost: number): TableAction {
  return { ...action, cost, amount: action.amount - action.cost + cost };
}

// ---------------------------------------------------------------------------
// Invariant harness
// ---------------------------------------------------------------------------

/**
 * The engine's own step ceiling, recomputed here from the stacks the hand is
 * about to be dealt with. It has to be per-hand: rebuys let a winner get very
 * deep, and a deep stack legitimately buys thousands of min-raises.
 */
function actionBound(t: Table): number {
  const n = t.seats.length;
  const deepest = Math.max(...t.seats.map((s) => s.stack));
  return 4 * n * (Math.ceil(deepest / t.config.bigBlind) + n + 1);
}

function offered(legal: TableAction[], action: TableAction): boolean {
  const match = legal.find((a) => a.type === action.type);
  if (!match) return false;
  if (match.min !== undefined && match.max !== undefined) {
    return action.cost >= match.min && action.cost <= match.max;
  }
  return action.cost === match.cost;
}

/**
 * Play `hands` and check invariants 1-3 (conservation, termination, legality)
 * before every single action rather than once per hand, a mid-hand accounting
 * slip that the payout happens to cancel out would otherwise go unseen.
 *
 * Failures are collected instead of asserted in place: at ~100k actions per run
 * an `expect` per check dominates the runtime, and the first failure is the one
 * worth reading anyway.
 */
function auditRun(
  t: Table,
  decider: SyncBotDecider,
  hands: number
): {
  failures: string[];
  reports: TableHandReport[];
  peak: number;
  /** Worst actions-taken / actions-allowed over the run. Must stay below 1. */
  worstRatio: number;
} {
  const base = totalChips(t);
  const failures: string[] = [];
  const reports: TableHandReport[] = [];
  let peak = 0;
  let worstRatio = 0;

  const note = (message: string) => {
    if (failures.length < 5) failures.push(`hand ${t.handNumber}: ${message}`);
  };

  const audited: SyncBotDecider = (state, seat, config) => {
    const chips = totalChips(state);
    if (chips !== base + t.rebuys) {
      note(`chips ${chips} != ${base} + ${t.rebuys} rebuys`);
    }
    if (state.toAct !== seat) note(`asked seat ${seat} while ${state.toAct} is up`);

    const legal = legalActions(state, seat, config);
    if (legal.length === 0) note(`seat ${seat} is to act with no legal action`);
    const chosen = decider(state, seat, config);
    if (!offered(legal, chosen.action)) {
      note(
        `seat ${seat} played ${chosen.action.type}/${chosen.action.cost}, not offered`
      );
    }
    return chosen;
  };

  for (let i = 0; i < hands; i++) {
    const limit = actionBound(t);
    const before = t.seats.map((s) => s.stack);
    const report = playHandHeadless(t, audited);

    peak = Math.max(peak, report.actions.length);
    worstRatio = Math.max(worstRatio, report.actions.length / limit);
    if (t.toAct !== null) note(`toAct ${t.toAct} left set after the hand`);
    if (t.pot !== 0) note(`pot ${t.pot} left in the middle`);
    if (totalChips(t) !== base + t.rebuys) {
      note(`chips ${totalChips(t)} != ${base} + ${t.rebuys} rebuys after payout`);
    }

    const net = report.seats.reduce((n, s) => n + s.net, 0);
    if (net !== 0) note(`seat nets sum to ${net}, not 0`);
    for (const seat of report.seats) {
      // Ties the report to the stacks it claims to describe, a busted seat is
      // back on the starting stack, everyone else is up or down by their net.
      const after = before[seat.seat] + seat.net;
      const expected = after === 0 ? t.startingStack : after;
      if (t.seats[seat.seat].stack !== expected) {
        note(`seat ${seat.seat} holds ${t.seats[seat.seat].stack}, not ${expected}`);
      }
    }
    reports.push(report);
  }

  return { failures, reports, peak, worstRatio };
}

/** Invariant 5: a seat all-in for X cannot win more than Σ min(X, invested_j). */
function capBreaches(report: TableHandReport): string[] {
  const bad: string[] = [];
  for (const seat of report.seats) {
    const cap = report.seats.reduce(
      (n, other) => n + Math.min(seat.invested, other.invested),
      0
    );
    if (seat.won > cap) {
      bad.push(`seat ${seat.seat} won ${seat.won} over its ${cap} cap`);
    }
  }
  return bad;
}

const SEAT_COUNTS = [2, 3, 4, 5, 6];

// ---------------------------------------------------------------------------
// Invariants 1-3, across the whole seat range
// ---------------------------------------------------------------------------

describe.each(SEAT_COUNTS)("%i-handed", (seatCount) => {
  const HANDS = 1000;

  it.each([
    ["call down", () => callDown],
    ["fold to bets", () => foldToBets],
    ["always jam", () => jam],
    ["min-raise grind", () => grind],
    ["random", () => shuffleBot(0xbeef)],
  ])(
    `conserves chips, terminates and stays legal over ${HANDS} hands (%s)`,
    (_label, build) => {
      const t = table({ seatCount, seed: 900 + seatCount });
      const { failures, reports, peak, worstRatio } = auditRun(t, build(), HANDS);

      expect(failures).toEqual([]);
      expect(reports).toHaveLength(HANDS);
      expect(worstRatio).toBeLessThan(1);
      expect(peak).toBeGreaterThanOrEqual(seatCount - 1);
      expect(totalChips(t)).toBe(seatCount * 200 + t.rebuys);
    }
  );

  it("reaches every ending under random play", () => {
    const t = table({ seatCount, seed: 31 + seatCount });
    const endings = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const report = playHandHeadless(t, shuffleBot(i));
      endings.add(report.endStreet);
    }
    // A run that only ever ended one way would pass the invariants vacuously.
    expect([...endings].sort()).toEqual([
      "flop",
      "preflop",
      "river",
      "showdown",
      "turn",
    ]);
  });

  it("never awards a seat more than its side-pot cap", () => {
    const t = table({ seatCount, seed: 4242, startingStack: 300 });
    // Uneven stacks are what create genuine layers; jamming forces them in.
    for (const seat of t.seats) seat.stack = 40 + seat.id * 90;

    const breaches: string[] = [];
    for (let i = 0; i < 400; i++) {
      breaches.push(...capBreaches(playHandHeadless(t, jam)));
    }
    expect(breaches).toEqual([]);
  });

  it("replays identically from the same seed", () => {
    const run = () => {
      const t = table({ seatCount, seed: 777 });
      const reports = [];
      for (let i = 0; i < 40; i++) reports.push(playHandHeadless(t, shuffleBot(9)));
      return JSON.stringify(reports);
    };
    expect(run()).toBe(run());
  });

  it("diverges on a different seed", () => {
    const run = (seed: number) => {
      const t = table({ seatCount, seed });
      const reports = [];
      for (let i = 0; i < 20; i++) reports.push(playHandHeadless(t, shuffleBot(9)));
      return JSON.stringify(reports);
    };
    expect(run(1)).not.toBe(run(2));
  });
});

// ---------------------------------------------------------------------------
// Dealing and rotation
// ---------------------------------------------------------------------------

describe("createTable", () => {
  it("seats everyone on the starting stack and rejects impossible tables", () => {
    const t = table({ seatCount: 6, startingStack: 500 });
    expect(t.seats.map((s) => s.stack)).toEqual([500, 500, 500, 500, 500, 500]);
    expect(t.seats.map((s) => s.kind)).toEqual([
      "human",
      "bot",
      "bot",
      "bot",
      "bot",
      "bot",
    ]);
    expect(totalChips(t)).toBe(3000);

    expect(() => table({ seatCount: 1 })).toThrow(/unsupported table size/);
    expect(() => table({ seatCount: 7 })).toThrow(/unsupported table size/);
    expect(() => table({ seatCount: 3, startingStack: 0 })).toThrow(/positive/);
    expect(() =>
      table({ seatCount: 3, smallBlind: 20, bigBlind: 10 })
    ).toThrow(/bad blinds/);
  });

  it("takes seat identities from the setup", () => {
    const t = table({
      seatCount: 3,
      seats: [
        { name: "Ada", kind: "human" },
        { name: "Rock", kind: "bot", profile: "rock" },
        { name: "Maniac", kind: "bot", profile: "maniac" },
      ],
    });
    expect(t.seats.map((s) => s.name)).toEqual(["Ada", "Rock", "Maniac"]);
    expect(t.seats.map((s) => s.profile)).toEqual([
      undefined,
      "rock",
      "maniac",
    ]);
  });
});

describe("startHand", () => {
  it("rotates the button and deals two distinct cards per seat", () => {
    const t = table({ seatCount: 6 });
    expect(t.button).toBe(5);

    startHand(t);
    expect(t.button).toBe(0);
    expect(t.handNumber).toBe(1);

    const dealt = t.seats.flatMap((s) => s.hole.map((c) => c.id));
    expect(dealt).toHaveLength(12);
    expect(new Set(dealt).size).toBe(12);
    expect(t.deck).toHaveLength(40);

    startHand(t);
    expect(t.button).toBe(1);
  });

  it("posts the blinds and gives the action to the seat left of the big blind", () => {
    const t = table({ seatCount: 6 });
    startHand(t);
    // button 0 => SB 1, BB 2, UTG 3.
    expect(t.seats[1].invested).toBe(5);
    expect(t.seats[2].invested).toBe(10);
    expect(t.pot).toBe(15);
    expect(t.toAct).toBe(3);
    expect(t.currentBet).toBe(10);
  });

  it("runs the board out when the blinds put everyone all-in", () => {
    // A stack of one small blind: both seats are all-in before anyone can act,
    // so there is nothing to ask and the round is closed on arrival.
    const t = table({ seatCount: 2, startingStack: 5 });
    startHand(t);

    expect(t.status).toBe("hand-over");
    expect(t.toAct).toBeNull();
    expect(t.board).toHaveLength(5);
    expect(t.lastReport?.wentToShowdown).toBe(true);
    expect(t.lastReport?.actions).toEqual([]);
    expect(t.lastReport?.pots).toEqual([
      { amount: 10, eligible: [0, 1], winners: expect.any(Array) },
    ]);
    expect(totalChips(t)).toBe(10 + t.rebuys);
  });
});

// ---------------------------------------------------------------------------
// Hand endings
// ---------------------------------------------------------------------------

describe("folding", () => {
  it("hands the blinds to the big blind when everyone folds", () => {
    const t = table({ seatCount: 6 });
    const report = playHandHeadless(t, foldToBets);

    // Four seats behind fold, then the small blind; the big blind never acts.
    expect(report.actions.map((a) => a.action)).toEqual([
      "fold",
      "fold",
      "fold",
      "fold",
      "fold",
    ]);
    expect(report.actions.map((a) => a.seat)).toEqual([3, 4, 5, 0, 1]);
    expect(report.wentToShowdown).toBe(false);
    expect(report.endStreet).toBe("preflop");
    expect(report.board).toEqual([]);

    expect(report.pots).toEqual([{ amount: 10, eligible: [2], winners: [2] }]);
    // The big blind's own uncalled 5 comes back on top of the 10 it won.
    expect(report.seats[2].won).toBe(15);
    expect(report.seats[2].net).toBe(5);
    expect(report.seats[1].net).toBe(-5);
    expect(t.seats[2].stack).toBe(205);
    expect(t.seats[1].stack).toBe(195);
    expect(t.pot).toBe(0);
  });

  it("keeps folded hole cards unevaluated", () => {
    const t = table({ seatCount: 4, seed: 55 });
    const report = playHandHeadless(t, shuffleBot(3));
    for (const seat of report.seats) {
      expect(seat.hole).toHaveLength(2);
      if (seat.status === "folded") expect(seat.final).toBeNull();
    }
  });
});

describe("showdown", () => {
  it("pays the best hand and clears the pot", () => {
    const t = table({ seatCount: 3, seed: 8 });
    const report = playHandHeadless(t, callDown);

    expect(report.wentToShowdown).toBe(true);
    expect(report.endStreet).toBe("showdown");
    expect(report.board).toHaveLength(5);
    expect(t.pot).toBe(0);

    const winners = report.pots.flatMap((p) => p.winners);
    const best = Math.max(
      ...report.seats.filter((s) => s.final).map((s) => s.final!.score)
    );
    for (const id of winners) expect(report.seats[id].final!.score).toBe(best);
    expect(totalChips(t)).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// Betting mechanics
// ---------------------------------------------------------------------------

describe("betting round", () => {
  it("gives the big blind its option after a round of limps", () => {
    const t = table({ seatCount: 4 });
    startHand(t);
    // button 0 => SB 1, BB 2, UTG 3.
    for (const seat of [3, 0, 1]) {
      applyAction(t, seat, pick(legalActions(t, seat, t.config), "call"));
    }

    expect(t.street).toBe("preflop");
    expect(t.toAct).toBe(2);
    expect(toCall(t, 2)).toBe(0);
    const option = legalActions(t, 2, t.config).map((a) => a.type);
    expect(option).toEqual(["check", "bet"]);

    applyAction(t, 2, pick(legalActions(t, 2, t.config), "check"));
    expect(t.street).toBe("flop");
    expect(t.board).toHaveLength(3);
    // Postflop the small blind leads.
    expect(t.toAct).toBe(1);
  });

  it("does not reopen the betting after an undersized all-in", () => {
    const t = table({ seatCount: 3 });
    t.seats[2].stack = 35;
    startHand(t);
    // button 0 => SB 1, BB 2 (35 chips), first to act 0.

    applyAction(t, 0, sized(pick(legalActions(t, 0, t.config), "raise"), 30));
    applyAction(t, 1, pick(legalActions(t, 1, t.config), "call"));
    expect(t.currentBet).toBe(30);
    expect(t.lastRaiseSize).toBe(20);

    // The big blind has 25 behind over a 20 call: a jam to 35 raises by 5, less
    // than the standing 20, so it does not reopen anything.
    const jamAction = pick(legalActions(t, 2, t.config), "raise");
    expect(jamAction.cost).toBe(25);
    expect(jamAction.max).toBe(25);
    applyAction(t, 2, jamAction);

    expect(t.currentBet).toBe(35);
    expect(t.lastRaiseSize).toBe(20);
    expect(t.toAct).toBe(0);
    expect(legalActions(t, 0, t.config).map((a) => a.type)).toEqual([
      "fold",
      "call",
    ]);
    expect(legalActions(t, 1, t.config).map((a) => a.type)).toEqual([
      "fold",
      "call",
    ]);
    expect(toCall(t, 0)).toBe(5);
  });

  it("reopens the betting after a full raise", () => {
    const t = table({ seatCount: 3 });
    startHand(t);
    applyAction(t, 0, sized(pick(legalActions(t, 0, t.config), "raise"), 30));
    applyAction(t, 1, sized(pick(legalActions(t, 1, t.config), "raise"), 75));
    expect(t.lastRaiseSize).toBe(50);
    expect(legalActions(t, 2, t.config).map((a) => a.type)).toEqual([
      "fold",
      "call",
      "raise",
    ]);
    expect(t.toAct).toBe(2);
  });

  it("rejects out-of-turn and out-of-range actions", () => {
    const t = table({ seatCount: 3 });
    startHand(t);
    const legal = legalActions(t, 0, t.config);
    expect(() => applyAction(t, 1, pick(legal, "call"))).toThrow(/out of turn/);
    expect(() => applyAction(t, 0, sized(pick(legal, "raise"), 5))).toThrow(
      /outside/
    );
    expect(() => applyAction(t, 0, sized(pick(legal, "raise"), 10_000))).toThrow(
      /outside/
    );
    expect(() =>
      applyAction(t, 0, { ...pick(legal, "call"), cost: 3 })
    ).toThrow(/costs 10/);
    expect(() =>
      applyAction(t, 0, { type: "check", amount: 0, cost: 0, label: "Check" })
    ).toThrow(/illegal action/);
  });
});

// ---------------------------------------------------------------------------
// Side pots
// ---------------------------------------------------------------------------

describe("side pots", () => {
  it("layers a main and a side pot at two all-in depths", () => {
    const t = table({ seatCount: 3 });
    t.seats[0].stack = 100;
    t.seats[1].stack = 300;
    t.seats[2].stack = 1000;
    startHand(t);
    // button 0 => SB 1, BB 2, first to act 0.

    applyAction(t, 0, sized(pick(legalActions(t, 0, t.config), "raise"), 100));
    applyAction(t, 1, sized(pick(legalActions(t, 1, t.config), "raise"), 295));
    applyAction(t, 2, pick(legalActions(t, 2, t.config), "call"));

    const report = t.lastReport!;
    expect(report.endStreet).toBe("showdown");
    expect(report.pots.map((p) => ({ amount: p.amount, eligible: p.eligible }))).toEqual([
      { amount: 300, eligible: [0, 1, 2] },
      { amount: 400, eligible: [1, 2] },
    ]);
    // Seat 0 is all-in for 100 and can never take more than 100 from each seat.
    expect(report.seats[0].won).toBeLessThanOrEqual(300);
    expect(capBreaches(report)).toEqual([]);
    expect(totalChips(t)).toBe(1400 + t.rebuys);
  });

  it("refunds the uncalled portion of a bet nobody covered", () => {
    const t = table({ seatCount: 3 });
    t.seats[2].stack = 40;
    startHand(t);
    // Seat 0 jams 200 into a big blind that can only cover 40.
    applyAction(t, 0, sized(pick(legalActions(t, 0, t.config), "raise"), 200));
    applyAction(t, 1, pick(legalActions(t, 1, t.config), "fold"));
    applyAction(t, 2, pick(legalActions(t, 2, t.config), "call"));

    const report = t.lastReport!;
    // Only the 40 the big blind could match is contested; the 5 dead small blind
    // rides along in the main pot and the other 160 comes straight back.
    expect(report.pots).toEqual([
      { amount: 85, eligible: [0, 2], winners: expect.any(Array) },
    ]);
    expect(report.seats[0].won).toBeGreaterThanOrEqual(160);
    expect(totalChips(t)).toBe(440 + t.rebuys);
  });

  it("produces three genuine layers from four different stack depths", () => {
    const t = table({ seatCount: 4 });
    t.seats[0].stack = 60;
    t.seats[1].stack = 120;
    t.seats[2].stack = 240;
    t.seats[3].stack = 480;
    const report = playHandHeadless(t, jam);

    expect(report.pots.length).toBeGreaterThanOrEqual(3);
    expect(new Set(report.pots.map((p) => p.eligible.length)).size).toBe(
      report.pots.length
    );
    expect(capBreaches(report)).toEqual([]);
    const paid = report.seats.reduce((n, s) => n + s.won - s.invested, 0);
    expect(paid).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rebuys
// ---------------------------------------------------------------------------

describe("auto-rebuy", () => {
  it("reloads a busted seat and records the injection", () => {
    const t = table({ seatCount: 2, startingStack: 20, seed: 31 });
    // Stacks of two big blinds: every hand is all-in preflop, so someone busts.
    const report = playHandHeadless(t, jam);
    const loser = report.seats.find((s) => s.won === 0);

    expect(loser).toBeDefined();
    expect(t.rebuys).toBe(20);
    expect(t.seats[loser!.seat].stack).toBe(20);
    expect(t.log.some((line) => line.includes("rebuys for $20"))).toBe(true);
    expect(totalChips(t)).toBe(40 + 20);
  });

  it("keeps every seat playable over a long session", () => {
    const t = table({ seatCount: 5, startingStack: 30, seed: 77 });
    for (let i = 0; i < 300; i++) playHandHeadless(t, jam);

    expect(t.rebuys).toBeGreaterThan(0);
    expect(t.rebuys % 30).toBe(0);
    for (const seat of t.seats) expect(seat.stack).toBeGreaterThan(0);
    expect(totalChips(t)).toBe(150 + t.rebuys);
  });
});

// ---------------------------------------------------------------------------
// Report shape and the decider seam
// ---------------------------------------------------------------------------

describe("hand report", () => {
  it("records every action with the pot and price it faced", () => {
    const t = table({ seatCount: 3, seed: 21 });
    const report = playHandHeadless(t, callDown);

    expect(report.handNumber).toBe(1);
    expect(report.button).toBe(0);
    expect(report.seatCount).toBe(3);
    expect(report.decisions).toHaveLength(report.actions.length);

    // Preflop the button faces the big blind into a 15-chip pot.
    expect(report.actions[0]).toEqual({
      seat: 0,
      street: "preflop",
      action: "call",
      cost: 10,
      potBefore: 15,
      toCall: 10,
    });
    for (const record of report.actions) {
      expect(record.cost).toBeGreaterThanOrEqual(0);
      expect(record.potBefore).toBeGreaterThanOrEqual(15);
    }
    for (const card of report.board) {
      expect(card).toBeGreaterThanOrEqual(0);
      expect(card).toBeLessThan(52);
    }
  });
});

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

describe("the log narrates in the subject's person", () => {
  /**
   * Seat 0 is named "You", and the replay page prints `table.log` verbatim.
   * Writing every line in the third person therefore produced "You folds.",
   * "You calls $960." and "You rebuys for $2000." on screen. This sweeps enough
   * random hands to reach every verb, including the rebuy, and fails on any
   * third-person form attached to that subject.
   */
  it("never conjugates a verb against 'You'", () => {
    // A short stack so seats bust and the rebuy line is reached too.
    const t = table({ seatCount: 4, seed: 20260802, startingStack: 60 });
    const lines = new Set<string>();
    for (let i = 0; i < 300; i++) {
      playHandHeadless(t, shuffleBot(i));
      for (const line of t.log) lines.add(line);
    }

    const hero = [...lines].filter((l) => l.startsWith("You "));
    // Guards the assertion below: a run that never spoke as the hero would
    // pass it without checking anything.
    expect(hero.length).toBeGreaterThan(4);
    expect(hero.some((l) => /^You rebuy\b/.test(l))).toBe(true);
    expect(hero.filter((l) => /^You \w+s\b/.test(l))).toEqual([]);
  });

  it("still conjugates a verb against a bot's name", () => {
    const t = table({ seatCount: 4, seed: 4, startingStack: 60 });
    const lines = new Set<string>();
    for (let i = 0; i < 200; i++) {
      playHandHeadless(t, shuffleBot(i));
      for (const line of t.log) lines.add(line);
    }
    const bots = [...lines].filter((l) => /^Bot \d /.test(l));
    expect(bots.length).toBeGreaterThan(4);
    expect(bots.some((l) => /^Bot \d (folds|checks|calls|bets|raises)\b/.test(l))).toBe(
      true
    );
  });
});
