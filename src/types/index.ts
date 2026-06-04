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

export interface BeliefSnapshot {
  street: Street;
  /** The player action that triggered this update (null = initial prior). */
  triggerAction: PlayerActionType | null;
  before: BeliefDistribution;
  after: BeliefDistribution;
  /**
   * The likelihood row P(action | tier) actually used for this update. With the
   * learned opponent model these change over time, so we record what was used
   * (rather than re-deriving from a fixed table) to keep the analysis honest.
   * Null for the initial prior snapshot.
   */
  likelihood?: BeliefDistribution | null;
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
  pWin: number;
  pLoss: number;
  pTie: number;
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

// ----------------------------------------------------------------------------
// Probability timeline (full-knowledge equity per street)
// ----------------------------------------------------------------------------

export interface TimelinePoint {
  street: "Preflop" | "Flop" | "Turn" | "River";
  playerWin: number;
  botWin: number;
  tie: number;
}

// ----------------------------------------------------------------------------
// Hand report (stored after every completed hand)
// ----------------------------------------------------------------------------

export interface HandReport {
  handNumber: number;
  playerHole: Card[];
  botHole: Card[];
  community: Card[];
  winner: Seat | "split";
  potWon: number;
  endStreet: Street;
  wentToShowdown: boolean;
  playerFinal: HandResult | null;
  botFinal: HandResult | null;
  decisions: BotDecision[];
  timeline: TimelinePoint[];
  /** Representative full-knowledge Monte Carlo run (5000 sims at preflop). */
  monteCarlo: MonteCarloResult;
  beliefEvolution: BeliefSnapshot[];
  /**
   * Whether the expensive post-hand analysis (timeline + representative Monte
   * Carlo) has been generated yet. The cheap report is created instantly when
   * the hand ends; analysis is filled in afterwards, off the gameplay path.
   */
  analysisReady: boolean;
}

// ----------------------------------------------------------------------------
// Live game state
// ----------------------------------------------------------------------------

export interface GameState {
  handNumber: number;
  playerBankroll: number;
  botBankroll: number;
  /** Who is the dealer / small blind this hand. */
  dealer: Seat;
  street: Street;

  deck: Card[];
  playerHole: Card[];
  botHole: Card[];
  community: Card[];

  pot: number;
  /** Chips invested this street. */
  streetCommit: Record<Seat, number>;
  /** Total chips invested this hand. */
  invested: Record<Seat, number>;
  /** Current bet level to match this street. */
  currentBet: number;
  /** Players who have voluntarily acted since the last aggression. */
  acted: Record<Seat, boolean>;
  raisesThisStreet: number;
  toAct: Seat | null;

  belief: BeliefDistribution;
  beliefEvolution: BeliefSnapshot[];
  /**
   * Cumulative learned model of the player's behavior. Persists across hands
   * for the whole session — startHand never resets it; only a new game does.
   */
  opponentModel: OpponentModel;
  decisions: BotDecision[];
  timeline: TimelinePoint[];

  /** Set when the hand is over. */
  result: HandEndState | null;

  log: string[];
  status: "playing" | "hand-over" | "game-over";
}

export interface HandEndState {
  winner: Seat | "split";
  potWon: number;
  reason: "fold" | "showdown";
  playerFinal: HandResult | null;
  botFinal: HandResult | null;
  report: HandReport;
}
