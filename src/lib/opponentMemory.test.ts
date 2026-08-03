import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_BELIEF } from "../data/constants";
import { updateBelief } from "../poker/bayesian";
import { encodeCard } from "../poker/core/card";
import { makeCard } from "../poker/cards";
import type { BotDecision, TableHandReport } from "../poker/table/contract";
import {
  createTable,
  playHandHeadless,
  startHand,
  type Table,
} from "../poker/table/engine";
import { legalActions } from "../poker/table/rules";
import { toCall as toCallOf } from "../poker/table/state";
import { positionOf } from "../poker/table/position";
import {
  HandBucket,
  bucketOfCards,
  classifyAll,
  makeBoardContext,
} from "../poker/model/buckets";
import {
  opponentRanges,
  tableDecider,
  uncontestedEquity,
} from "../poker/model/decider";
import {
  collapsedLikelihoods,
  createLikelihoodModel,
  likelihoodOf,
  type LikelihoodModel,
} from "../poker/model/likelihood";
import { COMBO_COUNT, type Range } from "../poker/model/range";
import {
  MAX_TRACKED_HANDS,
  MEMORY_VERSION,
  clearMemory,
  emptyMemory,
  flushMemoryWrites,
  handObservations,
  loadMemory,
  memoryStats,
  normalizeMemory,
  recordReport,
  recordReports,
  saveMemory,
  scheduleSave,
  seatModelsFor,
} from "./opponentMemory";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HERO_SEAT = 0;

/** A `window.localStorage` good enough for the module under test. */
function installStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    },
  };
  return store;
}

function uninstallStorage(): void {
  delete (globalThis as { window?: unknown }).window;
}

/** A hand report with only the fields this module reads meaningfully set. */
function report(partial: Partial<TableHandReport>): TableHandReport {
  return {
    handNumber: 1,
    seed: 1,
    button: 0,
    seatCount: 3,
    board: [],
    seats: [0, 1, 2].map((seat) => ({
      seat,
      hole: [],
      final: null,
      invested: 0,
      won: 0,
      net: 0,
      status: "folded" as const,
    })),
    pots: [],
    decisions: [],
    actions: [],
    endStreet: "flop",
    wentToShowdown: false,
    ...partial,
  };
}

const code = (rank: number, suit: "s" | "h" | "d" | "c") =>
  encodeCard(makeCard(rank, suit));

// K-7-2 rainbow, then a 9 and a 4. 7-2 is Air preflop and two pair by the river:
// the whole reason a decision has to be bucketed against the board it was taken
// on rather than against the one the hand ran out to.
const K72 = [code(13, "s"), code(7, "h"), code(2, "d")];
const K72_94 = [...K72, code(9, "c"), code(4, "s")];

// ---------------------------------------------------------------------------
// What a hand teaches
// ---------------------------------------------------------------------------

describe("handObservations", () => {
  it("records only the observed seat's decisions, at the node each was taken", () => {
    const hand = report({
      button: 0,
      board: K72,
      actions: [
        { seat: 1, street: "preflop", action: "raise", cost: 30, potBefore: 15, toCall: 10 },
        { seat: 0, street: "preflop", action: "call", cost: 30, potBefore: 45, toCall: 30 },
        { seat: 0, street: "flop", action: "check", cost: 0, potBefore: 75, toCall: 0 },
        { seat: 1, street: "flop", action: "bet", cost: 20, potBefore: 75, toCall: 0 },
        { seat: 0, street: "flop", action: "fold", cost: 0, potBefore: 95, toCall: 20 },
      ],
    });

    const observed = handObservations(hand, HERO_SEAT);
    expect(observed.map((o) => o.action)).toEqual(["call", "check", "fold"]);
    expect(observed.map((o) => o.street)).toEqual(["preflop", "flop", "flop"]);
    // Preflop the big blind is already an open and seat 1 raised over it, so the
    // call is facing a raise; the flop check is unopened; the fold answers a bet.
    expect(observed.map((o) => o.facing)).toEqual([
      "facing-raise",
      "unopened",
      "facing-bet",
    ]);
    // Seat 0 with the button on seat 0 is BTN in a three-handed game.
    expect(observed.every((o) => o.position === "BTN")).toBe(true);
  });

  it("invents no bucket for a hand that was never shown", () => {
    const hand = report({
      board: K72,
      wentToShowdown: false,
      seats: [
        { seat: 0, hole: [code(7, "c"), code(2, "c")], final: null, invested: 30, won: 0, net: -30, status: "folded" },
        { seat: 1, hole: [], final: null, invested: 30, won: 60, net: 30, status: "active" },
        { seat: 2, hole: [], final: null, invested: 0, won: 0, net: 0, status: "folded" },
      ],
      actions: [
        { seat: 0, street: "flop", action: "bet", cost: 20, potBefore: 60, toCall: 0 },
        { seat: 0, street: "flop", action: "fold", cost: 0, potBefore: 120, toCall: 40 },
      ],
    });
    // The cards are sitting right there in the report — the engine records every
    // seat's hole cards — and they are still not used, because the hand was
    // mucked. See `wasRevealed`.
    expect(handObservations(hand, HERO_SEAT).map((o) => o.bucket)).toEqual([
      null,
      null,
    ]);
  });

  it("buckets a revealed hand against the board as it stood on each street", () => {
    // 7-2 offsuit: Air preflop, two pair on K-7-2, still two pair on the river.
    const hand = report({
      board: K72_94,
      wentToShowdown: true,
      endStreet: "showdown",
      seats: [
        {
          seat: 0,
          hole: [code(7, "c"), code(2, "c")],
          final: { category: 2, score: 1, name: "Two Pair" },
          invested: 60,
          won: 180,
          net: 120,
          status: "active",
        },
        { seat: 1, hole: [code(14, "h"), code(13, "h")], final: { category: 1, score: 0, name: "Pair" }, invested: 60, won: 0, net: -60, status: "active" },
        { seat: 2, hole: [], final: null, invested: 0, won: 0, net: 0, status: "folded" },
      ],
      actions: [
        { seat: 0, street: "preflop", action: "call", cost: 10, potBefore: 15, toCall: 10 },
        { seat: 0, street: "flop", action: "bet", cost: 20, potBefore: 30, toCall: 0 },
        { seat: 0, street: "river", action: "bet", cost: 40, potBefore: 110, toCall: 0 },
      ],
    });

    const observed = handObservations(hand, HERO_SEAT);
    expect(observed.map((o) => o.bucket)).toEqual([
      bucketOfCards(makeCard(7, "c"), makeCard(2, "c"), []),
      HandBucket.TwoPair,
      HandBucket.TwoPair,
    ]);
    // ...and the preflop one really is a different class, which is the point.
    expect(observed[0].bucket).not.toBe(observed[1].bucket);
  });

  it("drops a report it cannot place rather than throwing", () => {
    expect(handObservations(report({ seatCount: 9 }), 0)).toEqual([]);
    expect(handObservations(report({ button: 7 }), 0)).toEqual([]);
    expect(handObservations(report({}), 5)).toEqual([]);
    expect(handObservations(report({}), -1)).toEqual([]);
    expect(
      handObservations(
        report({
          actions: [
            { seat: 0, street: "flop", action: "shove" as never, cost: 0, potBefore: 0, toCall: 0 },
          ],
        }),
        0
      )
    ).toEqual([]);
  });
});

describe("recordReport", () => {
  const folded = (seed: number) =>
    report({
      seed,
      board: K72,
      actions: [
        { seat: 0, street: "flop", action: "bet", cost: 20, potBefore: 60, toCall: 0 },
      ],
    });

  it("writes the bucket-free levels for a fold and nothing else", () => {
    const memory = emptyMemory();
    expect(recordReport(memory, folded(1), HERO_SEAT)).toBe(1);
    expect(Object.keys(memory.model.cells).sort()).toEqual([
      "*",
      "n:flop:unopened",
    ]);
    expect(memoryStats(memory)).toEqual({
      hands: 1,
      observations: 1,
      attributed: 0,
      unattributed: 1,
      cells: 2,
    });
  });

  it("counts a hand once however many times it is offered", () => {
    // The live hand-over effect and the archive replay both reach this module
    // with the same report; adding its counts twice would double the evidence.
    const memory = emptyMemory();
    expect(recordReport(memory, folded(7), HERO_SEAT)).toBe(1);
    expect(recordReport(memory, folded(7), HERO_SEAT)).toBe(0);
    expect(memoryStats(memory).observations).toBe(1);
    expect(recordReports(memory, [folded(7), folded(8)], HERO_SEAT)).toBe(1);
    expect(memoryStats(memory)).toMatchObject({ hands: 2, observations: 2 });
  });

  it("bounds the ids it remembers", () => {
    const memory = emptyMemory();
    for (let i = 0; i < MAX_TRACKED_HANDS + 25; i += 1) {
      recordReport(memory, folded(i), HERO_SEAT);
    }
    expect(memory.seeds).toHaveLength(MAX_TRACKED_HANDS);
    expect(memoryStats(memory).observations).toBe(MAX_TRACKED_HANDS + 25);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence", () => {
  beforeEach(installStorage);
  afterEach(uninstallStorage);

  const populated = () => {
    const memory = emptyMemory();
    recordReport(
      memory,
      report({
        seed: 12,
        board: K72,
        actions: [
          { seat: 0, street: "flop", action: "bet", cost: 20, potBefore: 60, toCall: 0 },
        ],
      }),
      HERO_SEAT
    );
    return memory;
  };

  it("round-trips a memory through storage", () => {
    const memory = populated();
    saveMemory(memory);
    const restored = loadMemory();
    expect(restored.model.cells).toEqual(memory.model.cells);
    expect(restored.seeds).toEqual(memory.seeds);
    expect(memoryStats(restored)).toMatchObject({ hands: 1, observations: 1 });
  });

  it("starts over rather than throwing on anything corrupt", () => {
    const store = installStorage();
    const fresh = () => memoryStats(loadMemory()).observations;

    store["pp.opponentMemory.v1"] = "{not json";
    expect(fresh()).toBe(0);
    store["pp.opponentMemory.v1"] = JSON.stringify({ version: 2, model: {} });
    expect(fresh()).toBe(0);
    store["pp.opponentMemory.v1"] = JSON.stringify({
      version: MEMORY_VERSION,
      model: { version: 1, prior: "vibes", cells: {} },
    });
    expect(fresh()).toBe(0);
    store["pp.opponentMemory.v1"] = JSON.stringify({
      version: MEMORY_VERSION,
      model: { version: 1, prior: "poker", cells: { "*": { total: -1, actions: {} } } },
      seeds: [],
    });
    expect(fresh()).toBe(0);
  });

  it("refuses a model built on a different prior", () => {
    // The prior is the root of the backoff, so counts against a different one
    // are corrections to a different quantity — not merely stale, meaningless.
    expect(
      normalizeMemory({
        version: MEMORY_VERSION,
        model: {
          version: 1,
          prior: "flat",
          cells: { "*": { total: 5, actions: { check: 0, bet: 5, call: 0, raise: 0, fold: 0 } } },
          observations: 5,
          unattributed: 5,
        },
        seeds: [1],
      }).model.prior
    ).toBe("poker");
    expect(normalizeMemory({ version: MEMORY_VERSION }).seeds).toEqual([]);
    expect(normalizeMemory(null).model.observations).toBe(0);
    expect(normalizeMemory("nope").model.observations).toBe(0);
  });

  it("keeps garbage out of the seed list without dropping the model", () => {
    const memory = populated();
    const stored = JSON.parse(
      JSON.stringify({
        version: MEMORY_VERSION,
        model: memory.model,
        seeds: [1, "two", null, 3, Number.NaN],
      })
    );
    const clean = normalizeMemory(stored);
    expect(clean.seeds).toEqual([1, 3]);
    expect(clean.model.observations).toBe(1);
  });

  it("forgets on demand", () => {
    saveMemory(populated());
    expect(memoryStats(loadMemory()).observations).toBe(1);
    expect(memoryStats(clearMemory()).observations).toBe(0);
    expect(memoryStats(loadMemory()).observations).toBe(0);
  });

  it("defers and coalesces its writes", async () => {
    const memory = populated();
    scheduleSave(memory);
    // Nothing has touched storage yet: the write is off the current task.
    expect(loadMemory().model.observations).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(loadMemory().model.observations).toBe(1);
  });

  it("flushes on demand, and flushing twice writes nothing new", () => {
    scheduleSave(populated());
    flushMemoryWrites();
    expect(loadMemory().model.observations).toBe(1);
    clearMemory();
    flushMemoryWrites();
    expect(loadMemory().model.observations).toBe(0);
  });

  it("survives a browser with no storage at all", () => {
    uninstallStorage();
    expect(() => saveMemory(populated())).not.toThrow();
    expect(memoryStats(loadMemory()).observations).toBe(0);
    expect(() => clearMemory()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The property: playing an exploitable pattern moves the bots' reads
// ---------------------------------------------------------------------------

/**
 * A scripted human seat with an obvious, exploitable leak: it bets and raises
 * exactly when it holds nothing, checks when it holds something, and never
 * folds. Every claim below is about whether the bots can come to see that.
 *
 * Never folding is what puts hands in front of a showdown, which is what makes
 * the observations attributed — the difference this whole file turns on.
 */
function bluffer(table: Table, seat: number): BotDecision {
  const actions = legalActions(table, seat, table.config);
  const hole = table.seats[seat].hole;
  const bucket = bucketOfCards(hole[0], hole[1], table.board);
  const weak = bucket <= HandBucket.WeakDraw;

  const aggressive = actions.find((a) => a.type === "bet" || a.type === "raise");
  const check = actions.find((a) => a.type === "check");
  const call = actions.find((a) => a.type === "call");
  const action =
    (weak ? aggressive : undefined) ?? check ?? call ?? aggressive ?? actions[0];

  return {
    seat,
    street: table.street,
    action,
    potBefore: table.pot,
    toCall: toCallOf(table, seat),
    equity: uncontestedEquity(),
    evByAction: {},
    beliefs: {},
    profile: "professor",
  };
}

/** Seat 0 is the scripted human; the rest think for themselves. */
function tableWithBluffer(seed: number): Table {
  return createTable({
    seatCount: 4,
    startingStack: 200,
    smallBlind: 5,
    bigBlind: 10,
    seed,
    seats: [
      { name: "You", kind: "human" },
      { name: "Bot 1", kind: "bot", profile: "tag" },
      { name: "Bot 2", kind: "bot", profile: "station" },
      { name: "Bot 3", kind: "bot", profile: "rock" },
    ],
  });
}

/** Share of a range's weight sitting on hands with no showdown value. */
function airShare(range: Range, buckets: Uint8Array): number {
  let air = 0;
  let total = 0;
  for (let c = 0; c < COMBO_COUNT; c += 1) {
    total += range[c];
    if (buckets[c] <= HandBucket.WeakDraw) air += range[c];
  }
  return total > 0 ? air / total : 0;
}

/**
 * A flop where the human seat has led out, seen from a bot's chair.
 *
 * This is the read the engine actually acts on: `opponentRanges` is what feeds
 * the multiway sampler, so a shift here is a shift in every equity number and
 * every price the bots compute against this player.
 */
function readOnBluffer(model: LikelihoodModel): {
  air: number;
  buckets: Uint8Array;
} {
  const table = tableWithBluffer(4242);
  startHand(table);
  table.street = "flop";
  table.board = [makeCard(13, "s"), makeCard(7, "h"), makeCard(2, "d")];
  table.pot = 60;
  table.currentBet = 0;
  table.lastAggressor = null;
  table.seats[1].hole = [makeCard(14, "h"), makeCard(14, "c")];
  table.actions = [
    { seat: 0, street: "flop", action: "bet", cost: 20, potBefore: 60, toCall: 0 },
  ];

  const models = seatModelsFor(HERO_SEAT, { ...emptyMemory(), model });
  const range = opponentRanges(table, 1, models)[HERO_SEAT];
  const buckets = classifyAll(makeBoardContext(table.board.map(encodeCard)));
  return { air: airShare(range, buckets), buckets };
}

describe("learning an exploitable player, end to end", () => {
  it("moves the bots' read onto air after watching a bluffer play", () => {
    const decide = tableDecider({ simulations: 200 });
    const table = tableWithBluffer(0xb1u77);
    const memory = emptyMemory();

    const before = readOnBluffer(createLikelihoodModel("poker")).air;
    const node = { street: "flop", position: "BTN", facing: "unopened" } as const;
    const betAir = (m: LikelihoodModel) =>
      likelihoodOf(m, "bet", HandBucket.Air, node.street, node.position, node.facing);
    const posterior = (m: LikelihoodModel) =>
      updateBelief(
        INITIAL_BELIEF,
        "bet",
        collapsedLikelihoods(m, node.street, node.position, node.facing)
      );

    const priorBetAir = betAir(createLikelihoodModel("poker"));
    const priorPosterior = posterior(createLikelihoodModel("poker"));

    // Play, recording after every hand exactly the way the live table would.
    const trace: string[] = [];
    let movedAt = 0;
    const HANDS = 60;
    for (let h = 1; h <= HANDS; h += 1) {
      const hand = playHandHeadless(table, (state, seat, config) =>
        seat === HERO_SEAT
          ? bluffer(state as Table, seat)
          : decide(state, seat, config)
      );
      recordReport(memory, hand, HERO_SEAT);
      if ([5, 10, 20, 40, 60].includes(h)) {
        const air = readOnBluffer(memory.model).air;
        trace.push(
          `${String(h).padStart(2)} hands: P(bet|air) ${betAir(memory.model).toFixed(3)} · ` +
            `air read ${(100 * air).toFixed(1)}% · ` +
            `P(weak|bet) ${posterior(memory.model).weak.toFixed(3)}`
        );
        if (movedAt === 0 && air > before + 0.05) movedAt = h;
      }
    }

    const stats = memoryStats(memory);
    const after = readOnBluffer(memory.model).air;
    // eslint-disable-next-line no-console
    console.log(
      `bluffer, ${HANDS} hands: ${stats.observations} decisions ` +
        `(${stats.attributed} shown, ${stats.unattributed} mucked) in ${stats.cells} cells\n  ` +
        `P(bet|air) ${priorBetAir.toFixed(3)} -> ${betAir(memory.model).toFixed(3)}\n  ` +
        `air share of the read ${(100 * before).toFixed(1)}% -> ${(100 * after).toFixed(1)}%\n  ` +
        `P(weak | observed bet) ${priorPosterior.weak.toFixed(3)} -> ${posterior(memory.model).weak.toFixed(3)}\n  ` +
        trace.join("\n  ")
    );

    // It saw enough to have an opinion, and some of it from shown cards.
    expect(stats.observations).toBeGreaterThan(100);
    expect(stats.attributed).toBeGreaterThan(0);

    // 1. The model learned the leak: this player bets air far more than the
    //    prior expects anybody to.
    expect(betAir(memory.model)).toBeGreaterThan(priorBetAir * 1.5);

    // 2. The posterior after an observed bet moved toward weak, which is the
    //    Bayesian statement of the same thing.
    expect(posterior(memory.model).weak).toBeGreaterThan(priorPosterior.weak);
    expect(posterior(memory.model).weak).toBeGreaterThan(
      posterior(memory.model).strong
    );

    // 3. The read the sampler actually draws from moved, measurably.
    expect(after).toBeGreaterThan(before + 0.05);
    expect(movedAt).toBeGreaterThan(0);
  });

  it("says nothing about a seat it never watched", () => {
    // The scoping claim. The learned model describes seat 0; seat 2 has been
    // sitting at the same table the whole time and its read must be untouched.
    const memory = emptyMemory();
    for (let seed = 0; seed < 40; seed += 1) {
      recordReport(
        memory,
        report({
          seed,
          board: K72,
          actions: [
            { seat: 0, street: "flop", action: "bet", cost: 20, potBefore: 60, toCall: 0 },
          ],
        }),
        HERO_SEAT
      );
    }

    const table = tableWithBluffer(99);
    startHand(table);
    table.street = "flop";
    table.board = [makeCard(13, "s"), makeCard(7, "h"), makeCard(2, "d")];
    table.pot = 60;
    table.seats[1].hole = [makeCard(14, "h"), makeCard(14, "c")];
    table.actions = [
      { seat: 0, street: "flop", action: "bet", cost: 20, potBefore: 60, toCall: 0 },
      { seat: 2, street: "flop", action: "call", cost: 20, potBefore: 80, toCall: 20 },
    ];

    const base = opponentRanges(table, 1);
    const learned = opponentRanges(table, 1, seatModelsFor(HERO_SEAT, memory));

    expect(Array.from(learned[2])).toEqual(Array.from(base[2]));
    expect(Array.from(learned[0])).not.toEqual(Array.from(base[0]));
  });

  it("is the identity while it has observed nothing", () => {
    const table = tableWithBluffer(99);
    startHand(table);
    table.actions = [
      { seat: 1, street: "preflop", action: "raise", cost: 30, potBefore: 15, toCall: 10 },
      { seat: 0, street: "preflop", action: "call", cost: 30, potBefore: 45, toCall: 30 },
    ];
    const base = opponentRanges(table, 2);
    const empty = opponentRanges(table, 2, seatModelsFor(HERO_SEAT, emptyMemory()));
    for (const id of [0, 1, 3]) {
      expect(Array.from(empty[id])).toEqual(Array.from(base[id]));
    }
    expect(positionOf(HERO_SEAT, table.button, 4)).toBeTruthy();
  });
});
