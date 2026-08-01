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
import { actionEv } from "../ev";
import type {
  ActionRecord,
  BotDecider,
  BotDecision,
  BotProfile,
  EquityRequest,
  MultiwayEquity,
  SyncBotDecider,
} from "../table/contract";
import {
  legalActions,
  sizingLadder,
  type TableAction,
  type TableConfig,
} from "../table/rules";
import {
  contestingSeats,
  seatOf,
  toCall as toCallOf,
  type TableState,
} from "../table/state";
import { BOT_PROFILES, chooseAction, findProfile } from "./profiles";

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
// The decision
// ---------------------------------------------------------------------------

/** A seat's profile, defaulting to the pure-EV baseline for an unlabelled seat. */
export function profileFor(id: string | undefined): BotProfile {
  return (id ? findProfile(id) : undefined) ?? BOT_PROFILES.professor;
}

/**
 * Turn an equity estimate into a move. Split out of the two entry points below
 * so the synchronous and asynchronous paths differ in *nothing* but how the
 * Monte Carlo was scheduled.
 */
function finish(
  state: TableState,
  seat: number,
  config: TableConfig,
  equity: MultiwayEquity
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

  const choice = chooseAction({
    profile,
    actions,
    evByAction: evs,
    street: state.street,
    hole: hero.hole,
    // The pot share, not the outright-win rate: the bluff gate asks "is there
    // anything here worth betting for value", and a hand that chops a lot has
    // value even when it rarely wins outright.
    strength: equity.equity,
    potBefore,
    toCall,
    sizings: sizingLadder(state, seat, config),
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
    return finish(state, seat, config, equity);
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
    return finish(state, seat, config, equity);
  };
}

/** Default-budget deciders, for callers with nothing to configure. */
export const decideTableAction: SyncBotDecider = tableDecider();
export const decideTableActionAsync: BotDecider = asyncTableDecider();
