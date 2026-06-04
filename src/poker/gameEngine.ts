import {
  BIG_BLIND,
  INITIAL_BELIEF,
  MONTE_CARLO_SIMS,
  SMALL_BLIND,
  STARTING_BANKROLL,
  TIMELINE_SIMS,
} from "../data/constants";
import { makeDeck, removeCards, shuffle } from "./cards";
import { compareHands, evaluate } from "./handEvaluator";
import {
  runFullKnowledgeMonteCarlo,
} from "./monteCarlo";
import {
  createOpponentModel,
  learnedActionLikelihoods,
  recordShowdownHand,
  tierOf,
  updateBelief,
} from "./bayesian";
import { decideBotAction, type BotChoice } from "./botStrategy";
import { getLegalActions, otherSeat } from "./betting";
import { HandCategory } from "../types";
import type {
  ActionType,
  Card,
  GameState,
  HandReport,
  HandResult,
  LegalAction,
  MonteCarloResult,
  PlayerActionType,
  Seat,
  Street,
  TimelinePoint,
} from "../types";

export function createInitialGame(): GameState {
  const state: GameState = {
    handNumber: 0,
    playerBankroll: STARTING_BANKROLL,
    botBankroll: STARTING_BANKROLL,
    dealer: "bot", // flips to "player" on the first hand
    street: "preflop",
    deck: [],
    playerHole: [],
    botHole: [],
    community: [],
    pot: 0,
    streetCommit: { player: 0, bot: 0 },
    invested: { player: 0, bot: 0 },
    currentBet: 0,
    acted: { player: false, bot: false },
    raisesThisStreet: 0,
    toAct: null,
    belief: { ...INITIAL_BELIEF },
    beliefEvolution: [],
    opponentModel: createOpponentModel(),
    decisions: [],
    timeline: [],
    result: null,
    log: [],
    status: "playing",
  };
  return state;
}

/** Begin a fresh hand. Mutates and returns the given state. */
export function startHand(state: GameState): GameState {
  if (state.playerBankroll <= 0 || state.botBankroll <= 0) {
    state.status = "game-over";
    return state;
  }

  state.handNumber += 1;
  state.dealer = state.handNumber === 1 ? "player" : otherSeat(state.dealer);

  const deck = shuffle(makeDeck());
  state.playerHole = [deck[0], deck[1]];
  state.botHole = [deck[2], deck[3]];
  state.community = [];
  state.deck = deck.slice(4);

  state.street = "preflop";
  state.pot = 0;
  state.streetCommit = { player: 0, bot: 0 };
  state.invested = { player: 0, bot: 0 };
  state.currentBet = 0;
  state.acted = { player: false, bot: false };
  state.raisesThisStreet = 0;
  // NOTE: state.opponentModel is intentionally NOT reset here — it accumulates
  // across every hand of the session so the bot keeps learning the player.
  state.belief = { ...INITIAL_BELIEF };
  state.beliefEvolution = [
    {
      street: "preflop",
      triggerAction: null,
      before: { ...INITIAL_BELIEF },
      after: { ...INITIAL_BELIEF },
      likelihood: null,
    },
  ];
  state.decisions = [];
  state.timeline = [];
  state.result = null;
  state.status = "playing";
  state.log = [`Hand #${state.handNumber} — ${state.dealer} is dealer.`];

  // Post blinds: dealer = small blind, other = big blind.
  const sb = state.dealer;
  const bb = otherSeat(state.dealer);
  commit(state, sb, Math.min(SMALL_BLIND, bankroll(state, sb)));
  commit(state, bb, Math.min(BIG_BLIND, bankroll(state, bb)));
  state.currentBet = Math.max(state.streetCommit.player, state.streetCommit.bot);

  // Small blind acts first preflop. (No probability simulations run here — all
  // analysis is generated after the hand completes to keep gameplay fast.)
  state.toAct = sb;
  return state;
}

function bankroll(state: GameState, seat: Seat): number {
  return seat === "player" ? state.playerBankroll : state.botBankroll;
}

function setBankroll(state: GameState, seat: Seat, value: number): void {
  if (seat === "player") state.playerBankroll = value;
  else state.botBankroll = value;
}

/** Move `cost` chips from a seat's stack into the pot. */
function commit(state: GameState, seat: Seat, cost: number): void {
  setBankroll(state, seat, bankroll(state, seat) - cost);
  state.streetCommit[seat] += cost;
  state.invested[seat] += cost;
  state.pot += cost;
}

function isAllIn(state: GameState, seat: Seat): boolean {
  return bankroll(state, seat) <= 0;
}

function bettingClosed(state: GameState): boolean {
  if (!state.acted.player || !state.acted.bot) return false;
  if (state.streetCommit.player === state.streetCommit.bot) return true;
  // Unequal only legitimately happens when someone is all-in.
  return isAllIn(state, "player") || isAllIn(state, "bot");
}

export { getLegalActions };

// ---------------------------------------------------------------------------
// Applying actions
// ---------------------------------------------------------------------------

/** Apply a player's chosen action, then advance the engine. */
export function applyPlayerAction(
  state: GameState,
  action: LegalAction
): GameState {
  applyAction(state, "player", action);

  // Bayesian belief update from the player's action, using the likelihoods
  // learned from this opponent's past showdowns (falls back to defaults until
  // any hands have been observed).
  if (state.status === "playing" || action.type === "fold") {
    const likelihoods = learnedActionLikelihoods(state.opponentModel);
    const before = { ...state.belief };
    const after = updateBelief(before, action.type, likelihoods);
    state.belief = after;
    state.beliefEvolution.push({
      street: state.street,
      triggerAction: action.type,
      before,
      after,
      likelihood: { ...likelihoods[action.type] },
    });
  }

  if (action.type === "fold") {
    resolveFold(state, "player");
    return state;
  }

  advance(state);
  return state;
}

/**
 * Apply an already-computed bot choice. Kept separate from `decideBotAction`
 * so the UI can compute the decision, show a "thinking" beat, and only then
 * commit the move.
 */
export function applyBotChoice(state: GameState, choice: BotChoice): GameState {
  state.decisions.push(choice.decision);
  applyAction(state, "bot", choice.action);

  if (choice.action.type === "fold") {
    resolveFold(state, "bot");
    return state;
  }

  advance(state);
  return state;
}

/** Compute and apply the bot's action (used by headless tests / non-animated flow). */
export function applyBotTurn(state: GameState): {
  state: GameState;
  choice: BotChoice;
} {
  const choice = decideBotAction(state);
  applyBotChoice(state, choice);
  return { state, choice };
}

function applyAction(
  state: GameState,
  seat: Seat,
  action: LegalAction
): void {
  const label = describeAction(seat, action);
  switch (action.type) {
    case "fold":
      state.acted[seat] = true;
      break;
    case "check":
      state.acted[seat] = true;
      break;
    case "call":
      commit(state, seat, action.cost);
      state.acted[seat] = true;
      break;
    case "bet":
    case "raise":
      commit(state, seat, action.cost);
      state.currentBet = Math.max(state.currentBet, state.streetCommit[seat]);
      state.raisesThisStreet += 1;
      // A new aggression re-opens the action for the opponent.
      state.acted = { player: false, bot: false };
      state.acted[seat] = true;
      break;
  }
  state.log.push(label);
}

function describeAction(seat: Seat, action: LegalAction): string {
  const who = seat === "player" ? "You" : "Bot";
  switch (action.type) {
    case "fold":
      return `${who} fold.`;
    case "check":
      return `${who} check.`;
    case "call":
      return `${who} call $${action.cost}.`;
    case "bet":
      return `${who} bet $${action.cost}.`;
    case "raise":
      return `${who} raise to $${action.amount}.`;
  }
}

// ---------------------------------------------------------------------------
// Advancing the hand
// ---------------------------------------------------------------------------

function advance(state: GameState): void {
  if (bettingClosed(state)) {
    advanceStreet(state);
    return;
  }
  // Otherwise it's the other player's turn.
  state.toAct = otherSeat(lastActor(state));
}

/** The seat that most recently acted is whoever is currently not to-act. */
function lastActor(state: GameState): Seat {
  // toAct still points at the actor that just moved until we flip it.
  return state.toAct ?? "player";
}

function advanceStreet(state: GameState): void {
  // Reset the betting round.
  state.streetCommit = { player: 0, bot: 0 };
  state.currentBet = 0;
  state.acted = { player: false, bot: false };
  state.raisesThisStreet = 0;

  switch (state.street) {
    case "preflop":
      state.community.push(...state.deck.splice(0, 3));
      state.street = "flop";
      break;
    case "flop":
      state.community.push(state.deck.splice(0, 1)[0]);
      state.street = "turn";
      break;
    case "turn":
      state.community.push(state.deck.splice(0, 1)[0]);
      state.street = "river";
      break;
    case "river":
      state.street = "showdown";
      resolveShowdown(state);
      return;
    case "showdown":
      return;
  }

  // If both players are all-in, run it out to showdown automatically.
  if (isAllIn(state, "player") && isAllIn(state, "bot")) {
    runOutToShowdown(state);
    return;
  }

  // Post-flop, the non-dealer (big blind) acts first.
  state.toAct = otherSeat(state.dealer);
}

function runOutToShowdown(state: GameState): void {
  while (state.community.length < 5) {
    state.community.push(state.deck.splice(0, 1)[0]);
  }
  state.street = "showdown";
  resolveShowdown(state);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function settlePot(state: GameState, winner: Seat | "split"): number {
  const matched = Math.min(state.invested.player, state.invested.bot);
  // Return uncalled chips.
  if (state.invested.player > matched) {
    state.playerBankroll += state.invested.player - matched;
  }
  if (state.invested.bot > matched) {
    state.botBankroll += state.invested.bot - matched;
  }
  const pot = matched * 2;
  if (winner === "player") state.playerBankroll += pot;
  else if (winner === "bot") state.botBankroll += pot;
  else {
    state.playerBankroll += matched;
    state.botBankroll += matched;
  }
  return pot;
}

function resolveFold(state: GameState, folder: Seat): void {
  const winner = otherSeat(folder);
  const pot = settlePot(state, winner);
  state.toAct = null;
  finishHand(state, winner, pot, "fold", null, null);
}

function resolveShowdown(state: GameState): void {
  const cmp = compareHands(
    [...state.playerHole, ...state.community],
    [...state.botHole, ...state.community]
  );
  const playerFinal: HandResult = evaluate([
    ...state.playerHole,
    ...state.community,
  ]);
  const botFinal: HandResult = evaluate([...state.botHole, ...state.community]);

  const winner: Seat | "split" =
    cmp > 0 ? "player" : cmp < 0 ? "bot" : "split";
  const pot = settlePot(state, winner);
  state.toAct = null;

  // The player's cards are now revealed: classify their true strength tier and
  // fold every action they took this hand into the learned opponent model. This
  // is what makes future Bayesian updates adapt to the player's real behavior.
  learnFromShowdown(state);

  finishHand(state, winner, pot, "showdown", playerFinal, botFinal);
}

/**
 * Update the persistent opponent model from a just-revealed hand. The player's
 * hole cards give the ground-truth tier; the belief-evolution log gives the
 * actions they took. Only ever called at showdown (folded hands stay hidden).
 */
function learnFromShowdown(state: GameState): void {
  if (state.playerHole.length < 2) return;
  const tier = tierOf(state.playerHole[0], state.playerHole[1]);
  const actions = state.beliefEvolution
    .filter((b) => b.triggerAction !== null)
    .map((b) => b.triggerAction as PlayerActionType);
  recordShowdownHand(state.opponentModel, tier, actions);
}

function finishHand(
  state: GameState,
  winner: Seat | "split",
  potWon: number,
  reason: "fold" | "showdown",
  playerFinal: HandResult | null,
  botFinal: HandResult | null
): void {
  const report = buildReport(state, winner, potWon, reason, playerFinal, botFinal);
  state.result = { winner, potWon, reason, playerFinal, botFinal, report };
  state.status =
    state.playerBankroll <= 0 || state.botBankroll <= 0
      ? "game-over"
      : "hand-over";

  const winLabel =
    winner === "split" ? "Split pot" : winner === "player" ? "You win" : "Bot wins";
  state.log.push(`${winLabel} $${potWon}.`);
}

/**
 * Build the *cheap* hand report synchronously when the hand ends. It contains
 * everything already recorded during play (cards, winner, bot decisions, belief
 * snapshots) but defers the expensive simulations (timeline + representative
 * Monte Carlo) to `generateAnalysis`, which runs off the gameplay path.
 */
function buildReport(
  state: GameState,
  winner: Seat | "split",
  potWon: number,
  reason: "fold" | "showdown",
  playerFinal: HandResult | null,
  botFinal: HandResult | null
): HandReport {
  return {
    handNumber: state.handNumber,
    playerHole: cloneCards(state.playerHole),
    botHole: cloneCards(state.botHole),
    community: cloneCards(state.community),
    winner,
    potWon,
    endStreet: state.street,
    wentToShowdown: reason === "showdown",
    playerFinal,
    botFinal,
    decisions: state.decisions.map((d) => ({ ...d })),
    timeline: [],
    monteCarlo: emptyMonteCarlo(),
    beliefEvolution: state.beliefEvolution.map((b) => ({ ...b })),
    analysisReady: false,
  };
}

function emptyMonteCarlo(): MonteCarloResult {
  return {
    simulations: 0,
    pWin: 0,
    pLoss: 0,
    pTie: 0,
    categoryFrequencies: {
      [HandCategory.HighCard]: 0,
      [HandCategory.Pair]: 0,
      [HandCategory.TwoPair]: 0,
      [HandCategory.ThreeOfAKind]: 0,
      [HandCategory.Straight]: 0,
      [HandCategory.Flush]: 0,
      [HandCategory.FullHouse]: 0,
      [HandCategory.FourOfAKind]: 0,
      [HandCategory.StraightFlush]: 0,
    },
  };
}

/**
 * Generate the expensive post-hand analysis from a completed report. Pure: it
 * derives everything from the already-known cards, so it can run any time after
 * the hand finishes (e.g. in an idle callback) without touching live state.
 *
 *   - Probability timeline: full-knowledge equity reconstructed at each street
 *     that was actually dealt.
 *   - Representative Monte Carlo: 5000-sim preflop equity + hand distribution.
 */
export function generateAnalysis(report: HandReport): HandReport {
  const { playerHole, botHole, community } = report;

  // Timeline: one point per street that was reached.
  const timeline: TimelinePoint[] = [];
  const streets: [TimelinePoint["street"], number][] = [
    ["Preflop", 0],
    ["Flop", 3],
    ["Turn", 4],
    ["River", 5],
  ];
  for (const [label, n] of streets) {
    if (community.length < n) break;
    const board = community.slice(0, n);
    const pool = removeCards(makeDeck(), [...playerHole, ...botHole, ...board]);
    const mc = runFullKnowledgeMonteCarlo(
      playerHole,
      botHole,
      board,
      pool,
      TIMELINE_SIMS
    );
    timeline.push({
      street: label,
      playerWin: mc.pWin,
      botWin: mc.pLoss,
      tie: mc.pTie,
    });
  }

  // Representative preflop Monte Carlo (player's perspective) + distribution.
  const preflopPool = removeCards(makeDeck(), [...playerHole, ...botHole]);
  const monteCarlo = runFullKnowledgeMonteCarlo(
    playerHole,
    botHole,
    [],
    preflopPool,
    MONTE_CARLO_SIMS
  );

  return { ...report, timeline, monteCarlo, analysisReady: true };
}

function cloneCards(cards: Card[]): Card[] {
  return cards.map((c) => ({ ...c }));
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

export function streetLabel(street: Street): string {
  switch (street) {
    case "preflop":
      return "Preflop";
    case "flop":
      return "Flop";
    case "turn":
      return "Turn";
    case "river":
      return "River";
    case "showdown":
      return "Showdown";
  }
}

export type { ActionType };
