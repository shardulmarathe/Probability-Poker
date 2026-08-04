import { describe, expect, it } from "vitest";
import { hashSeed } from "../core/rng";
import { tableDecider } from "../model/decider";
import { BOT_ARCHETYPES } from "../model/profiles";
import { createTable, handSeed, playHandHeadless } from "../table/engine";
import type { TableHandReport } from "../table/contract";
import { playSession } from "./fixtures";
import { compareReports, replayHand } from "./reconstruct";
import { mix32, seedRecoveryHolds, sessionSeedForHand, unmix32 } from "./seed";
import { entryStacks, inferBlinds, replayBlocker } from "./table";

// ---------------------------------------------------------------------------
// Seed recovery, the mechanism the whole replay rests on
// ---------------------------------------------------------------------------

describe("mix32", () => {
  it("is a bijection on uint32, which is what makes the seed invertible", () => {
    // The claim the whole replay rests on. Swept rather than spot-checked: a
    // finalizer that collided anywhere would produce a hand that replays as
    // somebody else's cards, with nothing to say why.
    let checked = 0;
    for (let i = 0; i < 300_000; i++) {
      const x = Math.imul(i, 2654435761) >>> 0;
      expect(unmix32(mix32(x))).toBe(x);
      checked++;
    }
    for (const edge of [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      expect(unmix32(mix32(edge))).toBe(edge);
    }
    expect(checked).toBe(300_000);
  });
});

describe("sessionSeedForHand", () => {
  it("inverts handSeed for every hand number it is given", () => {
    for (let handNumber = 1; handNumber <= 64; handNumber++) {
      for (const sessionSeed of [0, 1, 12345, 0xdeadbeef, 0xffffffff]) {
        const target = handSeed(sessionSeed, handNumber);
        const recovered = sessionSeedForHand(target, handNumber);
        expect(handSeed(recovered, handNumber)).toBe(target);
      }
    }
  });

  it("holds across a wide sweep of arbitrary hand seeds", () => {
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const target = hashSeed(i, i * 7919 + 13) >>> 0;
      const handNumber = 1 + (i % 200);
      expect(seedRecoveryHolds(target, handNumber)).toBe(true);
      checked++;
    }
    expect(checked).toBe(4000);
  });

  it("returns a uint32", () => {
    const seed = sessionSeedForHand(0xffffffff, 7);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// Fidelity, reconstructing a hand must reproduce it exactly
// ---------------------------------------------------------------------------

const BLIND_LEVELS = [
  { smallBlind: 5, bigBlind: 10 },
  { smallBlind: 1, bigBlind: 2 },
  { smallBlind: 25, bigBlind: 50 },
  { smallBlind: 10, bigBlind: 10 },
] as const;

const DEPTHS = [40, 200, 1000];

interface Fixture {
  report: TableHandReport;
  config: { smallBlind: number; bigBlind: number };
}

/**
 * Every table size across a spread of blind levels and stack depths, several
 * sessions each so stacks drift between hands, a report's entry stacks are
 * whatever the last hand left behind, never the table's starting stack.
 */
function allFixtureHands(): Fixture[] {
  const out: Fixture[] = [];
  let n = 0;
  for (let seatCount = 2; seatCount <= 6; seatCount++) {
    for (const config of BLIND_LEVELS) {
      for (const depth of DEPTHS) {
        for (let s = 0; s < 4; s++) {
          const session = playSession({
            seatCount,
            hands: 9,
            seed: 0x9e37 * ++n + seatCount,
            startingStack: depth * config.bigBlind,
            ...config,
          });
          for (const report of session.reports) out.push({ report, config });
        }
      }
    }
  }
  return out;
}

describe("replayHand fidelity", () => {
  it("reproduces every fixture hand exactly, at 2-6 seats", () => {
    const fixtures = allFixtureHands();
    expect(fixtures.length).toBe(2160);

    const failures: string[] = [];
    for (const { report, config } of fixtures) {
      const replay = replayHand(report, { config });
      if (!replay.fidelity.ok) {
        failures.push(
          `hand ${report.handNumber} (${report.seatCount} seats, ${config.smallBlind}/${config.bigBlind}): ${replay.fidelity.mismatches[0]}`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("reproduces hands the real bots played, at production shape", () => {
    // The random picker above is far more aggressive than any bot, which is
    // what makes it a good stress test and a bad sample of real play. These are
    // hands the shipped decider actually chose, start to finish.
    const decide = tableDecider({ simulations: 400 });
    const failures: string[] = [];
    let hands = 0;

    for (let seatCount = 2; seatCount <= 6; seatCount++) {
      const table = createTable({
        seatCount,
        startingStack: 1000,
        smallBlind: 5,
        bigBlind: 10,
        seed: 4321 + seatCount,
        seats: Array.from({ length: seatCount }, (_, i) => ({
          name: `Seat ${i}`,
          kind: "bot" as const,
          profile: BOT_ARCHETYPES[i % BOT_ARCHETYPES.length],
        })),
      });
      for (let h = 0; h < 8; h++) {
        const report = playHandHeadless(table, decide);
        hands++;
        const replay = replayHand(report, { config: { smallBlind: 5, bigBlind: 10 } });
        if (!replay.fidelity.ok) {
          failures.push(
            `hand ${report.handNumber} (${seatCount} seats): ${replay.fidelity.mismatches[0]}`
          );
        }
      }
    }

    expect(hands).toBe(40);
    expect(failures).toEqual([]);
  });

  it("covers the shapes that make reconstruction hard", () => {
    const reports = allFixtureHands().map((f) => f.report);
    const showdowns = reports.filter((r) => r.wentToShowdown).length;
    const sidePots = reports.filter((r) => r.pots.length > 1).length;
    const allIns = reports.filter((r) =>
      r.seats.some((s) => s.status === "allin")
    ).length;
    const chops = reports.filter((r) => r.pots.some((p) => p.winners.length > 1)).length;
    const cappedCalls = reports.filter((r) =>
      r.actions.some((a) => a.action === "fold" && a.toCall < a.potBefore / 4)
    ).length;

    // Guards on the fixture, not the replay: if a future change made these
    // hands tame, the fidelity test above would still pass while testing far
    // less than it claims to.
    expect(showdowns).toBeGreaterThan(400);
    expect(sidePots).toBeGreaterThan(100);
    expect(allIns).toBeGreaterThan(400);
    expect(chops).toBeGreaterThan(5);
    expect(cappedCalls).toBeGreaterThan(50);
  });

  it("produces one frame for the deal plus one per action", () => {
    const { reports } = playSession({ seatCount: 4, hands: 4, seed: 77 });
    for (const report of reports) {
      const replay = replayHand(report, { config: { smallBlind: 5, bigBlind: 10 } });
      expect(replay.fidelity.ok).toBe(true);
      expect(replay.frames.length).toBe(report.actions.length + 1);
      expect(replay.frames[0].action).toBeNull();
      expect(replay.frames[0].board).toEqual([]);
    }
  });

  it("frames track the pot and the board as the hand runs", () => {
    const { reports } = playSession({ seatCount: 3, hands: 12, seed: 909 });
    const report = reports.find((r) => r.endStreet === "showdown" && r.board.length === 5);
    expect(report).toBeDefined();

    const replay = replayHand(report!, { config: { smallBlind: 5, bigBlind: 10 } });
    expect(replay.fidelity.ok).toBe(true);

    // The board only ever grows, and lands on the recorded one.
    let seen = 0;
    for (const frame of replay.frames) {
      expect(frame.board.length).toBeGreaterThanOrEqual(seen);
      seen = frame.board.length;
    }
    expect(replay.frames[replay.frames.length - 1].board).toEqual(report!.board);

    // Chips are conserved while the hand is live: stacks plus pot never moves.
    // The settled frame is excluded because `resolve` rebuys any busted seat,
    // which is the one place the engine legitimately creates chips.
    const live = replay.frames.filter((f) => f.status === "playing");
    const totals = live.map((f) => f.pot + f.seats.reduce((n, s) => n + s.stack, 0));
    expect(live.length).toBeGreaterThan(1);
    expect(new Set(totals).size).toBe(1);
  });

  it("hole cards in the frames match the report", () => {
    const { reports } = playSession({ seatCount: 5, hands: 5, seed: 4242 });
    for (const report of reports) {
      const replay = replayHand(report, { config: { smallBlind: 5, bigBlind: 10 } });
      for (const seat of report.seats) {
        expect(replay.frames[0].seats[seat.seat].hole).toEqual(seat.hole);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The check itself has to be able to fail
// ---------------------------------------------------------------------------

describe("compareReports", () => {
  it("is empty for a report against itself", () => {
    const { reports } = playSession({ seatCount: 4, hands: 3, seed: 5 });
    expect(compareReports(reports[0], reports[0])).toEqual([]);
  });

  it("names a changed board", () => {
    const { reports } = playSession({ seatCount: 4, hands: 3, seed: 5 });
    const tampered = { ...reports[0], board: [0, 1, 2, 3, 4] };
    const diff = compareReports(reports[0], tampered);
    expect(diff.some((line) => line.startsWith("board:"))).toBe(true);
  });

  it("names a changed net", () => {
    const { reports } = playSession({ seatCount: 4, hands: 3, seed: 5 });
    const seats = reports[0].seats.map((s, i) => (i === 0 ? { ...s, net: s.net + 1 } : s));
    const diff = compareReports(reports[0], { ...reports[0], seats });
    expect(diff.some((line) => line.includes("net"))).toBe(true);
  });

  it("names a changed pot layout", () => {
    const { reports } = playSession({ seatCount: 4, hands: 3, seed: 5 });
    const pots = [...reports[0].pots, { amount: 1, eligible: [0], winners: [0] }];
    const diff = compareReports(reports[0], { ...reports[0], pots });
    expect(diff.some((line) => line.startsWith("pot layers:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recovering what the report does not store
// ---------------------------------------------------------------------------

describe("inferBlinds", () => {
  it("recovers the blinds at every table size", () => {
    for (let seatCount = 2; seatCount <= 6; seatCount++) {
      for (const config of [
        { smallBlind: 5, bigBlind: 10 },
        { smallBlind: 1, bigBlind: 2 },
        { smallBlind: 25, bigBlind: 50 },
      ]) {
        const { reports } = playSession({
          seatCount,
          hands: 4,
          seed: 31,
          // Deep enough that no blind is ever posted short, a crippled blind
          // breaks the premise the inference rests on, which is what the
          // fallback and the `sane` guard are for.
          startingStack: 100 * config.bigBlind,
          ...config,
        });
        const clean = reports.filter(
          (r) => r.actions.length > 0 && r.actions[0].potBefore === config.smallBlind + config.bigBlind
        );
        expect(clean.length).toBeGreaterThan(0);
        for (const report of clean) {
          expect(inferBlinds(report)).toEqual(config);
        }
      }
    }
  });

  it("lets a replay work with no config at all", () => {
    const { reports } = playSession({ seatCount: 4, hands: 6, seed: 808 });
    for (const report of reports) {
      expect(replayHand(report).fidelity.ok).toBe(true);
    }
  });
});

describe("entryStacks", () => {
  it("pins an all-in seat to exactly what it invested", () => {
    const { reports } = playSession({ seatCount: 4, hands: 20, seed: 12 });
    const report = reports.find((r) => r.seats.some((s) => s.status === "allin"));
    expect(report).toBeDefined();

    const stacks = entryStacks(report!, 10_000);
    for (const seat of report!.seats) {
      if (seat.status === "allin") expect(stacks[seat.seat]).toBe(seat.invested);
      else expect(stacks[seat.seat]).toBeGreaterThan(seat.invested);
    }
  });

  it("replays identically whatever depth is assumed for the survivors", () => {
    const { reports } = playSession({ seatCount: 5, hands: 8, seed: 60 });
    for (const report of reports) {
      for (const startingStack of [400, 5_000, 250_000]) {
        const replay = replayHand(report, {
          config: { smallBlind: 5, bigBlind: 10 },
          startingStack,
        });
        expect(replay.fidelity.mismatches).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------

describe("replayBlocker", () => {
  const good = () => playSession({ seatCount: 3, hands: 1, seed: 3 }).reports[0];

  it("passes a real report", () => {
    expect(replayBlocker(good())).toBeNull();
  });

  it("rejects impossible tables rather than letting createTable throw", () => {
    expect(replayBlocker({ ...good(), seatCount: 9 })).toContain("seat count");
    expect(replayBlocker({ ...good(), seatCount: 0 })).toContain("seat count");
    expect(replayBlocker({ ...good(), button: 7 })).toContain("button");
    expect(replayBlocker({ ...good(), seed: Number.NaN })).toContain("seed");
    expect(
      replayBlocker({ ...good(), actions: undefined as unknown as [] })
    ).toContain("action list");
    expect(replayBlocker({ ...good(), seats: [] })).toContain("seat results");
  });

  it("makes replayHand report the problem instead of throwing", () => {
    const replay = replayHand({ ...good(), button: 99 });
    expect(replay.fidelity.ok).toBe(false);
    expect(replay.fidelity.mismatches[0]).toContain("cannot replay");
    expect(replay.frames).toEqual([]);
    expect(replay.replayed).toBeNull();
  });

  it("reports a divergence rather than forcing an illegal move through", () => {
    const report = good();
    const actions = report.actions.map((a, i) =>
      i === 0 ? { ...a, cost: a.cost + 7777 } : a
    );
    const replay = replayHand({ ...report, actions });
    expect(replay.fidelity.ok).toBe(false);
    expect(replay.fidelity.mismatches.join(" ")).toContain("not legal");
  });
});
