/**
 * The bot's brain for the N-handed table.
 *
 * Three modules meet here and nowhere else: multiway equity (`equity/pool`),
 * forward-looking EV (`ev.ts`), and personality (`profiles.ts`). Each of those
 * is independently testable and none of them imports the others; this file is
 * the only place that knows the order they run in.
 *
 *   1. Estimate the acting seat's equity against the seats still contesting.
 *   2. Price every legal action against that equity.
 *   3. Let the seat's profile bend the answer, entry discipline, bluffs, and
 *      the aggression tilt, into the move actually taken.
 *
 * Every number is a deterministic function of `(table seed, hand number,
 * decision index, seat)`. There is no `Math.random()` here, which is what makes
 * a hand replayable from its seed alone and what makes the tests meaningful.
 */

import { INITIAL_BELIEF } from "../../data/constants";
import type {
  BeliefDistribution,
  HandCategory,
  MonteCarloResult,
  PlayerActionType,
  Street,
} from "../../types";
import { updateBelief } from "../bayesian";
import { encodeCards } from "../core/card";
import { hashSeed, makeRng } from "../core/rng";
import { runMultiwayEquity, runMultiwayEquitySync } from "../equity/pool";
import {
  actionEv,
  callEv,
  foldEquityEv,
  rangeEquity,
  type FoldEquityBreakdown,
  type FoldingOpponent,
} from "../ev";
import type {
  ActionRecord,
  BotDecider,
  BotDecision,
  BotProfile,
  EquityRequest,
  MultiwayEquity,
  SyncBotDecider,
} from "../table/contract";
import { positionOf } from "../table/position";
import {
  legalActions,
  sizingLadder,
  type SizingOption,
  type TableAction,
  type TableConfig,
} from "../table/rules";
import {
  contestingSeats,
  seatOf,
  toCall as toCallOf,
  type TableState,
} from "../table/state";
import { BUCKET_COUNT, classifyAll, makeBoardContext } from "./buckets";
import {
  createLikelihoodModel,
  likelihoodRow,
  type Facing,
  type LearnStreet,
  type LikelihoodModel,
} from "./likelihood";
import { BOT_PROFILES, chooseAction, findProfile } from "./profiles";
import {
  COMBO_COUNT,
  normalizeRange,
  removeCards,
  uniformRange,
  type Range,
} from "./range";

// ---------------------------------------------------------------------------
// Simulation budget
// ---------------------------------------------------------------------------

/**
 * Sims a *heads-up* decision runs, per street. Later streets get fewer because
 * fewer cards are unknown, so each sample carries more information.
 */
export const TABLE_DECISION_SIMS: Record<Exclude<Street, "showdown">, number> = {
  preflop: 20000,
  flop: 20000,
  turn: 15000,
  river: 10000,
};

/**
 * Floor on the budget. Below roughly this many samples the standard error on a
 * coin-flip spot passes 0.7%, which is where the noise starts to be visible as
 * the bot changing its mind between two nearly-equal actions.
 */
export const MIN_DECISION_SIMS = 5000;

/**
 * A multiway sim scores one hand per opponent where a heads-up sim scores one,
 * so the cost of a fixed sample count grows with the field. Dividing by the
 * opponent count holds the *work* per decision roughly constant instead of the
 * sample count, a six-handed pot must not cost five times a heads-up one on
 * the live gameplay path.
 */
export function decisionSims(street: Street, opponents: number): number {
  const base = TABLE_DECISION_SIMS[street === "showdown" ? "river" : street];
  return Math.max(MIN_DECISION_SIMS, Math.round(base / Math.max(1, opponents)));
}

// ---------------------------------------------------------------------------
// Reading the table
// ---------------------------------------------------------------------------

/**
 * This hand's action records, if the state carries them.
 *
 * `SyncBotDecider` is handed a `TableState`, but the engine always passes a
 * `Table`, which extends it with the records accumulated during the hand. Both
 * the opponent reads and the per-decision seed want that history, and widening
 * the contract to demand it would force every scripted test decider to fabricate
 * one. So it is read defensively: present in the real game, absent (and cleanly
 * defaulted) when a bare `TableState` is passed.
 */
export function handActions(state: TableState): ActionRecord[] {
  const carrier = state as TableState & { actions?: unknown };
  return Array.isArray(carrier.actions) ? (carrier.actions as ActionRecord[]) : [];
}

/**
 * A read on every seat, from this hand's public actions alone.
 *
 * Each seat starts on the same prior and is moved by `updateBelief` for each
 * action it took, a raise shifts weight to `strong`, a check to `weak`. This
 * is deliberately *public* information only: no seat's hole cards are consulted,
 * so a bot's read on you is exactly what you could work out yourself, and the
 * Study mode that displays these is showing the bots' actual information set
 * rather than a privileged one.
 */
export function readsFromActions(
  actions: ActionRecord[],
  seatCount: number
): Record<number, BeliefDistribution> {
  const reads: Record<number, BeliefDistribution> = {};
  for (let id = 0; id < seatCount; id++) reads[id] = INITIAL_BELIEF;
  for (const record of actions) {
    const prior = reads[record.seat] ?? INITIAL_BELIEF;
    reads[record.seat] = updateBelief(prior, record.action);
  }
  return reads;
}

/**
 * The stream a single decision draws from.
 *
 * Keyed by the decision's index within the hand rather than by a running
 * counter, so one decision can be re-run in isolation, for a replay or a test -
 * without depending on how much entropy the decisions before it happened to
 * consume.
 */
export function decisionSeed(state: TableState, seat: number): number {
  return hashSeed(
    state.seed,
    state.handNumber,
    handActions(state).length,
    seat
  );
}

// ---------------------------------------------------------------------------
// Equity
// ---------------------------------------------------------------------------

/** Seats other than `seat` that can still win the pot. */
export function opponentsOf(state: TableState, seat: number): number[] {
  return contestingSeats(state)
    .filter((s) => s.id !== seat)
    .map((s) => s.id);
}

/**
 * Would a call by `seat` close the action, is the pot it is priced against
 * already the final one?
 *
 * The test is that no opponent still owes chips. That is *not* the same as
 * `state.bettingClosed` one action early, and the difference is deliberate: a
 * big blind holding its option has matched the bet but not acted, so it can
 * still raise. A raise behind does not grow the pot the hero's call was priced
 * into, it hands the hero a fresh decision at a fresh price, which is priced on
 * its own when it arrives. Only chips that arrive *without* another hero
 * decision in between can make the price a forecast rather than a quotation, and
 * those are exactly the chips a seat still owes.
 *
 * So this is precisely the predicate under which `actionEv` is exact and
 * `priceCall` returns null, which is why both read it from here: one notion of
 * closing-ness, in one place, or the entry gate and the pricing drift apart.
 */
export function closesAction(state: TableState, seat: number): boolean {
  return opponentsOf(state, seat).every((id) => toCallOf(state, id) === 0);
}

export function equityRequest(
  state: TableState,
  seat: number,
  simulations?: number,
  models: SeatModels = defaultSeatModels
): EquityRequest {
  const hero = seatOf(state, seat);
  const opponents = opponentsOf(state, seat);
  return {
    heroHole: Array.from(encodeCards(hero.hole)),
    board: Array.from(encodeCards(state.board)),
    opponents,
    // The read the sampler draws from, per combo rather than per tier. See
    // `opponentRanges`, this is where `buckets.ts` reaches the equity number.
    ranges: opponentRanges(state, seat, models),
    simulations: simulations ?? decisionSims(state.street, opponents.length),
    seed: decisionSeed(state, seat),
  };
}

// ---------------------------------------------------------------------------
// Who the bot is modelling
// ---------------------------------------------------------------------------

/**
 * The bot's read on what an opponent does with each class of hand. A fresh
 * model is the generated poker prior, bucket-, street- and facing-conditioned,
 * with no player data in it, which is the right default for a bot that has
 * observed nothing. It is never written to, so one instance is shared.
 *
 * Read in both directions. `foldByBucket` asks it how often a bet gets through;
 * `opponentRanges` runs it backwards, asking what a seat's bets imply about
 * what it holds. One model answering both is what keeps the range the bot bets
 * against and the range it prices folds against the same range.
 */
export const OPPONENT_MODEL: LikelihoodModel = createLikelihoodModel("poker");

/**
 * Which model describes each seat.
 *
 * A learned model is a claim about *one player*. `opponentMemory` accumulates
 * one for the human seat, and pointing it at every seat would be a category
 * error: it would tell a bot that the seat across the table folds to river bets
 * 71% of the time on the evidence of somebody else's folds. So the model is a
 * function of the seat being read, not a module constant, and the default says
 * "I have observed nobody" for everybody.
 *
 * Three consequences the tests pin. The engine's own tests get a fresh prior and
 * stay deterministic; a bot modelling another bot is untouched; and an empty
 * learned model is *bit-identical* to the default, because `betaMean(0, 0, m)`
 * is exactly `m` at every level of the backoff, so a model with no cells cannot
 * move a single lookup.
 */
export type SeatModels = (seat: number) => LikelihoodModel;

/** Nobody has been observed: the shared prior describes every seat. */
export const defaultSeatModels: SeatModels = () => OPPONENT_MODEL;

/**
 * Apply a learned model to exactly one seat, and the prior to all the others.
 *
 * The whole scoping decision, in one line and in one place, so "which seats does
 * this describe" has a single answer that can be read off the call site.
 */
export function modelForSeat(seat: number, model: LikelihoodModel): SeatModels {
  return (id) => (id === seat ? model : OPPONENT_MODEL);
}

// ---------------------------------------------------------------------------
// Opponent ranges
// ---------------------------------------------------------------------------

/**
 * How much of the board a decision on each street could see.
 *
 * Exported because anything that *writes* the likelihood model has to bucket a
 * decision against the same board prefix this reads it back with, or the counts
 * are filed under one hand class and looked up under another. See
 * `lib/opponentMemory.handObservations`.
 */
export const BOARD_CARDS_AT: Record<LearnStreet, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

export const learnStreet = (street: Street): LearnStreet =>
  street === "showdown" ? "river" : street;

/** Where in the hand one action record sat, as the likelihood model keys it. */
export interface ActionContext {
  street: LearnStreet;
  facing: Facing;
}

/**
 * Replay a hand's records and label each with the node it happened at.
 *
 * `facing` is not stored on an action, so it is reconstructed from the
 * aggression that preceded it on that street: preflop the big blind is already
 * an open, which is why the count starts at one there and at zero on every later
 * street. A call adds no aggression, so it cannot change the question.
 *
 * One implementation, not two. `opponentRanges` reads the model at these nodes
 * and `opponentMemory` writes it at them; if the two reconstructions ever drifted
 * apart, every observation would be recorded at a node nothing looks up.
 */
export function actionContexts(actions: ActionRecord[]): ActionContext[] {
  const out: ActionContext[] = [];
  let street: LearnStreet = "preflop";
  let aggressors = 1;
  for (const record of actions) {
    const recordStreet = learnStreet(record.street);
    if (recordStreet !== street) {
      street = recordStreet;
      aggressors = recordStreet === "preflop" ? 1 : 0;
    }
    out.push({
      street,
      facing:
        record.toCall <= 0
          ? "unopened"
          : aggressors >= 2
            ? "facing-raise"
            : "facing-bet",
    });
    if (record.action === "bet" || record.action === "raise") aggressors++;
  }
  return out;
}

/**
 * Bucket tables for a board's street prefixes, built on demand and cached.
 *
 * A flop bet has to be scored against the flop, not against the river the hand
 * eventually ran out to, the actor could not see those cards, so weighting its
 * range by what they made would be reading its mind rather than its bets. Four
 * street prefixes means at most four `classifyAll` passes per decision (~190 µs
 * each) shared by every opponent, rather than one per opponent per action.
 */
function streetBuckets(board: number[]): (street: LearnStreet) => Uint8Array {
  const cache = new Map<LearnStreet, Uint8Array>();
  return (street) => {
    let hit = cache.get(street);
    if (hit === undefined) {
      const visible = Math.min(BOARD_CARDS_AT[street], board.length);
      hit = classifyAll(makeBoardContext(board.slice(0, visible)));
      cache.set(street, hit);
    }
    return hit;
  };
}

/** P(this action | bucket) at one node, one entry per bucket. */
function actionByBucket(
  model: LikelihoodModel,
  action: PlayerActionType,
  street: LearnStreet,
  position: ReturnType<typeof positionOf>,
  facing: Facing
): Float64Array {
  const out = new Float64Array(BUCKET_COUNT);
  for (let b = 0; b < BUCKET_COUNT; b++) {
    out[b] = likelihoodRow(model, { bucket: b, street, position, facing })[action];
  }
  return out;
}

/**
 * Each opponent's range over all 1326 combos, from this hand's public record.
 *
 * The estimator's actual input, and the thing this module exists to build:
 *
 *   1. Start from a flat prior. Before anybody acts, every combo the deck still
 *      allows is equally likely, that is what "dealt at random" means. The
 *      familiar 0.40 / 0.35 / 0.25 tilt toward strength is not a prior at all,
 *      it is the *posterior* after a seat has chosen to play, and deriving it
 *      rather than assuming it is what lets a limp and a three-bet disagree.
 *   2. Multiply each combo by `P(action | bucket(combo), street, position,
 *      facing)` for every action the seat took, with `bucket` measured against
 *      the board *as it stood on that street*. This is where `buckets.ts` pays
 *      off: on K-7-2 the combo 7-2 is two pair and gets the weight a bet
 *      deserves, where a preflop Chen score would have filed it under trash and
 *      folded it out of the continuing range.
 *   3. Renormalise after each factor, so the range is a probability
 *      distribution at every step rather than only at the end.
 *
 * Card removal is applied once up front and never undone: multiplying by a
 * per-combo factor cannot resurrect a zero, so a combo the hero can see stays
 * impossible however the seat bets.
 *
 * Reads only what any player at the table could see. No seat's hole cards are
 * consulted, which is what makes the ranges shown in Study mode the bots' real
 * information set rather than a privileged one.
 */
export function opponentRanges(
  state: TableState,
  seat: number,
  models: SeatModels = defaultSeatModels
): Record<number, Range> {
  const hero = seatOf(state, seat);
  const board = Array.from(encodeCards(state.board));
  const dead = [...encodeCards(hero.hole), ...board];
  const seatCount = state.seats.length;
  const bucketsAt = streetBuckets(board);

  const ranges: Record<number, Range> = {};
  for (const id of opponentsOf(state, seat)) {
    ranges[id] = normalizeRange(removeCards(uniformRange(), dead));
  }

  // One pass over the hand's record, each action read at the node it happened
  // at (`actionContexts`) and through the model that describes the seat that
  // took it, so a learned read on one player never colours another's range.
  const actions = handActions(state);
  const contexts = actionContexts(actions);
  for (let i = 0; i < actions.length; i++) {
    const record = actions[i];
    const range = ranges[record.seat];
    if (range === undefined) continue;
    const { street, facing } = contexts[i];
    const buckets = bucketsAt(street);
    const perBucket = actionByBucket(
      models(record.seat),
      record.action,
      street,
      positionOf(record.seat, state.button, seatCount),
      facing
    );
    for (let c = 0; c < COMBO_COUNT; c++) range[c] *= perBucket[buckets[c]];
    // Every likelihood is bounded below by the prior's uniform mixture, so no
    // product can reach zero and this can never divide by nothing.
    normalizeRange(range);
  }

  return ranges;
}

const NO_CATEGORIES = Object.freeze({
  0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0,
}) as Record<HandCategory, number>;

/**
 * Equity when there is nobody left to beat. Reached only if a decider is asked
 * to move with the pot already uncontested; the pot is already this seat's, so
 * the share is 1 and no simulation is worth running.
 */
export function uncontestedEquity(): MultiwayEquity {
  return {
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
  };
}

/**
 * Adapt multiway equity into the shape `actionEv` prices against.
 *
 * The substitution in the middle is the whole point of this function, and it is
 * the single easiest thing to get wrong in the move from heads-up to multiway:
 * EV is driven by the *share of the pot* a holding expects to collect, and that
 * is `equity`, not `pWin`. Heads-up the two are within a tie's width of each
 * other, a chop is worth exactly half, and ties are rare, which is why
 * `actionEv` could take `pWin` and be right. Four-handed, a hand that chops a
 * quarter of the time is collecting real chips that `pWin` scores as zero, and
 * a four-way chop is worth a quarter of the pot rather than half.
 *
 * Only `pWin` and `pLoss` are read by `actionEv`; the rest is carried through
 * so the audit trail keeps the sample count and interval it was priced from.
 */
export function evInput(equity: MultiwayEquity): MonteCarloResult {
  return {
    simulations: equity.simulations,
    wins: equity.wins,
    losses: equity.losses,
    ties: equity.ties,
    pWin: equity.equity,
    pLoss: 1 - equity.equity,
    pTie: 0,
    se: equity.se,
    ciWin: equity.ciWin,
    categoryFrequencies: NO_CATEGORIES,
  };
}

/** Forward-looking EV of every legal action, keyed by label. */
export function evByAction(
  actions: TableAction[],
  equity: MultiwayEquity,
  pot: number,
  toCall: number
): Record<string, number> {
  const mc = evInput(equity);
  const evs: Record<string, number> = {};
  for (const action of actions) evs[action.label] = actionEv(action, mc, pot, toCall);
  return evs;
}

// ---------------------------------------------------------------------------
// Fold equity
// ---------------------------------------------------------------------------

/**
 * Sims spent on one candidate size's continuing-range equity.
 *
 * Smaller than the showdown budget on purpose. That estimate decides between
 * folding and calling, where a 1% error changes the answer; this one decides
 * between two bet sizes whose EVs are usually within a few percent of each
 * other anyway, and it is paid once per rung of the ladder rather than once per
 * decision. 800 puts the standard error near 1.7% on a coin-flip spot.
 */
export const FOLD_EQUITY_SIMS = 800;

/**
 * How hard the price moves the fold rate, in log-odds per log of the pot
 * fraction. 1 means the odds of a fold scale linearly with the size: a pot-size
 * bet folds out twice the odds a half-pot bet does.
 */
export const SIZE_SENSITIVITY = 1;

/**
 * The size the likelihood model's fold rates are taken to describe.
 *
 * The model conditions on bucket, street, position and facing but not on size,
 * so its numbers are an average over the sizes people actually bet. Half pot is
 * both the middle rung of `sizingLadder` and every profile's default
 * `preferredSizing`, which makes it the honest anchor.
 */
export const REFERENCE_FRACTION = 0.5;

/**
 * Largest pot fraction the reference rate is extrapolated to. Above this the
 * fold rate is held flat.
 *
 * This bound is doing real work, not tidying an edge case. A logistic stretched
 * from half pot out to a twenty-times-pot shove says every bucket folds ~96% -
 * aces included, because a uniform shift in log-odds moves p = 0.44 and
 * p = 0.60 by the same odds ratio and the two converge on 1 together. The
 * strength correlation is what fold equity is priced from, so losing it makes a
 * shove with the worst hand at the table read as the highest-EV action on the
 * board. Which it did, before this line: 72o for +5.4 into a $15 pot.
 *
 * A pot-sized bet is the ladder's top rung, so the cap only ever binds on an
 * overbet all-in, the one size no rung of the model was built from. Holding
 * the rate flat there is the honest reading: there is no evidence that betting
 * more than the pot buys more folds, because the hands still there at pot are
 * calling on strength rather than on price.
 */
export const MAX_TILT_FRACTION = 1;

/**
 * P(fold) at a bet of `fraction` of the pot, given the rate at the reference
 * size.
 *
 * Working in log-odds is what keeps this a probability at both ends: no clamp
 * is needed, an opponent that never folds still never folds however large the
 * bet, and the curve is monotone in the size. The shift is
 * `k · log(fraction / REFERENCE_FRACTION)`, i.e. the odds of a fold are
 * multiplied by the ratio of the prices offered.
 */
export function foldAtSize(pFoldReference: number, fraction: number): number {
  if (!(fraction > 0)) return pFoldReference;
  if (!(pFoldReference > 0)) return 0;
  if (pFoldReference >= 1) return 1;
  const priced = Math.min(fraction, MAX_TILT_FRACTION);
  const odds =
    (pFoldReference / (1 - pFoldReference)) *
    Math.pow(priced / REFERENCE_FRACTION, SIZE_SENSITIVITY);
  return odds / (1 + odds);
}

/**
 * P(fold | bucket) for one opponent at the reference size, one entry per bucket.
 *
 * Renormalised over the moves that are actually available: facing a bet the
 * only choices are fold, call and raise, and the prior parks ~2% on the two
 * illegal ones so it can never treat a mislabelled observation as infinitely
 * strong evidence. Keeping that 2% here would understate every fold rate.
 */
export function foldByBucket(
  model: LikelihoodModel,
  street: LearnStreet,
  position: ReturnType<typeof positionOf>,
  facing: Facing
): Float64Array {
  const out = new Float64Array(BUCKET_COUNT);
  for (let b = 0; b < BUCKET_COUNT; b++) {
    const row = likelihoodRow(model, { bucket: b, street, position, facing });
    const denom = row.fold + row.call + row.raise;
    out[b] = denom > 0 ? row.fold / denom : 0;
  }
  return out;
}

/**
 * A three-tier belief spread over combos by board-relative bucket.
 *
 * Lives in `equity/multiway.ts`, which is where the legacy `beliefs` field of an
 * `EquityRequest` has to be interpreted; re-exported here because this is where
 * it was introduced and where its tests point.
 */
export { beliefRange as opponentRange } from "../equity/multiway";

/** Fan a per-bucket fold rate out to per-combo, at one size. */
function foldByCombo(
  perBucket: Float64Array | null,
  buckets: Uint8Array,
  fraction: number
): Float64Array {
  const out = new Float64Array(COMBO_COUNT);
  // An all-in opponent has no decision left to make; it calls by definition.
  if (!perBucket) return out;
  const sized = new Float64Array(BUCKET_COUNT);
  for (let b = 0; b < BUCKET_COUNT; b++) {
    sized[b] = foldAtSize(perBucket[b], fraction);
  }
  for (let c = 0; c < COMBO_COUNT; c++) out[c] = sized[buckets[c]];
  return out;
}

/**
 * Bet and raise sizes worth pricing: the legal minimum plus every rung of the
 * ladder, deduped and clamped. Labels match `profiles.sizedBluff`'s so a rung
 * chosen by the bluff branch is already in the EV table.
 */
export function sizedCandidates(
  base: TableAction,
  sizings: SizingOption[]
): TableAction[] {
  const min = base.min ?? base.cost;
  const max = base.max ?? base.cost;
  const out: TableAction[] = [base];
  const seen = new Set<number>([base.cost]);
  for (const option of sizings) {
    const cost = Math.min(Math.max(option.cost, min), max);
    if (seen.has(cost)) continue;
    seen.add(cost);
    const amount = base.amount - base.cost + cost;
    out.push({
      ...base,
      cost,
      amount,
      label:
        cost >= max
          ? `All-in $${cost}`
          : base.type === "bet"
            ? `Bet $${cost}`
            : `Raise to $${amount}`,
    });
  }
  return out;
}

export interface PricedSizes {
  /** Every size considered, in ladder order. */
  candidates: TableAction[];
  /** The fold-equity derivation for each, keyed by label. */
  byLabel: Record<string, FoldEquityBreakdown>;
  /** Hero's pot share against the opponents' full ranges. */
  eRange: number;
}

/**
 * Price every candidate size with its own fold equity.
 *
 * Each rung gets its own continuing range, because that is the point: a bigger
 * bet folds out more of the opponent's range, which raises the fold term and
 * lowers the equity of what is left. Pricing every size against one shared
 * continuing range would reintroduce exactly the error this module exists to
 * remove, one level up.
 *
 * Returns null when there is nothing to price, no opponents, or a state with
 * no cards dealt (a scripted test fixture).
 *
 * `opponentRanges` is passed in rather than rebuilt when the caller already has
 * it: the showdown estimate and the fold-equity estimate must price the same
 * opponent, or the gap between `eRange` and `eContinue` stops being the
 * selection effect and starts being two different models disagreeing.
 */
export function priceSizes(
  state: TableState,
  seat: number,
  base: TableAction,
  sizings: SizingOption[],
  simulations: number,
  seed: number,
  ranges?: Record<number, Range>,
  models: SeatModels = defaultSeatModels
): PricedSizes | null {
  const opponents = opponentsOf(state, seat);
  if (opponents.length === 0 || simulations <= 0) return null;

  const hero = seatOf(state, seat);
  if (hero.hole.length < 2) return null;

  const heroHole = Array.from(encodeCards(hero.hole));
  const board = Array.from(encodeCards(state.board));
  const buckets = classifyAll(makeBoardContext(board));
  const byId = ranges ?? opponentRanges(state, seat, models);
  const pot = state.pot;
  const toCall = toCallOf(state, seat);
  const potAfterCall = pot + toCall;

  // Postflop the opponents are answering a bet; when the hero is raising, they
  // are answering a raise, which the prior treats as the stronger message.
  const facing: Facing = toCall > 0 ? "facing-raise" : "facing-bet";
  const street = (state.street === "showdown" ? "river" : state.street) as LearnStreet;

  const priors: Range[] = [];
  const perBucket: (Float64Array | null)[] = [];
  for (const id of opponents) {
    priors.push(byId[id] ?? uniformRange());
    perBucket.push(
      seatOf(state, id).status === "allin"
        ? null
        : foldByBucket(
            models(id),
            street,
            positionOf(id, state.button, state.seats.length),
            facing
          )
    );
  }

  const eRange = rangeEquity({
    heroHole,
    board,
    ranges: priors,
    simulations,
    seed: hashSeed(seed, 0xe9a4e),
  });

  const candidates = sizedCandidates(base, sizings);
  const byLabel: Record<string, FoldEquityBreakdown> = {};
  for (const action of candidates) {
    const extra = Math.max(0, action.cost - toCall);
    const fraction = potAfterCall > 0 ? extra / potAfterCall : 0;
    // What each opponent must add to continue. A seat that already matched the
    // current bet owes only the raise increment, but one that has not owes the
    // whole way up to the hero's new level, charging everyone `extra` would
    // understate the pot a raise builds. Capped by the stack: an opponent
    // cannot put in more than it has, and the surplus would be returned.
    const newLevel = hero.streetCommit + action.cost;
    const field: FoldingOpponent[] = priors.map((range, i) => {
      const opp = seatOf(state, opponents[i]);
      return {
        range,
        foldByCombo: foldByCombo(perBucket[i], buckets, fraction),
        owes: Math.max(0, Math.min(newLevel - opp.streetCommit, opp.stack)),
      };
    });
    byLabel[action.label] = foldEquityEv({
      heroHole,
      board,
      opponents: field,
      pot,
      toCall,
      cost: action.cost,
      simulations,
      // One seed for every rung: common random numbers, so the argmax compares
      // sizes on the same sampled boards rather than on their sampling noise.
      seed: hashSeed(seed, 0xf01de9),
    });
  }

  return { candidates, byLabel, eRange };
}

// ---------------------------------------------------------------------------
// Pricing a call
// ---------------------------------------------------------------------------

/** A seat with no decision left to make. Shared: `callEv` only ever reads it. */
const NO_FOLD = new Float64Array(COMBO_COUNT);

/**
 * What a seat yet to act on this street is answering.
 *
 * Reconstructed the way `opponentRanges` reconstructs it, from the aggression
 * already on this street, with the big blind counting as the preflop open -
 * because the seats behind a caller face precisely what the caller faced.
 * Calling adds no aggression, so it cannot change the question. This is why
 * `priceSizes`'s `facing` cannot be reused: there the hero is the one betting,
 * and the seats behind are answering the hero.
 */
function facingThisStreet(state: TableState): Facing {
  const street = learnStreet(state.street);
  let aggressors = street === "preflop" ? 1 : 0;
  for (const record of handActions(state)) {
    if (learnStreet(record.street) !== street) continue;
    if (record.action === "bet" || record.action === "raise") aggressors++;
  }
  return aggressors >= 2 ? "facing-raise" : aggressors >= 1 ? "facing-bet" : "unopened";
}

/**
 * Price a call against the pot the seats still to act will build.
 *
 * Returns null, leaving `actionEv`'s price standing, unchanged to the last bit
 *, whenever no opponent still owes chips. That is the case the old formula
 * gets exactly right, because the pot as it stands is already the final one, so
 * re-estimating it would trade a correct number for a noisier one; heads-up it
 * is every call there is. See `ev.callEv` for why the other case needs a
 * different basis.
 *
 * `ranges` is passed in rather than rebuilt for the same reason `priceSizes`
 * takes it: the showdown estimate, the raise's fold equity and the call's field
 * must all be reading one opponent, not three.
 */
export function priceCall(
  state: TableState,
  seat: number,
  call: TableAction,
  simulations: number,
  seed: number,
  ranges?: Record<number, Range>,
  models: SeatModels = defaultSeatModels
): FoldEquityBreakdown | null {
  const opponents = opponentsOf(state, seat);
  if (opponents.length === 0 || simulations <= 0) return null;

  const hero = seatOf(state, seat);
  if (hero.hole.length < 2) return null;

  const toCall = call.cost;
  if (toCall <= 0) return null;

  // Nobody can add anything, so the pot as it stands IS the final pot,
  // `actionEv` is exact, and there is nothing here to correct.
  if (closesAction(state, seat)) return null;

  // Chips each opponent still owes to keep playing.
  const owed = opponents.map((id) => toCallOf(state, id));

  const heroHole = Array.from(encodeCards(hero.hole));
  const board = Array.from(encodeCards(state.board));
  const buckets = classifyAll(makeBoardContext(board));
  const byId = ranges ?? opponentRanges(state, seat, models);
  const pot = state.pot;
  const potAfterCall = pot + toCall;
  const street = learnStreet(state.street);
  const facing = facingThisStreet(state);

  const field: FoldingOpponent[] = opponents.map((id, i) => {
    const range = byId[id] ?? uniformRange();
    const owes = owed[i];
    // The bettor, an earlier caller, anyone all-in: already in for this street,
    // so it neither folds to the call nor adds to the pot. It stays in the
    // field because it is still in the hand.
    if (owes === 0) return { range, foldByCombo: NO_FOLD, owes: 0 };
    // Every seat behind is priced at the price *it* is being offered, what it
    // owes against the pot it would be calling into. Not one shared fraction:
    // the small blind is getting a materially better price than a seat that has
    // yet to put in a chip, and folding it out at the same rate would be pricing
    // the wrong decision. `owes > 0` already implies a live stack, so an all-in
    // seat can only reach the branch above and needs no `status` test here.
    const fraction = potAfterCall > 0 ? owes / potAfterCall : 0;
    return {
      range,
      foldByCombo: foldByCombo(
        foldByBucket(
          models(id),
          street,
          positionOf(id, state.button, state.seats.length),
          facing
        ),
        buckets,
        fraction
      ),
      owes,
    };
  });

  return callEv({
    heroHole,
    board,
    opponents: field,
    pot,
    toCall,
    simulations,
    seed: hashSeed(seed, 0xca11e4),
  });
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** A seat's profile, defaulting to the pure-EV baseline for an unlabelled seat. */
export function profileFor(id: string | undefined): BotProfile {
  return (id ? findProfile(id) : undefined) ?? BOT_PROFILES.professor;
}

const isAggressive = (a: TableAction) => a.type === "bet" || a.type === "raise";

/**
 * Turn an equity estimate into a move. Split out of the two entry points below
 * so the synchronous and asynchronous paths differ in *nothing* but how the
 * Monte Carlo was scheduled.
 *
 * Three prices are formed here, not one, and the point of the third is that all
 * of them are measured against the same pot.
 *
 *   - Checks, folds and *closing* calls: `actionEv`. It assumes the hand goes to
 *     showdown for the pot as it stands, which is exactly right when nobody left
 *     can add a chip.
 *   - Bets and raises: `foldEquityEv`, once per candidate size. This is the
 *     price that lets a hand with no showdown value be worth betting at all.
 *   - Calls that do NOT close the action: `callEv`, which is `foldEquityEv` with
 *     the fold branch removed, same field simulation, same pot, no fold equity,
 *     because nobody folds to a call.
 */
function finish(
  state: TableState,
  seat: number,
  config: TableConfig,
  equity: MultiwayEquity,
  foldEquitySims: number,
  ranges: Record<number, Range>,
  models: SeatModels
): BotDecision {
  const actions = legalActions(state, seat, config);
  if (actions.length === 0) {
    throw new Error(`decider: seat ${seat} has no legal action`);
  }

  const hero = seatOf(state, seat);
  const potBefore = state.pot;
  const toCall = toCallOf(state, seat);
  const evs = evByAction(actions, equity, potBefore, toCall);
  const profile = profileFor(hero.profile);
  const sizings = sizingLadder(state, seat, config);

  const base = actions.find(isAggressive);
  const priced = base
    ? priceSizes(
        state,
        seat,
        base,
        sizings,
        foldEquitySims,
        decisionSeed(state, seat),
        // The ranges the showdown estimate was just run against, not a second
        // set built from the same records, one read per decision, priced twice.
        ranges,
        models
      )
    : null;

  // A call that does not close the action is re-priced against the pot the seats
  // behind will build, on the same basis `priceSizes` prices a raise, otherwise
  // the argmax below compares a heads-up pot against a multiway one. A closing
  // call keeps `evByAction`'s number exactly.
  const call = actions.find((a) => a.type === "call");
  const pricedCall = call
    ? priceCall(
        state,
        seat,
        call,
        foldEquitySims,
        decisionSeed(state, seat),
        ranges,
        models
      )
    : null;
  if (call && pricedCall) evs[call.label] = pricedCall.ev;

  // Every size the ladder offers becomes its own candidate, so the argmax below
  // is over sizes as well as over action types.
  let candidates = actions;
  if (priced) {
    for (const action of priced.candidates) {
      evs[action.label] = priced.byLabel[action.label].ev;
    }
    candidates = actions.flatMap((a) =>
      isAggressive(a) ? priced.candidates : [a]
    );
  }

  const choice = chooseAction({
    profile,
    actions: candidates,
    evByAction: evs,
    street: state.street,
    hole: hero.hole,
    // The pot share, not the outright-win rate: the bluff gate asks "is there
    // anything here worth betting for value", and a hand that chops a lot has
    // value even when it rarely wins outright.
    strength: equity.equity,
    potBefore,
    toCall,
    // Only the entry-gate override reads this, and only to decline to fire on a
    // call whose pot is not yet settled. See `profiles.clearlyProfitable`.
    closesAction: closesAction(state, seat),
    sizings,
    // A separate stream from the equity run's, derived from the same key, so a
    // profile's bluff coin flip cannot correlate with its own Monte Carlo draw.
    rng: makeRng(hashSeed(decisionSeed(state, seat), 0x51ced1ce)),
  });

  return {
    seat,
    street: state.street,
    action: choice.action,
    potBefore,
    toCall,
    equity,
    evByAction: evs,
    beliefs: readsFromActions(handActions(state), state.seats.length),
    profile: profile.id,
    foldEquity: priced?.byLabel,
    equityVsRange: priced?.eRange,
  };
}

export interface DeciderOptions {
  /**
   * Fixed sim count, overriding the per-street budget. Tests use a small number
   * to run whole hands quickly; the game leaves it unset.
   */
  simulations?: number;
  /**
   * Which learned model describes each seat. Injected rather than imported so
   * the engine's tests keep a fresh prior, and stay deterministic, while the
   * live table can hand in the one `opponentMemory` has accumulated for the
   * human seat. Unset means the shared prior for everybody, which is exactly
   * what this file did before the model was learnable at all.
   */
  models?: SeatModels;
}

/**
 * Sims for the fold-equity runs. Capped well below the showdown budget (see
 * `FOLD_EQUITY_SIMS`), but never above an explicit override, a test that asks
 * for 400 sims wants a fast decision, not a fast Monte Carlo and a slow one.
 */
function foldEquityBudget(options: DeciderOptions): number {
  return Math.min(FOLD_EQUITY_SIMS, options.simulations ?? FOLD_EQUITY_SIMS);
}

/**
 * The offline path: every shard runs on the calling thread. Used by tests and
 * scripts, and by the browser whenever the worker pool is unavailable.
 */
export function tableDecider(options: DeciderOptions = {}): SyncBotDecider {
  const models = options.models ?? defaultSeatModels;
  return (state, seat, config) => {
    const request = equityRequest(state, seat, options.simulations, models);
    const equity =
      request.opponents.length === 0
        ? uncontestedEquity()
        : runMultiwayEquitySync(request);
    return finish(
      state,
      seat,
      config,
      equity,
      foldEquityBudget(options),
      request.ranges ?? {},
      models
    );
  };
}

/**
 * The live gameplay path: the Monte Carlo shards go to the worker pool, so the
 * main thread stays free to animate while the decision is in flight. Numerically
 * identical to `tableDecider` for the same state, the pool merges shards in
 * shard order, never completion order.
 */
export function asyncTableDecider(options: DeciderOptions = {}): BotDecider {
  const models = options.models ?? defaultSeatModels;
  return async (state, seat, config) => {
    const request = equityRequest(state, seat, options.simulations, models);
    const equity =
      request.opponents.length === 0
        ? uncontestedEquity()
        : await runMultiwayEquity(request);
    return finish(
      state,
      seat,
      config,
      equity,
      foldEquityBudget(options),
      request.ranges ?? {},
      models
    );
  };
}

/** Default-budget deciders, for callers with nothing to configure. */
export const decideTableAction: SyncBotDecider = tableDecider();
export const decideTableActionAsync: BotDecider = asyncTableDecider();
