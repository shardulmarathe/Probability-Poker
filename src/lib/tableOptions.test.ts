import { describe, expect, it } from "vitest";
import {
  botsNeeded,
  DEFAULT_SETUP,
  fitLineup,
  MAX_SEATS,
  MIN_SEATS,
  normalizeSetup,
  startingStack,
  STACK_DEPTHS,
  type TableSetup,
} from "./tableOptions";
import { BOT_PROFILES, type BuiltArchetype } from "../poker/model/profiles";
import type { BotArchetype, BotProfile } from "../poker/table/contract";
import { MIRROR_ID } from "../poker/model/mirror";

/**
 * The static roster read with a lineup's wider id type.
 *
 * `lineup` admits `mirror`, which has no row on purpose, so indexing needs to
 * be able to come back undefined. The assertions below still demand a row: no
 * path in this file seats a mirror, and that is the property being checked.
 */
const rosterRow = (id: BotArchetype) =>
  (BOT_PROFILES as Record<string, BotProfile | undefined>)[id];


describe("botsNeeded", () => {
  it("leaves a seat for the human", () => {
    expect(botsNeeded({ seatCount: 4, observer: false })).toBe(3);
    expect(botsNeeded({ seatCount: 2, observer: false })).toBe(1);
  });

  it("fills every seat in observer mode", () => {
    expect(botsNeeded({ seatCount: 4, observer: true })).toBe(4);
  });
});

describe("fitLineup", () => {
  it("keeps existing picks when growing the table", () => {
    const kept: BuiltArchetype[] = ["rock", "maniac"];
    const grown = fitLineup(kept, 4, 1);
    expect(grown).toHaveLength(4);
    expect(grown.slice(0, 2)).toEqual(kept);
    // Distinctness is the point of the roster, filler must not repeat a pick.
    expect(new Set(grown).size).toBe(grown.length);
  });

  it("produces distinct bots for every size and seed", () => {
    for (let n = 1; n <= MAX_SEATS; n++) {
      for (const seed of [0, 1, 2, 3, 9, 99]) {
        for (const start of [[], ["maniac"], ["maniac", "nit"]] as BuiltArchetype[][]) {
          const out = fitLineup(start, n, seed);
          expect(out).toHaveLength(n);
          expect(new Set(out).size).toBe(n);
        }
      }
    }
  });

  it("truncates from the end when shrinking", () => {
    const lineup: BuiltArchetype[] = ["rock", "maniac", "tag", "nit"];
    expect(fitLineup(lineup, 2, 1)).toEqual(["rock", "maniac"]);
  });

  it("is a no-op at the right size", () => {
    const lineup: BuiltArchetype[] = ["rock", "maniac"];
    expect(fitLineup(lineup, 2, 1)).toBe(lineup);
  });

  it("fills an empty lineup to any legal table size", () => {
    for (let n = 1; n <= MAX_SEATS; n++) {
      const filled = fitLineup([], n, 7);
      expect(filled).toHaveLength(n);
      for (const id of filled) expect(rosterRow(id)).toBeDefined();
    }
  });

  it("is reproducible from a seed", () => {
    expect(fitLineup([], 5, 42)).toEqual(fitLineup([], 5, 42));
  });
});

describe("normalizeSetup", () => {
  const base = (over: Partial<TableSetup>): TableSetup =>
    ({ ...DEFAULT_SETUP, ...over }) as TableSetup;

  it("clamps seat count into range", () => {
    expect(normalizeSetup(base({ seatCount: 99 })).seatCount).toBe(MAX_SEATS);
    expect(normalizeSetup(base({ seatCount: 0 })).seatCount).toBe(MIN_SEATS);
  });

  it("rejects a stack depth that is not on the menu", () => {
    expect(normalizeSetup(base({ stackBb: 37 as never })).stackBb).toBe(
      DEFAULT_SETUP.stackBb
    );
    for (const d of STACK_DEPTHS) {
      expect(normalizeSetup(base({ stackBb: d })).stackBb).toBe(d);
    }
  });

  it("drops archetypes that no longer exist", () => {
    // Storage may predate a roster change; an unknown id must not reach the table.
    const setup = normalizeSetup(
      base({ lineup: ["rock", "ghost" as never, "maniac"], seatCount: 4 })
    );
    expect(setup.lineup).toHaveLength(3);
    for (const id of setup.lineup) expect(rosterRow(id)).toBeDefined();
  });

  it("always produces exactly enough bots for the seats", () => {
    for (let seats = MIN_SEATS; seats <= MAX_SEATS; seats++) {
      for (const observer of [false, true]) {
        const s = normalizeSetup(base({ seatCount: seats, observer, lineup: [] }));
        expect(s.lineup).toHaveLength(botsNeeded({ seatCount: seats, observer }));
      }
    }
  });

  it("falls back on an unknown mode", () => {
    expect(normalizeSetup(base({ mode: "cheat" as never })).mode).toBe(
      DEFAULT_SETUP.mode
    );
  });

  it("rejects non-positive blinds", () => {
    const s = normalizeSetup(base({ smallBlind: 0, bigBlind: -5 }));
    expect(s.smallBlind).toBe(DEFAULT_SETUP.smallBlind);
    expect(s.bigBlind).toBe(DEFAULT_SETUP.bigBlind);
  });

  it("never lets the big blind fall below the small blind", () => {
    // createTable throws on bigBlind < smallBlind, and because the bad value is
    // persisted that throw survives a reload, it bricks the app, not one hand.
    const s = normalizeSetup(base({ smallBlind: 50, bigBlind: 10 }));
    expect(s.bigBlind).toBeGreaterThanOrEqual(s.smallBlind);
  });

  it("forces blinds to whole chips", () => {
    // Settlement floors and walks an odd-chip remainder; fractional chips make
    // the payout disagree with the pot and the engine throws mid-session.
    const s = normalizeSetup(base({ smallBlind: 0.5, bigBlind: 1.5 }));
    expect(Number.isInteger(s.smallBlind)).toBe(true);
    expect(Number.isInteger(s.bigBlind)).toBe(true);
  });

  it("coerces blinds arriving as strings", () => {
    // JSON can yield strings, and "10" < "5" compares lexicographically, the
    // engine's own validation would then reject a valid 5/10 table.
    const s = normalizeSetup(
      base({ smallBlind: "5" as never, bigBlind: "10" as never })
    );
    expect(s.smallBlind).toBe(5);
    expect(s.bigBlind).toBe(10);
  });

  it("rejects non-finite blinds", () => {
    const s = normalizeSetup(base({ smallBlind: 1e308, bigBlind: 1e308 }));
    expect(Number.isFinite(startingStack(s))).toBe(true);
  });

  it("does not seat prototype keys as bots", () => {
    // `id in BOT_PROFILES` matches Object.prototype members, seating a "bot"
    // whose every parameter is undefined, it would fold aces forever.
    const s = normalizeSetup(
      base({ lineup: ["toString", "constructor", "valueOf"] as never })
    );
    for (const id of s.lineup) {
      expect(Object.hasOwn(BOT_PROFILES, id)).toBe(true);
      expect(typeof rosterRow(id)!.aggression).toBe("number");
    }
  });

  it("survives a lineup that is not an array", () => {
    expect(() => normalizeSetup(base({ lineup: "tag" as never }))).not.toThrow();
    expect(() => normalizeSetup(base({ lineup: null as never }))).not.toThrow();
  });

  it("never seats the same archetype twice", () => {
    for (let seats = MIN_SEATS; seats <= MAX_SEATS; seats++) {
      for (const observer of [false, true]) {
        const s = normalizeSetup(
          base({ seatCount: seats, observer, lineup: ["maniac", "nit"] })
        );
        expect(new Set(s.lineup).size).toBe(s.lineup.length);
      }
    }
  });

  it("is idempotent", () => {
    const once = normalizeSetup(base({ seatCount: 9, lineup: [] }));
    expect(normalizeSetup(once)).toEqual(once);
  });
});

describe("startingStack", () => {
  it("is depth times the big blind", () => {
    expect(startingStack({ ...DEFAULT_SETUP, stackBb: 100, bigBlind: 10 })).toBe(1000);
    expect(startingStack({ ...DEFAULT_SETUP, stackBb: 20, bigBlind: 10 })).toBe(200);
  });
});

describe("DEFAULT_SETUP", () => {
  it("is already normalized", () => {
    expect(normalizeSetup(DEFAULT_SETUP)).toEqual(DEFAULT_SETUP);
  });
});

describe("the mirror is a legal lineup entry without a roster row", () => {
  const base = (over: Partial<TableSetup>): TableSetup =>
    ({ ...DEFAULT_SETUP, ...over }) as TableSetup;

  it("survives normalisation even though BOT_PROFILES has no entry for it", () => {
    // Its four numbers are measured per session, so a stored setup naming it is
    // valid on a machine whose archive has since been cleared. `profileFor`
    // then resolves it to the pure-EV baseline rather than throwing.
    const setup = normalizeSetup(
      base({ lineup: [MIRROR_ID, "tag"], seatCount: 3 })
    );
    expect(setup.lineup).toContain(MIRROR_ID);
    expect(rosterRow(MIRROR_ID)).toBeUndefined();
  });

  it("still rejects a label that is neither the mirror nor a roster row", () => {
    const setup = normalizeSetup(
      base({ lineup: ["tag", "ghost" as never], seatCount: 3 })
    );
    expect(setup.lineup).not.toContain("ghost");
  });

  it("never invents a second mirror when filling a short lineup", () => {
    // `fitLineup` fills from the static roster, so a table that asked for one
    // mirrored seat gets exactly one.
    const filled = fitLineup([MIRROR_ID], 5, 11);
    expect(filled).toHaveLength(5);
    expect(filled.filter((id) => id === MIRROR_ID)).toHaveLength(1);
  });
});
