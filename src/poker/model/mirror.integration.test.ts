/**
 * A mirrored seat, at a table, playing hands.
 *
 * `mirror.test.ts` covers the derivation and `decider.test.ts` covers the
 * resolution order. Neither answers the question that matters most: does a table
 * with a seat the static roster has no row for actually deal? The label reaches
 * the engine as a plain string, resolution happens per decision inside `finish`,
 * and a lookup returning the wrong thing (or nothing) is silent. So this plays
 * real hands through `playHandHeadless` and checks the chips.
 */

import { describe, expect, it } from "vitest";

import { createTable, playHandHeadless, type Table } from "../table/engine";
import { tableDecider } from "./decider";
import { BOT_PROFILES } from "./profiles";
import { MIRROR_ID, mirrorProfile } from "./mirror";
import { computeStats } from "../coach/stats";
import { playSession } from "../replay/fixtures";
import type { BotProfile } from "../table/contract";

const FAST = { simulations: 400 };

/**
 * Every chip in the pots reached a seat.
 *
 * Not `totalChips` before and after: busted seats rebuy, so the table's total
 * legitimately grows across a hand and comparing the two ends measures rebuys
 * rather than the pot maths. This is the invariant a single hand actually owes,
 * and a seat whose profile failed to resolve would break it before anything
 * else showed.
 */
function potsAllPaid(report: {
  pots: { amount: number }[];
  seats: { won: number }[];
}): void {
  const inPots = report.pots.reduce((sum, p) => sum + p.amount, 0);
  const paidOut = report.seats.reduce((sum, s) => sum + s.won, 0);
  expect(paidOut).toBe(inPots);
}

function table(lineup: string[], seed = 909): Table {
  return createTable({
    seatCount: lineup.length,
    startingStack: 400,
    smallBlind: 5,
    bigBlind: 10,
    seed,
    seats: lineup.map((profile, i) => ({
      name: `Seat ${i}`,
      kind: "bot" as const,
      profile,
    })),
  });
}

/** A profile derived from hands actually played, which is the real path. */
function measuredProfile(): BotProfile {
  const { reports } = playSession({ seatCount: 3, hands: 40 });
  const derived = mirrorProfile(computeStats(reports, 0));
  if (!derived) throw new Error("fixture produced no measurable style");
  return derived;
}

describe("a table seating a mirror", () => {
  it("plays a hand to completion with the derived profile", () => {
    const mirror = measuredProfile();
    const t = table([MIRROR_ID, "tag", "station"]);
    const decide = tableDecider({
      ...FAST,
      profiles: (id) => (id === MIRROR_ID ? mirror : undefined),
    });

    const report = playHandHeadless(t, decide);
    expect(report.actions.length).toBeGreaterThan(0);
    potsAllPaid(report);
  });

  it("plays a hand to completion when the mirror cannot be resolved", () => {
    // A stored setup can name `mirror` on a machine whose archive has been
    // cleared. That must be a table, not a white screen.
    const t = table([MIRROR_ID, "tag", "station"]);
    const report = playHandHeadless(t, tableDecider(FAST));
    expect(report.actions.length).toBeGreaterThan(0);
    potsAllPaid(report);
  });

  it("seats more than one mirror without them interfering", () => {
    const mirror = measuredProfile();
    const t = table([MIRROR_ID, MIRROR_ID, "tag"]);
    const report = playHandHeadless(
      t,
      tableDecider({ ...FAST, profiles: (id) => (id === MIRROR_ID ? mirror : undefined) })
    );
    potsAllPaid(report);
  });

  it("records the label on every decision the mirrored seat made", () => {
    const mirror = measuredProfile();
    const t = table([MIRROR_ID, "tag", "station"]);
    playHandHeadless(
      t,
      tableDecider({ ...FAST, profiles: (id) => (id === MIRROR_ID ? mirror : undefined) })
    );
    const mine = t.decisions.filter((d) => d.seat === 0);
    // The review needs to be able to say which seat this was without the roster
    // carrying a row for it.
    for (const d of mine) expect(d.profile).toBe(MIRROR_ID);
  });

  it("actually plays the injected style rather than the baseline", () => {
    // The observable difference is behaviour over a run of hands. A mirror given
    // the maniac's parameters must commit more chips than one given the nit's,
    // on the same seed and the same table, or the injection is decorative.
    const asOne = (source: BotProfile) => {
      const t = table([MIRROR_ID, "tag", "station"], 4141);
      const decide = tableDecider({
        ...FAST,
        profiles: (id) =>
          id === MIRROR_ID
            ? { ...source, id: MIRROR_ID as BotProfile["id"] }
            : undefined,
      });
      let invested = 0;
      for (let i = 0; i < 6; i++) {
        const report = playHandHeadless(t, decide);
        invested += report.seats.find((s) => s.seat === 0)?.invested ?? 0;
      }
      return invested;
    };

    const wild = asOne(BOT_PROFILES.maniac);
    const tight = asOne(BOT_PROFILES.nit);
    expect(wild).toBeGreaterThan(tight);
  });
});
