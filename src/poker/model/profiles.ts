/**
 * The bot roster.
 *
 * A seat's playing style lives here as data, four numbers per archetype -
 * rather than as a subclass with an overridden `decide()`. That is a deliberate
 * choice: the whole point of this project is to report honestly on what the
 * opponents are doing ("this seat enters 11% of pots and bluffs 3% of the time
 * it has nothing"), and you can only make that claim if the style is a number
 * you can print, not behaviour spread across a class hierarchy.
 *
 * Nothing in here estimates equity or computes EV. This module answers a
 * narrower question: given the EV of each legal action, which one does a
 * player with this personality actually take? The deviation from the pure
 * maximiser is the personality.
 */

import type { Card, Street } from "../../types";
import { holeScore } from "../bayesian";
import { makeRng, type Rng } from "../core/rng";
import type { BotArchetype, BotProfile } from "../table/contract";
import type { SizingOption, TableAction } from "../table/rules";

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/**
 * Archetypes that exist as static parameters.
 *
 * `mirror` is excluded on purpose: it copies a learned profile of the human
 * player, so it has no parameters until a session has been observed and cannot
 * be written down here. Deleting it from this `Exclude` is all Phase 2 needs -
 * the compiler will then demand the missing `BOT_PROFILES` entry rather than
 * letting a half-built archetype ship silently.
 */
export type BuiltArchetype = Exclude<BotArchetype, "mirror">;

/** Tightest to loosest. Order is the roster's display order. */
export const BOT_ARCHETYPES: readonly BuiltArchetype[] = [
  "nit",
  "rock",
  "tag",
  "professor",
  "lag",
  "station",
  "maniac",
] as const;

/**
 * The lowest score `holeScore` can return (72o). A threshold here admits every
 * hand, which is how the professor's entry gate is switched off, see below.
 */
export const MIN_HOLE_SCORE = -1;

/**
 * `entryThreshold` is a Chen-style `holeScore`, which runs -1 (72o) to 20 (AA).
 * The scale is coarse and lumpy, so the percentages below are the real
 * combo-weighted fraction of the 1326 starting hands at or above each cut:
 *
 *   >= 10 -> 4.4%   >= 8 -> 10.7%   >= 7 -> 17.8%
 *   >=  5 -> 43.3%  >= 3 -> 67.1%   >= 0 -> 96.4%
 *
 * Those are the numbers quoted in the blurbs, so a seat's advertised looseness
 * is checkable rather than decorative.
 */
export const BOT_PROFILES: Record<BuiltArchetype, BotProfile> = {
  // Tight-passive, taken to its extreme: folds so much that the blinds alone
  // grind it down. Low aggression and a tiny bluff rate, because the whole
  // failure mode of a nit is that it only ever puts chips in with the nuts.
  nit: {
    id: "nit",
    name: "Ultra-Tight",
    short: "Ultra-Tight",
    monogram: "UT",
    blurb: "Enters the top 4% of hands and rarely raises them.",
    entryThreshold: 10,
    aggression: 0.8,
    bluffRate: 0.01,
    preferredSizing: 0.5,
  },

  // Also tight-passive, but the axis that separates it from the nit is width,
  // not temperament: a rock plays a genuine (if narrow) range, and is the more
  // reluctant to build a pot with it (lower `aggression`) while firing at air
  // marginally more often, an 11% range actually misses sometimes, a 4% one
  // barely does. The two parameters are not the same axis.
  rock: {
    id: "rock",
    name: "Tight Passive",
    short: "Tight Passive",
    monogram: "TP",
    blurb: "Plays 11% of hands and shows little appetite for building pots.",
    entryThreshold: 8,
    aggression: 0.7,
    bluffRate: 0.02,
    preferredSizing: 0.5,
  },

  // Tight-aggressive: the textbook winning style. Barely wider than a rock, but
  // the aggression multiplier is on the other side of 1, which is the entire
  // difference, same cards, opposite chips.
  tag: {
    id: "tag",
    name: "Tight Aggressive",
    short: "TAG",
    monogram: "TAG",
    blurb: "Enters 18% of pots and applies pressure in all of them.",
    entryThreshold: 7,
    aggression: 1.35,
    bluffRate: 0.14,
    preferredSizing: 0.66,
  },

  // The neutral baseline: aggression 1 and bluffRate 0 make `chooseAction`
  // collapse to a plain argmax over unmodified EV, exactly the old heads-up
  // bot. The threshold sits at the minimum possible holeScore, which is a
  // disabled gate rather than a claim about looseness: this seat folds when
  // the EV says fold and for no other reason, so it can be tighter than a nit
  // or looser than a maniac depending only on the price it is being offered.
  // Every other profile is defined as a deviation from this row.
  professor: {
    id: "professor",
    name: "Expected Value Baseline",
    short: "EV Baseline",
    monogram: "EV",
    blurb: "Pure expected value, no personality. The row every other profile deviates from.",
    entryThreshold: MIN_HOLE_SCORE,
    aggression: 1,
    bluffRate: 0,
    preferredSizing: 0.5,
  },

  // Loose-aggressive: a much wider range than the TAG plus more of everything
  // after the flop. Wide and aggressive is what makes it hard to read, the
  // same bet covers far more hands.
  lag: {
    id: "lag",
    name: "Loose Aggressive",
    short: "LAG",
    monogram: "LAG",
    blurb: "Plays 43% of hands and barrels most of them, which makes it hard to range.",
    entryThreshold: 5,
    aggression: 1.6,
    bluffRate: 0.26,
    preferredSizing: 0.75,
  },

  // Loose-passive: the classic losing style. Enters two thirds of pots and then
  // almost never takes the betting lead, so it realises none of the equity its
  // wide range picks up. Small preferred sizing on the rare bet, and a bluff
  // rate near zero, a station's chips go in by calling, never by representing.
  station: {
    id: "station",
    name: "Calling Station",
    short: "Station",
    monogram: "CS",
    blurb: "Sees 67% of flops and folds almost none of them.",
    entryThreshold: 3,
    aggression: 0.55,
    bluffRate: 0.01,
    preferredSizing: 0.33,
  },

  // Loose-aggressive taken past the point of sense: plays essentially any two
  // cards, more than doubles the appeal of every bet and raise, and bluffs on
  // roughly two of every five hands it whiffs. Same quadrant as the LAG, but
  // strictly looser, strictly more aggressive, and strictly bluffier.
  maniac: {
    id: "maniac",
    name: "Hyper-Aggressive",
    short: "Maniac",
    monogram: "HA",
    blurb: "Plays 96% of hands, raises most of them, and bets pot with nothing.",
    entryThreshold: 0,
    aggression: 2.2,
    bluffRate: 0.42,
    preferredSizing: 1,
  },
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function getProfile(id: BuiltArchetype): BotProfile {
  return BOT_PROFILES[id];
}

/** Lookup for `TableSeat.profile`, which is a bare string. */
export function findProfile(id: string): BotProfile | undefined {
  return (BOT_PROFILES as Record<string, BotProfile>)[id];
}

/**
 * `count` distinct profiles, shuffled from a seed. Distinct because a table of
 * five identical maniacs teaches nothing about how styles interact, and seeded
 * because every table in this project must replay exactly from its seed alone.
 */
export function randomLineup(count: number, seed: number): BotProfile[] {
  if (count < 0) throw new Error(`randomLineup: negative count ${count}`);
  if (count > BOT_ARCHETYPES.length) {
    throw new Error(
      `randomLineup: asked for ${count} distinct bots, only ${BOT_ARCHETYPES.length} exist`
    );
  }
  return makeRng(seed)
    .shuffle([...BOT_ARCHETYPES])
    .slice(0, count)
    .map(getProfile);
}

// ---------------------------------------------------------------------------
// Choosing an action
// ---------------------------------------------------------------------------

/**
 * Equity below which there is no hand to value bet, so any bet is a bluff.
 *
 * Strictly this should be equity against the calling range rather than raw
 * equity against the field, but that needs the opponent model this module
 * deliberately does not depend on. Half the pot share is the honest coarse cut.
 */
export const VALUE_BET_FLOOR = 0.5;

/**
 * How much a hand below the entry threshold must be making, per chip it risks,
 * before the profile's discipline is overridden.
 *
 * Expressed as a ratio rather than a chip count so it means the same thing at
 * $2 blinds and $200 blinds. A nit dealt 84s in the big blind getting 6-to-1 is
 * making a clear profit; folding that would be a bug dressed up as a style.
 */
export const ENTRY_OVERRIDE_EDGE = 0.25;

export interface ActionChoiceInput {
  profile: BotProfile;
  /** From `legalActions`. */
  actions: TableAction[];
  /** EV of each action, keyed by `TableAction.label`, `BotDecision`'s shape. */
  evByAction: Record<string, number>;
  street: Street;
  /** The seat's hole cards; only the preflop entry gate reads them. */
  hole: Card[];
  /** Pot share this holding expects right now, 0..1. Gates bluffing. */
  strength: number;
  potBefore: number;
  toCall: number;
  /**
   * Whether calling would CLOSE the action, no seat behind still has a live
   * decision, so the pot the call is priced against is the final one.
   *
   * Read by the entry-gate override and by nothing else; see
   * `clearlyProfitable` for why it is the override's precondition.
   *
   * Omitted means "assume it closes", which is what a caller with no table to
   * read it from (a scripted spot, a synthetic fixture) gets. That is the
   * permissive direction on purpose: the flag exists to withdraw the override,
   * and withdrawing it from every caller that has not been taught the
   * distinction would tighten the roster invisibly.
   */
  closesAction?: boolean;
  /** From `sizingLadder`; the bluff picks the rung nearest `preferredSizing`. */
  sizings?: SizingOption[];
  /** Seeded, per decision. Nothing here ever calls `Math.random`. */
  rng: Rng;
}

export type ChoiceReason = "argmax" | "entry-fold" | "bluff" | "passive";

export interface ActionChoice {
  action: TableAction;
  /** Which of the three rules produced it, the seat's commentary line. */
  reason: ChoiceReason;
  /** EVs after the aggression tilt, keyed by label, for the audit trail. */
  tiltedEv: Record<string, number>;
}

const isAggressive = (a: TableAction) => a.type === "bet" || a.type === "raise";

/**
 * Bend an aggressive action's EV by the profile's aggression.
 *
 * The obvious `ev * aggression` is wrong the moment EV goes negative: it would
 * make a maniac less willing to fire a -$3 bluff than a rock, inverting the
 * whole parameter. Dividing on the negative side keeps the multiplier monotone
 * across zero, above 1 always makes betting look better, below 1 always worse
 *, while staying continuous at 0 and exactly the identity at 1, which is what
 * lets the professor be a genuine no-op rather than an approximate one.
 */
export function tiltEv(ev: number, aggression: number): number {
  return ev >= 0 ? ev * aggression : ev / aggression;
}

/** Whether this holding clears the profile's preflop entry bar. */
export function meetsEntry(profile: BotProfile, hole: Card[]): boolean {
  if (hole.length < 2) return true;
  return holeScore(hole[0], hole[1]) >= profile.entryThreshold;
}

/**
 * WHY `aggression` ALONE CANNOT MAKE A PROFILE PASSIVE
 *
 * `tiltEv` is a multiplier, so it preserves sign: `tiltEv(ev, a)` and `ev` are
 * on the same side of zero for every `a > 0`. That is fine while the two actions
 * being compared are on the same side of zero themselves, and it is what the
 * measured "AF lands on the multiplier" property rests on. It is useless the
 * moment they are not, and preflop multiway they never are.
 *
 * The reason is in how the two prices are formed. A call is priced by
 * `ev.actionEv` against the pot as it stands, because a call is assumed to
 * close the action; a bet or raise is priced by `ev.foldEquityEv` against the
 * pot every caller will have built by the time the hand is decided. Six-handed
 * with an even share of the equity those come out at roughly
 *
 *     call   =  share x pot        - (1 - share) x toCall     ~  -4 chips
 *     raise  =  share x (pot + Σ owed) - (1 - share) x cost   ~  +12 chips
 *
 * for the same holding, so raising is priced positive and calling negative for
 * essentially every hand. No `aggression` in (0, ∞) reorders a positive number
 * below a negative one, and measurement agrees: over 220 six-handed hands only
 * 4.3% of the spots where the aggressive line led could be flipped by any
 * multiplier below 1. That is why every profile's PFR tracked its VPIP, and it
 * is not something a different constant in `BOT_PROFILES` can fix.
 *
 * What can, without a new parameter: this module already names the equity below
 * which a bet cannot be for value (`VALUE_BET_FLOOR`), and already carries the
 * rate at which each profile fires there (`bluffRate`). Below the floor every
 * aggressive action is a bluff by this module's own definition, so letting the
 * argmax take one whenever a one-street EV model likes the price made the
 * declared `bluffRate` a fiction, a station with `bluffRate: 0.01` was firing
 * at air in roughly half its spots. Rule 2 below therefore decides both ways for
 * a profile that is passive by parameter: it fires at `bluffRate` and declines
 * otherwise. Aggressive profiles keep the maximiser's freedom, so `aggression`
 * still has exactly one mechanism on each side of 1, `tiltEv` promotes above
 * it, this rule demotes below it, and the professor at exactly 1 is untouched.
 */

/** Whether a profile is passive by parameter. The professor sits exactly at 1. */
const isPassive = (profile: BotProfile) => profile.aggression < 1;

/**
 * Pick an action for a seat with this personality.
 *
 * Three rules, in order, because each is allowed to veto the next:
 *   1. Preflop discipline, below the entry threshold, fold rather than pay to
 *      see a flop, unless the price makes it clearly profitable anyway.
 *   2. Bluff, or decline to. With a hand too weak to value bet, fire anyway at
 *      `bluffRate`; a passive profile that does not fire declines the aggressive
 *      line entirely rather than letting the argmax take it (see above).
 *   3. Otherwise take the highest EV, with aggressive actions tilted first.
 *
 * The only randomness is rule 2's coin flip, drawn from the injected `Rng`, and
 * it is drawn only when a bluff is actually possible. So a profile with
 * `bluffRate === 0` consumes no entropy at all and is a pure argmax. Rule 2's
 * new second half reads that same coin rather than drawing another, so passivity
 * costs no extra entropy and cannot desynchronise a replay.
 */
export function chooseAction(input: ActionChoiceInput): ActionChoice {
  const { profile, actions, evByAction, rng } = input;
  if (actions.length === 0) {
    throw new Error("chooseAction: no legal actions");
  }

  const tiltedEv: Record<string, number> = {};
  for (const action of actions) {
    const ev = evByAction[action.label] ?? 0;
    tiltedEv[action.label] = isAggressive(action)
      ? tiltEv(ev, profile.aggression)
      : ev;
  }

  // 1. Entry gate. Only reachable when folding is legal, i.e. someone has bet -
  //    the big blind checking its option is never a "decision to enter".
  const fold = actions.find((a) => a.type === "fold");
  if (
    fold &&
    input.street === "preflop" &&
    !meetsEntry(profile, input.hole) &&
    !clearlyProfitable(
      actions,
      tiltedEv,
      input.toCall,
      input.closesAction ?? true
    )
  ) {
    return { action: fold, reason: "entry-fold", tiltedEv };
  }

  // 2. Bluff. Nothing worth betting for value, so the only reason to bet is to
  //    make someone fold, which is exactly what `bluffRate` measures.
  const aggressive = actions.find(isAggressive);
  if (aggressive && input.strength < VALUE_BET_FLOOR) {
    if (profile.bluffRate > 0 && rng.next() < profile.bluffRate) {
      return { action: sizedBluff(aggressive, input), reason: "bluff", tiltedEv };
    }
    // ...and the other side of that same coin: a profile that is passive by
    // parameter does not fire at a hand it cannot value bet, so it takes its
    // passive continuation instead of letting rule 3 raise for it.
    if (isPassive(profile)) {
      const passive = bestPassive(actions, tiltedEv);
      if (passive) return { action: passive, reason: "passive", tiltedEv };
    }
  }

  // 3. Argmax. Strict `>` keeps the first action in `legalActions` order on a
  //    tie, so equal EVs never depend on the RNG or on object key order.
  let best = actions[0];
  let bestEv = tiltedEv[best.label];
  for (const action of actions) {
    const ev = tiltedEv[action.label];
    if (ev > bestEv) {
      bestEv = ev;
      best = action;
    }
  }
  return { action: best, reason: "argmax", tiltedEv };
}

/**
 * The best way to keep playing without building the pot: a check or a call.
 *
 * Folding is deliberately not a candidate. Declining to raise is a statement
 * about aggression; whether the hand is worth playing at all was already settled
 * by rule 1, and re-deciding it here would turn `aggression` into a second,
 * hidden entry gate. Measured, that is not a nicety: falling back to the plain
 * argmax over fold-and-call instead would have dropped the station's VPIP from
 * 53% to ~19% against a declared 67%, because `ev.actionEv` prices a multiway
 * call negative (see the note above) in 63% of the spots the entry gate admits.
 * Width belongs to `entryThreshold` and to nothing else.
 *
 * Returns undefined when there is no passive continuation, an all-in to answer,
 * where the only moves are call-or-fold with no rung in between, and rule 3
 * then decides normally.
 */
function bestPassive(
  actions: TableAction[],
  tiltedEv: Record<string, number>
): TableAction | undefined {
  let best: TableAction | undefined;
  for (const action of actions) {
    if (isAggressive(action) || action.type === "fold") continue;
    if (!best || tiltedEv[action.label] > tiltedEv[best.label]) best = action;
  }
  return best;
}

/**
 * Is calling so obviously profitable that the style's entry gate should yield?
 *
 * Only passive actions can waive the gate, and deliberately so. The override
 * exists for the case its constant documents, a nit in the big blind getting
 * 6-to-1, which is a call: cheap, priced entirely by this street, and wrong to
 * fold. A raise is different in kind. Its EV here is a single-street number, and
 * the chips it commits get contested on streets this model cannot see, so a
 * marginal steal showing a small edge is not evidence the hand is worth playing.
 * Letting raises waive the gate made every profile enter 42-54% of pots and
 * collapsed the roster toward the maniac.
 *
 * A call that does NOT close the action is single-street in exactly that same
 * sense, and is excluded for exactly that same reason. "Getting 6-to-1" is only
 * a fact about the price when the price is settled: with seats behind still
 * owing chips, the pot the call is priced against is one they will grow, so the
 * number compared to the bar is a forecast rather than a quotation. The
 * distinction did not matter while `ev.actionEv` priced every such call against
 * a pot too small to clear the bar; it matters the moment that pot is priced
 * correctly (`ev.callEv`), because the correction adds `share · E[Σ owed]` to
 * every non-closing call monotonically and can therefore only make this fire
 * more. Measured over 220 six-handed hands, letting it: the nit's override
 * firings went 8 -> 59 and its VPIP 9.5% -> 25.9%, collapsing into the rock
 * (26.4) and the tag (27.7) and destroying the roster's width ordering at the
 * tight end. Width belongs to `entryThreshold` and to nothing else.
 *
 * The bar also scales with what the action actually risks rather than with the
 * price of calling, which is what the constant's "per chip risked" means.
 */
function clearlyProfitable(
  actions: TableAction[],
  tiltedEv: Record<string, number>,
  toCall: number,
  closesAction: boolean
): boolean {
  if (!closesAction) return false;
  return actions.some(
    (a) =>
      a.type !== "fold" &&
      !isAggressive(a) &&
      tiltedEv[a.label] > ENTRY_OVERRIDE_EDGE * Math.max(a.cost, toCall, 1)
  );
}

/**
 * Resize a bet or raise to the profile's preferred pot fraction.
 *
 * `sizingLadder` hands back chip costs, not fractions, so the fraction is
 * recovered by inverting its formula (`cost = toCall + f * (pot + toCall)`).
 * Cheaper than asking the caller to pass fractions it does not otherwise have,
 * and it stays correct if the ladder's rungs ever change.
 */
function sizedBluff(base: TableAction, input: ActionChoiceInput): TableAction {
  const sizings = input.sizings ?? [];
  if (sizings.length === 0) return base;

  const potAfterCall = input.potBefore + input.toCall;
  let pick: SizingOption = sizings[0];
  let bestGap = Infinity;
  for (const option of sizings) {
    const fraction =
      potAfterCall > 0 ? (option.cost - input.toCall) / potAfterCall : 0;
    const gap = Math.abs(fraction - input.profile.preferredSizing);
    if (gap < bestGap) {
      bestGap = gap;
      pick = option;
    }
  }

  // The ladder is already clamped to the legal range, but an "All-in" rung can
  // exceed a `min`-sized base action's cost, so re-clamp defensively.
  const min = base.min ?? base.cost;
  const max = base.max ?? base.cost;
  const cost = Math.min(Math.max(pick.cost, min), max);
  // base.amount - base.cost is the seat's existing street commitment.
  const amount = base.amount - base.cost + cost;

  return {
    ...base,
    cost,
    amount,
    label:
      cost >= max
        ? `All-in $${cost}`
        : base.type === "bet"
          ? `Bet $${cost}`
          : `Raise to $${amount}`,
  };
}
