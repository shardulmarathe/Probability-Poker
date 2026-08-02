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
 *   3. Let the seat's profile bend the answer — entry discipline, bluffs, and
 *      the aggression tilt — into the move actually taken.
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
  Street,
} from "../../types";
import { updateBelief } from "../bayesian";
import { encodeCards } from "../core/card";
import { hashSeed, makeRng } from "../core/rng";
import { runMultiwayEquity, runMultiwayEquitySync } from "../equity/pool";
import {
  actionEv,
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
import {
  BUCKET_COUNT,
  classifyAll,
  makeBoardContext,
  tierFromBucket,
  type HandBucket,
} from "./buckets";
import {
  createLikelihoodModel,
  likelihoodRow,
  type Facing,
  type LearnStreet,
  type LikelihoodModel,
} from "./likelihood";
import { BOT_PROFILES, chooseAction, findProfile } from "./profiles";
import { COMBO_COUNT, removeCards, uniformRange, type Range } from "./range";

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
 * sample count — a six-handed pot must not cost five times a heads-up one on
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
 * action it took — a raise shifts weight to `strong`, a check to `weak`. This
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
 * counter, so one decision can be re-run in isolation — for a replay or a test —
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

export function equityRequest(
  state: TableState,
  seat: number,
  simulations?: number
): EquityRequest {
  const hero = seatOf(state, seat);
  const opponents = opponentsOf(state, seat);
  return {
    heroHole: Array.from(encodeCards(hero.hole)),
    board: Array.from(encodeCards(state.board)),
    opponents,
    beliefs: readsFromActions(handActions(state), state.seats.length),
    simulations: simulations ?? decisionSims(state.street, opponents.length),
    seed: decisionSeed(state, seat),
  };
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
 * other — a chop is worth exactly half, and ties are rare — which is why
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
 * from half pot out to a twenty-times-pot shove says every bucket folds ~96% —
 * aces included — because a uniform shift in log-odds moves p = 0.44 and
 * p = 0.60 by the same odds ratio and the two converge on 1 together. The
 * strength correlation is what fold equity is priced from, so losing it makes a
 * shove with the worst hand at the table read as the highest-EV action on the
 * board. Which it did, before this line: 72o for +5.4 into a $15 pot.
 *
 * A pot-sized bet is the ladder's top rung, so the cap only ever binds on an
 * overbet all-in — the one size no rung of the model was built from. Holding
 * the rate flat there is the honest reading: there is no evidence that betting
 * more than the pot buys more folds, because the hands still there at pot are
 * calling on strength rather than on price.
 */
export const MAX_TILT_FRACTION = 1;

/**
 * The bot's read on how often an opponent folds. A fresh model is the generated
 * poker prior — bucket-, street- and facing-conditioned, with no player data in
 * it — which is the right default for a bot that has observed nothing. It is
 * never written to, so one instance is shared.
 */
const FOLD_MODEL: LikelihoodModel = createLikelihoodModel("poker");

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
 * An opponent's range over all 1326 combos, from the read the table already has.
 *
 * The three-tier belief says how much weight sits on weak / medium / strong;
 * `buckets` says which tier each combo is in *on this board*, which is the whole
 * reason `buckets.ts` exists — on K-7-2 the combo 7-2 is two pair, and a range
 * built from the preflop `tierOf` would file it under "weak" and then wonder why
 * the continuing range looks so harmless.
 *
 * The belief is a distribution over TIERS, not over combos, so each tier's total
 * weight is set to `belief[tier]` and split evenly inside it. Writing
 * `belief[tier]` straight into every combo instead is the obvious mistake and a
 * large one: the weak tier holds roughly seven times the combos the strong tier
 * does, so it would turn a 0.40 / 0.35 / 0.25 read into an effective
 * 0.70 / 0.24 / 0.06 — an opponent four times less likely to hold a real hand
 * than the table believes. This way the tier marginals match the ones
 * `equity/multiway.ts` samples from, so `rangeEquity` and `MultiwayEquity` are
 * two measurements of the same opponent rather than of two different ones.
 *
 * Card removal is applied first, so blockers thin the tier they actually hit.
 */
export function opponentRange(
  belief: BeliefDistribution,
  buckets: Uint8Array,
  dead: number[]
): Range {
  const range = removeCards(uniformRange(), dead);
  const live = new Float64Array(3);
  const tierIndex = (c: number) => {
    const tier = tierFromBucket(buckets[c] as HandBucket);
    return tier === "weak" ? 0 : tier === "medium" ? 1 : 2;
  };

  for (let c = 0; c < COMBO_COUNT; c++) if (range[c] > 0) live[tierIndex(c)] += 1;

  const mass = [belief.weak, belief.medium, belief.strong];
  let total = 0;
  for (let c = 0; c < COMBO_COUNT; c++) {
    if (range[c] <= 0) continue;
    const t = tierIndex(c);
    range[c] = live[t] > 0 ? mass[t] / live[t] : 0;
    total += range[c];
  }

  // A read that put all its weight on a tier this board leaves empty would
  // otherwise produce a range with nothing in it. Fall back to no read at all.
  if (!(total > 0)) return removeCards(uniformRange(), dead);
  return range;
}

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
 * Returns null when there is nothing to price — no opponents, or a state with
 * no cards dealt (a scripted test fixture).
 */
export function priceSizes(
  state: TableState,
  seat: number,
  base: TableAction,
  sizings: SizingOption[],
  simulations: number,
  seed: number
): PricedSizes | null {
  const opponents = opponentsOf(state, seat);
  if (opponents.length === 0 || simulations <= 0) return null;

  const hero = seatOf(state, seat);
  if (hero.hole.length < 2) return null;

  const heroHole = Array.from(encodeCards(hero.hole));
  const board = Array.from(encodeCards(state.board));
  const buckets = classifyAll(makeBoardContext(board));
  const dead = [...heroHole, ...board];
  const beliefs = readsFromActions(handActions(state), state.seats.length);
  const pot = state.pot;
  const toCall = toCallOf(state, seat);
  const potAfterCall = pot + toCall;

  // Postflop the opponents are answering a bet; when the hero is raising, they
  // are answering a raise, which the prior treats as the stronger message.
  const facing: Facing = toCall > 0 ? "facing-raise" : "facing-bet";
  const street = (state.street === "showdown" ? "river" : state.street) as LearnStreet;

  const ranges: Range[] = [];
  const perBucket: (Float64Array | null)[] = [];
  for (const id of opponents) {
    ranges.push(
      opponentRange(beliefs[id] ?? INITIAL_BELIEF, buckets, dead)
    );
    perBucket.push(
      seatOf(state, id).status === "allin"
        ? null
        : foldByBucket(
            FOLD_MODEL,
            street,
            positionOf(id, state.button, state.seats.length),
            facing
          )
    );
  }

  const eRange = rangeEquity({
    heroHole,
    board,
    ranges,
    simulations,
    seed: hashSeed(seed, 0xe9a4e),
  });

  const candidates = sizedCandidates(base, sizings);
  const byLabel: Record<string, FoldEquityBreakdown> = {};
  for (const action of candidates) {
    const extra = Math.max(0, action.cost - toCall);
    const fraction = potAfterCall > 0 ? extra / potAfterCall : 0;
    const models: FoldingOpponent[] = ranges.map((range, i) => ({
      range,
      foldByCombo: foldByCombo(perBucket[i], buckets, fraction),
    }));
    byLabel[action.label] = foldEquityEv({
      heroHole,
      board,
      opponents: models,
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
 * Two prices are formed here, not one. Checks, calls and folds are priced by
 * `actionEv`, which assumes the hand goes to showdown — correct, since none of
 * them can make anybody fold. Bets and raises are priced by `foldEquityEv`,
 * once per candidate size, and it is that second price which lets a hand with
 * no showdown value be worth betting at all.
 */
function finish(
  state: TableState,
  seat: number,
  config: TableConfig,
  equity: MultiwayEquity,
  foldEquitySims: number
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
        decisionSeed(state, seat)
      )
    : null;

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
}

/**
 * Sims for the fold-equity runs. Capped well below the showdown budget (see
 * `FOLD_EQUITY_SIMS`), but never above an explicit override — a test that asks
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
  return (state, seat, config) => {
    const request = equityRequest(state, seat, options.simulations);
    const equity =
      request.opponents.length === 0
        ? uncontestedEquity()
        : runMultiwayEquitySync(request);
    return finish(state, seat, config, equity, foldEquityBudget(options));
  };
}

/**
 * The live gameplay path: the Monte Carlo shards go to the worker pool, so the
 * main thread stays free to animate while the decision is in flight. Numerically
 * identical to `tableDecider` for the same state — the pool merges shards in
 * shard order, never completion order.
 */
export function asyncTableDecider(options: DeciderOptions = {}): BotDecider {
  return async (state, seat, config) => {
    const request = equityRequest(state, seat, options.simulations);
    const equity =
      request.opponents.length === 0
        ? uncontestedEquity()
        : await runMultiwayEquity(request);
    return finish(state, seat, config, equity, foldEquityBudget(options));
  };
}

/** Default-budget deciders, for callers with nothing to configure. */
export const decideTableAction: SyncBotDecider = tableDecider();
export const decideTableActionAsync: BotDecider = asyncTableDecider();
