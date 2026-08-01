import { describe, expect, it } from "vitest";
import type { ActionType, Card } from "../../types";
import { holeScore } from "../bayesian";
import { makeCard, makeDeck } from "../cards";
import { makeRng, type Rng } from "../core/rng";
import { sizingLadder, type TableAction, type TableConfig } from "../table/rules";
import type { TableSeat, TableState } from "../table/state";
import {
  BOT_ARCHETYPES,
  BOT_PROFILES,
  ENTRY_OVERRIDE_EDGE,
  MIN_HOLE_SCORE,
  VALUE_BET_FLOOR,
  chooseAction,
  findProfile,
  getProfile,
  meetsEntry,
  randomLineup,
  tiltEv,
  type ActionChoiceInput,
  type BuiltArchetype,
} from "./profiles";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const act = (
  type: ActionType,
  label: string,
  cost = 0,
  amount = cost
): TableAction => ({ type, amount, cost, label });

const FOLD = act("fold", "Fold");
const CALL = act("call", "Call $10", 10, 10);
const RAISE = act("raise", "Raise to $30", 30, 30);
const CHECK = act("check", "Check");
const BET = act("bet", "Bet $10", 10, 10);

const card = (r: number, s: "s" | "h" | "d" | "c"): Card =>
  makeCard(r as Card["rank"], s);

const AA = [card(14, "s"), card(14, "h")]; // score 20
const T7o = [card(10, "s"), card(7, "h")]; // score 3
const S72o = [card(7, "d"), card(2, "c")]; // score -1, the worst hand there is

/** A spot with a hand worth value betting, so the bluff rule never fires. */
function base(
  profile: BuiltArchetype,
  over: Partial<ActionChoiceInput> = {}
): ActionChoiceInput {
  return {
    profile: getProfile(profile),
    actions: [FOLD, CALL, RAISE],
    evByAction: { Fold: 0, "Call $10": 10, "Raise to $30": 8 },
    street: "flop",
    hole: AA,
    strength: 0.75,
    potBefore: 100,
    toCall: 10,
    rng: makeRng(1),
    ...over,
  };
}

/** An Rng that always fires the bluff coin, without touching Math.random. */
const ALWAYS: Rng = { next: () => 0, int: () => 0, shuffle: (a) => a.slice() };
/** An Rng that explodes if drawn from — proves a profile consumes no entropy. */
const FORBIDDEN: Rng = {
  next: () => {
    throw new Error("drew from the rng");
  },
  int: () => {
    throw new Error("drew from the rng");
  },
  shuffle: () => {
    throw new Error("drew from the rng");
  },
};

const CONFIG: TableConfig = { smallBlind: 5, bigBlind: 10 };

function table(pot: number, stack = 1000): TableState {
  const seats: TableSeat[] = Array.from({ length: 3 }, (_, id) => ({
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
    button: 0,
    street: "flop",
    deck: [],
    board: [],
    currentBet: 0,
    lastRaiseSize: 0,
    lastAggressor: null,
    toAct: 1,
    pot,
    log: [],
    status: "playing",
  };
}

// ---------------------------------------------------------------------------
// The roster as data
// ---------------------------------------------------------------------------

describe("roster", () => {
  it("has the seven built archetypes and no stub for mirror", () => {
    expect([...BOT_ARCHETYPES].sort()).toEqual(
      ["lag", "maniac", "nit", "professor", "rock", "station", "tag"].sort()
    );
    // `mirror` needs a learned player model, so it cannot exist as static data.
    // Phase 2 removes it from the `Exclude` and the compiler demands the row.
    expect(Object.keys(BOT_PROFILES)).not.toContain("mirror");
    expect(findProfile("mirror")).toBeUndefined();
  });

  it("keys match ids and presentation fields are distinct and non-empty", () => {
    for (const id of BOT_ARCHETYPES) {
      const p = BOT_PROFILES[id];
      expect(p.id).toBe(id);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.avatar.length).toBeGreaterThan(0);
      expect(p.blurb.length).toBeGreaterThan(0);
    }
    const names = BOT_ARCHETYPES.map((id) => BOT_PROFILES[id].name);
    const avatars = BOT_ARCHETYPES.map((id) => BOT_PROFILES[id].avatar);
    expect(new Set(names).size).toBe(BOT_ARCHETYPES.length);
    expect(new Set(avatars).size).toBe(BOT_ARCHETYPES.length);
  });

  it("keeps every parameter inside its meaningful range", () => {
    for (const id of BOT_ARCHETYPES) {
      const p = BOT_PROFILES[id];
      // Below the minimum holeScore the gate is off; above 20 it never plays.
      expect(p.entryThreshold).toBeGreaterThanOrEqual(MIN_HOLE_SCORE);
      expect(p.entryThreshold).toBeLessThanOrEqual(20);
      expect(p.aggression).toBeGreaterThan(0);
      expect(p.bluffRate).toBeGreaterThanOrEqual(0);
      expect(p.bluffRate).toBeLessThanOrEqual(1);
      expect(p.preferredSizing).toBeGreaterThan(0);
      expect(p.preferredSizing).toBeLessThanOrEqual(1);
    }
  });
});

describe("profile coherence", () => {
  // A typo that swaps two numbers would leave every "is it in range" test green
  // while turning the rock into a maniac. So name the quadrants explicitly.
  const TIGHT = 7; // entryThreshold >= this is ~18% of hands or fewer
  const LOOSE = 5; // entryThreshold <= this is ~43% of hands or more

  const tight = (id: BuiltArchetype) =>
    expect(BOT_PROFILES[id].entryThreshold).toBeGreaterThanOrEqual(TIGHT);
  const loose = (id: BuiltArchetype) =>
    expect(BOT_PROFILES[id].entryThreshold).toBeLessThanOrEqual(LOOSE);
  const passive = (id: BuiltArchetype) =>
    expect(BOT_PROFILES[id].aggression).toBeLessThan(1);
  const aggro = (id: BuiltArchetype) =>
    expect(BOT_PROFILES[id].aggression).toBeGreaterThan(1);

  it("nit is tight and passive, and the tightest of all", () => {
    tight("nit");
    passive("nit");
    for (const id of BOT_ARCHETYPES) {
      if (id === "nit") continue;
      expect(BOT_PROFILES.nit.entryThreshold).toBeGreaterThan(
        BOT_PROFILES[id].entryThreshold
      );
    }
  });

  it("rock is tight and passive", () => {
    tight("rock");
    passive("rock");
    // Wider than a nit but more reluctant to bet — that is the whole contrast.
    expect(BOT_PROFILES.rock.entryThreshold).toBeLessThan(
      BOT_PROFILES.nit.entryThreshold
    );
    expect(BOT_PROFILES.rock.aggression).toBeLessThan(BOT_PROFILES.nit.aggression);
  });

  it("station is loose and passive and essentially never bluffs", () => {
    loose("station");
    passive("station");
    expect(BOT_PROFILES.station.bluffRate).toBeLessThanOrEqual(0.02);
    // The losing style: widest range of the passive seats, least aggression.
    for (const id of BOT_ARCHETYPES) {
      expect(BOT_PROFILES.station.aggression).toBeLessThanOrEqual(
        BOT_PROFILES[id].aggression
      );
    }
  });

  it("maniac is loose and aggressive, and the extreme of both", () => {
    loose("maniac");
    aggro("maniac");
    for (const id of BOT_ARCHETYPES) {
      if (id === "maniac") continue;
      // The professor is skipped on the range axis only: its threshold is a
      // switched-off gate, not a claim to be looser than a maniac.
      if (id !== "professor") {
        expect(BOT_PROFILES.maniac.entryThreshold).toBeLessThan(
          BOT_PROFILES[id].entryThreshold
        );
      }
      expect(BOT_PROFILES.maniac.aggression).toBeGreaterThan(
        BOT_PROFILES[id].aggression
      );
      expect(BOT_PROFILES.maniac.bluffRate).toBeGreaterThan(
        BOT_PROFILES[id].bluffRate
      );
    }
  });

  it("tag is tight and aggressive", () => {
    tight("tag");
    aggro("tag");
  });

  it("lag is loose and aggressive, wider and pushier than the tag", () => {
    loose("lag");
    aggro("lag");
    expect(BOT_PROFILES.lag.entryThreshold).toBeLessThan(
      BOT_PROFILES.tag.entryThreshold
    );
    expect(BOT_PROFILES.lag.aggression).toBeGreaterThan(BOT_PROFILES.tag.aggression);
    expect(BOT_PROFILES.lag.bluffRate).toBeGreaterThan(BOT_PROFILES.tag.bluffRate);
  });

  it("separates the bluff rates of the passive and aggressive seats", () => {
    // A profile that bluffed often while dividing down its bet EVs would not
    // describe any real player. Note this is deliberately *not* a claim that
    // bluffRate is monotone in aggression across the whole roster: it is not,
    // and cannot be, because the professor sits at aggression 1 with bluffRate
    // 0 — a pure maximiser bluffs when the EV says to and never as a style.
    const passiveIds = BOT_ARCHETYPES.filter((id) => BOT_PROFILES[id].aggression < 1);
    const aggroIds = BOT_ARCHETYPES.filter((id) => BOT_PROFILES[id].aggression > 1);
    expect(passiveIds.sort()).toEqual(["nit", "rock", "station"]);
    expect(aggroIds.sort()).toEqual(["lag", "maniac", "tag"]);

    const floor = Math.min(...aggroIds.map((id) => BOT_PROFILES[id].bluffRate));
    for (const id of passiveIds) {
      expect(BOT_PROFILES[id].bluffRate).toBeLessThan(floor);
      expect(BOT_PROFILES[id].bluffRate).toBeLessThanOrEqual(0.03);
    }
    // Within the aggressive seats the two axes do move together.
    const byAggression = [...aggroIds].sort(
      (a, b) => BOT_PROFILES[a].aggression - BOT_PROFILES[b].aggression
    );
    const bluffs = byAggression.map((id) => BOT_PROFILES[id].bluffRate);
    expect(bluffs).toEqual([...bluffs].sort((a, b) => a - b));
  });
});

describe("professor is the neutral baseline", () => {
  const professor = BOT_PROFILES.professor;

  it("has aggression 1 and no bluffs", () => {
    expect(professor.aggression).toBe(1);
    expect(professor.bluffRate).toBe(0);
    // The only profile that is exactly neutral on both axes.
    for (const id of BOT_ARCHETYPES) {
      if (id === "professor") continue;
      expect(BOT_PROFILES[id].aggression).not.toBe(1);
    }
  });

  it("has an entry gate that no real hand can trip", () => {
    // Pin MIN_HOLE_SCORE against the actual minimum over all 1326 combos, so a
    // future tweak to holeScore that lowers the floor fails here rather than
    // silently giving the pure maximiser a style-based fold.
    const deck = makeDeck();
    let min = Infinity;
    for (let i = 0; i < deck.length; i++) {
      for (let j = i + 1; j < deck.length; j++) {
        min = Math.min(min, holeScore(deck[i], deck[j]));
      }
    }
    expect(min).toBe(MIN_HOLE_SCORE);
    expect(professor.entryThreshold).toBeLessThanOrEqual(min);
    expect(meetsEntry(professor, S72o)).toBe(true);
  });

  it("always picks the plain argmax over the given EVs", () => {
    const rng = makeRng(99);
    const labels = [FOLD.label, CALL.label, RAISE.label];
    for (let trial = 0; trial < 2000; trial++) {
      const evByAction = {
        [FOLD.label]: 0,
        [CALL.label]: rng.next() * 40 - 20,
        [RAISE.label]: rng.next() * 40 - 20,
      };
      const expected = labels.reduce((best, l) =>
        evByAction[l] > evByAction[best] ? l : best
      );
      const choice = chooseAction(
        base("professor", {
          evByAction,
          // Preflop, with the worst hand, holding nothing: the two rules that
          // could override the argmax are both in play and must both no-op.
          street: "preflop",
          hole: S72o,
          strength: 0.05,
          rng: FORBIDDEN,
        })
      );
      expect(choice.reason).toBe("argmax");
      expect(choice.action.label).toBe(expected);
    }
  });

  it("leaves EVs untouched — the tilt is exactly the identity", () => {
    const choice = chooseAction(
      base("professor", {
        evByAction: { Fold: 0, "Call $10": -4, "Raise to $30": -1 },
        rng: FORBIDDEN,
      })
    );
    expect(choice.tiltedEv).toEqual({ Fold: 0, "Call $10": -4, "Raise to $30": -1 });
    expect(choice.action.label).toBe(FOLD.label);
  });
});

// ---------------------------------------------------------------------------
// Aggression
// ---------------------------------------------------------------------------

describe("tiltEv", () => {
  it("is the identity at aggression 1", () => {
    for (const ev of [-10, -0.5, 0, 0.5, 10]) expect(tiltEv(ev, 1)).toBe(ev);
  });

  it("makes aggression monotone across zero", () => {
    // The naive `ev * aggression` inverts below zero: a maniac would become the
    // *least* willing to fire a losing bluff. Check both signs.
    for (const ev of [-12, -1, 3, 25]) {
      expect(tiltEv(ev, 2.2)).toBeGreaterThan(tiltEv(ev, 1));
      expect(tiltEv(ev, 1)).toBeGreaterThan(tiltEv(ev, 0.55));
    }
    expect(tiltEv(0, 5)).toBe(0);
  });
});

describe("aggression shifts real choices", () => {
  /**
   * The same 8000 close spots put to every profile: calling is worth exactly
   * $10, raising is worth a uniform draw on [0, 20). A pure maximiser raises
   * half the time; the tilt moves that. Identical EV samples for each profile
   * (same jitter seed), so any difference in the counts is the profile.
   */
  const TRIALS = 8000;

  function raiseFrequency(id: BuiltArchetype): number {
    const jitter = makeRng(4242);
    let raises = 0;
    for (let i = 0; i < TRIALS; i++) {
      const choice = chooseAction(
        base(id, {
          evByAction: {
            [FOLD.label]: 0,
            [CALL.label]: 10,
            [RAISE.label]: jitter.next() * 20,
          },
          // Strong enough to value bet, so this measures the tilt alone.
          strength: 0.75,
          rng: FORBIDDEN,
        })
      );
      if (choice.action.type === "raise") raises++;
    }
    return raises / TRIALS;
  }

  const measured = new Map<BuiltArchetype, number>(
    BOT_ARCHETYPES.map((id) => [id, raiseFrequency(id)])
  );

  it("has the maniac raising far more often than the rock", () => {
    const maniac = measured.get("maniac")!;
    const rock = measured.get("rock")!;
    expect(maniac).toBeGreaterThan(0.7);
    expect(rock).toBeLessThan(0.35);
    expect(maniac - rock).toBeGreaterThan(0.4);
  });

  it("orders every profile's raise frequency by its aggression", () => {
    const byAggression = [...BOT_ARCHETYPES].sort(
      (a, b) => BOT_PROFILES[a].aggression - BOT_PROFILES[b].aggression
    );
    const freqs = byAggression.map((id) => measured.get(id)!);
    expect(freqs).toEqual([...freqs].sort((a, b) => a - b));
    // And the spread is wide enough to be a real behavioural difference.
    expect(freqs[freqs.length - 1] - freqs[0]).toBeGreaterThan(0.5);
  });

  it("matches the frequency the tilt predicts analytically", () => {
    // Raise wins iff ev*a > 10, i.e. ev > 10/a on a uniform [0, 20) draw, so
    // the expected rate is 1 - 0.5/a. sd at n=8000 is <= 0.0056; 0.03 is >5sd.
    for (const id of BOT_ARCHETYPES) {
      const predicted = 1 - 0.5 / BOT_PROFILES[id].aggression;
      expect(measured.get(id)!).toBeCloseTo(predicted, 1);
      expect(Math.abs(measured.get(id)! - predicted)).toBeLessThan(0.03);
    }
  });
});

// ---------------------------------------------------------------------------
// Bluffing
// ---------------------------------------------------------------------------

describe("bluffing", () => {
  /**
   * Nothing to value bet (strength 0.2) and betting is plainly -EV, so the
   * argmax is always "check". Every bet that comes out is therefore a bluff and
   * the measured rate is the declared rate.
   */
  const TRIALS = 20000;

  function bluffFrequency(id: BuiltArchetype, seed = 77): number {
    const rng = makeRng(seed);
    let bluffs = 0;
    for (let i = 0; i < TRIALS; i++) {
      const choice = chooseAction(
        base(id, {
          actions: [CHECK, BET],
          evByAction: { Check: 5, "Bet $10": -20 },
          toCall: 0,
          strength: 0.2,
          rng,
        })
      );
      if (choice.reason === "bluff") bluffs++;
    }
    return bluffs / TRIALS;
  }

  it("fires at roughly the declared rate", () => {
    // sd at n=20000 is at most 0.0035, so 0.02 is more than 5 standard errors
    // for every profile — a tolerance that catches a wrong constant, not noise.
    for (const id of BOT_ARCHETYPES) {
      const declared = BOT_PROFILES[id].bluffRate;
      expect(Math.abs(bluffFrequency(id) - declared)).toBeLessThan(0.02);
    }
  });

  it("never bluffs with a hand worth value betting", () => {
    const rng = makeRng(5);
    for (let i = 0; i < 500; i++) {
      const choice = chooseAction(
        base("maniac", {
          actions: [CHECK, BET],
          evByAction: { Check: 5, "Bet $10": -20 },
          toCall: 0,
          strength: VALUE_BET_FLOOR,
          rng,
        })
      );
      expect(choice.reason).toBe("argmax");
    }
  });

  it("gives the professor a bluff rate of exactly zero and draws no entropy", () => {
    const choice = chooseAction(
      base("professor", {
        actions: [CHECK, BET],
        evByAction: { Check: 5, "Bet $10": -20 },
        toCall: 0,
        strength: 0.05,
        rng: FORBIDDEN,
      })
    );
    expect(choice.reason).toBe("argmax");
    expect(choice.action.type).toBe("check");
  });

  it("sizes the bluff near the profile's preferred pot fraction", () => {
    // Real ladder off a real state: $100 pot, nothing owed -> 33/50/75/100.
    const state = table(100);
    const sizings = sizingLadder(state, 1, CONFIG);
    expect(sizings.map((s) => s.cost)).toEqual([33, 50, 75, 100, 1000]);

    const betAction = act("bet", "Bet $10", 10, 10);
    betAction.min = 10;
    betAction.max = 1000;

    const costFor = (id: BuiltArchetype) =>
      chooseAction(
        base(id, {
          actions: [CHECK, betAction],
          evByAction: { Check: 5, "Bet $10": -20 },
          toCall: 0,
          potBefore: 100,
          strength: 0.1,
          sizings,
          rng: ALWAYS,
        })
      ).action.cost;

    expect(costFor("station")).toBe(33); // prefers 1/3
    expect(costFor("rock")).toBe(50); // prefers 1/2
    expect(costFor("tag")).toBe(75); // 0.66 rounds to the 3/4 rung
    expect(costFor("lag")).toBe(75); // prefers 3/4
    expect(costFor("maniac")).toBe(100); // prefers pot — but not the all-in rung
  });

  it("keeps the resized bet legal and internally consistent", () => {
    const state = table(100);
    const sizings = sizingLadder(state, 1, CONFIG);
    const raise: TableAction = {
      type: "raise",
      label: "Raise to $40",
      cost: 40,
      amount: 60, // seat already has $20 in on this street
      min: 40,
      max: 500,
    };
    const choice = chooseAction(
      base("maniac", {
        actions: [FOLD, CALL, raise],
        evByAction: { Fold: 0, "Call $10": -3, "Raise to $40": -20 },
        potBefore: 100,
        toCall: 20,
        strength: 0.1,
        sizings,
        rng: ALWAYS,
      })
    );
    expect(choice.reason).toBe("bluff");
    expect(choice.action.type).toBe("raise");
    expect(choice.action.cost).toBeGreaterThanOrEqual(raise.min!);
    expect(choice.action.cost).toBeLessThanOrEqual(raise.max!);
    // amount - cost is the seat's street commitment, and must be preserved.
    expect(choice.action.amount - choice.action.cost).toBe(20);
  });

  it("falls back to the minimum size when no ladder is supplied", () => {
    const choice = chooseAction(
      base("maniac", {
        actions: [CHECK, BET],
        evByAction: { Check: 5, "Bet $10": -20 },
        toCall: 0,
        strength: 0.1,
        rng: ALWAYS,
      })
    );
    expect(choice.reason).toBe("bluff");
    expect(choice.action).toEqual(BET);
  });
});

// ---------------------------------------------------------------------------
// Preflop entry gate
// ---------------------------------------------------------------------------

describe("preflop entry gate", () => {
  const entersWith = (hole: Card[]) =>
    BOT_ARCHETYPES.filter(
      (id) =>
        chooseAction(
          base(id, {
            street: "preflop",
            hole,
            // Positive, but below the ENTRY_OVERRIDE_EDGE bar of 0.25 * $10.
            evByAction: { Fold: 0, "Call $10": 2, "Raise to $30": 1 },
            strength: 0.75,
            rng: FORBIDDEN,
          })
        ).reason !== "entry-fold"
    );

  it("lets every profile play aces", () => {
    expect(holeScore(AA[0], AA[1])).toBe(20);
    expect(entersWith(AA)).toEqual([...BOT_ARCHETYPES]);
  });

  it("splits the roster on a marginal hand", () => {
    expect(holeScore(T7o[0], T7o[1])).toBe(3);
    expect(entersWith(T7o).sort()).toEqual(["maniac", "professor", "station"]);
  });

  it("leaves only the pure maximiser in with the worst hand there is", () => {
    expect(holeScore(S72o[0], S72o[1])).toBe(-1);
    expect(entersWith(S72o)).toEqual(["professor"]);
  });

  it("overrides the gate when the price makes it clearly profitable", () => {
    const bar = ENTRY_OVERRIDE_EDGE * 10;
    const choice = chooseAction(
      base("nit", {
        street: "preflop",
        hole: S72o,
        evByAction: { Fold: 0, "Call $10": bar + 20, "Raise to $30": 0 },
        strength: 0.75,
        rng: FORBIDDEN,
      })
    );
    expect(choice.reason).toBe("argmax");
    expect(choice.action.type).toBe("call");
  });

  it("does not apply after the flop", () => {
    // Postflop the chips are already in and the hand has changed; only EV
    // decides. A nit that folded every flop with a bad starting hand would be
    // folding the nuts on a 772 board.
    const choice = chooseAction(
      base("nit", {
        street: "flop",
        hole: S72o,
        evByAction: { Fold: 0, "Call $10": 2, "Raise to $30": 1 },
        strength: 0.75,
        rng: FORBIDDEN,
      })
    );
    expect(choice.reason).toBe("argmax");
    expect(choice.action.type).toBe("call");
  });

  it("does not apply when checking is free", () => {
    // No fold action means nobody has bet — the big blind's option is not a
    // decision to enter, so even the nit takes its free flop.
    const choice = chooseAction(
      base("nit", {
        actions: [CHECK, BET],
        evByAction: { Check: 1, "Bet $10": -5 },
        street: "preflop",
        hole: S72o,
        toCall: 0,
        strength: 0.75,
        rng: FORBIDDEN,
      })
    );
    expect(choice.action.type).toBe("check");
  });

  it("agrees with meetsEntry", () => {
    for (const id of BOT_ARCHETYPES) {
      const p = BOT_PROFILES[id];
      expect(meetsEntry(p, T7o)).toBe(3 >= p.entryThreshold);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  function run(seed: number, id: BuiltArchetype = "maniac"): string[] {
    const rng = makeRng(seed);
    const out: string[] = [];
    for (let i = 0; i < 300; i++) {
      out.push(
        chooseAction(
          base(id, {
            actions: [CHECK, BET],
            evByAction: { Check: 5, "Bet $10": -20 },
            toCall: 0,
            strength: 0.2,
            rng,
          })
        ).reason
      );
    }
    return out;
  }

  it("gives identical choices for the same seed", () => {
    expect(run(12345)).toEqual(run(12345));
  });

  it("diverges for different seeds", () => {
    const a = run(1);
    const b = run(2);
    expect(a).not.toEqual(b);
    // Not merely a shifted copy: a good fraction of positions must differ.
    const differing = a.filter((v, i) => v !== b[i]).length;
    expect(differing).toBeGreaterThan(30);
  });

  it("is unaffected by how many decisions came before it", () => {
    // Each decision gets its own stream in the engine, so a fresh Rng at the
    // same seed must reproduce a decision in isolation.
    const one = chooseAction(
      base("lag", {
        actions: [CHECK, BET],
        evByAction: { Check: 5, "Bet $10": -20 },
        toCall: 0,
        strength: 0.2,
        rng: makeRng(808),
      })
    );
    const again = chooseAction(
      base("lag", {
        actions: [CHECK, BET],
        evByAction: { Check: 5, "Bet $10": -20 },
        toCall: 0,
        strength: 0.2,
        rng: makeRng(808),
      })
    );
    expect(again).toEqual(one);
  });

  it("breaks EV ties without consulting the Rng", () => {
    const choice = chooseAction(
      base("maniac", {
        evByAction: { Fold: 0, "Call $10": 5, "Raise to $30": 5 / 2.2 },
        strength: 0.75,
        rng: FORBIDDEN,
      })
    );
    // Tilted raise EV is exactly 5, equal to the call: first action wins.
    expect(choice.tiltedEv["Raise to $30"]).toBeCloseTo(5, 10);
    expect(choice.action.type).toBe("call");
  });

  it("rejects an empty action set rather than inventing a move", () => {
    expect(() => chooseAction(base("tag", { actions: [] }))).toThrow(
      /no legal actions/
    );
  });
});

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

describe("selection", () => {
  it("looks a profile up by id", () => {
    expect(getProfile("tag")).toBe(BOT_PROFILES.tag);
    expect(findProfile("tag")).toBe(BOT_PROFILES.tag);
    expect(findProfile("nobody")).toBeUndefined();
  });

  it("builds a lineup of distinct bots", () => {
    for (let n = 0; n <= BOT_ARCHETYPES.length; n++) {
      const lineup = randomLineup(n, 2024);
      expect(lineup).toHaveLength(n);
      expect(new Set(lineup.map((p) => p.id)).size).toBe(n);
      for (const p of lineup) expect(BOT_PROFILES[p.id as BuiltArchetype]).toBe(p);
    }
  });

  it("reproduces a lineup from its seed", () => {
    for (const seed of [0, 1, 7, 999999]) {
      expect(randomLineup(5, seed).map((p) => p.id)).toEqual(
        randomLineup(5, seed).map((p) => p.id)
      );
    }
  });

  it("gives different lineups for different seeds", () => {
    const lineups = new Set(
      Array.from({ length: 40 }, (_, seed) =>
        randomLineup(5, seed)
          .map((p) => p.id)
          .join(",")
      )
    );
    // 40 seeds over 2520 orderings: collisions are possible, uniformity is not.
    expect(lineups.size).toBeGreaterThan(20);
  });

  it("refuses to seat more bots than there are distinct profiles", () => {
    expect(() => randomLineup(BOT_ARCHETYPES.length + 1, 1)).toThrow(/only 7 exist/);
    expect(() => randomLineup(-1, 1)).toThrow(/negative/);
  });
});
