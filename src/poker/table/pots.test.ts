import { describe, expect, it } from "vitest";
import { awardPots, buildPots, type SeatContribution } from "./pots";

const seat = (
  id: number,
  invested: number,
  folded = false
): SeatContribution => ({ id, invested, folded });

const sum = (xs: number[]) => xs.reduce((n, v) => n + v, 0);

/** Every chip put in must come back out as either pot money or a refund. */
function expectConserved(contributions: SeatContribution[]) {
  const { pots, refunds } = buildPots(contributions);
  const out = sum(pots.map((p) => p.amount)) + sum(Object.values(refunds));
  expect(out).toBe(sum(contributions.map((c) => c.invested)));
}

/**
 * The side-pot cap: a seat that invested X can never win more than
 * Σ_j min(X, invested_j) — it only ever covered that much of each opponent.
 * Conservation alone does not imply this, which is exactly how an earlier bug
 * that over-paid a short all-in slipped through.
 */
function expectWithinCap(contributions: SeatContribution[]) {
  const { pots } = buildPots(contributions);
  for (const me of contributions) {
    if (me.folded) continue;
    const cap = sum(contributions.map((c) => Math.min(me.invested, c.invested)));
    const winnable = sum(
      pots.filter((p) => p.eligible.includes(me.id)).map((p) => p.amount)
    );
    expect(winnable).toBeLessThanOrEqual(cap);
  }
}

describe("buildPots", () => {
  it("makes a single pot when everyone matched", () => {
    const { pots, refunds } = buildPots([seat(0, 100), seat(1, 100), seat(2, 100)]);
    expect(pots).toEqual([{ amount: 300, eligible: [0, 1, 2] }]);
    expect(refunds).toEqual({});
  });

  it("splits a main and side pot around one short all-in", () => {
    // Seat 0 is all-in for 50; seats 1 and 2 continue to 200.
    const { pots } = buildPots([seat(0, 50), seat(1, 200), seat(2, 200)]);
    expect(pots).toEqual([
      { amount: 150, eligible: [0, 1, 2] }, // 50 x 3
      { amount: 300, eligible: [1, 2] }, // 150 x 2
    ]);
  });

  it("builds a layer per distinct all-in level", () => {
    const { pots } = buildPots([
      seat(0, 25),
      seat(1, 60),
      seat(2, 100),
      seat(3, 100),
    ]);
    expect(pots).toEqual([
      { amount: 100, eligible: [0, 1, 2, 3] }, // 25 x 4
      { amount: 105, eligible: [1, 2, 3] }, // 35 x 3
      { amount: 80, eligible: [2, 3] }, // 40 x 2
    ]);
  });

  it("refunds an uncalled bet instead of potting it", () => {
    // Seat 2 bet 200 but only seat 0 called 50 and seat 1 folded at 50.
    const { pots, refunds } = buildPots([
      seat(0, 50),
      seat(1, 50, true),
      seat(2, 200),
    ]);
    expect(refunds).toEqual({ 2: 150 });
    expect(pots).toEqual([{ amount: 150, eligible: [0, 2] }]);
  });

  it("keeps folded seats' chips in the pot but not their eligibility", () => {
    const { pots } = buildPots([seat(0, 100), seat(1, 100, true), seat(2, 100)]);
    expect(pots).toEqual([{ amount: 300, eligible: [0, 2] }]);
  });

  it("merges adjacent layers contested by the same seats", () => {
    // Seat 1 folded at 40, so both layers are contested by exactly seats 0 and
    // 2. Splitting them would be a distinction without a difference.
    const { pots } = buildPots([seat(0, 100), seat(1, 40, true), seat(2, 100)]);
    expect(pots).toEqual([{ amount: 240, eligible: [0, 2] }]);
  });

  it("refunds money nobody live can win rather than losing it", () => {
    // Degenerate: every contributor folded, so there is no pot to absorb it.
    const { pots, refunds } = buildPots([seat(0, 50, true), seat(1, 50, true)]);
    expect(pots).toEqual([]);
    expect(refunds).toEqual({ 0: 50, 1: 50 });
  });

  it("never pays a short all-in more than it covered", () => {
    // Seat 0 is all-in for 50; the two deep seats built a 300 side pot and then
    // both folded. That side pot is not seat 0's to win — it only covered 50 of
    // each opponent, so its ceiling is 150.
    const { pots, refunds } = buildPots([
      seat(0, 50),
      seat(1, 200, true),
      seat(2, 200, true),
    ]);
    expect(pots).toEqual([{ amount: 150, eligible: [0] }]);
    expect(refunds).toEqual({ 1: 150, 2: 150 });
  });

  it("handles a walk where everyone else folded", () => {
    const { pots, refunds } = buildPots([
      seat(0, 10),
      seat(1, 5, true),
      seat(2, 0, true),
    ]);
    expect(refunds).toEqual({ 0: 5 });
    expect(pots).toEqual([{ amount: 10, eligible: [0] }]);
  });

  it("ignores seats that put in nothing", () => {
    const { pots } = buildPots([seat(0, 100), seat(1, 100), seat(2, 0, true)]);
    expect(pots).toEqual([{ amount: 200, eligible: [0, 1] }]);
  });

  it("conserves chips and respects the cap across random shapes", () => {
    let s = 12345;
    const rand = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
    for (let trial = 0; trial < 2000; trial++) {
      const n = 2 + rand(4);
      const contributions = Array.from({ length: n }, (_, id) =>
        seat(id, rand(200), rand(3) === 0)
      );
      expectConserved(contributions);
      expectWithinCap(contributions);
    }
  });

  it("respects the cap exhaustively over small contribution shapes", () => {
    // 4 seats x invested 0..4 x folded/not — small enough to enumerate, and it
    // is where the layered edge cases actually live.
    for (let mask = 0; mask < 5 ** 4 * 2 ** 4; mask++) {
      let m = mask;
      const contributions: SeatContribution[] = [];
      for (let id = 0; id < 4; id++) {
        const invested = m % 5;
        m = Math.floor(m / 5);
        contributions.push(seat(id, invested, false));
      }
      for (let id = 0; id < 4; id++) {
        contributions[id].folded = m % 2 === 1;
        m = Math.floor(m / 2);
      }
      expectConserved(contributions);
      expectWithinCap(contributions);
    }
  });
});

describe("awardPots", () => {
  it("gives the whole pot to the best hand", () => {
    const { pots } = buildPots([seat(0, 100), seat(1, 100), seat(2, 100)]);
    expect(awardPots(pots, { 0: 5, 1: 9, 2: 3 }, [0, 1, 2])).toEqual({ 1: 300 });
  });

  it("lets a short all-in win only the main pot", () => {
    const { pots } = buildPots([seat(0, 50), seat(1, 200), seat(2, 200)]);
    // Seat 0 has the best hand but is only in for the main pot.
    const won = awardPots(pots, { 0: 9, 1: 7, 2: 3 }, [0, 1, 2]);
    expect(won).toEqual({ 0: 150, 1: 300 });
  });

  it("splits evenly between tied winners", () => {
    const { pots } = buildPots([seat(0, 100), seat(1, 100)]);
    expect(awardPots(pots, { 0: 7, 1: 7 }, [0, 1])).toEqual({ 0: 100, 1: 100 });
  });

  it("gives an odd chip to the first seat in odd-chip order", () => {
    // A 15-chip pot split between two tied winners leaves one indivisible chip.
    const { pots } = buildPots([seat(0, 5), seat(1, 5), seat(2, 5)]);
    expect(pots[0].amount).toBe(15);

    const won = awardPots(pots, { 0: 7, 1: 7 }, [1, 0, 2]);
    expect(won).toEqual({ 0: 7, 1: 8 });

    // Reversing the order moves the odd chip to the other winner.
    expect(awardPots(pots, { 0: 7, 1: 7 }, [0, 1, 2])).toEqual({ 0: 8, 1: 7 });
  });

  it("never creates or destroys chips when awarding", () => {
    const contributions = [seat(0, 25), seat(1, 60), seat(2, 100), seat(3, 100)];
    const layout = buildPots(contributions);
    const won = awardPots(layout.pots, { 0: 9, 1: 9, 2: 4, 3: 4 }, [0, 1, 2, 3]);
    const out =
      Object.values(won).reduce((n, v) => n + v, 0) +
      Object.values(layout.refunds).reduce((n, v) => n + v, 0);
    expect(out).toBe(contributions.reduce((n, c) => n + c.invested, 0));
  });

  it("throws rather than silently destroying an unscored pot", () => {
    const { pots } = buildPots([seat(0, 50), seat(1, 200), seat(2, 200)]);
    // Seats 1 and 2 are eligible for the side pot but unscored — a caller bug.
    // Skipping it would vaporize 300 chips, so it must be loud.
    expect(() => awardPots(pots, { 0: 9 }, [0, 1, 2])).toThrow(/no scored contender/);
  });

  it("still hands out every odd chip when oddChipOrder is incomplete", () => {
    // 20 chips, three-way tie: share 6, remainder 2. An order that omits the
    // winners must not drop those two chips.
    const { pots } = buildPots([seat(0, 20), seat(1, 20), seat(2, 20)]);
    expect(pots[0].amount).toBe(60);

    const score = { 0: 7, 1: 7, 2: 7 };
    for (const order of [[0, 1, 2], [0], [], [2]]) {
      const won = awardPots(pots, score, order);
      expect(Object.values(won).reduce((n, v) => n + v, 0)).toBe(60);
    }
  });

  it("gives no winner two odd chips while another gets none", () => {
    const { pots } = buildPots([seat(0, 20), seat(1, 20), seat(2, 20)]);
    // remainder 2 over 3 winners: two distinct seats get one each.
    const won = awardPots(pots, { 0: 7, 1: 7, 2: 7 }, [0]);
    expect(Object.values(won).sort()).toEqual([20, 20, 20]);
  });
});
