/**
 * Shared plumbing for the two replays that invent something.
 *
 * `reconstruct.ts` never asks anybody to decide anything, it has the moves.
 * The counterfactual and the alternative lineup both do, and this is the only
 * file in the replay that reaches for a bot. Keeping it to one file is
 * deliberate: the decider's own module is under active change, and a single
 * import means a change there costs one line here rather than three.
 */

import { tableDecider } from "../model/decider";
import type { SyncBotDecider } from "../table/contract";
import { applyAction, type Table } from "../table/engine";
import type { TableConfig } from "../table/rules";
import { snapshot, type ReplayFrame } from "./frames";
import type { ReplayTableOptions } from "./table";

/**
 * Monte Carlo budget for a re-derived move.
 *
 * Below the live game's per-street budget because a replay runs the whole
 * remainder of a hand synchronously on whatever thread asked for it, in the
 * browser, the one painting the page. Measured, a full simulated hand costs
 * about 35ms here against roughly 15ms at 400 sims: the Monte Carlo is not what
 * dominates, so there is no reason to economise further. The standard error at
 * this count is about 0.8% on a coin flip.
 */
export const SIMULATION_SIMS = 4000;

export interface SimulationOptions extends ReplayTableOptions {
  /**
   * The bot that fills in every move a replay does not have a record for.
   * Supply one to make a test deterministic and instant; the default is the
   * real decider on a reduced budget.
   */
  decide?: SyncBotDecider;
  /** Monte Carlo budget for the default decider. */
  simulations?: number;
}

export function defaultDecider(options: SimulationOptions): SyncBotDecider {
  return tableDecider({ simulations: options.simulations ?? SIMULATION_SIMS });
}

/**
 * A hand cannot legitimately run longer than this. The engine's own bound,
 * restated because it is private to `engine.ts`; both exist so a cycling turn
 * order surfaces as a throw rather than a hang.
 */
export function actionBound(table: Table): number {
  const n = table.seats.length;
  const deepest = Math.max(...table.seats.map((s) => s.stack + s.invested));
  return 4 * n * (Math.ceil(deepest / table.config.bigBlind) + n + 1);
}

export interface DriveResult {
  /** Moves the bot supplied. None of them was observed. */
  rederived: number;
  /** Set when the hand could not be finished. */
  reason: string | null;
}

/** Run a live hand to settlement with the bot deciding, snapshotting as it goes. */
export function driveWithBots(
  table: Table,
  config: TableConfig,
  decide: SyncBotDecider,
  frames: ReplayFrame[]
): DriveResult {
  const limit = actionBound(table);
  let rederived = 0;

  while (table.status === "playing") {
    if (rederived >= limit) {
      return { rederived, reason: `simulation exceeded ${limit} actions` };
    }
    const seat = table.toAct;
    if (seat === null) return { rederived, reason: "live hand with nobody to act" };
    const decision = decide(table, seat, config);
    table.decisions.push(decision);
    applyAction(table, seat, decision.action);
    rederived += 1;
    frames.push(snapshot(table, frames.length));
  }
  return { rederived, reason: null };
}
