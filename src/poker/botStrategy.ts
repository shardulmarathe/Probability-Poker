import { DECISION_SIMS } from "../data/constants";
import { makeDeck, removeCards } from "./cards";
import { hashSeed } from "./core/rng";
import { getLegalActions } from "./betting";
import { runEquity, runEquitySync, type EquityJob } from "./equity/pool";
import { actionEv } from "./ev";
import type {
  ActionType,
  BotDecision,
  EvalEv,
  GameState,
  LegalAction,
  MonteCarloResult,
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
 * Each decision gets its own stream, keyed by which decision of the hand it is.
 * That keeps a decision's Monte Carlo reproducible in isolation — re-running
 * one decision does not depend on how many draws earlier ones happened to make.
 */
function decisionSeed(state: GameState): number {
  return hashSeed(state.seed, state.handNumber, state.decisions.length);
}

/** Sims this decision will run. Exported so the UI can narrate it without
 * waiting for the result. */
export function decisionSims(state: GameState): number {
  return DECISION_SIMS[state.street === "showdown" ? "river" : state.street];
}

function equityJob(state: GameState): EquityJob {
  return {
    botHole: state.botHole,
    community: state.community,
    pool: botUnknownPool(state),
    belief: state.belief,
    sims: decisionSims(state),
    seed: decisionSeed(state),
  };
}

/**
 * Decide the bot's action purely from expected value:
 *   1. Estimate equity with a belief-weighted Monte Carlo simulation.
 *   2. Compute EV for every legal action.
 *   3. Choose the action with the highest EV.
 *
 * Step 1 is the only expensive computation on the live gameplay path; it is
 * sharded across the equity worker pool. All post-hand analysis (timeline,
 * distributions, representative simulation) is generated later.
 *
 * Two entry points, same numbers. This is the synchronous one — every shard
 * runs on the calling thread — used by the headless engine (`applyBotTurn`)
 * and the offline scripts; `decideBotActionAsync` is the UI's.
 */
export function decideBotAction(state: GameState): BotChoice {
  const mcStart = performance.now();
  const mc = runEquitySync(equityJob(state));
  return finishChoice(state, mc, performance.now() - mcStart);
}

/** The live gameplay path: the shards run in the worker pool. Numerically
 * identical to `decideBotAction` for the same state. */
export async function decideBotActionAsync(
  state: GameState
): Promise<BotChoice> {
  const mcStart = performance.now();
  const mc = await runEquity(equityJob(state));
  return finishChoice(state, mc, performance.now() - mcStart);
}

function finishChoice(
  state: GameState,
  mc: MonteCarloResult,
  mcTime: number
): BotChoice {
  const legal = getLegalActions(state, "bot");

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
