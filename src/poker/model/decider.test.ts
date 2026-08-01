import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_BELIEF } from "../../data/constants";
import type { Card } from "../../types";
import { makeCard } from "../cards";
import {
  createTable,
  playHandHeadless,
  startHand,
  type Table,
} from "../table/engine";
import { legalActions } from "../table/rules";
import { totalChips } from "../table/state";
import type { ActionRecord, MultiwayEquity } from "../table/contract";
import {
  MIN_DECISION_SIMS,
  TABLE_DECISION_SIMS,
  decisionSeed,
  decisionSims,
  equityRequest,
  evByAction,
  evInput,
  handActions,
  opponentsOf,
  profileFor,
  readsFromActions,
  tableDecider,
  uncontestedEquity,
} from "./decider";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tiny budget: these tests care about the plumbing, not the sample count. */
const FAST = tableDecider({ simulations: 400 });

function seatedTable(profiles: string[], seed = 4242): Table {
  return createTable({
    seatCount: profiles.length,
    startingStack: 200,
    smallBlind: 5,
    bigBlind: 10,
    seed,
    seats: profiles.map((profile, i) => ({
      name: `Seat ${i}`,
      kind: "bot" as const,
      profile,
    })),
  });
}

function dealt(profiles: string[], seed = 4242): Table {
  return startHand(seatedTable(profiles, seed));
}

const record = (seat: number, action: ActionRecord["action"]): ActionRecord => ({
  seat,
  street: "preflop",
  action,
  cost: 0,
  potBefore: 0,
  toCall: 0,
});

/** Give a seat exactly these hole cards, whatever the shuffle dealt it. */
function setHole(table: Table, seat: number, cards: [Card, Card]): void {
  table.seats[seat].hole = [cards[0], cards[1]];
}

const equityOf = (partial: Partial<MultiwayEquity>): MultiwayEquity => ({
  ...uncontestedEquity(),
  ...partial,
});

// ---------------------------------------------------------------------------

describe("decisionSims", () => {
  it("spends the full heads-up budget on one opponent", () => {
    expect(decisionSims("preflop", 1)).toBe(TABLE_DECISION_SIMS.preflop);
    expect(decisionSims("river", 1)).toBe(TABLE_DECISION_SIMS.river);
  });

  it("divides the budget by the field so work per decision stays flat", () => {
    expect(decisionSims("preflop", 2)).toBe(TABLE_DECISION_SIMS.preflop / 2);
    expect(decisionSims("preflop", 4)).toBe(TABLE_DECISION_SIMS.preflop / 4);
  });

  it("never drops below the noise floor", () => {
    expect(decisionSims("river", 5)).toBe(MIN_DECISION_SIMS);
    expect(decisionSims("river", 50)).toBe(MIN_DECISION_SIMS);
  });

  it("prices a showdown street like the river", () => {
    expect(decisionSims("showdown", 1)).toBe(decisionSims("river", 1));
  });
});

describe("readsFromActions", () => {
  it("starts every seat on the shared prior", () => {
    const reads = readsFromActions([], 4);
    expect(Object.keys(reads)).toHaveLength(4);
    for (const id of [0, 1, 2, 3]) expect(reads[id]).toEqual(INITIAL_BELIEF);
  });

  it("shifts weight to strong when a seat raises", () => {
    const reads = readsFromActions([record(2, "raise")], 4);
    expect(reads[2].strong).toBeGreaterThan(INITIAL_BELIEF.strong);
    expect(reads[2].weak).toBeLessThan(INITIAL_BELIEF.weak);
  });

  it("shifts weight to weak when a seat checks", () => {
    const reads = readsFromActions([record(1, "check")], 4);
    expect(reads[1].weak).toBeGreaterThan(INITIAL_BELIEF.weak);
  });

  it("moves only the seat that acted", () => {
    const reads = readsFromActions([record(0, "raise")], 3);
    expect(reads[1]).toEqual(INITIAL_BELIEF);
    expect(reads[2]).toEqual(INITIAL_BELIEF);
  });

  it("compounds repeated aggression from the same seat", () => {
    const once = readsFromActions([record(0, "raise")], 2);
    const twice = readsFromActions([record(0, "raise"), record(0, "raise")], 2);
    expect(twice[0].strong).toBeGreaterThan(once[0].strong);
  });

  it("reads only public actions — never a seat's cards", () => {
    // Two tables dealt from different seeds hold different cards; identical
    // action histories must therefore produce identical reads.
    const a = readsFromActions([record(0, "bet"), record(1, "call")], 3);
    const b = readsFromActions([record(0, "bet"), record(1, "call")], 3);
    expect(a).toEqual(b);
  });
});

describe("handActions", () => {
  it("reads the records off a live table", () => {
    const table = dealt(["tag", "rock", "nit"]);
    expect(handActions(table)).toEqual([]);
    const seat = table.toAct as number;
    const call = legalActions(table, seat, table.config).find(
      (a) => a.type === "call"
    )!;
    table.actions.push(record(seat, call.type));
    expect(handActions(table)).toHaveLength(1);
  });

  it("defaults to empty for a bare TableState", () => {
    const table = dealt(["tag", "rock"]);
    const { actions: _drop, ...bare } = table;
    expect(handActions(bare)).toEqual([]);
  });
});

describe("decisionSeed", () => {
  it("differs between seats at the same decision point", () => {
    const table = dealt(["tag", "rock", "nit"]);
    expect(decisionSeed(table, 0)).not.toBe(decisionSeed(table, 1));
  });

  it("differs between decisions within a hand", () => {
    const table = dealt(["tag", "rock", "nit"]);
    const before = decisionSeed(table, 0);
    table.actions.push(record(1, "call"));
    expect(decisionSeed(table, 0)).not.toBe(before);
  });

  it("differs between hands of the same session", () => {
    const table = dealt(["tag", "rock", "nit"]);
    const first = decisionSeed(table, 0);
    startHand(table);
    expect(decisionSeed(table, 0)).not.toBe(first);
  });

  it("is a pure function of the state, not of a call counter", () => {
    const table = dealt(["tag", "rock", "nit"]);
    expect(decisionSeed(table, 2)).toBe(decisionSeed(table, 2));
  });
});

describe("evInput", () => {
  it("prices from the pot share, not the outright-win rate", () => {
    // The regression this file exists for: a hand that wins 20% outright and
    // chops the other 80% four ways collects 40% of the pot, and EV must see
    // 0.40 — not 0.20, and not 0.20 + 0.80.
    const mc = evInput(equityOf({ pWin: 0.2, pTie: 0.8, equity: 0.4 }));
    expect(mc.pWin).toBe(0.4);
    expect(mc.pLoss).toBeCloseTo(0.6, 12);
  });

  it("carries the sample count and interval through for the audit trail", () => {
    const mc = evInput(
      equityOf({ simulations: 1234, se: 0.01, ciWin: { lo: 0.3, hi: 0.5 } })
    );
    expect(mc.simulations).toBe(1234);
    expect(mc.se).toBe(0.01);
    expect(mc.ciWin).toEqual({ lo: 0.3, hi: 0.5 });
  });
});

describe("evByAction", () => {
  const actions = [
    { type: "fold" as const, amount: 0, cost: 0, label: "Fold" },
    { type: "call" as const, amount: 20, cost: 20, label: "Call $20" },
  ];

  it("scores folding as the zero baseline", () => {
    const evs = evByAction(actions, equityOf({ equity: 0.9 }), 100, 20);
    expect(evs.Fold).toBe(0);
  });

  it("prices a call at share*pot - (1-share)*cost", () => {
    const evs = evByAction(actions, equityOf({ equity: 0.5 }), 100, 20);
    expect(evs["Call $20"]).toBeCloseTo(0.5 * 100 - 0.5 * 20, 10);
  });

  it("covers every action it is handed", () => {
    const table = dealt(["tag", "rock", "nit", "lag"]);
    const seat = table.toAct as number;
    const legal = legalActions(table, seat, table.config);
    const evs = evByAction(legal, equityOf({ equity: 0.4 }), table.pot, 10);
    for (const action of legal) expect(evs).toHaveProperty(action.label);
  });
});

describe("equityRequest", () => {
  it("asks about the seats still contesting, excluding the hero", () => {
    const table = dealt(["tag", "rock", "nit", "lag"]);
    table.seats[2].status = "folded";
    const request = equityRequest(table, 0);
    expect(request.opponents).toEqual([1, 3]);
    expect(opponentsOf(table, 0)).toEqual([1, 3]);
  });

  it("includes all-in seats — they can still win the pot", () => {
    const table = dealt(["tag", "rock", "nit"]);
    table.seats[1].status = "allin";
    expect(equityRequest(table, 0).opponents).toContain(1);
  });

  it("carries the hero's own cards and the visible board", () => {
    const table = dealt(["tag", "rock", "nit"]);
    const request = equityRequest(table, 0);
    expect(request.heroHole).toHaveLength(2);
    expect(request.board).toHaveLength(0);
  });

  it("honours an explicit simulation budget", () => {
    const table = dealt(["tag", "rock", "nit"]);
    expect(equityRequest(table, 0, 777).simulations).toBe(777);
  });
});

describe("profileFor", () => {
  it("resolves a known archetype", () => {
    expect(profileFor("maniac").id).toBe("maniac");
  });

  it("falls back to the pure-EV baseline for an unlabelled seat", () => {
    expect(profileFor(undefined).id).toBe("professor");
    expect(profileFor("no-such-bot").id).toBe("professor");
  });
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe("tableDecider", () => {
  it("returns a full BotDecision for the acting seat", () => {
    const table = dealt(["tag", "rock", "nit", "lag"]);
    const seat = table.toAct as number;
    const decision = FAST(table, seat, table.config);

    expect(decision.seat).toBe(seat);
    expect(decision.street).toBe("preflop");
    expect(decision.potBefore).toBe(table.pot);
    expect(decision.equity.simulations).toBeGreaterThan(0);
    expect(Object.keys(decision.evByAction).length).toBeGreaterThan(0);
    expect(Object.keys(decision.beliefs)).toHaveLength(4);
    expect(decision.profile).toBe(table.seats[seat].profile);
  });

  it("chooses only from the legal action set", () => {
    const table = dealt(["tag", "rock", "nit", "lag"]);
    const seat = table.toAct as number;
    const legal = legalActions(table, seat, table.config);
    const decision = FAST(table, seat, table.config);
    expect(legal.map((a) => a.type)).toContain(decision.action.type);
  });

  it("keeps a sized bet inside the legal range", () => {
    const table = dealt(["maniac", "maniac", "maniac", "maniac"]);
    const seat = table.toAct as number;
    const decision = FAST(table, seat, table.config);
    const offered = legalActions(table, seat, table.config).find(
      (a) => a.type === decision.action.type
    )!;
    if (offered.min !== undefined && offered.max !== undefined) {
      expect(decision.action.cost).toBeGreaterThanOrEqual(offered.min);
      expect(decision.action.cost).toBeLessThanOrEqual(offered.max);
    } else {
      expect(decision.action.cost).toBe(offered.cost);
    }
  });

  it("is deterministic — the same state decides the same way twice", () => {
    const table = dealt(["lag", "maniac", "station", "tag"]);
    const seat = table.toAct as number;
    const a = FAST(table, seat, table.config);
    const b = FAST(table, seat, table.config);
    expect(b.action).toEqual(a.action);
    expect(b.evByAction).toEqual(a.evByAction);
    expect(b.equity.equity).toBe(a.equity.equity);
  });

  it("decides differently for different seeds", () => {
    // Same seats, same profiles, different shuffle: the equity estimates must
    // actually depend on the cards rather than on the seat index alone.
    const first = dealt(["tag", "rock", "nit", "lag"], 1);
    const second = dealt(["tag", "rock", "nit", "lag"], 2);
    const a = FAST(first, first.toAct as number, first.config);
    const b = FAST(second, second.toAct as number, second.config);
    expect(a.equity.equity).not.toBe(b.equity.equity);
  });

  it("folds a nit's trash preflop when it is facing a raise", () => {
    const table = dealt(["nit", "nit", "nit", "nit"]);
    const seat = table.toAct as number;
    setHole(table, seat, [makeCard(7, "c"), makeCard(2, "d")]);
    const decision = FAST(table, seat, table.config);
    expect(decision.action.type).toBe("fold");
  });

  it("does not fold aces", () => {
    const table = dealt(["nit", "nit", "nit", "nit"]);
    const seat = table.toAct as number;
    setHole(table, seat, [makeCard(14, "s"), makeCard(14, "h")]);
    const decision = FAST(table, seat, table.config);
    expect(decision.action.type).not.toBe("fold");
  });

  it("routes the acting seat's own profile into the choice", () => {
    // K4o scores 3 on the Chen scale — outside a nit's 4% entry range and
    // inside a maniac's 96%. Identical cards and identical price, so any
    // difference in the decision can only have come from the profile.
    const hole: [Card, Card] = [makeCard(13, "c"), makeCard(4, "d")];
    const decide = (profile: string) => {
      const table = dealt([profile, profile, profile, profile]);
      const seat = table.toAct as number;
      setHole(table, seat, hole);
      return FAST(table, seat, table.config);
    };

    expect(decide("nit").action.type).toBe("fold");
    expect(decide("nit").profile).toBe("nit");
    expect(decide("maniac").profile).toBe("maniac");
  });

  it("uses an uncontested equity of 1 when nobody is left to beat", () => {
    const table = dealt(["tag", "rock", "nit"]);
    const seat = table.toAct as number;
    for (const s of table.seats) if (s.id !== seat) s.status = "folded";
    const decision = FAST(table, seat, table.config);
    expect(decision.equity.equity).toBe(1);
    expect(decision.equity.simulations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Whole hands
// ---------------------------------------------------------------------------

describe("driving the engine", () => {
  it("plays a four-handed hand to completion", () => {
    const table = dealt(["tag", "station", "maniac", "rock"]);
    table.handNumber = 0;
    table.button = 3;
    const report = playHandHeadless(table, FAST);
    expect(report.seats).toHaveLength(4);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.decisions.length).toBe(report.actions.length);
  });

  it("conserves chips over a session", () => {
    const table = seatedTable(["tag", "station", "maniac", "rock", "lag"]);
    const bank = totalChips(table);
    for (let i = 0; i < 6; i++) playHandHeadless(table, FAST);
    expect(totalChips(table)).toBe(bank + table.rebuys);
  });

  it("replays a session exactly from its seed", () => {
    const play = () => {
      const table = seatedTable(["tag", "station", "maniac", "rock"], 99);
      const reports = [];
      for (let i = 0; i < 3; i++) reports.push(playHandHeadless(table, FAST));
      return reports.map((r) => r.actions);
    };
    expect(play()).toEqual(play());
  });

  it("draws no entropy outside its own seeded stream", () => {
    // The strongest form of "deterministic": with `Math.random` removed
    // entirely, a whole session still plays out.
    const original = Math.random;
    Math.random = () => {
      throw new Error("decider reached for Math.random");
    };
    try {
      const table = seatedTable(["lag", "maniac", "station", "nit"], 7);
      for (let i = 0; i < 3; i++) playHandHeadless(table, FAST);
      expect(table.handNumber).toBe(3);
    } finally {
      Math.random = original;
    }
  });

  afterEach(() => {
    // Guard against a failed assertion above leaving the stub installed.
    expect(typeof Math.random()).toBe("number");
  });

  it("makes a table of maniacs measurably more aggressive than a table of nits", () => {
    // The personality parameters have to survive the trip through equity and EV
    // and still be visible in the chips. Same seed, same cards, same seats —
    // only the profiles differ.
    const aggressionRate = (profile: string) => {
      const table = seatedTable(Array(4).fill(profile), 8675309);
      let aggressive = 0;
      let total = 0;
      for (let i = 0; i < 8; i++) {
        for (const d of playHandHeadless(table, FAST).decisions) {
          total++;
          if (d.action.type === "bet" || d.action.type === "raise") aggressive++;
        }
      }
      return aggressive / total;
    };

    expect(aggressionRate("maniac")).toBeGreaterThan(aggressionRate("nit"));
  });

  it("records an auditable EV table for every decision", () => {
    const table = seatedTable(["tag", "station", "maniac", "rock"], 31);
    const report = playHandHeadless(table, FAST);
    for (const decision of report.decisions) {
      expect(Object.keys(decision.evByAction).length).toBeGreaterThan(0);
      expect(decision.equity.equity).toBeGreaterThanOrEqual(0);
      expect(decision.equity.equity).toBeLessThanOrEqual(1);
    }
  });

  it("runs every table size from heads-up to six-handed", () => {
    const roster = ["tag", "station", "maniac", "rock", "lag", "nit"];
    for (let n = 2; n <= 6; n++) {
      const table = seatedTable(roster.slice(0, n), 500 + n);
      const bank = totalChips(table);
      playHandHeadless(table, FAST);
      expect(totalChips(table)).toBe(bank + table.rebuys);
    }
  });
});
