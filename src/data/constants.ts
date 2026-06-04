import type { BeliefDistribution, PlayerActionType, Street } from "../types";

export const STARTING_BANKROLL = 1000;
export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;

/** Fixed-limit bet size per street. */
export const BET_SIZE: Record<Exclude<Street, "showdown">, number> = {
  preflop: 10,
  flop: 10,
  turn: 20,
  river: 20,
};

/** Maximum number of raises allowed per betting round (keeps rounds bounded). */
export const MAX_RAISES_PER_STREET = 4;

/** Sims for the representative post-hand report run (off the gameplay path). */
export const MONTE_CARLO_SIMS = 5000;

/**
 * Per-street sim counts for the bot's live in-hand decisions. Tuned for
 * responsiveness (< 500ms per decision) over precision — later streets need
 * fewer samples because fewer cards remain unknown.
 */
export const DECISION_SIMS: Record<Exclude<Street, "showdown">, number> = {
  preflop: 7000,
  flop: 7000,
  turn: 5000,
  river: 3000,
};

/** Sims for the post-hand probability timeline (kept light for snappy streets). */
export const TIMELINE_SIMS = 1500;

/** Initial preflop belief over opponent hand strength. */
export const INITIAL_BELIEF: BeliefDistribution = {
  weak: 0.4,
  medium: 0.35,
  strong: 0.25,
};

/**
 * Likelihood of each player action given the opponent's true strength tier:
 * P(action | tier). Used directly in the Bayesian update.
 */
export const ACTION_LIKELIHOODS: Record<
  PlayerActionType,
  BeliefDistribution
> = {
  check: { weak: 0.5, medium: 0.35, strong: 0.15 },
  call: { weak: 0.25, medium: 0.5, strong: 0.25 },
  bet: { weak: 0.15, medium: 0.35, strong: 0.5 },
  raise: { weak: 0.05, medium: 0.25, strong: 0.7 },
  // Folding ends the hand; included for completeness only.
  fold: { weak: 0.8, medium: 0.15, strong: 0.05 },
};
