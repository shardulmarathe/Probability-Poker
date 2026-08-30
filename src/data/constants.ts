import type { BeliefDistribution, PlayerActionType } from "../types";

/*
 * The fixed-limit bet ladder, the raise cap, the fixed starting bankroll and
 * the three sim budgets that used to live here went with the heads-up engine.
 * The table is No-Limit and its stack depth is chosen per session, so sizing
 * comes from `table/rules.ts` and the sim budget from `TABLE_DECISION_SIMS`,
 * which divides by the number of live opponents rather than by street.
 */

/** Initial preflop belief over opponent hand strength. */
export const INITIAL_BELIEF: BeliefDistribution = {
  weak: 0.4,
  medium: 0.35,
  strong: 0.25,
};

/**
 * Default likelihood of each player action given the opponent's true strength
 * tier: P(action | tier). These are the fallback values used before any hands
 * have been observed. Once the learned opponent model has data it supplies the
 * likelihoods instead (see `learnedActionLikelihoods` in `poker/bayesian.ts`).
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

/**
 * Beta-prior smoothing for the learned opponent model. Each action's likelihood
 * is computed as:
 *
 *   P(action | tier) = (handsWithAction + LEARNING_PRIOR_ALPHA)
 *                      / (handsObserved + LEARNING_PRIOR_DENOM)
 *
 * With ALPHA = 2 and DENOM = 10 the prior belief (before any data) is ~20% for
 * every action, and early hands nudge the estimate gently rather than swinging
 * it wildly. As more showdowns accumulate, the observed frequencies dominate.
 */
export const LEARNING_PRIOR_ALPHA = 2;
export const LEARNING_PRIOR_DENOM = 10;
