/**
 * Shared shapes for the N-handed table.
 *
 * This file is the seam between the three pieces that are built independently:
 * the hand lifecycle (`engine.ts`), multiway equity (`../equity/multiway.ts`),
 * and the bot roster (`../model/profiles.ts`). Each depends only on the types
 * here, never on the others' implementations, so a change to how equity is
 * estimated cannot ripple into how a hand is dealt.
 */

import type { BeliefDistribution, HandResult, Street } from "../../types";
import type { FoldEquityBreakdown } from "../ev";
import type { Range } from "../model/range";
import type { TableSeat, TableState } from "./state";
import type { TableAction, TableConfig } from "./rules";

// ---------------------------------------------------------------------------
// Equity
// ---------------------------------------------------------------------------

/**
 * Equity for one seat against a specific set of opponents.
 *
 * `pWin` counts only outright wins; a k-way chop contributes to `pTie` and is
 * worth `1/k` of the pot, so the value of a holding is `equity`, not `pWin`.
 * Heads-up these nearly coincide, which is exactly why multiway needs both.
 */
export interface MultiwayEquity {
  simulations: number;
  wins: number;
  ties: number;
  losses: number;
  pWin: number;
  pTie: number;
  pLoss: number;
  /** Pot share under random completion: pWin + Σ (tie split) / sims. */
  equity: number;
  se: number;
  ciWin: { lo: number; hi: number };
  /**
   * Head-to-head equity against each opponent taken alone, keyed by seat id.
   *
   * The number the report needs most: you can hold 60% against every opponent
   * individually and still be an underdog to the field, which is the single
   * biggest way multiway play differs from heads-up.
   */
  perOpponent: Record<number, number>;
}

export interface EquityRequest {
  heroHole: number[];
  board: number[];
  /** Seat ids still contesting the pot, excluding the hero. */
  opponents: number[];
  /**
   * What the sampler actually draws each opponent's hole cards from: a weight
   * per hole-card combination, keyed by seat id.
   *
   * This is the whole read, not a summary of one. A three-tier belief can say
   * an opponent is 70% likely to be strong; it cannot say *which* hands those
   * are, so a sampler fed one has to guess, and the guess it used to make was
   * a preflop Chen score, which files 7-2 under "weak" on K-7-2-9-4 and aces
   * under "strong" on 5-6-7-8-9. A `Range` carries the board-relative answer
   * and the card removal together, so blockers land in the equity number rather
   * than only in the display.
   */
  ranges?: Record<number, Range>;
  /**
   * The table's three-tier read, kept for callers that have not been migrated
   * (`coach/evLoss.ts` scores a finished hand from action records alone).
   *
   * Consulted only for a seat `ranges` has no entry for, and then it is spread
   * over combos by *board-relative* bucket (`beliefRange`) rather than by the
   * preflop score, so even this path no longer inherits the defect. Supplying
   * neither is legal and means no read at all: a flat prior over every combo
   * the deck still allows.
   */
  beliefs?: Record<number, BeliefDistribution>;
  simulations: number;
  seed: number;
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export type BotArchetype =
  | "rock"
  | "nit"
  | "station"
  | "maniac"
  | "tag"
  | "lag"
  | "professor"
  | "mirror";

/**
 * A bot's playing style, expressed as parameters rather than code so each seat
 * can be described honestly in the analysis ("this opponent enters 38% of pots
 * and bluffs 22% of its river bets") instead of being an opaque black box.
 */
export interface BotProfile {
  id: BotArchetype;
  name: string;
  avatar: string;
  blurb: string;
  /** Minimum Chen-style hole score to enter a pot unraised. Lower = looser. */
  entryThreshold: number;
  /**
   * Multiplier on the EV of aggressive actions. Above 1 the bot bets and raises
   * where a pure maximiser would call; below 1 it does the reverse.
   */
  aggression: number;
  /** Probability of betting with a hand too weak to value bet. */
  bluffRate: number;
  /** Preferred pot fraction when betting, before EV comparison. */
  preferredSizing: number;
}

export interface BotDecision {
  seat: number;
  street: Street;
  action: TableAction;
  potBefore: number;
  toCall: number;
  equity: MultiwayEquity;
  /** EV of every action considered, by label, for the audit trail. */
  evByAction: Record<string, number>;
  beliefs: Record<number, BeliefDistribution>;
  profile: BotArchetype;
  /**
   * Why each bet or raise size scored what it did: the fold probability, the
   * equity against the range that continues, and the two EV terms they combine
   * into. Keyed by the same labels as `evByAction`, and present only for the
   * bet/raise entries, checks, calls and folds have no fold-equity term.
   *
   * Optional because a scripted decider (the engine's tests) does not price
   * anything, and because a seat with nobody left to act against has no fold
   * equity to record.
   */
  foldEquity?: Record<string, FoldEquityBreakdown>;
  /**
   * Hero's pot share against the opponents' full ranges, on the same scale as
   * each size's `eContinue`. The pair is the audit trail for a bluff: betting
   * is profitable precisely when the folds bought are worth more than the gap
   * between these two numbers costs.
   */
  equityVsRange?: number;
}

/**
 * How the engine asks a bot to move. Injected rather than imported so the
 * engine can be tested with a scripted decider and never needs Monte Carlo.
 */
export type BotDecider = (
  state: TableState,
  seat: number,
  config: TableConfig
) => Promise<BotDecision>;

/** Synchronous variant for headless tests and offline scripts. */
export type SyncBotDecider = (
  state: TableState,
  seat: number,
  config: TableConfig
) => BotDecision;

// ---------------------------------------------------------------------------
// Hand records
// ---------------------------------------------------------------------------

export interface SeatResult {
  seat: number;
  hole: number[];
  /** Null when the seat folded before showdown, its cards stay hidden. */
  final: HandResult | null;
  invested: number;
  won: number;
  net: number;
  status: TableSeat["status"];
}

export interface PotRecord {
  amount: number;
  eligible: number[];
  winners: number[];
}

/**
 * The immutable record of a completed hand. `seed` alone is enough to replay
 * it exactly, so this is both the analysis input and the persistence payload.
 */
export interface TableHandReport {
  handNumber: number;
  seed: number;
  button: number;
  seatCount: number;
  board: number[];
  seats: SeatResult[];
  pots: PotRecord[];
  decisions: BotDecision[];
  actions: ActionRecord[];
  endStreet: Street;
  wentToShowdown: boolean;
}

export interface ActionRecord {
  seat: number;
  street: Street;
  action: TableAction["type"];
  cost: number;
  potBefore: number;
  toCall: number;
}
