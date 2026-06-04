import { ACTION_LIKELIHOODS } from "../data/constants";
import type {
  BeliefDistribution,
  Card,
  PlayerActionType,
  StrengthTier,
} from "../types";

/** Normalize a belief distribution so the three tiers sum to 1. */
export function normalize(b: BeliefDistribution): BeliefDistribution {
  const sum = b.weak + b.medium + b.strong;
  if (sum <= 0) return { weak: 1 / 3, medium: 1 / 3, strong: 1 / 3 };
  return { weak: b.weak / sum, medium: b.medium / sum, strong: b.strong / sum };
}

/**
 * Bayesian update: posterior(tier) ∝ prior(tier) * P(action | tier).
 * The likelihoods come from the opponent-model table.
 */
export function updateBelief(
  prior: BeliefDistribution,
  action: PlayerActionType
): BeliefDistribution {
  const like = ACTION_LIKELIHOODS[action];
  return normalize({
    weak: prior.weak * like.weak,
    medium: prior.medium * like.medium,
    strong: prior.strong * like.strong,
  });
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
