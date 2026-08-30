// ============================================================================
// Core domain types for Probability Poker
// ============================================================================

export type Suit = "s" | "h" | "d" | "c";

/** Rank value 2..14 (14 = Ace). */
export type RankValue =
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14;

export interface Card {
  rank: RankValue;
  suit: Suit;
  /** Stable id like "As", "Td", "2c". */
  id: string;
}

// ----------------------------------------------------------------------------
// Hand evaluation
// ----------------------------------------------------------------------------

export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

export const HAND_CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High Card",
  [HandCategory.Pair]: "Pair",
  [HandCategory.TwoPair]: "Two Pair",
  [HandCategory.ThreeOfAKind]: "Trips",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full House",
  [HandCategory.FourOfAKind]: "Quads",
  [HandCategory.StraightFlush]: "Straight Flush",
};

export interface HandResult {
  category: HandCategory;
  /** Comparable score; higher beats lower. */
  score: number;
  name: string;
}

// ----------------------------------------------------------------------------
// Bayesian opponent model
// ----------------------------------------------------------------------------

export type StrengthTier = "weak" | "medium" | "strong";

export interface BeliefDistribution {
  weak: number;
  medium: number;
  strong: number;
}

// ----------------------------------------------------------------------------
// Learned opponent model (adapts to the player's behavior across hands)
// ----------------------------------------------------------------------------

/**
 * Per-tier behavioral tallies accumulated from revealed (showdown) hands.
 * `total` counts hands observed in the tier; each action field counts hands of
 * that tier in which the player took that action at least once. These feed
 * Beta-smoothed likelihoods P(action | tier).
 */
export interface TierActionStats {
  total: number;
  raises: number;
  calls: number;
  checks: number;
  folds: number;
  bets: number;
}

export interface OpponentModel {
  weak: TierActionStats;
  medium: TierActionStats;
  strong: TierActionStats;
}

// ----------------------------------------------------------------------------
// Game flow
// ----------------------------------------------------------------------------

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export type Seat = "player" | "bot";

export type ActionType = "check" | "bet" | "call" | "raise" | "fold";
export type PlayerActionType = ActionType;

export interface LegalAction {
  type: ActionType;
  /** Total chips the actor will have committed this street after acting. */
  amount: number;
  /** Chips that must be added now. */
  cost: number;
  label: string;
}

// ----------------------------------------------------------------------------
// Monte Carlo + EV
// ----------------------------------------------------------------------------

export interface MonteCarloResult {
  simulations: number;
  /**
   * Raw outcome counts. Kept alongside the probabilities because they are the
   * sufficient statistics: the confidence interval needs the actual successes
   * (not a rounded probability), and partial runs are merged by summing these.
   */
  wins: number;
  losses: number;
  ties: number;
  pWin: number;
  pLoss: number;
  pTie: number;
  /**
   * Sampling error on pWin. `se` is the Wald error the writeup derives;
   * `ciWin` is the 95% Wilson interval, which stays honest at pWin = 0 or 1
   * where the Wald error collapses to zero. Both are shown so the difference
   * is visible rather than hidden.
   */
  se: number;
  ciWin: { lo: number; hi: number };
  /** Distribution of the evaluated player's final made-hand category. */
  categoryFrequencies: Record<HandCategory, number>;
}

export interface EvalEv {
  evFold: number;
  evCall: number | null;
  evRaise: number | null;
  evCheck: number | null;
  evBet: number | null;
}

export interface BotDecision {
  street: Street;
  /** Snapshot of the situation. */
  toCall: number;
  potBefore: number;
  monteCarlo: MonteCarloResult;
  ev: EvalEv;
  chosen: ActionType;
  belief: BeliefDistribution;
}

