/**
 * What each decision cost, the two numbers, and why there are two.
 *
 * Every action a seat takes is scored against the alternatives it could have
 * taken instead. The score is reported twice, and the distinction between the
 * two is the pedagogical core of this whole layer:
 *
 *   modelEv, priced against the range inferred from the PUBLIC action so
 *                 far. Nothing but what the seat could have known at the moment
 *                 it acted. This is the honest metric and the only one a
 *                 decision should be judged by.
 *
 *   hindsightEv, priced against the opponents' ACTUAL cards and the board that
 *                 actually came. Omniscient, and therefore results-oriented: a
 *                 correct call that got outdrawn shows a loss here, and a
 *                 reckless call that spiked shows a gain.
 *
 * A player who conflates them learns exactly the wrong lesson, "I lost, so it
 * was wrong", which is why the two are never merged into one field, never
 * averaged, and never share a name. `modelEvLoss` is the coaching number.
 * `hindsightEvLoss` exists to be shown next to it, so the gap between them can
 * be named out loud as variance rather than mistaken for skill.
 *
 * Sign convention, matching `player_stats`/`decisions` in
 * db/migrations/001_persistence.sql:
 *
 *     evLoss = evChosen - evBest  <= 0,  and exactly 0 iff the best was taken.
 *
 * Negative because it is a loss. It cannot be positive: the chosen action is
 * always a member of the set the best is taken over.
 *
 * Scope, stated because the input contract genuinely limits it:
 *
 *  - This compares ACTION CLASSES (fold / check / call / bet / raise), not bet
 *    sizes. The project's forward-looking EV model has no fold equity, the
 *    opponent is assumed to call, so `d(EV)/d(cost) = 2·equity − 1`, and any
 *    holding above 50% equity would be told to jam every time. A sizing
 *    critique from that model would be noise dressed up as advice, so the
 *    aggressive alternative is priced at exactly one canonical size (the ½-pot
 *    rung of `sizingLadder`) and the seat's own size is used whenever the seat
 *    itself bet or raised.
 *  - `TableHandReport` carries no stacks, so this module cannot tell a seat that
 *    chose to call from one that was all-in and had no raise available. The
 *    aggressive alternative is therefore always priced; `alternatives` lists
 *    exactly what was considered, so a counterfactual is visible rather than
 *    hidden.
 *
 * CLASSIFICATION.
 *
 * A price is not a lesson. "That call cost 180" is a fact about one hand; "you
 * call below the price the pot is laying you" is a fact about a game, and only
 * the second one transfers. Every decision therefore also carries a `kind`, a
 * name for WHAT went wrong, read off the model lens. Hindsight names exactly one
 * kind and it is the one that is not a leak, see RESULTS-ORIENTED below.
 *
 * Two rules keep the vocabulary honest.
 *
 * The first is that `kind` is `null` whenever the recorded data cannot support a
 * name. A wrong leak name is worse than no leak name: the player drills the
 * wrong thing, and the analysis spent its credibility to send them there. The
 * `null` bucket is aggregated and ranked like any other, so an unclassifiable
 * majority is visible rather than quietly absorbed into the nearest label.
 *
 * The second is that the pricing model's blind spot decides which kinds may
 * exist at all. `priceAction` carries no fold-equity term, so it prices every
 * bet as though it were called. That error has a direction: it UNDERSTATES
 * betting. So
 *
 *   - "the model wanted the aggressive line and you took the passive one" is
 *     safe. Fold equity could only have widened that gap, so the complaint
 *     survives adding the term the model lacks. That kind is `missed-value`.
 *   - "you bet without value" is not safe, and is REJECTED for that reason. It
 *     is what this model says about every bluff ever made, and a taxonomy that
 *     files bluffing under leaks teaches a falsehood with the authority of a
 *     number. Such a decision is left unclassified instead.
 *
 * PRICE, not MDF. Owing `toCall` into `potBefore`, a call breaks even at
 * `toCall / (potBefore + toCall)` of the pot. That is exact from the record and
 * assumes nothing about who put which chips in, and it is the threshold the call
 * and fold kinds test against. Alpha and MDF are deliberately NOT used per
 * decision. MDF is a frequency over a range, one fold has no frequency, and
 * "folded above MDF" is therefore a category error wearing a diagnosis. The
 * frequency claim belongs to the aggregate, where `LeakAggregate.rate` divides a
 * count by the number of spots that actually offered the error, and that is a
 * number MDF can be set against.
 *
 * MULTIWAY. `perOpponent` (`equity/multiway.ts`, where it falls out of the same
 * scoring pass and costs nothing) is the hero's equity against each seat taken
 * alone. When the hero had the price against every opponent individually and did
 * not have it against the field, the mistake is not the call, it is the
 * arithmetic: equity does not survive being multiplied by a field. That is
 * `multiway-as-heads-up`, and it is tested before `call-below-price` because it
 * is a strict refinement of it and names the mechanism instead of the symptom.
 *
 * RESULTS-ORIENTED is the one kind that is not a leak. It fires when
 * `modelEvLoss` is within noise of zero, hindsight's best line was to fold, and
 * the gap between the lenses is a real fraction of the pot: the read said be in
 * this hand, the cards said be out of it, and the player was right. It is a kind
 * rather than an absence of one because the alternative is silence, and silence
 * in that exact spot is what teaches the lesson this module exists to prevent.
 * Its `modelEvLoss` is bounded by the mistake threshold, so it cannot outrank a
 * real leak; its `totalHindsightEvLoss` is the number worth showing.
 *
 * RANKING. Kinds are ranked by total model EV lost, which is count times mean
 * per occurrence, so the order is frequency x cost by construction. Ranking by
 * the single worst decision instead puts one disastrous hand above a habit the
 * player has forty times, and the habit is what is actually costing them. The
 * mean is reported next to the total rather than instead of it, because a rare
 * expensive kind and a frequent cheap one need different advice.
 *
 * NOISE. `modelEquity` is a Monte Carlo estimate, so every comparison above
 * carries a margin: `MISTAKE_POT_FRACTION` of the pot before a loss counts as a
 * mistake at all, and `PRICE_MARGIN` of equity before a holding counts as being
 * on the wrong side of a price. Both sit at roughly two to three standard errors
 * at `DEFAULT_MODEL_SIMS`. Without them the classifier would put names to the
 * sampler's own noise, and it would do it most often in the marginal spots where
 * a name matters most.
 *
 * Everything here reads only the long-standing fields of `TableHandReport`
 * (`seats`, `board`, `actions`, `button`, `seatCount`, `seed`) and rebuilds the
 * opponent read itself, so it works identically for a human seat, which has no
 * `BotDecision` and no recorded equity, and for a bot.
 */

import { INITIAL_BELIEF } from "../../data/constants";
import type {
  ActionType,
  BeliefDistribution,
  Street,
} from "../../types";
import { updateBelief } from "../bayesian";
import { hashSeed, makeRng } from "../core/rng";
import { runMultiwayEquitySync } from "../equity/pool";
import { scoreInts } from "../handEvaluator";
import { positionOf, type PositionName } from "../table/position";
import type { ActionRecord, TableHandReport } from "../table/contract";

/** Streets a decision can be taken on. `showdown` has no actions. */
export type ActingStreet = Exclude<Street, "showdown">;

export const ACTING_STREETS: readonly ActingStreet[] = [
  "preflop",
  "flop",
  "turn",
  "river",
] as const;

/** Board cards face-up when a street's betting happens. */
const BOARD_CARDS_AT: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
  showdown: 5,
};

/**
 * Sims behind each decision's model equity.
 *
 * 2000 puts the standard error on a coin-flip spot at ~1.1%, which moves a
 * pot-sized EV by about a hundredth of a pot, well under the gaps this module
 * is asked to report on, and cheap enough to score a whole session in a beat.
 */
export const DEFAULT_MODEL_SIMS = 2000;

/**
 * Runouts sampled for hindsight when the board never completed.
 *
 * Only reachable for hands that ended before the river with cards still to come
 * (everyone folded preflop, say). Two board cards or fewer are enumerated
 * exactly instead, see `hindsightEquity`, so this is the preflop-fold case and
 * nothing else, and `DecisionEvLoss.hindsightExact` says which one happened.
 */
export const DEFAULT_HINDSIGHT_RUNOUTS = 4000;

/**
 * Pot fraction for the hypothetical bet/raise, matching the ½-pot rung of
 * `sizingLadder` (`cost = toCall + f·(pot + toCall)`) so the counterfactual is
 * a size the seat was actually offered.
 */
export const AGGRESSIVE_ALTERNATIVE_FRACTION = 0.5;

export interface EvLossOptions {
  /** Monte Carlo sims per decision for the model equity. */
  simulations?: number;
  /** Sampled runouts when the actual board is more than two cards short. */
  hindsightRunouts?: number;
  /** Pot fraction of the hypothetical aggressive alternative. */
  aggressiveFraction?: number;
}

/** One counterfactual, priced under both lenses. */
export interface AlternativeEv {
  action: ActionType;
  /** Chips this line would have added now. */
  cost: number;
  /** Priced against the inferred range, what was knowable. */
  modelEv: number;
  /** Priced against the actual cards, what happened. */
  hindsightEv: number;
  /** True for the line the seat actually took. */
  chosen: boolean;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * What kind of mistake a decision was, as opposed to what it cost.
 *
 * Every member is a claim the model lens can make on its own from the recorded
 * action, and the header's CLASSIFICATION section says why the obvious extra
 * members ("bet without value", "folded above MDF") are absent rather than
 * merely unimplemented.
 */
export type LeakKind =
  | "results-oriented"
  | "multiway-as-heads-up"
  | "fold-to-cbet"
  | "fold-above-price"
  | "call-below-price"
  | "missed-value";

/**
 * Every kind, in classifier precedence order: the earliest match wins, so a
 * refinement is listed above the general case it refines.
 */
export const LEAK_KINDS: readonly LeakKind[] = [
  "results-oriented",
  "multiway-as-heads-up",
  "fold-to-cbet",
  "fold-above-price",
  "call-below-price",
  "missed-value",
] as const;

/**
 * The one kind that is not a leak. Exported so a caller can present it
 * separately without hardcoding the string, which is exactly the mistake that
 * would let it be listed as something the player should fix.
 */
export const NOT_A_LEAK: LeakKind = "results-oriented";

/** Fraction of the pot a model loss must exceed to count as a mistake. */
export const MISTAKE_POT_FRACTION = 0.02;

/** Floor on that threshold, so a blind-sized pot still needs a real loss. */
export const MISTAKE_FLOOR_CHIPS = 1;

/**
 * Equity a holding must clear a price by before it is called wrong-side of it.
 * About three standard errors at `DEFAULT_MODEL_SIMS`.
 */
export const PRICE_MARGIN = 0.03;

/**
 * Fraction of the pot the hindsight-minus-model gap must exceed before a
 * correctly played decision is called out as punished by the cards.
 */
export const VARIANCE_GAP_POT_FRACTION = 0.2;

/**
 * How large a model loss has to be, in chips, before it is a mistake rather
 * than the sampler's noise. Scaled by the pot because the noise is: the EV error
 * from an equity error of e is on the order of e times the pot.
 */
export function mistakeThreshold(potBefore: number): number {
  return Math.max(MISTAKE_FLOOR_CHIPS, MISTAKE_POT_FRACTION * potBefore);
}

export interface DecisionEvLoss {
  /** Index into `report.actions`. */
  index: number;
  handNumber: number;
  seat: number;
  street: ActingStreet;
  position: PositionName;
  action: ActionType;
  cost: number;
  potBefore: number;
  toCall: number;

  // --- Model: the honest lens ---------------------------------------------
  /** Pot share against the inferred range, 0..1. */
  modelEquity: number;
  /**
   * Pot share against each live opponent taken alone, keyed by seat id, from the
   * same run and the same inferred ranges as `modelEquity`. Empty when the seat
   * had nobody left to beat.
   *
   * The gap between the smallest of these and `modelEquity` is the cost of the
   * field, and it is the evidence behind `multiway-as-heads-up`.
   */
  modelEquityPerOpponent: Record<number, number>;
  modelEvChosen: number;
  modelEvBest: number;
  modelBestAction: ActionType;
  /** `modelEvChosen - modelEvBest`, always <= 0. Zero means no mistake. */
  modelEvLoss: number;

  // --- Hindsight: results-oriented, never coach from this alone ------------
  /** Pot share against the actual cards, 0..1. */
  hindsightEquity: number;
  hindsightEvChosen: number;
  hindsightEvBest: number;
  hindsightBestAction: ActionType;
  /** `hindsightEvChosen - hindsightEvBest`, always <= 0. */
  hindsightEvLoss: number;
  /** False when the runout was sampled rather than enumerated or observed. */
  hindsightExact: boolean;

  alternatives: AlternativeEv[];

  // --- Classification: the name, and the evidence behind it ----------------
  //
  // The three fields below `kind` are what the classifier reads and what a
  // caller needs to state the finding as a sentence ("you needed 23% and had
  // 18%", "you were ahead of each of the three of them and behind the field").
  // All three are derivations of the same `TableHandReport`, so a decision can
  // still be re-scored in isolation.

  /** Seats still contesting the pot when the decision was taken, hero aside. */
  opponentCount: number;
  /**
   * Pot share a call has to beat to break even, `toCall / (potBefore + toCall)`.
   * Null when nothing was owed, a check or a bet has no price to be wrong about.
   */
  requiredEquity: number | null;
  /**
   * True when this is a flop decision facing a bet from the seat that was the
   * last preflop aggressor, which is what a continuation bet is.
   */
  facingCbet: boolean;
  /** Null when the recorded data supports no honest name. See `LeakKind`. */
  kind: LeakKind | null;
}

/**
 * Everything `classifyLeak` is allowed to look at, which is a whole decision
 * minus the answer. Written as an `Omit` rather than a hand-listed subset so a
 * new field on `DecisionEvLoss` is available to the classifier automatically and
 * a `DecisionEvLoss` can be passed straight in.
 */
export type LeakEvidence = Omit<DecisionEvLoss, "kind">;

/**
 * Name the mistake, or decline to.
 *
 * Reads the model lens only, with the single exception of `results-oriented`,
 * which is a statement about the gap between the lenses and cannot be made
 * without both. Precedence follows `LEAK_KINDS`.
 */
export function classifyLeak(d: LeakEvidence): LeakKind | null {
  const threshold = mistakeThreshold(d.potBefore);

  // Played correctly. The only thing left to ask is whether the cards punished
  // it anyway, and that is the one question hindsight answers by itself.
  //
  // The gap alone is not enough to ask it with. `hindsightEvLoss` is negative
  // for a winner too, because with the cards face up the omniscient line is
  // always the biggest raise, so "you were ahead and could have charged more"
  // shares a sign with "you were behind and the cards took your chips". Only the
  // second is variance. `hindsightBestAction === "fold"` separates them exactly:
  // folding wins the hindsight lens only when every line that put chips in lost
  // them, which is to say the cards said be out of this hand while the read said
  // be in it. That is the whole of the claim, and it is why a bare gap test was
  // rejected here.
  if (d.modelEvLoss > -threshold) {
    const punished = Math.max(
      MISTAKE_FLOOR_CHIPS,
      VARIANCE_GAP_POT_FRACTION * d.potBefore
    );
    return d.hindsightBestAction === "fold" &&
      d.hindsightEvLoss - d.modelEvLoss < -punished
      ? "results-oriented"
      : null;
  }

  const price = d.requiredEquity;
  if (price !== null) {
    if (d.action === "fold" && d.modelEquity > price + PRICE_MARGIN) {
      return d.facingCbet ? "fold-to-cbet" : "fold-above-price";
    }

    if (d.action !== "fold" && d.modelEquity + PRICE_MARGIN < price) {
      // Ahead of each of them, behind all of them: the field is the whole of
      // the mistake. Tested before the bare price failure it refines.
      const heads = Object.values(d.modelEquityPerOpponent);
      if (
        d.opponentCount >= 2 &&
        heads.length === d.opponentCount &&
        Math.min(...heads) > price + PRICE_MARGIN
      ) {
        return "multiway-as-heads-up";
      }
      if (d.action === "call") return "call-below-price";
    }
  }

  // Passive where the model wanted aggression. Safe in exactly one direction:
  // the missing fold-equity term could only have made the aggressive line look
  // better still. The mirror claim is rejected, see the header.
  const wantedAggression =
    d.modelBestAction === "bet" || d.modelBestAction === "raise";
  const wasPassive = d.action === "check" || d.action === "call";
  if (wantedAggression && wasPassive) return "missed-value";

  return null;
}

/** One kind, counted and priced across a set of decisions. */
export interface LeakAggregate {
  /** Null is the unclassified bucket, reported rather than dropped. */
  kind: LeakKind | null;
  /** Decisions classified this way. */
  count: number;
  /**
   * Decisions that OFFERED this error, whether or not they committed it: the
   * denominator that turns a count into a frequency. Always >= `count`, because
   * committing an error implies having been in a spot that allowed it.
   */
  opportunities: number;
  /** `count / opportunities`, and 0 when no decision offered the error. */
  rate: number;
  /** Σ `modelEvLoss` over the bucket, <= 0. The ranking key. */
  totalModelEvLoss: number;
  /** Σ `hindsightEvLoss` over the bucket. What `results-oriented` is read from. */
  totalHindsightEvLoss: number;
  /** `totalModelEvLoss / count`. Cost of one occurrence, not of the habit. */
  meanModelEvLoss: number;
  /** Most negative `modelEvLoss` in the bucket; ties go to the earliest. */
  worst: DecisionEvLoss | null;
}

/**
 * Whether a decision was in a position to commit `kind`.
 *
 * The denominators are deliberately narrow. Counting every decision as an
 * opportunity to overfold to a continuation bet would divide fourteen bad folds
 * by four hundred decisions and report a 3.5% leak, when the honest number is
 * fourteen out of the forty continuation bets the seat actually faced.
 */
function offersLeak(kind: LeakKind | null, d: DecisionEvLoss): boolean {
  switch (kind) {
    case "results-oriented":
      // Only a decision played correctly can have been punished for it.
      return d.modelEvLoss > -mistakeThreshold(d.potBefore);
    case "multiway-as-heads-up":
      return d.toCall > 0 && d.opponentCount >= 2;
    case "fold-to-cbet":
      return d.facingCbet;
    case "fold-above-price":
    case "call-below-price":
      return d.toCall > 0;
    case "missed-value":
      // Every decision has a passive line and an aggressive one available.
      return true;
    case null:
      return true;
  }
}

/**
 * Group decisions by kind and rank the groups by frequency x cost.
 *
 * The product is `totalModelEvLoss` itself, since a total is a count times a
 * mean, so the total is the sort key and no separate score has to be invented
 * and justified. Empty buckets are dropped: a list of kinds the player has never
 * committed is not a finding.
 *
 * Takes a flat decision list rather than a `HandEvLoss`, because a frequency
 * needs a sample and one hand is not one. `SessionEvLoss.leaks` is the intended
 * caller for that reason.
 */
export function aggregateLeaks(
  decisions: readonly DecisionEvLoss[]
): LeakAggregate[] {
  const out: LeakAggregate[] = [];
  for (const kind of [...LEAK_KINDS, null] as (LeakKind | null)[]) {
    const own = decisions.filter((d) => d.kind === kind);
    if (own.length === 0) continue;

    let totalModelEvLoss = 0;
    let totalHindsightEvLoss = 0;
    let worst: DecisionEvLoss | null = null;
    for (const d of own) {
      totalModelEvLoss += d.modelEvLoss;
      totalHindsightEvLoss += d.hindsightEvLoss;
      if (!worst || d.modelEvLoss < worst.modelEvLoss) worst = d;
    }

    const opportunities = decisions.filter((d) => offersLeak(kind, d)).length;
    out.push({
      kind,
      count: own.length,
      opportunities,
      rate: opportunities > 0 ? own.length / opportunities : 0,
      totalModelEvLoss,
      totalHindsightEvLoss,
      meanModelEvLoss: totalModelEvLoss / own.length,
      worst,
    });
  }

  // Ties to the more frequent kind: the same chips lost more often is the firmer
  // read on a habit, and the firmer read is the one worth putting first.
  out.sort(
    (a, b) => a.totalModelEvLoss - b.totalModelEvLoss || b.count - a.count
  );
  return out;
}

export interface EvLossTotals {
  model: number;
  hindsight: number;
}

export interface HandEvLoss {
  handNumber: number;
  seat: number;
  decisions: DecisionEvLoss[];
  /** Σ of `modelEvLoss` over the seat's decisions. <= 0. */
  totalModelEvLoss: number;
  totalHindsightEvLoss: number;
  byStreet: Record<ActingStreet, EvLossTotals>;
  /** Most negative `modelEvLoss`; ties go to the earliest decision. */
  worst: DecisionEvLoss | null;
}

export interface SessionEvLoss {
  seat: number;
  hands: HandEvLoss[];
  decisionCount: number;
  totalModelEvLoss: number;
  totalHindsightEvLoss: number;
  byStreet: Record<ActingStreet, EvLossTotals>;
  worst: DecisionEvLoss | null;
  /**
   * Every kind the seat committed, ranked by frequency x cost. Lives on the
   * session and not on `HandEvLoss` because a frequency needs a sample: one
   * hand's worth of "you did this once" is the per-hand cost report again under
   * a new name.
   */
  leaks: LeakAggregate[];
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Forward-looking (pot-odds) EV of one line, from a scalar pot share.
 *
 * The same formula `ev.ts`'s `actionEv` prices with, restated over a bare
 * `equity` because this module's input is an `ActionRecord` rather than a
 * `LegalAction` plus a `MonteCarloResult`, and because the counterfactual lines
 * it prices were never legal-action objects in the first place.
 *
 *   fold        0                                    (risk nothing, win nothing)
 *   check       equity · pot
 *   call        equity · pot − (1 − equity) · cost
 *   bet/raise   equity · (pot + extra) − (1 − equity) · cost,  extra = cost − toCall
 *
 * `equity` is the pot SHARE, not the outright-win rate: a four-way chop is worth
 * a quarter of the pot and `pWin` scores it as zero.
 */
export function priceAction(
  action: ActionType,
  cost: number,
  toCall: number,
  potBefore: number,
  equity: number
): number {
  if (action === "fold") return 0;
  const extra = Math.max(0, cost - toCall);
  return equity * (potBefore + extra) - (1 - equity) * cost;
}

/**
 * The lines available, as classes.
 *
 * Facing a bet: fold, call, raise. Facing none: check, bet. The chosen line's
 * own cost always wins over the canonical size, which is what guarantees the
 * chosen action is a member of the set and hence that the loss is <= 0.
 */
function alternativesFor(
  record: ActionRecord,
  fraction: number
): { action: ActionType; cost: number }[] {
  const facing = record.toCall > 0;
  const aggressive: ActionType = facing ? "raise" : "bet";
  // The seat's own size when it was the seat that raised, never a rounded
  // stand-in for it, so the chosen line is a member of this set exactly and the
  // loss cannot come out positive by a rounding step.
  const aggressiveCost =
    record.action === aggressive
      ? record.cost
      : Math.max(
          Math.round(record.toCall + fraction * (record.potBefore + record.toCall)),
          record.toCall + 1
        );

  const lines: { action: ActionType; cost: number }[] = facing
    ? [
        { action: "fold", cost: 0 },
        { action: "call", cost: record.toCall },
        { action: "raise", cost: aggressiveCost },
      ]
    : [
        { action: "check", cost: 0 },
        { action: "bet", cost: aggressiveCost },
      ];

  // A record whose action is not in the class set for its `toCall` should be
  // impossible, but a hand-built report can carry one. Add it rather than drop
  // it: scoring an action against a set it is not in would break the sign.
  if (!lines.some((l) => l.action === record.action)) {
    lines.push({ action: record.action, cost: record.cost });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Reading the hand
// ---------------------------------------------------------------------------

/** Seats dealt in, a seat with no hole cards never had a hand to analyse. */
function dealtSeats(report: TableHandReport): number[] {
  return report.seats.filter((s) => s.hole.length === 2).map((s) => s.seat);
}

/** Seats other than `hero` that had not folded by `index`. */
function liveOpponentsAt(
  report: TableHandReport,
  hero: number,
  index: number
): number[] {
  const folded = new Set<number>();
  for (let i = 0; i < index; i++) {
    if (report.actions[i].action === "fold") folded.add(report.actions[i].seat);
  }
  return dealtSeats(report).filter((s) => s !== hero && !folded.has(s));
}

/**
 * The read on every seat from the public action prefix alone.
 *
 * Deliberately public-information-only: the same prior for everyone, moved by
 * `updateBelief` once per action taken. No hole card is consulted, so the model
 * lens sees exactly what the seat could have worked out for itself.
 */
function beliefsAt(
  report: TableHandReport,
  index: number
): Record<number, BeliefDistribution> {
  const reads: Record<number, BeliefDistribution> = {};
  for (const seat of report.seats) reads[seat.seat] = INITIAL_BELIEF;
  for (let i = 0; i < index; i++) {
    const record = report.actions[i];
    reads[record.seat] = updateBelief(
      reads[record.seat] ?? INITIAL_BELIEF,
      record.action
    );
  }
  return reads;
}

function holeOf(report: TableHandReport, seat: number): number[] {
  return report.seats.find((s) => s.seat === seat)?.hole ?? [];
}

// ---------------------------------------------------------------------------
// Equity, both lenses
// ---------------------------------------------------------------------------

/**
 * Model equity, with the per-opponent heads-up shares alongside it.
 *
 * Both come out of one run: `perOpponent` is a by-product of the same scoring
 * pass (see `equity/multiway.ts`) and costs nothing, which is what makes the
 * multiway classification free rather than a second simulation per decision.
 */
function modelEquity(
  report: TableHandReport,
  hero: number,
  index: number,
  street: ActingStreet,
  opponents: number[],
  simulations: number
): { equity: number; perOpponent: Record<number, number> } {
  // Nobody to beat: the pot is already this seat's, and no sampling is honest
  // about a certainty.
  if (opponents.length === 0) return { equity: 1, perOpponent: {} };

  const visible = Math.min(BOARD_CARDS_AT[street], report.board.length);
  const run = runMultiwayEquitySync({
    heroHole: holeOf(report, hero),
    board: report.board.slice(0, visible),
    opponents,
    beliefs: beliefsAt(report, index),
    simulations,
    // Keyed by (hand seed, decision index, seat) so one decision can be
    // re-scored in isolation and lands on the same number every time.
    seed: hashSeed(report.seed, index, hero),
  });
  // The pot SHARE, not `pWin`: a chop is worth 1/k of the pot and `pWin`
  // scores it as zero, which multiway is exactly where it starts to matter.
  return { equity: run.equity, perOpponent: run.perOpponent };
}

/**
 * Was this decision facing a continuation bet.
 *
 * A c-bet is the flop bet of the seat that took the last aggressive action
 * preflop. Both halves are read straight off the action prefix, so no new input
 * is needed and a scripted report classifies the same way a played one does.
 * Blinds are not action records, so an unraised pot has no preflop aggressor and
 * therefore no continuation bet, which is correct.
 */
function facingCbetAt(
  report: TableHandReport,
  hero: number,
  index: number
): boolean {
  const record = report.actions[index];
  if (record.street !== "flop" || record.toCall <= 0) return false;

  let preflopAggressor: number | null = null;
  let flopBettor: number | null = null;
  for (let i = 0; i < index; i++) {
    const a = report.actions[i];
    if (a.action !== "bet" && a.action !== "raise") continue;
    if (a.street === "preflop") preflopAggressor = a.seat;
    else if (a.street === "flop" && flopBettor === null) flopBettor = a.seat;
  }

  return (
    preflopAggressor !== null &&
    preflopAggressor === flopBettor &&
    preflopAggressor !== hero
  );
}

/** Hero's share of the pot given every score at showdown; 1/k on a k-way chop. */
function shareOf(heroScore: number, oppScores: number[]): number {
  let best = heroScore;
  let tied = 1;
  for (const s of oppScores) {
    if (s > best) {
      best = s;
      tied = 1;
    } else if (s === best) {
      tied++;
    }
  }
  return best === heroScore ? 1 / tied : 0;
}

/**
 * Pot share with every live seat's cards face up.
 *
 * The board used is the one that ACTUALLY came, not the prefix visible at the
 * decision, that is what makes this the hindsight lens rather than a
 * cards-known-but-runout-fair one. When the hand ended before the board
 * completed those cards were never dealt, so they are enumerated exactly (one or
 * two to come) or sampled from the stub (a hand that ended preflop); `exact`
 * reports which.
 */
function hindsightEquity(
  report: TableHandReport,
  hero: number,
  opponents: number[],
  runouts: number,
  seed: number
): { equity: number; exact: boolean } {
  if (opponents.length === 0) return { equity: 1, exact: true };

  const heroHole = holeOf(report, hero);
  const oppHoles = opponents.map((s) => holeOf(report, s));
  if (heroHole.length !== 2 || oppHoles.some((h) => h.length !== 2)) {
    return { equity: 0, exact: false };
  }

  const board = report.board;
  const need = 5 - board.length;
  const size = 7;

  const heroHand = new Uint8Array(size);
  heroHand[0] = heroHole[0];
  heroHand[1] = heroHole[1];
  const oppHands = oppHoles.map((h) => {
    const buf = new Uint8Array(size);
    buf[0] = h[0];
    buf[1] = h[1];
    return buf;
  });
  for (let i = 0; i < board.length; i++) {
    heroHand[2 + i] = board[i];
    for (const buf of oppHands) buf[2 + i] = board[i];
  }

  const scoreRunout = (): number => {
    const scores = oppHands.map((h) => scoreInts(h, size));
    return shareOf(scoreInts(heroHand, size), scores);
  };

  if (need === 0) return { equity: scoreRunout(), exact: true };

  // The stub: the deck minus every card that was dealt to anybody, folded seats
  // included. Those cards physically left the deck, and in hindsight we know it.
  const used = new Uint8Array(52);
  for (const c of board) used[c] = 1;
  for (const s of report.seats) for (const c of s.hole) used[c] = 1;
  const stub: number[] = [];
  for (let c = 0; c < 52; c++) if (used[c] === 0) stub.push(c);

  const place = (slot: number, card: number): void => {
    heroHand[2 + board.length + slot] = card;
    for (const buf of oppHands) buf[2 + board.length + slot] = card;
  };

  if (need === 1) {
    let sum = 0;
    for (const c of stub) {
      place(0, c);
      sum += scoreRunout();
    }
    return { equity: stub.length > 0 ? sum / stub.length : 0, exact: true };
  }

  if (need === 2) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < stub.length; i++) {
      place(0, stub[i]);
      for (let j = i + 1; j < stub.length; j++) {
        place(1, stub[j]);
        sum += scoreRunout();
        n++;
      }
    }
    return { equity: n > 0 ? sum / n : 0, exact: true };
  }

  // Three or more to come only happens when a hand ended preflop. Enumerating
  // C(44,5) ≈ 1.1M runouts per decision is not worth it for a lens nobody should
  // be coaching from, so sample, seeded, so a replay reproduces the number.
  const rng = makeRng(seed);
  const deck = stub.slice();
  let sum = 0;
  for (let r = 0; r < runouts; r++) {
    // Partial Fisher-Yates: only the first `need` slots need to be right.
    for (let k = 0; k < need; k++) {
      const j = k + rng.int(deck.length - k);
      const tmp = deck[k];
      deck[k] = deck[j];
      deck[j] = tmp;
      place(k, deck[k]);
    }
    sum += scoreRunout();
  }
  return { equity: runouts > 0 ? sum / runouts : 0, exact: false };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function emptyStreetTotals(): Record<ActingStreet, EvLossTotals> {
  return {
    preflop: { model: 0, hindsight: 0 },
    flop: { model: 0, hindsight: 0 },
    turn: { model: 0, hindsight: 0 },
    river: { model: 0, hindsight: 0 },
  };
}

/** Argmax over the priced lines. First one wins a tie, so ties are stable. */
function best(
  lines: AlternativeEv[],
  lens: "modelEv" | "hindsightEv"
): AlternativeEv {
  let winner = lines[0];
  for (const line of lines) if (line[lens] > winner[lens]) winner = line;
  return winner;
}

/** Score one action of one seat. Exported for callers scoring a live decision. */
export function analyzeDecision(
  report: TableHandReport,
  index: number,
  options: EvLossOptions = {}
): DecisionEvLoss {
  const record = report.actions[index];
  if (!record) throw new Error(`analyzeDecision: no action at index ${index}`);
  if (record.street === "showdown") {
    throw new Error("analyzeDecision: showdown has no decisions");
  }

  const street = record.street as ActingStreet;
  const hero = record.seat;
  const opponents = liveOpponentsAt(report, hero, index);

  const model = modelEquity(
    report,
    hero,
    index,
    street,
    opponents,
    options.simulations ?? DEFAULT_MODEL_SIMS
  );
  const equityModel = model.equity;
  const hindsight = hindsightEquity(
    report,
    hero,
    opponents,
    options.hindsightRunouts ?? DEFAULT_HINDSIGHT_RUNOUTS,
    hashSeed(report.seed, index, hero, 0x4e15)
  );

  const fraction = options.aggressiveFraction ?? AGGRESSIVE_ALTERNATIVE_FRACTION;
  const alternatives: AlternativeEv[] = alternativesFor(record, fraction).map(
    (line) => ({
      action: line.action,
      cost: line.cost,
      modelEv: priceAction(
        line.action,
        line.cost,
        record.toCall,
        record.potBefore,
        equityModel
      ),
      hindsightEv: priceAction(
        line.action,
        line.cost,
        record.toCall,
        record.potBefore,
        hindsight.equity
      ),
      chosen: line.action === record.action,
    })
  );

  // The chosen entry, not a re-derivation of it: subtracting two numbers taken
  // from the same array is what makes the loss exactly 0 on a best play rather
  // than 0 ± an ulp.
  const chosen =
    alternatives.find((a) => a.chosen) ?? alternatives[alternatives.length - 1];
  const bestModel = best(alternatives, "modelEv");
  const bestHindsight = best(alternatives, "hindsightEv");

  const evidence: LeakEvidence = {
    index,
    handNumber: report.handNumber,
    seat: hero,
    street,
    position: positionOf(hero, report.button, report.seatCount),
    action: record.action,
    cost: record.cost,
    potBefore: record.potBefore,
    toCall: record.toCall,

    modelEquity: equityModel,
    modelEquityPerOpponent: model.perOpponent,
    modelEvChosen: chosen.modelEv,
    modelEvBest: bestModel.modelEv,
    modelBestAction: bestModel.action,
    modelEvLoss: chosen.modelEv - bestModel.modelEv,

    hindsightEquity: hindsight.equity,
    hindsightEvChosen: chosen.hindsightEv,
    hindsightEvBest: bestHindsight.hindsightEv,
    hindsightBestAction: bestHindsight.action,
    hindsightEvLoss: chosen.hindsightEv - bestHindsight.hindsightEv,
    hindsightExact: hindsight.exact,

    alternatives,

    opponentCount: opponents.length,
    // Exact from the record: nothing here assumes which seats put in the chips
    // that make up `potBefore`, only that the hero owes `toCall` to win it.
    requiredEquity:
      record.toCall > 0 && record.potBefore + record.toCall > 0
        ? record.toCall / (record.potBefore + record.toCall)
        : null,
    facingCbet: facingCbetAt(report, hero, index),
  };

  return { ...evidence, kind: classifyLeak(evidence) };
}

/** Every decision one seat took in one hand. */
export function analyzeHand(
  report: TableHandReport,
  seat: number,
  options: EvLossOptions = {}
): HandEvLoss {
  const decisions: DecisionEvLoss[] = [];
  for (let i = 0; i < report.actions.length; i++) {
    if (report.actions[i].seat !== seat) continue;
    if (report.actions[i].street === "showdown") continue;
    decisions.push(analyzeDecision(report, i, options));
  }

  const byStreet = emptyStreetTotals();
  let totalModelEvLoss = 0;
  let totalHindsightEvLoss = 0;
  let worst: DecisionEvLoss | null = null;
  for (const d of decisions) {
    byStreet[d.street].model += d.modelEvLoss;
    byStreet[d.street].hindsight += d.hindsightEvLoss;
    totalModelEvLoss += d.modelEvLoss;
    totalHindsightEvLoss += d.hindsightEvLoss;
    if (!worst || d.modelEvLoss < worst.modelEvLoss) worst = d;
  }

  return {
    handNumber: report.handNumber,
    seat,
    decisions,
    totalModelEvLoss,
    totalHindsightEvLoss,
    byStreet,
    worst,
  };
}

/** The same roll-up across a session. */
export function analyzeHands(
  reports: TableHandReport[],
  seat: number,
  options: EvLossOptions = {}
): SessionEvLoss {
  const hands = reports.map((r) => analyzeHand(r, seat, options));

  const byStreet = emptyStreetTotals();
  let totalModelEvLoss = 0;
  let totalHindsightEvLoss = 0;
  let decisionCount = 0;
  let worst: DecisionEvLoss | null = null;
  for (const hand of hands) {
    for (const street of ACTING_STREETS) {
      byStreet[street].model += hand.byStreet[street].model;
      byStreet[street].hindsight += hand.byStreet[street].hindsight;
    }
    totalModelEvLoss += hand.totalModelEvLoss;
    totalHindsightEvLoss += hand.totalHindsightEvLoss;
    decisionCount += hand.decisions.length;
    if (hand.worst && (!worst || hand.worst.modelEvLoss < worst.modelEvLoss)) {
      worst = hand.worst;
    }
  }

  return {
    seat,
    hands,
    decisionCount,
    totalModelEvLoss,
    totalHindsightEvLoss,
    byStreet,
    worst,
    leaks: aggregateLeaks(hands.flatMap((h) => h.decisions)),
  };
}
