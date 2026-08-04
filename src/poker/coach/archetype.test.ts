import { describe, expect, it } from "vitest";
import { INITIAL_BELIEF } from "../../data/constants";
import type { ActionType, BeliefDistribution } from "../../types";
import { updateBelief } from "../bayesian";
import { decodeCard, encodeCards } from "../core/card";
import { hashSeed, makeRng } from "../core/rng";
import { runMultiwayEquitySync } from "../equity/pool";
import {
  BOT_ARCHETYPES,
  chooseAction,
  findProfile,
  getProfile,
  type BuiltArchetype,
} from "../model/profiles";
import { COMBO_COUNT, comboCardA, comboCardB } from "../model/range";
import type {
  ActionRecord,
  BotDecision,
  SyncBotDecider,
  TableHandReport,
} from "../table/contract";
import { createTable, playHandHeadless } from "../table/engine";
import { legalActions, sizingLadder, type TableAction } from "../table/rules";
import { contestingSeats, seatOf, toCall } from "../table/state";
import { priceAction } from "./evLoss";
import { computeStats } from "./stats";
import {
  AGGRESSIVE_AF,
  ARCHETYPE_STYLE,
  classify,
  classifyStats,
  CONFIDENCE_HALF_HANDS,
  MANIAC_VPIP,
  MIN_CLASSIFY_HANDS,
  NIT_VPIP,
  sampleConfidence,
  TIGHT_VPIP,
  vectorFromStats,
  type StyleVector,
} from "./archetype";

// ---------------------------------------------------------------------------
// Threshold behaviour, on vectors chosen by hand
// ---------------------------------------------------------------------------

const vector = (over: Partial<StyleVector>): StyleVector => ({
  hands: 500,
  vpip: 20,
  pfr: 15,
  af: 2,
  pfrRatio: 0.75,
  ...over,
});

describe("classify", () => {
  it("calls a tight, aggressive seat a TAG", () => {
    expect(classify(vector({ vpip: 21, pfr: 17, af: 2.4 })).style).toBe("TAG");
  });

  it("calls a wide, aggressive seat a LAG", () => {
    expect(classify(vector({ vpip: 33, pfr: 26, af: 2.6 })).style).toBe("LAG");
  });

  it("calls a very tight seat a nit however hard it plays", () => {
    expect(classify(vector({ vpip: 9, pfr: 8, af: 4 })).style).toBe("Nit");
  });

  it("calls a merely tight but passive seat a nit too", () => {
    // Tight-passive has no label of its own; a rock plays the same losing shape.
    expect(
      classify(vector({ vpip: 20, pfr: 3, af: 0.4, pfrRatio: 0.15 })).style
    ).toBe("Nit");
  });

  it("calls a wide, passive seat a calling station", () => {
    expect(
      classify(vector({ vpip: 55, pfr: 6, af: 0.4, pfrRatio: 0.11 })).style
    ).toBe("Calling Station");
  });

  it("requires both width and aggression before saying maniac", () => {
    // Wide but passive is a station, not a maniac…
    expect(
      classify(vector({ vpip: 70, pfr: 8, af: 0.5, pfrRatio: 0.11 })).style
    ).toBe("Calling Station");
    // …and aggressive but not wide enough is still a LAG.
    expect(
      classify(vector({ vpip: 40, pfr: 34, af: 3.5, pfrRatio: 0.85 })).style
    ).toBe("LAG");
    // Both together is a maniac.
    expect(
      classify(vector({ vpip: 70, pfr: 50, af: 3.5, pfrRatio: 0.71 })).style
    ).toBe("Maniac");
  });

  it("does not read a seat that never calls postflop as passive", () => {
    // AF is null, so the PFR ratio has to carry the aggression signal alone.
    expect(
      classify(vector({ vpip: 20, pfr: 18, af: null, pfrRatio: 0.9 })).style
    ).toBe("TAG");
    expect(
      classify(vector({ vpip: 20, pfr: 2, af: null, pfrRatio: 0.1 })).style
    ).toBe("Nit");
  });

  it("moves label exactly at the published cut points", () => {
    const passive = { pfr: 0, af: 0.2, pfrRatio: 0 };
    expect(classify(vector({ vpip: NIT_VPIP - 0.1, ...passive })).style).toBe("Nit");
    expect(classify(vector({ vpip: TIGHT_VPIP - 0.1, ...passive })).style).toBe("Nit");
    expect(classify(vector({ vpip: TIGHT_VPIP, ...passive })).style).toBe(
      "Calling Station"
    );
    const wild = { pfr: 40, af: 3, pfrRatio: 0.8 };
    expect(classify(vector({ vpip: MANIAC_VPIP - 0.1, ...wild })).style).toBe("LAG");
    expect(classify(vector({ vpip: MANIAC_VPIP, ...wild })).style).toBe("Maniac");
    expect(classify(vector({ vpip: 30, pfr: 20, af: AGGRESSIVE_AF, pfrRatio: 0 })).style).toBe(
      "LAG"
    );
  });

  it("explains itself", () => {
    const verdict = classify(vector({ vpip: 21, pfr: 17, af: 2.4 }));
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(3);
    expect(verdict.reasons.join(" ")).toContain("VPIP");
    expect(verdict.reasons.join(" ")).toContain("AF");
  });
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

describe("confidence", () => {
  it("is near zero at a sample nobody should trust", () => {
    expect(classify(vector({ hands: 12 })).confidence).toBeLessThan(0.15);
    expect(classify(vector({ hands: 0 })).confidence).toBe(0);
  });

  it("rises strictly with sample size", () => {
    const sizes = [1, 5, 12, 30, 60, 100, 250, 600, 2000];
    // VPIP 34 sits clear of every cut point, so the margin penalty is one and
    // the sample term is all that moves.
    const confidences = sizes.map(
      (hands) => classify(vector({ hands, vpip: 34 })).confidence
    );
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i]).toBeGreaterThan(confidences[i - 1]);
    }
    expect(confidences[confidences.length - 1]).toBeGreaterThan(0.9);
  });

  it("reaches one half at the documented sample, and never one", () => {
    expect(sampleConfidence(CONFIDENCE_HALF_HANDS)).toBe(0.5);
    expect(sampleConfidence(1e9)).toBeLessThan(1);
    expect(sampleConfidence(0)).toBe(0);
  });

  it("marks a small sample provisional and a large one not", () => {
    expect(classify(vector({ hands: MIN_CLASSIFY_HANDS - 1 })).provisional).toBe(true);
    expect(classify(vector({ hands: MIN_CLASSIFY_HANDS })).provisional).toBe(false);
  });

  it("discounts a seat sitting on a threshold", () => {
    const clear = classify(vector({ hands: 500, vpip: 34 }));
    const borderline = classify(vector({ hands: 500, vpip: TIGHT_VPIP + 0.2 }));
    expect(borderline.confidence).toBeLessThan(clear.confidence);
    // …but the sample term still dominates: a clear read on 20 hands is worth
    // less than a borderline one on 500.
    expect(classify(vector({ hands: 20, vpip: 34 })).confidence).toBeLessThan(
      borderline.confidence
    );
  });

  it("still returns a label at a tiny sample rather than refusing", () => {
    const verdict = classify(vector({ hands: 3, vpip: 60, pfr: 5, af: 0.3, pfrRatio: 0.08 }));
    expect(verdict.style).toBe("Calling Station");
    expect(verdict.provisional).toBe(true);
    expect(verdict.confidence).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Recovering the roster's known styles from its parameters
//
// `../model/profiles.ts` states each seat's style as four numbers, and
// `chooseAction` is the function that turns those numbers into moves. So the
// validation is: drive `chooseAction` over a spread of ordinary spots, count
// what it did with `stats.ts`'s definitions, and ask whether `classify` gets the
// roster's own labels back. Ground truth comes from outside this module, and no
// step invents a parameters-to-statistics formula, the profile module's own
// code does the interpreting.
//
// The spots are deliberately plain and symmetric so that what varies between
// profiles is only the personality:
//
//  - Preflop: both entering and raising are priced from the same positive set,
//    all of it far under a quarter of what any of those lines risks, so the
//    entry gate's `ENTRY_OVERRIDE_EDGE` waiver never fires. Measured VPIP is
//    then the profile's entry threshold and nothing else; PFR is how the
//    aggression multiplier and the bluff rate resolve the choice among the
//    hands the gate let through.
//  - Postflop: the same construction, prices now spanning zero so folding is
//    live and no gate applies. What is measured there is aggression alone.
// ---------------------------------------------------------------------------

/**
 * Preflop prices.
 *
 * `toCall` is large and every price is small, so even the maniac's 2.2x tilt
 * (max 66) stays under `ENTRY_OVERRIDE_EDGE` times the smallest thing any line
 * risks (0.25 x 400 = 100) and the gate is never waived. Deliberately a wide
 * margin: the waiver's exact formula belongs to profiles.ts, not here.
 * Both prices are drawn from the SAME positive set with the diagonal
 * skipped, which makes the grid exactly symmetric under swapping them: entering
 * always beats folding (so measured VPIP is the entry threshold and nothing
 * else), and a pure maximiser raises exactly half the hands it enters. Every
 * departure from that half is the aggression multiplier and the bluff rate.
 */
const PREFLOP_TO_CALL = 400;
const PREFLOP_EV = [2, 6, 10, 14, 18, 22, 26, 30];
const PREFLOP_STRENGTHS = [0.3, 0.8];

/**
 * Postflop prices, the same set for the call and the raise, diagonal skipped,
 * and spanning zero so that folding is a live option. Symmetric for the same
 * reason: a seat that treats a bet and a call alike measures AF exactly 1.
 *
 * Spaced finely (-25, -23, … -1, 1, … 25, odd, so no price is ever exactly
 * zero), because the tilt is a multiplier: a coarse grid would leave every
 * decision on the same side of the comparison and report every profile neutral.
 */
const POSTFLOP_EV = Array.from({ length: 26 }, (_, i) => 2 * i - 25);

/** Pot shares spanning the bluff gate at `VALUE_BET_FLOOR`. */
const STRENGTHS = [0.2, 0.45, 0.7, 0.95];
/** Repeats per spot, so a bluff rate is measured rather than sampled once. */
const REPEATS = 30;

const action = (
  type: ActionType,
  label: string,
  cost = 0
): TableAction => ({ type, amount: cost, cost, label });

const FOLD = action("fold", "Fold");
const CALL = action("call", "Call", PREFLOP_TO_CALL);
const RAISE = action("raise", "Raise", PREFLOP_TO_CALL * 3);

/**
 * A profile's style, measured by counting what `chooseAction` does.
 *
 * The counts go through exactly the definitions in stats.ts. VPIP is a
 * non-fold, PFR is a raise, AF is (bets+raises)/calls, so what is validated is
 * the whole chain from parameter to label, not the classifier in isolation.
 */
function measureProfile(id: BuiltArchetype): StyleVector {
  const profile = getProfile(id);
  const rng = makeRng(hashSeed(0xc0ffee, BOT_ARCHETYPES.indexOf(id)));

  let hands = 0;
  let entered = 0;
  let raised = 0;

  // Preflop: every one of the 1326 starting combos, so VPIP is combo-weighted
  // exactly as a real tracker's would be rather than sampled.
  for (let combo = 0; combo < COMBO_COUNT; combo++) {
    const hole = [decodeCard(comboCardA(combo)), decodeCard(comboCardB(combo))];
    for (const callEv of PREFLOP_EV) {
      for (const raiseEv of PREFLOP_EV) {
        if (callEv === raiseEv) continue; // keeps the grid symmetric; see above
        for (const strength of PREFLOP_STRENGTHS) {
          hands++;
          const choice = chooseAction({
            profile,
            actions: [FOLD, CALL, RAISE],
            evByAction: { Fold: 0, Call: callEv, Raise: raiseEv },
            street: "preflop",
            hole,
            strength,
            potBefore: 60,
            toCall: PREFLOP_TO_CALL,
            rng,
          });
          if (choice.action.type !== "fold") entered++;
          if (choice.action.type === "raise" || choice.action.type === "bet") raised++;
        }
      }
    }
  }

  // Postflop: no entry gate, folding live, prices symmetric about zero.
  let aggressive = 0;
  let calls = 0;
  for (let r = 0; r < REPEATS; r++) {
    for (const callEv of POSTFLOP_EV) {
      for (const raiseEv of POSTFLOP_EV) {
        if (callEv === raiseEv) continue; // keeps the grid symmetric; see above
        for (const strength of STRENGTHS) {
          const chosen = chooseAction({
            profile,
            actions: [FOLD, CALL, RAISE],
            evByAction: { Fold: 0, Call: callEv, Raise: raiseEv },
            street: "flop",
            hole: [],
            strength,
            potBefore: 60,
            toCall: 40,
            rng,
          }).action.type;
          if (chosen === "raise" || chosen === "bet") aggressive++;
          else if (chosen === "call") calls++;
          // A fold is neither, exactly as in stats.ts's AF.
        }
      }
    }
  }

  return {
    hands,
    vpip: (entered / hands) * 100,
    pfr: (raised / hands) * 100,
    af: calls > 0 ? aggressive / calls : null,
    pfrRatio: entered > 0 ? raised / entered : null,
  };
}

describe("recovering the bot roster's styles", () => {
  const measured = new Map<BuiltArchetype, StyleVector>();
  for (const id of BOT_ARCHETYPES) measured.set(id, measureProfile(id));

  it("recovers every archetype whose style is a parameter", () => {
    let checked = 0;
    for (const id of BOT_ARCHETYPES) {
      const expected = ARCHETYPE_STYLE[id];
      if (expected === null) continue; // the professor has no style; see archetype.ts
      const v = measured.get(id)!;
      const why = `${id}: VPIP ${v.vpip.toFixed(1)} PFR ${v.pfr.toFixed(1)} AF ${
        v.af === null ? "n/a" : v.af.toFixed(2)
      } ratio ${v.pfrRatio === null ? "n/a" : v.pfrRatio.toFixed(2)}`;
      expect(classify(v).style, why).toBe(expected);
      checked++;
    }
    // Every built archetype but the professor.
    expect(checked).toBe(BOT_ARCHETYPES.length - 1);
  });

  it("measures a VPIP that matches the entry threshold profiles.ts advertises", () => {
    // profiles.ts quotes these combo-weighted percentages for its `holeScore`
    // cuts. Recovering them is what makes the VPIP axis above a real
    // measurement rather than a number that merely sorts correctly.
    const advertised: [BuiltArchetype, number][] = [
      ["nit", 4.4],
      ["rock", 10.7],
      ["tag", 17.8],
      ["lag", 43.3],
      ["station", 67.1],
      ["maniac", 96.4],
    ];
    for (const [id, want] of advertised) {
      expect(measured.get(id)!.vpip, id).toBeCloseTo(want, 0);
    }
    // The professor's gate is disabled, so it enters every spot priced to enter.
    expect(measured.get("professor")!.vpip).toBe(100);
  });

  it("orders the roster by looseness, tightest first", () => {
    const order: BuiltArchetype[] = ["nit", "rock", "tag", "lag", "station", "maniac"];
    for (let i = 1; i < order.length; i++) {
      expect(
        measured.get(order[i])!.vpip,
        `${order[i]} should enter more pots than ${order[i - 1]}`
      ).toBeGreaterThan(measured.get(order[i - 1])!.vpip);
    }
  });

  it("orders the roster by aggression, and puts the baseline at the middle", () => {
    // `aggression` is 1 for the professor by construction, so every profile
    // above it must measure more aggressive and every profile below it less.
    const neutral = measured.get("professor")!.af!;
    for (const id of ["station", "rock", "nit"] as BuiltArchetype[]) {
      expect(measured.get(id)!.af!, id).toBeLessThan(neutral);
    }
    for (const id of ["tag", "lag", "maniac"] as BuiltArchetype[]) {
      expect(measured.get(id)!.af!, id).toBeGreaterThan(neutral);
    }
    expect(measured.get("maniac")!.af!).toBeGreaterThan(measured.get("lag")!.af!);
  });

  it("recovers the aggression multiplier itself, not merely its order", () => {
    // The neutral profile is defined by `aggression === 1`, and the symmetric
    // grid is built so a seat that treats a raise and a call alike measures AF
    // exactly 1. That the other six then land in `aggression` order, and, at
    // the aggressive end, land almost exactly ON their multiplier, is the
    // strongest evidence available that the AF axis reads what it claims to.
    expect(measured.get("professor")!.af).toBe(1);
    const byParameter: BuiltArchetype[] = [
      "station", // 0.55
      "rock", //    0.70
      "nit", //     0.80
      "professor", // 1.00
      "tag", //     1.35
      "lag", //     1.60
      "maniac", //  2.20
    ];
    for (let i = 1; i < byParameter.length; i++) {
      expect(
        measured.get(byParameter[i])!.af!,
        `${byParameter[i]} vs ${byParameter[i - 1]}`
      ).toBeGreaterThan(measured.get(byParameter[i - 1])!.af!);
    }
    // A tenth of a point: the residual is the profile's bluff rate, which adds
    // raises the multiplier alone does not account for.
    for (const id of ["tag", "lag", "maniac"] as BuiltArchetype[]) {
      const gap = Math.abs(measured.get(id)!.af! - getProfile(id).aggression);
      expect(gap, `${id} AF vs its aggression multiplier`).toBeLessThan(0.1);
    }
  });

  it("separates the tight-passive pair from the tight-aggressive one", () => {
    // Same side of the width axis, opposite sides of the aggression one, the
    // distinction profiles.ts says its `aggression` multiplier encodes.
    const rock = measured.get("rock")!;
    const tag = measured.get("tag")!;
    expect(Math.abs(tag.vpip - rock.vpip)).toBeLessThan(10);
    expect(rock.af!).toBeLessThan(1);
    expect(tag.af!).toBeGreaterThan(1);
    expect(classify(rock).style).toBe("Nit");
    expect(classify(tag).style).toBe("TAG");
  });
});

// ---------------------------------------------------------------------------
// End to end, through hands the engine actually dealt
// ---------------------------------------------------------------------------

/**
 * A decider assembled from `profiles.chooseAction`, multiway equity and this
 * layer's own `priceAction`, the same three ingredients `model/decider.ts`
 * uses, wired here directly so this test depends on none of it.
 */
function profileDecider(simulations: number): SyncBotDecider {
  /** The read every seat starts on, moved by the public action so far. */
  const reads = (state: { seats: unknown[] }): Record<number, BeliefDistribution> => {
    const out: Record<number, BeliefDistribution> = {};
    for (let i = 0; i < state.seats.length; i++) out[i] = INITIAL_BELIEF;
    const carrier = state as { actions?: ActionRecord[] };
    for (const a of carrier.actions ?? []) {
      out[a.seat] = updateBelief(out[a.seat] ?? INITIAL_BELIEF, a.action);
    }
    return out;
  };

  return (state, seat, config): BotDecision => {
    const actions = legalActions(state, seat, config);
    if (actions.length === 0) throw new Error(`no legal action for seat ${seat}`);

    const hero = seatOf(state, seat);
    const profile = findProfile(hero.profile ?? "professor")!;
    const opponents = contestingSeats(state)
      .filter((s) => s.id !== seat)
      .map((s) => s.id);
    const potBefore = state.pot;
    const toCallAmt = toCall(state, seat);
    const seed = hashSeed(state.seed, state.handNumber, seat, potBefore, toCallAmt);
    const beliefs = reads(state);

    const equity =
      opponents.length === 0
        ? null
        : runMultiwayEquitySync({
            heroHole: Array.from(encodeCards(hero.hole)),
            board: Array.from(encodeCards(state.board)),
            opponents,
            beliefs,
            simulations,
            seed,
          });
    const share = equity ? equity.equity : 1;

    const evByAction: Record<string, number> = {};
    for (const a of actions) {
      evByAction[a.label] = priceAction(a.type, a.cost, toCallAmt, potBefore, share);
    }

    const choice = chooseAction({
      profile,
      actions,
      evByAction,
      street: state.street,
      hole: hero.hole,
      strength: share,
      potBefore,
      toCall: toCallAmt,
      sizings: sizingLadder(state, seat, config),
      rng: makeRng(hashSeed(seed, 0x51ced1ce)),
    });

    return {
      seat,
      street: state.street,
      action: choice.action,
      potBefore,
      toCall: toCallAmt,
      equity: equity ?? {
        simulations: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        pWin: 1,
        pTie: 0,
        pLoss: 0,
        equity: 1,
        se: 0,
        ciWin: { lo: 1, hi: 1 },
        perOpponent: {},
      },
      evByAction,
      beliefs,
      profile: profile.id,
    };
  };
}

/** `hands` hands with `archetype` in seat 0 and pure-EV professors elsewhere. */
function playAs(
  archetype: BuiltArchetype,
  hands: number,
  seed: number,
  simulations = 240
): TableHandReport[] {
  const seats = 3;
  const table = createTable({
    seatCount: seats,
    startingStack: 200,
    smallBlind: 5,
    bigBlind: 10,
    seed,
    seats: Array.from({ length: seats }, (_, i) => ({
      name: i === 0 ? "Hero" : `P${i}`,
      kind: "bot" as const,
      profile: i === 0 ? archetype : "professor",
    })),
  });
  const decider = profileDecider(simulations);
  const reports: TableHandReport[] = [];
  for (let i = 0; i < hands; i++) reports.push(playHandHeadless(table, decider));
  return reports;
}

describe("through hands the engine actually dealt", () => {
  const HANDS = 120;
  const maniac = computeStats(playAs("maniac", HANDS, 20260801), 0);
  const rock = computeStats(playAs("rock", HANDS, 20260801), 0);

  it("separates the roster's extremes on both axes", () => {
    const wild = vectorFromStats(maniac);
    const tight = vectorFromStats(rock);
    expect(wild.vpip).toBeGreaterThan(tight.vpip);
    expect(wild.af!).toBeGreaterThan(tight.af!);
    expect(classifyStats(maniac).style).toBe("Maniac");
  });

  it("reads the rock as passive, which short-handed is what it plays like", () => {
    // Worth stating plainly, because it is a finding rather than a tautology:
    // over real hands three-handed the rock's measured VPIP (~37%) is far above
    // the 10.7% its entry threshold admits. `ENTRY_OVERRIDE_EDGE` in profiles.ts
    // waives the gate whenever a line makes more than a quarter of what it
    // risks, and completing a $5 small blind into a $15 pot clears that with
    // almost any two cards. So the honest label from PLAY is the passive one
    // rather than the tight one, a fact about the bot, not about the
    // classifier, and exactly why the parameter-level recovery above is measured
    // in spots priced so the gate is never waived.
    const verdict = classifyStats(rock);
    expect(["Nit", "Calling Station"]).toContain(verdict.style);
    expect(vectorFromStats(rock).af!).toBeLessThan(1);
    expect(vectorFromStats(rock).pfrRatio!).toBeLessThan(0.2);
  });

  it("gives a full session a confident, non-provisional verdict", () => {
    const verdict = classifyStats(maniac);
    expect(verdict.hands).toBe(HANDS);
    expect(verdict.provisional).toBe(false);
    expect(verdict.confidence).toBeGreaterThan(0.5);
  });

  it("is unconfident about the same seat after a dozen hands", () => {
    const short = classifyStats(computeStats(playAs("maniac", 12, 20260801), 0));
    expect(short.hands).toBe(12);
    expect(short.provisional).toBe(true);
    expect(short.confidence).toBeLessThan(0.15);
    // The label may well be right, it is the certainty that is not earned.
    expect(short.confidence).toBeLessThan(classifyStats(maniac).confidence);
  });

  it("keeps position slices consistent with the total", () => {
    const total = maniac.total.hands;
    const sliced = (Object.keys(maniac.byPosition) as (keyof typeof maniac.byPosition)[])
      .reduce((n, p) => n + maniac.byPosition[p].hands, 0);
    expect(sliced).toBe(total);
  });
});
