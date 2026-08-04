import { describe, expect, it } from "vitest";
import { legalActions, sizingLadder, type TableConfig } from "./rules";
import {
  commitChips,
  postBlinds,
  recordAction,
  type TableSeat,
  type TableState,
} from "./state";

const CONFIG: TableConfig = { smallBlind: 5, bigBlind: 10 };

function table(n: number, stack = 1000, button = 0): TableState {
  const seats: TableSeat[] = Array.from({ length: n }, (_, id) => ({
    id,
    name: `S${id}`,
    kind: id === 0 ? "human" : "bot",
    stack,
    hole: [],
    status: "active",
    streetCommit: 0,
    invested: 0,
    hasActed: false,
    mayRaise: true,
  }));
  return {
    seed: 1,
    handNumber: 1,
    seats,
    button,
    street: "preflop",
    deck: [],
    board: [],
    currentBet: 0,
    lastRaiseSize: 0,
    lastAggressor: null,
    toAct: null,
    pot: 0,
    log: [],
    status: "playing",
  };
}

const types = (s: TableState, id: number) =>
  legalActions(s, id, CONFIG).map((a) => a.type);
const find = (s: TableState, id: number, t: string) =>
  legalActions(s, id, CONFIG).find((a) => a.type === t);

describe("legalActions", () => {
  it("offers check or bet when nothing is owed", () => {
    const t = table(3);
    t.street = "flop";
    expect(types(t, 0)).toEqual(["check", "bet"]);
  });

  it("offers fold, call and raise when facing a bet", () => {
    const t = table(3);
    postBlinds(t, 5, 10);
    expect(types(t, 0)).toEqual(["fold", "call", "raise"]);
  });

  it("prices the call as the shortfall", () => {
    const t = table(3);
    postBlinds(t, 5, 10);
    expect(find(t, 1, "call")?.cost).toBe(5); // SB owes 5 more
    expect(find(t, 0, "call")?.cost).toBe(10);
  });

  it("opens betting at one big blind with the stack as the ceiling", () => {
    const t = table(3, 400);
    t.street = "flop";
    const bet = find(t, 0, "bet");
    expect(bet?.cost).toBe(10);
    expect(bet?.min).toBe(10);
    expect(bet?.max).toBe(400);
  });

  it("requires a raise to match the previous raise size", () => {
    const t = table(3);
    t.street = "flop";
    t.currentBet = 50;
    t.lastRaiseSize = 50;
    // Minimum re-raise is to 100, up by at least the 50 that came before.
    expect(find(t, 0, "raise")?.amount).toBe(100);
  });

  it("uses the big blind as the standing raise preflop", () => {
    const t = table(3);
    postBlinds(t, 5, 10);
    // Over a $10 blind the minimum open is to $20.
    expect(find(t, 0, "raise")?.amount).toBe(20);
  });

  it("lets a short stack jam below the legal minimum raise", () => {
    const t = table(3);
    t.street = "flop";
    t.currentBet = 100;
    t.lastRaiseSize = 100;
    t.seats[0].stack = 130; // a full raise would need 200
    const raise = find(t, 0, "raise");
    expect(raise?.cost).toBe(130);
    expect(raise?.label).toMatch(/All-in/);
  });

  it("withholds the raise from a seat that lost the right to it", () => {
    const t = table(3);
    t.street = "flop";
    t.currentBet = 130;
    t.seats[0].streetCommit = 100;
    t.seats[0].mayRaise = false;
    expect(types(t, 0)).toEqual(["fold", "call"]);
  });

  it("marks an all-in call", () => {
    const t = table(3, 40);
    t.street = "flop";
    t.currentBet = 100;
    const call = find(t, 0, "call");
    expect(call?.cost).toBe(40);
    expect(call?.label).toMatch(/all-in/i);
  });

  it("offers no aggression when everyone else is already all-in", () => {
    const t = table(3);
    t.street = "flop";
    t.seats[1].status = "allin";
    t.seats[2].status = "folded";
    expect(types(t, 0)).toEqual(["check"]);
  });

  it("returns nothing for a seat that cannot act", () => {
    const t = table(3);
    t.street = "flop";
    t.seats[0].status = "folded";
    expect(legalActions(t, 0, CONFIG)).toEqual([]);
    t.seats[0].status = "active";
    t.street = "showdown";
    expect(legalActions(t, 0, CONFIG)).toEqual([]);
  });

  it("never lets a seat commit more than its stack", () => {
    const t = table(4, 75);
    t.street = "flop";
    t.currentBet = 30;
    for (const id of [0, 1, 2, 3]) {
      for (const a of legalActions(t, id, CONFIG)) {
        expect(a.cost).toBeLessThanOrEqual(t.seats[id].stack);
        if (a.max !== undefined) expect(a.max).toBe(t.seats[id].stack);
      }
    }
  });
});

describe("undersized all-in interaction", () => {
  it("strips the re-raise from seats that already acted, but not from others", () => {
    const t = table(4);
    t.street = "flop";
    t.currentBet = 100;
    t.lastRaiseSize = 100;
    t.seats[0].streetCommit = 100;
    t.seats[0].hasActed = true;
    t.seats[1].streetCommit = 100;
    t.seats[1].hasActed = true;
    t.seats[3].hasActed = false; // yet to act

    t.seats[2].streetCommit = 140;
    t.currentBet = 140;
    recordAction(t, 2, 40); // undersized jam

    expect(types(t, 0)).toEqual(["fold", "call"]);
    expect(types(t, 1)).toEqual(["fold", "call"]);
    // Seat 3 had not acted, so its first action may still be a raise.
    expect(types(t, 3)).toContain("raise");
  });
});

describe("sizingLadder", () => {
  it("prices presets off the pot after calling", () => {
    const t = table(3);
    t.street = "flop";
    t.pot = 100;
    const ladder = sizingLadder(t, 0, CONFIG);
    const byLabel = Object.fromEntries(ladder.map((o) => [o.label, o.cost]));
    expect(byLabel["½ pot"]).toBe(50);
    expect(byLabel["Pot"]).toBe(100);
  });

  it("includes the call amount when facing a bet", () => {
    const t = table(3);
    t.street = "flop";
    t.pot = 100;
    t.currentBet = 20;
    t.lastRaiseSize = 20;
    // Pot-sized raise = call 20, then raise the resulting 120 pot.
    const pot = sizingLadder(t, 0, CONFIG).find((o) => o.label === "Pot");
    expect(pot?.cost).toBe(140);
  });

  it("always ends with an all-in", () => {
    const t = table(3, 250);
    t.street = "flop";
    t.pot = 60;
    const ladder = sizingLadder(t, 0, CONFIG);
    expect(ladder.at(-1)).toEqual({ label: "All-in", cost: 250, amount: 250 });
  });

  it("drops presets that exceed the stack", () => {
    const t = table(3, 40);
    t.street = "flop";
    t.pot = 200;
    // Every pot fraction is beyond a 40-chip stack, so only the jam survives.
    expect(sizingLadder(t, 0, CONFIG).map((o) => o.label)).toEqual(["All-in"]);
  });

  it("keeps every option legal and within the stack", () => {
    const t = table(3, 300);
    t.street = "flop";
    t.pot = 120;
    t.currentBet = 40;
    t.lastRaiseSize = 40;
    const raise = find(t, 0, "raise")!;
    for (const o of sizingLadder(t, 0, CONFIG)) {
      expect(o.cost).toBeGreaterThanOrEqual(raise.min!);
      expect(o.cost).toBeLessThanOrEqual(raise.max!);
    }
  });

  it("is empty when no aggression is legal", () => {
    const t = table(3);
    t.street = "flop";
    t.seats[0].mayRaise = false;
    t.currentBet = 50;
    expect(sizingLadder(t, 0, CONFIG)).toEqual([]);
  });

  it("does not repeat a size under two labels", () => {
    const t = table(3, 1000);
    t.street = "flop";
    t.pot = 2; // fractions collapse onto the same rounded cost
    const ladder = sizingLadder(t, 0, CONFIG);
    expect(new Set(ladder.map((o) => o.cost)).size).toBe(ladder.length);
  });
});

describe("chip safety", () => {
  it("keeps totals conserved when a legal action is applied", () => {
    const t = table(4, 500);
    postBlinds(t, 5, 10);
    const before = t.seats.reduce((n, s) => n + s.stack, 0) + t.pot;
    for (const a of legalActions(t, 3, CONFIG)) {
      const copy = structuredClone(t);
      commitChips(copy, 3, a.cost);
      expect(copy.seats.reduce((n, s) => n + s.stack, 0) + copy.pot).toBe(before);
    }
  });
});
