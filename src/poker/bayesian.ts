import {
  ACTION_LIKELIHOODS,
  LEARNING_PRIOR_ALPHA,
  LEARNING_PRIOR_DENOM,
} from "../data/constants";
import type {
  BeliefDistribution,
  Card,
  OpponentModel,
  PlayerActionType,
  StrengthTier,
  TierActionStats,
} from "../types";

/** Normalize a belief distribution so the three tiers sum to 1. */
export function normalize(b: BeliefDistribution): BeliefDistribution {
  const sum = b.weak + b.medium + b.strong;
  if (sum <= 0) return { weak: 1 / 3, medium: 1 / 3, strong: 1 / 3 };
  return { weak: b.weak / sum, medium: b.medium / sum, strong: b.strong / sum };
}

/**
 * Bayesian update: posterior(tier) ∝ prior(tier) * P(action | tier).
 *
 * The likelihood table defaults to the fixed `ACTION_LIKELIHOODS`, but callers
 * pass the learned table (derived from observed player behavior) so the bot
 * adapts to how this specific opponent actually plays.
 */
export function updateBelief(
  prior: BeliefDistribution,
  action: PlayerActionType,
  likelihoods: Record<PlayerActionType, BeliefDistribution> = ACTION_LIKELIHOODS
): BeliefDistribution {
  const like = likelihoods[action];
  return normalize({
    weak: prior.weak * like.weak,
    medium: prior.medium * like.medium,
    strong: prior.strong * like.strong,
  });
}

// ---------------------------------------------------------------------------
// Learned opponent model
// ---------------------------------------------------------------------------

/** Maps an action type to its tally field on a `TierActionStats`. */
const ACTION_STAT_KEY: Record<PlayerActionType, keyof TierActionStats> = {
  raise: "raises",
  call: "calls",
  check: "checks",
  fold: "folds",
  bet: "bets",
};

function emptyTierStats(): TierActionStats {
  return { total: 0, raises: 0, calls: 0, checks: 0, folds: 0, bets: 0 };
}

/** A fresh model with zero observations (falls back to ~20% per action). */
export function createOpponentModel(): OpponentModel {
  return {
    weak: emptyTierStats(),
    medium: emptyTierStats(),
    strong: emptyTierStats(),
  };
}

/**
 * Beta-smoothed probability that the player takes `action` in a hand of this
 * tier: (handsWithAction + α) / (handsObserved + denom). Each action is treated
 * as an independent event, so these need not sum to 1 across actions.
 */
export function learnedLikelihood(
  stats: TierActionStats,
  action: PlayerActionType
): number {
  const count = stats[ACTION_STAT_KEY[action]];
  return (count + LEARNING_PRIOR_ALPHA) / (stats.total + LEARNING_PRIOR_DENOM);
}

/** P(action | tier) across all three tiers for a single action. */
export function actionLikelihoodAcrossTiers(
  model: OpponentModel,
  action: PlayerActionType
): BeliefDistribution {
  return {
    weak: learnedLikelihood(model.weak, action),
    medium: learnedLikelihood(model.medium, action),
    strong: learnedLikelihood(model.strong, action),
  };
}

/** Build the full learned likelihood table P(action | tier) from the model. */
export function learnedActionLikelihoods(
  model: OpponentModel
): Record<PlayerActionType, BeliefDistribution> {
  return {
    check: actionLikelihoodAcrossTiers(model, "check"),
    call: actionLikelihoodAcrossTiers(model, "call"),
    bet: actionLikelihoodAcrossTiers(model, "bet"),
    raise: actionLikelihoodAcrossTiers(model, "raise"),
    fold: actionLikelihoodAcrossTiers(model, "fold"),
  };
}

/**
 * Record one revealed (showdown) hand into the model: bump the tier's hand
 * count, then mark each action the player took during the hand. Actions are
 * de-duplicated so a tally reflects "hands in which the action occurred."
 */
export function recordShowdownHand(
  model: OpponentModel,
  tier: StrengthTier,
  actions: PlayerActionType[]
): void {
  const stats = model[tier];
  stats.total += 1;
  for (const action of new Set(actions)) {
    stats[ACTION_STAT_KEY[action]] += 1;
  }
}

/**
 * Chen-formula style preflop hole-card score. Roughly ranges from ~ -1 to 20.
 * Used to bucket a hole-card combo into a strength tier for the opponent model.
 */
export function holeScore(a: Card, b: Card): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);

  const pointsFor = (rank: number): number => {
    if (rank === 14) return 10; // Ace
    if (rank === 13) return 8; // King
    if (rank === 12) return 7; // Queen
    if (rank === 11) return 6; // Jack
    return rank / 2;
  };

  let score: number;
  if (a.rank === b.rank) {
    // Pair: highest card value x2, minimum 5.
    score = Math.max(pointsFor(hi) * 2, 5);
  } else {
    score = pointsFor(hi);
  }

  // Suited bonus.
  if (a.suit === b.suit) score += 2;

  // Gap penalty.
  if (a.rank !== b.rank) {
    const gap = hi - lo - 1;
    if (gap === 1) score -= 1;
    else if (gap === 2) score -= 2;
    else if (gap === 3) score -= 4;
    else if (gap >= 4) score -= 5;

    // Straight bonus: 0 or 1 gap and both below Q.
    if (gap <= 1 && hi < 12) score += 1;
  }

  return Math.round(score);
}

export function tierOf(a: Card, b: Card): StrengthTier {
  const score = holeScore(a, b);
  if (score >= 9) return "strong";
  if (score >= 5) return "medium";
  return "weak";
}
