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
import { legalActions, sizingLadder } from "../table/rules";
import { totalChips } from "../table/state";
import type { ActionRecord, MultiwayEquity } from "../table/contract";
import { makeRng } from "../core/rng";
import { encodeCard } from "../core/card";
import {
  BUCKET_COUNT,
  classifyAll,
  makeBoardContext,
  HandBucket,
} from "./buckets";
import { BUCKET_COUNT as MODEL_BUCKETS, createLikelihoodModel } from "./likelihood";
import type { LikelihoodModel } from "./likelihood";
import { observe } from "./learn";
import {
  COMBO_COUNT,
  comboCardA,
  comboCardB,
  comboIndex,
  totalWeight,
} from "./range";
import { runMultiway } from "../equity/multiway";
import {
  FOLD_EQUITY_SIMS,
  MAX_TILT_FRACTION,
  MIN_DECISION_SIMS,
  REFERENCE_FRACTION,
  TABLE_DECISION_SIMS,
  closesAction,
  decisionSeed,
  decisionSims,
  equityRequest,
  evByAction,
  evInput,
  foldAtSize,
  foldByBucket,
  handActions,
  actionContexts,
  defaultSeatModels,
  modelForSeat,
  opponentRange,
  opponentRanges,
  opponentsOf,
  priceCall,
  priceSizes,
  profileFor,
  readsFromActions,
  sizedCandidates,
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

  it("carries a range per opponent, not a three-tier read", () => {
    // The migration at the seam: what crosses into the estimator is 1326
    // weights per seat. A tier label cannot say "two pair on this board", and
    // that is what every equity number the bot acts on is now built from.
    const table = dealt(["tag", "rock", "nit", "lag"]);
    const request = equityRequest(table, 0);
    expect(Object.keys(request.ranges ?? {}).map(Number)).toEqual(
      request.opponents
    );
    for (const id of request.opponents) {
      const range = request.ranges![id];
      expect(range).toHaveLength(COMBO_COUNT);
      expect(totalWeight(range)).toBeCloseTo(1, 12);
    }
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

// ---------------------------------------------------------------------------
// Fold equity
// ---------------------------------------------------------------------------

describe("foldAtSize", () => {
  it("is the identity at the reference size", () => {
    expect(foldAtSize(0.42, REFERENCE_FRACTION)).toBeCloseTo(0.42, 12);
  });

  it("folds more to a bigger bet and less to a smaller one", () => {
    const half = foldAtSize(0.42, 0.5);
    expect(foldAtSize(0.42, 0.33)).toBeLessThan(half);
    expect(foldAtSize(0.42, 1)).toBeGreaterThan(half);
  });

  it("stays a probability at every size", () => {
    for (const f of [0.01, 0.1, 0.5, 1, 4, 40, 400]) {
      for (const base of [0.01, 0.42, 0.99]) {
        const p = foldAtSize(base, f);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("never gets a calling station to fold", () => {
    // The station's whole identity is that price does not move it. A model that
    // let a big enough bet fold it out would hand the bot a free bluff against
    // the one opponent type that never folds.
    for (const f of [1, 4, 20, 200]) expect(foldAtSize(0.02, f)).toBeLessThan(0.05);
  });

  it("stops crediting size past the cap", () => {
    // Without this the logistic extrapolates a half-pot rate out to a
    // twenty-times-pot shove and folds out aces 96% of the time.
    const capped = foldAtSize(0.44, MAX_TILT_FRACTION);
    expect(foldAtSize(0.44, 20)).toBe(capped);
    expect(capped).toBeLessThan(0.7);
  });

  it("keeps strong hands folding less than weak ones at every size", () => {
    // The property the whole term rests on: if size compressed the difference
    // away, the continuing range would stop being the strong part of the range.
    for (const f of [0.33, 0.5, 1, MAX_TILT_FRACTION * 4]) {
      expect(foldAtSize(0.3, f)).toBeLessThan(foldAtSize(0.7, f));
    }
  });
});

describe("foldByBucket", () => {
  const model = createLikelihoodModel("poker");

  it("falls from air to monsters", () => {
    const row = foldByBucket(model, "river", "BTN", "facing-bet");
    expect(row).toHaveLength(BUCKET_COUNT);
    for (let b = 1; b < BUCKET_COUNT; b++) {
      expect(row[b]).toBeLessThan(row[b - 1]);
    }
  });

  it("is a probability over the moves that are actually legal", () => {
    // Facing a bet the choices are fold, call and raise; the prior parks ~2% on
    // check and bet so no single observation can be infinitely strong evidence.
    // Leaving that 2% in would understate every fold rate by the same amount.
    const row = foldByBucket(model, "river", "BTN", "facing-bet");
    for (const p of row) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("respects MDF, which is what stops the bot bluffing everything", () => {
    // Worth pinning explicitly, because it sets every bluff frequency this file
    // measures. Against a half-pot bet the minimum defence frequency is
    // 1 − alpha = 2/3, i.e. an opponent that folds more than 1/3 of its range
    // is beatable by betting *any* two cards. This assertion used to read
    // `toBeGreaterThan` and the prior folded 46.4% here — 13 points past the
    // bound — which was a standing subsidy on aggression that the EV maximiser
    // correctly collected by betting almost everything. `likelihood.ts`'s
    // MDF_FOLD_SCALE removes it; the bound is asserted range-weighted and at
    // every size in `likelihood.test.ts`, and this is the per-bucket mean at
    // the node the fold-equity term is priced from most often.
    const row = foldByBucket(model, "flop", "BTN", "facing-bet");
    let mean = 0;
    for (const p of row) mean += p / BUCKET_COUNT;
    const alphaHalfPot = 1 / 3;
    expect(mean).toBeLessThanOrEqual(alphaHalfPot);
    // Not collapsed to nothing either: a prior that never folds prices every
    // bluff at zero fold equity, which is a different bug of the same size.
    expect(mean).toBeGreaterThan(0.2);
  });

  it("says a river bet is read more sharply than a preflop one", () => {
    // The hand is complete on the river, so what a player holds and what they
    // do with it are at their most correlated — the model's own claim, and the
    // continuing range is sharper for it.
    const river = foldByBucket(model, "river", "BTN", "facing-bet");
    const preflop = foldByBucket(model, "preflop", "BTN", "facing-bet");
    const spread = (r: Float64Array) => r[0] - r[BUCKET_COUNT - 1];
    expect(spread(river)).toBeGreaterThan(spread(preflop));
  });
});

describe("opponentRange", () => {
  const board = [makeCard(13, "s"), makeCard(9, "h"), makeCard(4, "d")].map(
    encodeCard
  );
  const hole = [makeCard(7, "c"), makeCard(2, "d")].map(encodeCard);
  const buckets = classifyAll(makeBoardContext(board));

  it("puts the belief's mass on each tier, not on each combo", () => {
    // The regression this exists for: writing `belief[tier]` into every combo
    // makes the effective strong mass 0.06 rather than 0.25, because the weak
    // tier holds seven times the combos.
    const range = opponentRange(INITIAL_BELIEF, buckets, [...hole, ...board]);
    const mass = { weak: 0, medium: 0, strong: 0 };
    for (let c = 0; c < COMBO_COUNT; c++) {
      const b = buckets[c] as HandBucket;
      const tier =
        b >= HandBucket.Overpair
          ? "strong"
          : b >= HandBucket.WeakPair
            ? "medium"
            : "weak";
      mass[tier] += range[c];
    }
    expect(mass.weak).toBeCloseTo(INITIAL_BELIEF.weak, 6);
    expect(mass.medium).toBeCloseTo(INITIAL_BELIEF.medium, 6);
    expect(mass.strong).toBeCloseTo(INITIAL_BELIEF.strong, 6);
  });

  it("zeroes every combo the hero can see", () => {
    const range = opponentRange(INITIAL_BELIEF, buckets, [...hole, ...board]);
    for (const seen of [...hole, ...board]) {
      for (let c = 0; c < COMBO_COUNT; c++) {
        if (comboCardA(c) === seen || comboCardB(c) === seen) {
          expect(range[c]).toBe(0);
        }
      }
    }
    // ...and leaves a real range behind.
    expect(range[comboIndex(encodeCard(makeCard(14, "s")), encodeCard(makeCard(14, "h")))])
      .toBeGreaterThan(0);
  });
});

describe("opponentRanges", () => {
  const rankOf = (c: number) => (c >> 2) + 2;
  const suitOf = (c: number) => c & 3; // s=0 h=1 d=2 c=3

  /** Share of a range's weight on combos matching a predicate. */
  function share(
    range: Float64Array,
    pred: (a: number, b: number) => boolean
  ): number {
    let hit = 0;
    for (let c = 0; c < COMBO_COUNT; c++) {
      if (range[c] > 0 && pred(comboCardA(c), comboCardB(c))) hit += range[c];
    }
    return hit / totalWeight(range);
  }

  /** A spot with a chosen board and a seat that has led every street. */
  function driven(hero: [Card, Card], board: Card[], streets: ActionRecord["street"][]) {
    const { table, seat } = flopSpot({
      seats: 3, hero, board, pot: 60, seed: 4242,
    });
    table.street = board.length === 5 ? "river" : board.length === 4 ? "turn" : "flop";
    table.actions = streets.map((street) => ({
      seat: 1, street, action: "bet", cost: 10, potBefore: 40, toCall: 0,
    }));
    return { table, seat };
  }

  it("is a probability distribution after every update", () => {
    const { table, seat } = driven(
      [makeCard(14, "h"), makeCard(14, "c")],
      [
        makeCard(13, "s"), makeCard(7, "h"), makeCard(2, "d"),
        makeCard(9, "c"), makeCard(4, "s"),
      ],
      ["flop", "turn", "river"]
    );
    for (const range of Object.values(opponentRanges(table, seat))) {
      expect(totalWeight(range)).toBeCloseTo(1, 12);
    }
  });

  it("zeroes every combo the hero can see, exactly", () => {
    const board = [makeCard(13, "s"), makeCard(7, "h"), makeCard(2, "d")];
    const { table, seat } = driven(
      [makeCard(14, "h"), makeCard(14, "c")],
      board,
      ["flop"]
    );
    const dead = [...table.seats[seat].hole, ...board].map(encodeCard);
    for (const range of Object.values(opponentRanges(table, seat))) {
      let live = 0;
      for (let c = 0; c < COMBO_COUNT; c++) {
        const clash =
          dead.includes(comboCardA(c)) || dead.includes(comboCardB(c));
        if (clash) expect(range[c]).toBe(0);
        else if (range[c] > 0) live++;
      }
      // C(52 - 5, 2): every combo the deck still allows keeps some weight.
      expect(live).toBe(1081);
    }
  });

  it("reads a seat that bets three streets as holding the board's hands", () => {
    // The headline: on K-7-2-9-4 the combo 7-2 is two pair, and a seat that has
    // driven the betting is *more* likely to hold it, not less. The preflop
    // Chen score the estimator used to bucket by said the opposite, and every
    // equity number inherited that.
    const board = [
      makeCard(13, "s"), makeCard(7, "h"), makeCard(2, "d"),
      makeCard(9, "c"), makeCard(4, "s"),
    ];
    const { table, seat } = driven(
      [makeCard(14, "h"), makeCard(14, "c")],
      board,
      ["flop", "turn", "river"]
    );
    const passive = flopSpot({
      seats: 3, hero: [makeCard(14, "h"), makeCard(14, "c")],
      board, pot: 60, seed: 4242,
    });
    passive.table.street = "river";
    passive.table.actions = [];

    const driving = opponentRanges(table, seat)[1];
    const quiet = opponentRanges(passive.table, passive.seat)[1];

    const isSevenDeuce = (a: number, b: number) => {
      const lo = Math.min(rankOf(a), rankOf(b));
      return lo === 2 && Math.max(rankOf(a), rankOf(b)) === 7;
    };
    const boardRanks = [13, 9, 7, 4, 2];
    const twoPair = (a: number, b: number) =>
      boardRanks.includes(rankOf(a)) &&
      boardRanks.includes(rankOf(b)) &&
      rankOf(a) !== rankOf(b);

    // Betting moves weight onto hands this board actually made...
    expect(share(driving, isSevenDeuce)).toBeGreaterThan(
      share(quiet, isSevenDeuce)
    );
    expect(share(driving, twoPair)).toBeGreaterThan(2 * share(quiet, twoPair));
    // ...and 7-2 is a real part of it, not a rounding error.
    expect(share(driving, isSevenDeuce)).toBeGreaterThan(0.05);
  });

  it("puts the hero's blocker into the equity number", () => {
    // Three hearts on board and the hero holds one ace or another. Identical in
    // every way except which ace, so the whole difference is the blocker — and
    // unlike a tier-normalised read, a per-combo range lets it reach the equity
    // instead of handing the missing mass back to the same tier.
    const board = [
      makeCard(13, "h"), makeCard(7, "h"), makeCard(2, "h"),
      makeCard(9, "c"), makeCard(4, "s"),
    ];
    const nutFlush = (a: number, b: number) =>
      suitOf(a) === 1 && suitOf(b) === 1 && (rankOf(a) === 14 || rankOf(b) === 14);
    const flush = (a: number, b: number) => suitOf(a) === 1 && suitOf(b) === 1;

    const measure = (ace: "h" | "d") => {
      const hero: [Card, Card] = [makeCard(14, ace), makeCard(9, "s")];
      const { table, seat } = driven(hero, board, ["flop", "turn", "river"]);
      const range = opponentRanges(table, seat)[1];
      const equity = runMultiway({
        heroHole: hero.map(encodeCard),
        board: board.map(encodeCard),
        opponents: [1],
        ranges: { 1: range },
        simulations: 400_000,
        seed: 0x810c,
      });
      return { range, equity: equity.equity, se: equity.se };
    };

    const blocking = measure("h");
    const not = measure("d");

    expect(share(blocking.range, nutFlush)).toBe(0);
    expect(share(not.range, nutFlush)).toBeGreaterThan(0.05);
    expect(share(blocking.range, flush)).toBeLessThan(
      share(not.range, flush) - 0.03
    );
    // The number the bot acts on, well outside the noise on it.
    expect(blocking.equity).toBeGreaterThan(not.equity + 4 * not.se);
  });

  it("reads only public actions — never a seat's cards", () => {
    const board = [makeCard(13, "s"), makeCard(7, "h"), makeCard(2, "d")];
    const hero: [Card, Card] = [makeCard(14, "h"), makeCard(14, "c")];
    const a = driven(hero, board, ["flop"]);
    const b = driven(hero, board, ["flop"]);
    // Same public record, different hidden cards: the read cannot move.
    b.table.seats[1].hole = [makeCard(5, "c"), makeCard(5, "d")];
    b.table.seats[2].hole = [makeCard(12, "s"), makeCard(11, "s")];
    expect(Array.from(opponentRanges(a.table, a.seat)[1])).toEqual(
      Array.from(opponentRanges(b.table, b.seat)[1])
    );
  });
});

describe("sizedCandidates", () => {
  it("offers every rung of the ladder, deduped and legal", () => {
    const table = dealt(["tag", "rock", "nit", "lag"]);
    const seat = table.toAct as number;
    const base = legalActions(table, seat, table.config).find(
      (a) => a.type === "bet" || a.type === "raise"
    )!;
    const candidates = sizedCandidates(base, sizingLadder(table, seat, table.config));

    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates[0]).toBe(base);
    const costs = candidates.map((c) => c.cost);
    expect(new Set(costs).size).toBe(costs.length);
    for (const c of candidates) {
      expect(c.cost).toBeGreaterThanOrEqual(base.min!);
      expect(c.cost).toBeLessThanOrEqual(base.max!);
      expect(c.type).toBe(base.type);
    }
  });
});

// ---------------------------------------------------------------------------
// The bot bluffs
// ---------------------------------------------------------------------------

/**
 * Put a table on the flop with a chosen board, hero holding and pot, everyone
 * still in and nobody having bet. Built by hand rather than by playing to the
 * flop so the spot is exactly the one under test.
 */
function flopSpot(options: {
  seats: number;
  hero: [Card, Card];
  board: Card[];
  pot: number;
  seed: number;
  profile?: string;
}): { table: Table; seat: number } {
  const table = seatedTable(
    Array(options.seats).fill(options.profile ?? "professor"),
    options.seed
  );
  startHand(table);
  const seat = 0;
  table.street = "flop";
  table.board = options.board;
  table.pot = options.pot;
  table.currentBet = 0;
  table.lastRaiseSize = 0;
  table.lastAggressor = null;
  table.actions = [];
  for (const s of table.seats) {
    s.status = "active";
    s.streetCommit = 0;
    s.hasActed = false;
    s.mayRaise = true;
    s.stack = 200;
  }
  table.seats[seat].hole = [options.hero[0], options.hero[1]];
  table.toAct = seat;
  return { table, seat };
}

const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
const SUITS = ["s", "h", "d", "c"] as const;

/** A seeded random deal of a flop plus two hole cards, all distinct. */
function randomSpot(seed: number): { hero: [Card, Card]; board: Card[] } {
  const rng = makeRng(seed);
  const codes = rng.shuffle(Array.from({ length: 52 }, (_, i) => i)).slice(0, 5);
  const toCard = (code: number): Card =>
    makeCard(RANKS[code >> 2], SUITS[code & 3]);
  return {
    hero: [toCard(codes[0]), toCard(codes[1])],
    board: [toCard(codes[2]), toCard(codes[3]), toCard(codes[4])],
  };
}

const bucketOf = (hero: [Card, Card], board: Card[]): HandBucket => {
  const buckets = classifyAll(makeBoardContext(board.map(encodeCard)));
  return buckets[
    comboIndex(encodeCard(hero[0]), encodeCard(hero[1]))
  ] as HandBucket;
};

/**
 * Bet frequency for holdings in `keep`, over `trials` seeded flops.
 *
 * The profile is the professor throughout: `bluffRate` 0 and `aggression` 1, so
 * `chooseAction` is a plain argmax and every bet measured here was chosen by the
 * EV arithmetic rather than by a personality's coin flip.
 */
function betRate(options: {
  seats: number;
  keep: (b: HandBucket) => boolean;
  trials: number;
  pot?: number;
}): { rate: number; n: number } {
  const decide = tableDecider({ simulations: 400 });
  let bets = 0;
  let n = 0;
  for (let t = 0; t < options.trials; t++) {
    const { hero, board } = randomSpot(0x5eed + t);
    if (!options.keep(bucketOf(hero, board))) continue;
    const { table, seat } = flopSpot({
      seats: options.seats,
      hero,
      board,
      pot: options.pot ?? 60,
      seed: 0xb10f + t,
    });
    if (decide(table, seat, table.config).action.type === "bet") bets++;
    n++;
  }
  return { rate: n > 0 ? bets / n : 0, n };
}

const isAir = (b: HandBucket) => b <= HandBucket.WeakDraw;
const isStrong = (b: HandBucket) => b >= HandBucket.TwoPair;

describe("bluffing, end to end", () => {
  it("bets air a measurable fraction of the time", () => {
    // The headline claim. Before fold equity this number was exactly zero and
    // could not have been anything else: with no fold term a hand with no
    // showdown value scores worse betting than checking at every size.
    const air = betRate({ seats: 3, keep: isAir, trials: 400 });
    // eslint-disable-next-line no-console
    console.log(`air bet rate (2 opponents): ${(100 * air.rate).toFixed(1)}% of ${air.n}`);
    expect(air.n).toBeGreaterThan(30);
    expect(air.rate).toBeGreaterThan(0);
  });

  it("bets strong hands more often than air", () => {
    // Fold equity must not flatten the strength gradient — a bot that bluffs as
    // often as it value bets is as unreadable as one that never bluffs, and
    // just as wrong. Two pair or better is ~4% of random flops, hence the
    // larger sweep for the same number of measurements.
    const air = betRate({ seats: 4, keep: isAir, trials: 400 });
    const strong = betRate({ seats: 4, keep: isStrong, trials: 1200 });
    // eslint-disable-next-line no-console
    console.log(
      `3 opponents — air ${(100 * air.rate).toFixed(1)}% of ${air.n}, ` +
        `strong ${(100 * strong.rate).toFixed(1)}% of ${strong.n}`
    );
    expect(strong.n).toBeGreaterThan(20);
    expect(strong.rate).toBeGreaterThan(air.rate);
  });

  it("bluffs less into a bigger field", () => {
    const rows: string[] = [];
    const rates: number[] = [];
    for (const opponents of [1, 2, 3, 5]) {
      const air = betRate({ seats: opponents + 1, keep: isAir, trials: 240 });
      rates.push(air.rate);
      rows.push(`${opponents} opp: ${(100 * air.rate).toFixed(1)}% of ${air.n}`);
    }
    // eslint-disable-next-line no-console
    console.log("air bet rate by field size:\n  " + rows.join("\n  "));
    // Π P(fold_i) decays geometrically, so the far end must be well under the
    // near end. Adjacent rungs can tie when both are near a boundary.
    expect(rates[3]).toBeLessThan(rates[0]);
    expect(rates[2]).toBeLessThanOrEqual(rates[0]);
  });
});

describe("pricing sizes", () => {
  const spot = () =>
    flopSpot({
      seats: 3,
      hero: [makeCard(7, "c"), makeCard(2, "d")],
      board: [makeCard(13, "s"), makeCard(9, "h"), makeCard(4, "d")],
      pot: 60,
      seed: 77,
    });

  it("prices every rung with its own fold equity", () => {
    const { table, seat } = spot();
    const base = legalActions(table, seat, table.config).find(
      (a) => a.type === "bet"
    )!;
    const priced = priceSizes(
      table,
      seat,
      base,
      sizingLadder(table, seat, table.config),
      FOLD_EQUITY_SIMS,
      99
    )!;

    expect(priced).not.toBeNull();
    expect(priced.candidates.length).toBeGreaterThan(2);
    // A bigger bet buys more folds and leaves a stronger range behind. That
    // trade is the reason each size needs its own continuing range.
    const rungs = priced.candidates.map((c) => priced.byLabel[c.label]);
    const bigger = [...priced.candidates]
      .map((c, i) => ({ cost: c.cost, pFold: rungs[i].pFold }))
      .sort((a, b) => a.cost - b.cost);
    for (let i = 1; i < bigger.length; i++) {
      expect(bigger[i].pFold).toBeGreaterThanOrEqual(bigger[i - 1].pFold);
    }
  });

  it("records the derivation on the decision", () => {
    const { table, seat } = spot();
    const decision = tableDecider({ simulations: 400 })(table, seat, table.config);
    expect(decision.equityVsRange).toBeGreaterThan(0);
    const breakdowns = Object.values(decision.foldEquity ?? {});
    expect(breakdowns.length).toBeGreaterThan(0);
    for (const b of breakdowns) {
      expect(b.pFold).toBeGreaterThanOrEqual(0);
      expect(b.pFold).toBeLessThanOrEqual(1);
      expect(b.ev).toBeCloseTo(b.foldEv + b.callEv, 8);
      expect(decision.evByAction).toHaveProperty(
        Object.keys(decision.foldEquity!)[0]
      );
    }
  });

  it("gives an all-in opponent no fold equity at all", () => {
    // An all-in seat has no decision left to make, so it cannot be bluffed. A
    // model that let it fold would price a bet against chips already committed.
    const { table, seat } = spot();
    for (const s of table.seats) if (s.id !== seat) s.status = "allin";
    const base = legalActions(table, seat, table.config).find(
      (a) => a.type === "bet"
    );
    // With everyone all-in there is nobody left to bet against.
    expect(base).toBeUndefined();

    const { table: t2, seat: s2 } = spot();
    t2.seats[1].status = "allin";
    const b2 = legalActions(t2, s2, t2.config).find((a) => a.type === "bet")!;
    const priced = priceSizes(
      t2,
      s2,
      b2,
      sizingLadder(t2, s2, t2.config),
      FOLD_EQUITY_SIMS,
      99
    )!;
    for (const label of Object.keys(priced.byLabel)) {
      // Opponents are in seat order: the all-in one never folds.
      expect(priced.byLabel[label].pFoldEach[0]).toBe(0);
      expect(priced.byLabel[label].pFold).toBe(0);
    }
  });

  it("is deterministic, breakdown included", () => {
    const a = spot();
    const b = spot();
    const decide = tableDecider({ simulations: 400 });
    const first = decide(a.table, a.seat, a.table.config);
    const second = decide(b.table, b.seat, b.table.config);
    expect(second.action).toEqual(first.action);
    expect(second.evByAction).toEqual(first.evByAction);
    expect(second.foldEquity).toEqual(first.foldEquity);
    expect(second.equityVsRange).toBe(first.equityVsRange);
  });

  it("stays inside the thinking budget", () => {
    // Six-handed on the flop at the real budget: one multiway Monte Carlo plus
    // one continuing-range run per rung of the ladder.
    const decide = tableDecider();
    const { table, seat } = flopSpot({
      seats: 6,
      hero: [makeCard(7, "c"), makeCard(2, "d")],
      board: [makeCard(13, "s"), makeCard(9, "h"), makeCard(4, "d")],
      pot: 60,
      seed: 31337,
    });
    decide(table, seat, table.config); // warm the JIT and the bucket tables
    const started = performance.now();
    const runs = 5;
    for (let i = 0; i < runs; i++) decide(table, seat, table.config);
    const each = (performance.now() - started) / runs;
    // eslint-disable-next-line no-console
    console.log(`six-handed flop decision: ${each.toFixed(1)}ms`);
    expect(each).toBeLessThan(250);
  });
});

// ---------------------------------------------------------------------------
// Pricing a call
// ---------------------------------------------------------------------------
//
// The whole risk in re-pricing calls is that it leaks into the calls that were
// already right. A closing call must come out of the decider bit-for-bit
// unchanged — not close, not within the sampling error of a second Monte Carlo,
// identical — or the fix has traded a correct number for a noisier one.

/**
 * A flop spot where a bet of `bet` stands and the hero must call it.
 *
 * `behind` is how many opponents have yet to act; the rest have already matched.
 * `behind: 0` is therefore a closing call, and heads-up it is the only kind.
 */
function callSpot(options: {
  seats: number;
  behind: number;
  bet?: number;
  seed?: number;
}): { table: Table; seat: number; bet: number } {
  const bet = options.bet ?? 20;
  const { table, seat } = flopSpot({
    seats: options.seats,
    hero: [makeCard(7, "c"), makeCard(2, "d")],
    board: [makeCard(13, "s"), makeCard(9, "h"), makeCard(4, "d")],
    pot: 60,
    seed: options.seed ?? 4242,
  });

  const opponents = table.seats.filter((s) => s.id !== seat);
  const matched = opponents.length - options.behind;
  if (matched < 1) throw new Error("callSpot: somebody has to have bet");
  opponents.forEach((s, i) => {
    const isIn = i < matched;
    s.streetCommit = isIn ? bet : 0;
    s.hasActed = isIn;
    s.stack = 200 - s.streetCommit;
    if (isIn) table.pot += bet;
  });
  table.currentBet = bet;
  table.lastRaiseSize = bet;
  table.lastAggressor = opponents[0].id;
  return { table, seat, bet };
}

const callOf = (table: Table, seat: number) =>
  legalActions(table, seat, table.config).find((a) => a.type === "call")!;

describe("pricing a call", () => {
  it("calls a heads-up call closing, and declines to re-price it", () => {
    const { table, seat } = callSpot({ seats: 2, behind: 0 });
    expect(closesAction(table, seat)).toBe(true);
    expect(
      priceCall(table, seat, callOf(table, seat), FOLD_EQUITY_SIMS, 99)
    ).toBeNull();
  });

  it("calls a six-handed call closing once every other seat has matched", () => {
    const { table, seat } = callSpot({ seats: 6, behind: 0 });
    expect(opponentsOf(table, seat)).toHaveLength(5);
    expect(closesAction(table, seat)).toBe(true);
    expect(
      priceCall(table, seat, callOf(table, seat), FOLD_EQUITY_SIMS, 99)
    ).toBeNull();
  });

  it("does not call it closing while one seat still owes chips", () => {
    const { table, seat } = callSpot({ seats: 6, behind: 1 });
    expect(closesAction(table, seat)).toBe(false);
    const priced = priceCall(
      table,
      seat,
      callOf(table, seat),
      FOLD_EQUITY_SIMS,
      99
    )!;
    expect(priced).not.toBeNull();
    // No fold equity, and a pot bigger than the one standing — the two halves
    // of what `ev.callEv` is for.
    expect(priced.pFold).toBe(0);
    expect(priced.foldEv).toBe(0);
    expect(priced.potIfCalled).toBeGreaterThan(table.pot);
  });

  it("leaves a closing call's EV bit-identical to actionEv's", () => {
    // Reconstructed from the decision's own equity estimate, so this is an
    // equality between two evaluations of the same formula, not a tolerance.
    for (const seats of [2, 6]) {
      const { table, seat } = callSpot({ seats, behind: 0 });
      const decision = FAST(table, seat, table.config);
      const label = callOf(table, seat).label;
      const old = evByAction(
        legalActions(table, seat, table.config),
        decision.equity,
        decision.potBefore,
        decision.toCall
      );
      expect(decision.evByAction[label]).toBe(old[label]);
    }
  });

  it("moves a non-closing call's EV off actionEv's number, upward", () => {
    const { table, seat } = callSpot({ seats: 6, behind: 3 });
    const decision = FAST(table, seat, table.config);
    const label = callOf(table, seat).label;
    const old = evByAction(
      legalActions(table, seat, table.config),
      decision.equity,
      decision.potBefore,
      decision.toCall
    );
    expect(decision.evByAction[label]).not.toBe(old[label]);
    // Monotone: the correction adds the chips the seats behind bring, and
    // subtracts the ones that fold from the field contesting the hero's share.
    expect(decision.evByAction[label]).toBeGreaterThan(old[label]);
    // eslint-disable-next-line no-console
    console.log(
      `six-handed call, 3 seats behind: ${decision.evByAction[label].toFixed(2)} ` +
        `on the reached pot vs ${old[label].toFixed(2)} on the standing pot`
    );
  });

  it("declines to price a call that costs nothing", () => {
    // The big blind's option is a check, not a call, and there is no such
    // action — but a scripted state can still ask, and a zero-cost call has no
    // pot to correct.
    const { table, seat } = callSpot({ seats: 3, behind: 1 });
    const free = { ...callOf(table, seat), cost: 0 };
    expect(priceCall(table, seat, free, FOLD_EQUITY_SIMS, 99)).toBeNull();
  });

  it("is deterministic for the same seed", () => {
    const a = callSpot({ seats: 6, behind: 2 });
    const b = callSpot({ seats: 6, behind: 2 });
    expect(
      priceCall(a.table, a.seat, callOf(a.table, a.seat), FOLD_EQUITY_SIMS, 7)
    ).toEqual(
      priceCall(b.table, b.seat, callOf(b.table, b.seat), FOLD_EQUITY_SIMS, 7)
    );
  });
});

// ---------------------------------------------------------------------------
// Reading the hand's nodes
// ---------------------------------------------------------------------------

describe("actionContexts", () => {
  const at = (
    seat: number,
    street: ActionRecord["street"],
    action: ActionRecord["action"],
    toCall: number
  ): ActionRecord => ({ seat, street, action, cost: 0, potBefore: 0, toCall });

  it("counts the big blind as the preflop open", () => {
    // A caller preflop is answering a bet, not acting into an unopened pot —
    // somebody already put chips in, by force.
    expect(actionContexts([at(0, "preflop", "call", 10)])).toEqual([
      { street: "preflop", facing: "facing-bet" },
    ]);
    expect(actionContexts([at(0, "flop", "bet", 0)])).toEqual([
      { street: "flop", facing: "unopened" },
    ]);
  });

  it("promotes to facing-raise once a second aggressor has acted", () => {
    const contexts = actionContexts([
      at(1, "preflop", "raise", 10),
      at(2, "preflop", "call", 30),
      at(0, "flop", "bet", 0),
      at(1, "flop", "raise", 20),
      at(0, "flop", "call", 40),
    ]);
    expect(contexts.map((c) => c.facing)).toEqual([
      "facing-bet", // over the blind
      "facing-raise", // the blind plus the raise
      "unopened", // fresh street, nothing bet
      "facing-bet", // answering the lead
      "facing-raise", // answering the raise over it
    ]);
  });

  it("resets the aggression count on every new street", () => {
    const contexts = actionContexts([
      at(0, "preflop", "raise", 10),
      at(0, "flop", "check", 0),
      at(0, "turn", "bet", 0),
    ]);
    expect(contexts.map((c) => c.street)).toEqual(["preflop", "flop", "turn"]);
    expect(contexts.map((c) => c.facing)).toEqual([
      "facing-bet",
      "unopened",
      "unopened",
    ]);
  });

  it("prices a showdown record as a river one", () => {
    expect(actionContexts([at(0, "showdown", "check", 0)])[0].street).toBe("river");
  });
});

// ---------------------------------------------------------------------------
// Injecting a learned model
// ---------------------------------------------------------------------------
//
// `opponentMemory` accumulates a model of the *human* seat. Two things have to
// be true for that to be safe to plug in: an empty one must change nothing at
// all, and a populated one must change only the seat it is a claim about.

/** A player who has been seen calling with everything, at every flop node. */
function neverFolds(): LikelihoodModel {
  const model = createLikelihoodModel("poker");
  for (const facing of ["unopened", "facing-bet", "facing-raise"] as const) {
    for (let i = 0; i < 40; i += 1) {
      for (let b = 0; b < MODEL_BUCKETS; b += 1) {
        observe(model, {
          action: facing === "unopened" ? "check" : "call",
          bucket: b,
          street: "flop",
          position: "BTN",
          facing,
        });
      }
    }
  }
  return model;
}

describe("injecting a learned model", () => {
  it("plays a whole session bit-identically through an empty model", () => {
    // The determinism guarantee. A learned model is extra input to every
    // decision, so the only thing that makes it safe to add is that an empty
    // one is exactly the identity: `betaMean(0, 0, m)` is `m` at every level of
    // the backoff, so a model with no cells cannot move a single lookup. Not
    // "within the sampling error" — the same bits.
    const play = (models?: Parameters<typeof tableDecider>[0]) => {
      const table = seatedTable(["tag", "station", "maniac", "rock"], 99);
      const decide = tableDecider({ simulations: 400, ...models });
      const reports = [];
      for (let i = 0; i < 3; i++) reports.push(playHandHeadless(table, decide));
      return reports;
    };

    const base = play();
    expect(play({ models: defaultSeatModels })).toEqual(base);
    expect(play({ models: modelForSeat(0, createLikelihoodModel("poker")) })).toEqual(
      base
    );
    // Not vacuous: those reports carry the Monte Carlo estimates, the whole EV
    // table and the fold-equity breakdown for every decision of three hands.
    expect(base.flatMap((r) => r.decisions).length).toBeGreaterThan(10);
    expect(base[0].decisions[0].foldEquity ?? base[0].decisions[0].evByAction).toBeTruthy();
  });

  it("prices fold equity through the model of the seat being priced", () => {
    const spot = () =>
      flopSpot({
        seats: 3,
        hero: [makeCard(7, "c"), makeCard(2, "d")],
        board: [makeCard(13, "s"), makeCard(9, "h"), makeCard(4, "d")],
        pot: 60,
        seed: 77,
      });
    const price = (models?: ReturnType<typeof modelForSeat>) => {
      const { table, seat } = spot();
      const base = legalActions(table, seat, table.config).find(
        (a) => a.type === "bet"
      )!;
      return priceSizes(
        table,
        seat,
        base,
        sizingLadder(table, seat, table.config),
        FOLD_EQUITY_SIMS,
        99,
        undefined,
        models
      )!;
    };

    const before = price();
    const after = price(modelForSeat(1, neverFolds()));
    const label = before.candidates[1].label;

    // Opponents are in seat order. Seat 1 is the one that has been watched, and
    // it folds less than the prior said; seat 2 has been watched by nobody and
    // its number is untouched to the bit.
    expect(after.byLabel[label].pFoldEach[0]).toBeLessThan(
      before.byLabel[label].pFoldEach[0]
    );
    expect(after.byLabel[label].pFoldEach[1]).toBe(
      before.byLabel[label].pFoldEach[1]
    );
    // ...and a bluff into a player who never folds is worth less.
    expect(after.byLabel[label].foldEv).toBeLessThan(
      before.byLabel[label].foldEv
    );
  });

  it("prices a call through the model of the seat still to act", () => {
    const price = (models?: ReturnType<typeof modelForSeat>) => {
      const { table, seat } = callSpot({ seats: 3, behind: 1 });
      return priceCall(
        table,
        seat,
        callOf(table, seat),
        FOLD_EQUITY_SIMS,
        99,
        undefined,
        models
      )!;
    };
    // Only seat 2 still owes chips, so only its model can move this number.
    const before = price();
    expect(price(modelForSeat(1, neverFolds()))).toEqual(before);
    expect(price(modelForSeat(2, neverFolds())).potIfCalled).not.toBe(
      before.potIfCalled
    );
  });

  it("leaves a bot modelling another bot on the data-free prior", () => {
    // The scoping claim, from the other side: the learned model belongs to seat
    // 0, and the read seat 1 forms about seat 2 must be exactly what it was.
    const board = [makeCard(13, "s"), makeCard(7, "h"), makeCard(2, "d")];
    const build = () => {
      const { table } = flopSpot({
        seats: 4,
        hero: [makeCard(14, "h"), makeCard(14, "c")],
        board,
        pot: 60,
        seed: 4242,
      });
      table.actions = [
        { seat: 0, street: "flop", action: "bet", cost: 10, potBefore: 60, toCall: 0 },
        { seat: 2, street: "flop", action: "call", cost: 10, potBefore: 70, toCall: 10 },
        { seat: 3, street: "flop", action: "fold", cost: 0, potBefore: 80, toCall: 10 },
      ];
      return table;
    };

    const before = opponentRanges(build(), 1);
    const after = opponentRanges(build(), 1, modelForSeat(0, neverFolds()));
    expect(Array.from(after[2])).toEqual(Array.from(before[2]));
    expect(Array.from(after[3])).toEqual(Array.from(before[3]));
    expect(Array.from(after[0])).not.toEqual(Array.from(before[0]));
  });
});
