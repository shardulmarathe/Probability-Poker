import { describe, expect, it } from "vitest";
import {
  actingSeats,
  bettingClosed,
  commitChips,
  contestingSeats,
  nextToAct,
  onlyOneLeft,
  openingActor,
  postBlinds,
  recordAction,
  resetStreetBetting,
  toCall,
  totalChips,
  type TableSeat,
  type TableState,
} from "./state";

function table(n: number, stack = 1000, button = 0): TableState {
  const seats: TableSeat[] = Array.from({ length: n }, (_, id) => ({
    id,
    name: id === 0 ? "You" : `Bot ${id}`,
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

describe("commitChips", () => {
  it("conserves chips", () => {
    const t = table(4);
    const before = totalChips(t);
    commitChips(t, 1, 250);
    commitChips(t, 2, 40);
    expect(totalChips(t)).toBe(before);
  });

  it("clamps to the stack and marks the seat all-in", () => {
    const t = table(3, 60);
    expect(commitChips(t, 1, 500)).toBe(60);
    expect(t.seats[1].stack).toBe(0);
    expect(t.seats[1].status).toBe("allin");
    expect(t.pot).toBe(60);
  });

  it("tracks street and hand totals separately", () => {
    const t = table(2);
    commitChips(t, 0, 10);
    resetStreetBetting(t);
    commitChips(t, 0, 25);
    expect(t.seats[0].streetCommit).toBe(25); // reset by the new street
    expect(t.seats[0].invested).toBe(35); // survives, side pots need it
  });

  it("does not resurrect a folded seat into all-in", () => {
    const t = table(3, 20);
    t.seats[1].status = "folded";
    commitChips(t, 1, 20);
    expect(t.seats[1].status).toBe("folded");
  });
});

describe("toCall", () => {
  it("is the shortfall against the current bet", () => {
    const t = table(3);
    t.currentBet = 50;
    t.seats[1].streetCommit = 20;
    expect(toCall(t, 1)).toBe(30);
  });

  it("caps at the seat's remaining stack", () => {
    const t = table(3, 25);
    t.currentBet = 100;
    expect(toCall(t, 1)).toBe(25);
  });

  it("is zero when already matched", () => {
    const t = table(3);
    t.currentBet = 50;
    t.seats[1].streetCommit = 50;
    expect(toCall(t, 1)).toBe(0);
  });
});

describe("nextToAct", () => {
  it("wraps clockwise and skips folded and all-in seats", () => {
    const t = table(4);
    t.seats[1].status = "folded";
    t.seats[2].status = "allin";
    expect(nextToAct(t, 0)).toBe(3);
    expect(nextToAct(t, 3)).toBe(0);
  });

  it("never returns the seat it started from", () => {
    const t = table(3);
    t.seats[1].status = "folded";
    t.seats[2].status = "folded";
    expect(nextToAct(t, 0)).toBeNull();
  });
});

describe("openingActor", () => {
  it("opens postflop at the small blind", () => {
    const t = table(4);
    t.street = "flop";
    expect(openingActor(t)).toBe(1);
  });

  it("skips past seats that cannot act", () => {
    const t = table(4);
    t.street = "flop";
    t.seats[1].status = "folded";
    t.seats[2].status = "allin";
    expect(openingActor(t)).toBe(3);
  });

  it("opens preflop left of the big blind", () => {
    const t = table(4);
    expect(openingActor(t)).toBe(3);
  });
});

describe("postBlinds", () => {
  it("posts small and big and opens under the gun", () => {
    const t = table(4);
    postBlinds(t, 5, 10);
    expect(t.seats[1].streetCommit).toBe(5);
    expect(t.seats[2].streetCommit).toBe(10);
    expect(t.currentBet).toBe(10);
    expect(t.pot).toBe(15);
    expect(t.toAct).toBe(3);
  });

  it("makes the button the small blind heads-up and gives it the action", () => {
    const t = table(2);
    postBlinds(t, 5, 10);
    expect(t.seats[0].streetCommit).toBe(5);
    expect(t.seats[1].streetCommit).toBe(10);
    expect(t.toAct).toBe(0);
  });

  it("leaves blind posters not-yet-acted so the big blind keeps its option", () => {
    const t = table(3);
    postBlinds(t, 5, 10);
    expect(t.seats[1].hasActed).toBe(false);
    expect(t.seats[2].hasActed).toBe(false);
  });

  it("sets the big blind as the standing raise size", () => {
    const t = table(3);
    postBlinds(t, 5, 10);
    expect(t.lastRaiseSize).toBe(10);
  });

  it("puts a short stack all-in on its blind", () => {
    const t = table(3, 4);
    postBlinds(t, 5, 10);
    expect(t.seats[1].status).toBe("allin");
    expect(t.pot).toBe(8); // both blinds capped at the 4-chip stacks
  });
});

describe("bettingClosed", () => {
  it("stays open while the big blind still has its option", () => {
    // Everyone limps: commits are equal, but the BB has not acted.
    const t = table(3);
    postBlinds(t, 5, 10);
    commitChips(t, 0, 10);
    recordAction(t, 0, null);
    commitChips(t, 1, 5);
    recordAction(t, 1, null);
    expect(t.seats.every((s) => s.streetCommit === t.currentBet)).toBe(true);
    expect(bettingClosed(t)).toBe(false); // BB option
    recordAction(t, 2, null);
    expect(bettingClosed(t)).toBe(true);
  });

  it("reopens after a raise even for seats that already called", () => {
    const t = table(3);
    postBlinds(t, 5, 10);
    commitChips(t, 0, 10);
    recordAction(t, 0, null); // UTG limps
    commitChips(t, 1, 5);
    recordAction(t, 1, null); // SB completes
    commitChips(t, 2, 30);
    t.currentBet = 40;
    recordAction(t, 2, 30); // BB raises
    expect(bettingClosed(t)).toBe(false);
    expect(t.seats[0].hasActed).toBe(false);
    expect(t.seats[1].hasActed).toBe(false);
    expect(t.seats[2].hasActed).toBe(true);
    expect(t.lastAggressor).toBe(2);
  });

  it("does not reopen raising after an undersized all-in", () => {
    // Standard rule: an all-in that raises by less than a full raise puts the
    // extra chips in play but does NOT give already-acted seats a re-raise.
    const t = table(3);
    t.street = "flop";
    t.currentBet = 100;
    t.lastRaiseSize = 100;
    for (const s of t.seats) {
      s.streetCommit = 100;
      s.hasActed = true;
    }
    // Seat 2 jams for 130 total, only a 30-chip raise over the 100 standing.
    t.seats[2].streetCommit = 130;
    t.currentBet = 130;
    recordAction(t, 2, 30);

    // Both must act again (they owe 30) but neither may raise.
    expect(t.seats[0].hasActed).toBe(false);
    expect(t.seats[1].hasActed).toBe(false);
    expect(t.seats[0].mayRaise).toBe(false);
    expect(t.seats[1].mayRaise).toBe(false);
    // An undersized raise does not raise the bar for the next full raise.
    expect(t.lastRaiseSize).toBe(100);
    expect(bettingClosed(t)).toBe(false);
  });

  it("does reopen raising after a full raise", () => {
    const t = table(3);
    t.street = "flop";
    t.currentBet = 100;
    t.lastRaiseSize = 100;
    for (const s of t.seats) {
      s.streetCommit = 100;
      s.hasActed = true;
      s.mayRaise = false;
    }
    t.seats[2].streetCommit = 250;
    t.currentBet = 250;
    recordAction(t, 2, 150);

    expect(t.seats[0].mayRaise).toBe(true);
    expect(t.seats[1].mayRaise).toBe(true);
    expect(t.lastRaiseSize).toBe(150);
  });

  it("closes when everyone checks around", () => {
    const t = table(4);
    t.street = "flop";
    for (const s of t.seats) recordAction(t, s.id, null);
    expect(bettingClosed(t)).toBe(true);
  });

  it("closes when no seat can act", () => {
    const t = table(3);
    t.seats[0].status = "allin";
    t.seats[1].status = "allin";
    t.seats[2].status = "folded";
    expect(actingSeats(t)).toHaveLength(0);
    expect(bettingClosed(t)).toBe(true);
  });

  it("keeps the lone live seat on the hook for an all-in it has not called", () => {
    const t = table(3);
    t.seats[1].status = "allin";
    t.seats[1].streetCommit = 200;
    t.seats[2].status = "folded";
    t.currentBet = 200;
    expect(bettingClosed(t)).toBe(false);
    commitChips(t, 0, 200);
    recordAction(t, 0, null);
    expect(bettingClosed(t)).toBe(true);
  });
});

describe("resetStreetBetting", () => {
  it("clears per-street state but not hand investment", () => {
    const t = table(3);
    postBlinds(t, 5, 10);
    recordAction(t, 0, 10);
    resetStreetBetting(t);
    expect(t.currentBet).toBe(0);
    expect(t.lastRaiseSize).toBe(0);
    expect(t.lastAggressor).toBeNull();
    expect(t.seats.every((s) => s.streetCommit === 0 && !s.hasActed)).toBe(true);
    expect(t.seats[2].invested).toBe(10);
  });
});

describe("contestingSeats / onlyOneLeft", () => {
  it("counts all-in seats as still able to win", () => {
    const t = table(4);
    t.seats[0].status = "allin";
    t.seats[1].status = "folded";
    expect(contestingSeats(t).map((s) => s.id)).toEqual([0, 2, 3]);
    expect(onlyOneLeft(t)).toBe(false);
  });

  it("detects everyone folding to one seat", () => {
    const t = table(4);
    t.seats[1].status = "folded";
    t.seats[2].status = "folded";
    t.seats[3].status = "folded";
    expect(onlyOneLeft(t)).toBe(true);
  });
});
