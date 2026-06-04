import { DECISION_SIMS } from "../data/constants";
import { makeDeck, removeCards } from "./cards";
import { getLegalActions } from "./betting";
import { runBeliefMonteCarlo } from "./monteCarlo";
import { actionEv } from "./ev";
import type {
  ActionType,
  BotDecision,
  EvalEv,
  GameState,
  LegalAction,
} from "../types";

/** The pool of cards unknown to the bot: everything except its hole + the board. */
export function botUnknownPool(state: GameState) {
  return removeCards(makeDeck(), [...state.botHole, ...state.community]);
}

export interface BotChoice {
  action: LegalAction;
  decision: BotDecision;
  /** Phase timings (ms) for latency instrumentation. */
  timings: { mc: number; ev: number };
}

/**
 * Decide the bot's action purely from expected value:
 *   1. Estimate equity with a belief-weighted Monte Carlo simulation.
 *   2. Compute EV for every legal action.
 *   3. Choose the action with the highest EV.
 *
 * This is the only expensive computation on the live gameplay path ("fast
 * mode"): a single Monte Carlo run per decision. All post-hand analysis
 * (timeline, distributions, representative simulation) is generated later.
 */
export function decideBotAction(state: GameState): BotChoice {
  const legal = getLegalActions(state, "bot");
  const pool = botUnknownPool(state);

  const street = state.street === "showdown" ? "river" : state.street;
  const sims = DECISION_SIMS[street];

  const mcStart = performance.now();
  const mc = runBeliefMonteCarlo(
    state.botHole,
    state.community,
    pool,
    state.belief,
    sims
  );
  const mcTime = performance.now() - mcStart;

  const evStart = performance.now();
  const pot = state.pot;
  const toCall = state.currentBet - state.streetCommit.bot;

  let best: LegalAction = legal[0];
  let bestEv = -Infinity;
  const evByType = new Map<ActionType, number>();

  for (const action of legal) {
    const ev = actionEv(action, mc, pot, toCall);
    evByType.set(action.type, ev);
    if (ev > bestEv) {
      bestEv = ev;
      best = action;
    }
  }

  const ev: EvalEv = {
    // Folding is always the zero baseline in the forward-looking model.
    evFold: evByType.get("fold") ?? 0,
    evCall: evByType.get("call") ?? null,
    evRaise: evByType.get("raise") ?? null,
    evCheck: evByType.get("check") ?? null,
    evBet: evByType.get("bet") ?? null,
  };

  const decision: BotDecision = {
    street: state.street,
    toCall,
    potBefore: pot,
    monteCarlo: mc,
    ev,
    chosen: best.type,
    belief: { ...state.belief },
  };
  const evTime = performance.now() - evStart;

  return { action: best, decision, timings: { mc: mcTime, ev: evTime } };
}
