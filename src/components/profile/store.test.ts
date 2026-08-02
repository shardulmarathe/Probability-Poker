import { describe, expect, it } from "vitest";
import { computeStats } from "../../poker/coach/stats";
import { classifyStats } from "../../poker/coach/archetype";
import { playSession } from "../../poker/replay/fixtures";
import { replayHand } from "../../poker/replay/reconstruct";
import type { TableHandReport } from "../../poker/table/contract";
import {
  MAX_STORED_HANDS,
  mergeHands,
  normalizeArchive,
  normalizeReport,
} from "./store";

const BLINDS = { smallBlind: 5, bigBlind: 10 };

function session(hands = 6, seed = 99): TableHandReport[] {
  return playSession({ seatCount: 4, hands, seed, ...BLINDS }).reports;
}

/** What a report looks like after a round trip through JSON. */
function stored(report: TableHandReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...report, decisions: [] }));
}

/** A report with one field replaced by something storage could hold. */
function tampered(
  report: TableHandReport,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...stored(report), ...patch };
}

describe("normalizeReport", () => {
  it("round-trips a real report through JSON unchanged", () => {
    for (const report of session()) {
      const back = normalizeReport(stored(report));
      expect(back).toEqual({ ...report, decisions: [] });
    }
  });

  it("keeps a normalised report replayable", () => {
    for (const report of session()) {
      const back = normalizeReport(stored(report));
      expect(back).not.toBeNull();
      expect(replayHand(back!, { config: BLINDS }).fidelity.ok).toBe(true);
    }
  });

  it("rejects anything that would throw inside createTable or positionOf", () => {
    const good = session(1)[0];
    // Seat counts outside 2-6 throw in `positionOf` and `createTable`; a button
    // that is not a seat indexes past the end of the layout table.
    expect(normalizeReport(tampered(good, { seatCount: 9 }))).toBeNull();
    expect(normalizeReport(tampered(good, { seatCount: 1 }))).toBeNull();
    expect(normalizeReport(tampered(good, { seatCount: 4.5 }))).toBeNull();
    expect(normalizeReport(tampered(good, { button: 4 }))).toBeNull();
    expect(normalizeReport(tampered(good, { button: -1 }))).toBeNull();
    expect(normalizeReport(tampered(good, { seed: "12" }))).toBeNull();
    expect(normalizeReport(tampered(good, { handNumber: 0 }))).toBeNull();
  });

  it("rejects malformed collections rather than half-reading them", () => {
    const good = stored(session(1)[0]) as Record<string, unknown>;
    expect(normalizeReport({ ...good, seats: [] })).toBeNull();
    expect(normalizeReport({ ...good, seats: "nope" })).toBeNull();
    expect(normalizeReport({ ...good, actions: {} })).toBeNull();
    expect(normalizeReport({ ...good, pots: null })).toBeNull();
    expect(normalizeReport({ ...good, board: [0, 1] })).toBeNull();
    expect(normalizeReport({ ...good, board: [0, 1, 99] })).toBeNull();
    expect(normalizeReport({ ...good, endStreet: "fifth" })).toBeNull();
  });

  it("rejects a duplicated card, which would break the equity samplers", () => {
    const good = session(1)[0];
    const seats = good.seats.map((s, i) =>
      i === 0 && s.hole.length === 2 ? { ...s, hole: [s.hole[0], s.hole[0]] } : s
    );
    expect(normalizeReport(stored({ ...good, seats }))).toBeNull();

    const collide = good.seats.map((s, i) =>
      i === 1 && s.hole.length === 2 ? { ...s, hole: [good.seats[0].hole[0], s.hole[1]] } : s
    );
    expect(normalizeReport(stored({ ...good, seats: collide }))).toBeNull();
  });

  it("rejects a bad action record", () => {
    const good = session(1)[0];
    const first = stored(good).actions as Record<string, unknown>[];
    for (const patch of [
      { seat: 9 },
      { seat: -1 },
      { action: "shove" },
      { street: "fifth" },
      { cost: -5 },
      { cost: "10" },
      { toCall: null },
    ]) {
      expect(
        normalizeReport(tampered(good, { actions: [{ ...first[0], ...patch }] }))
      ).toBeNull();
    }
  });

  it("recomputes net rather than trusting a stored one", () => {
    const good = session(1)[0];
    const seats = (stored(good).seats as Record<string, unknown>[]).map((s, i) =>
      i === 0 ? { ...s, net: 999999 } : s
    );
    const back = normalizeReport(tampered(good, { seats }));
    expect(back).not.toBeNull();
    expect(back!.seats[0].net).toBe(back!.seats[0].won - back!.seats[0].invested);
  });

  it("always strips the decision audit trail", () => {
    const { table, reports } = playSession({ seatCount: 3, hands: 1, seed: 5, ...BLINDS });
    expect(table.seats.length).toBe(3);
    const withDecisions = { ...reports[0], decisions: [{ junk: true }] } as unknown;
    const back = normalizeReport(withDecisions);
    expect(back?.decisions).toEqual([]);
  });
});

describe("normalizeArchive", () => {
  it("drops only the hands that fail, keeping the rest", () => {
    const hands = session(5).map(stored);
    const archive = normalizeArchive({
      hands: [...hands.slice(0, 2), { seatCount: 42 }, "garbage", null, ...hands.slice(2)],
      smallBlind: 5,
      bigBlind: 10,
      heroSeat: 0,
    });
    expect(archive.hands.length).toBe(5);
  });

  it("survives every shape of junk", () => {
    for (const junk of [null, undefined, 0, "", [], "hello", { hands: 7 }, { hands: {} }]) {
      const archive = normalizeArchive(junk);
      expect(archive.hands).toEqual([]);
      expect(archive.smallBlind).toBeGreaterThan(0);
      expect(archive.bigBlind).toBeGreaterThanOrEqual(archive.smallBlind);
    }
  });

  it("clamps blinds the engine would reject", () => {
    expect(normalizeArchive({ smallBlind: 100, bigBlind: 10 }).bigBlind).toBe(100);
    expect(normalizeArchive({ smallBlind: -1, bigBlind: 10 }).smallBlind).toBe(5);
    expect(normalizeArchive({ smallBlind: 1e12, bigBlind: 1e12 }).smallBlind).toBe(5);
    expect(normalizeArchive({ smallBlind: 2.5, bigBlind: 5 }).smallBlind).toBe(5);
  });

  it("rejects a hero seat that is not a seat", () => {
    expect(normalizeArchive({ heroSeat: 9 }).heroSeat).toBeNull();
    expect(normalizeArchive({ heroSeat: -1 }).heroSeat).toBeNull();
    expect(normalizeArchive({ heroSeat: 2 }).heroSeat).toBe(2);
    expect(normalizeArchive({}).heroSeat).toBeNull();
  });

  it("caps the archive", () => {
    const hands = Array.from({ length: MAX_STORED_HANDS + 50 }, (_, i) => ({
      ...stored(session(1)[0]) as Record<string, unknown>,
      seed: i + 1,
    }));
    expect(normalizeArchive({ hands }).hands.length).toBe(MAX_STORED_HANDS);
  });

  it("leaves a normalised archive usable by the tracker", () => {
    const archive = normalizeArchive({ hands: session(8).map(stored) });
    const stats = computeStats(archive.hands, 0);
    expect(stats.total.hands).toBe(8);
    expect(classifyStats(stats).hands).toBe(8);
  });
});

describe("mergeHands", () => {
  it("keys on the deal seed, so two sessions do not collide", () => {
    // Hand numbers restart at 1 for every new table, which is exactly why the
    // seed is the identity here.
    const first = session(4, 1);
    const second = session(4, 2);
    expect(first[0].handNumber).toBe(second[0].handNumber);

    const merged = mergeHands(first, second);
    expect(merged.length).toBe(8);
    expect(new Set(merged.map((h) => h.seed)).size).toBe(8);
  });

  it("prefers the live copy, which still has its decisions", () => {
    const hands = session(2);
    const archived = hands.map((h) => ({ ...h, decisions: [] }));
    const live = hands.map((h) => ({ ...h, decisions: [{ seat: 0 }] })) as TableHandReport[];
    const merged = mergeHands(archived, live);
    expect(merged.length).toBe(2);
    expect(merged.every((h) => h.decisions.length === 1)).toBe(true);
  });

  it("drops a live hand that does not normalise", () => {
    const hands = session(3);
    const broken = { ...hands[0], seatCount: 99 } as TableHandReport;
    expect(mergeHands([], [broken, hands[1]]).length).toBe(1);
  });

  it("caps the result", () => {
    const many = Array.from({ length: MAX_STORED_HANDS + 20 }, (_, i) => ({
      ...session(1)[0],
      seed: i + 1,
    }));
    expect(mergeHands(many, []).length).toBe(MAX_STORED_HANDS);
  });
});
