/**
 * Hand generators for the replay tests.
 *
 * These drive the engine through `applyAction` directly rather than through
 * `playHandHeadless`, so no `BotDecision` has to be fabricated, the replay
 * tests care about chips and cards, and the bots' audit trail is the one part
 * of a report a replay deliberately does not reproduce.
 *
 * The action picker is deliberately more aggressive than any real bot. Uniform
 * play folds most hands preflop and almost never builds a side pot, and side
 * pots are exactly where a reconstruction that mishandles all-in entry stacks
 * would come apart.
 */

import { makeRng, type Rng } from "../core/rng";
import type { TableHandReport } from "../table/contract";
import {
  applyAction,
  createTable,
  startHand,
  type Table,
  type TableSetup,
} from "../table/engine";
import { legalActions, type TableAction } from "../table/rules";

/** Weighted pick over whatever is legal, with a random size on aggression. */
function chooseAction(legal: TableAction[], rng: Rng): TableAction {
  const roll = rng.next();
  const aggressive = legal.find((a) => a.type === "bet" || a.type === "raise");
  const passive = legal.find((a) => a.type === "check" || a.type === "call");
  const fold = legal.find((a) => a.type === "fold");

  if (aggressive && roll < 0.4) {
    const { min = aggressive.cost, max = aggressive.cost } = aggressive;
    // A quarter of raises jam, so all-ins and side pots are common.
    const cost = rng.next() < 0.25 ? max : min + rng.int(Math.max(1, max - min + 1));
    return { ...aggressive, cost, amount: aggressive.amount - aggressive.cost + cost };
  }
  if (passive && roll < 0.85) return passive;
  return fold ?? passive ?? legal[0];
}

/** Play one hand with the random picker and return its report. */
export function playRandomHand(table: Table, rng: Rng): TableHandReport {
  startHand(table);
  let steps = 0;
  while (table.status === "playing") {
    if (steps++ > 2000) throw new Error("fixture hand did not terminate");
    const seat = table.toAct;
    if (seat === null) throw new Error("live hand with nobody to act");
    applyAction(table, seat, chooseAction(legalActions(table, seat, table.config), rng));
  }
  if (!table.lastReport) throw new Error("hand ended without a report");
  return table.lastReport;
}

export interface FixtureOptions extends Partial<TableSetup> {
  seatCount: number;
  hands?: number;
}

/**
 * A session of random hands at one table size, with the table it was played on.
 * Stacks drift between hands, which is the point: a report's entry stacks are
 * not the table's starting stack, and the replay has to cope with that.
 */
export function playSession(options: FixtureOptions): {
  table: Table;
  reports: TableHandReport[];
} {
  const { hands = 5, seatCount, ...setup } = options;
  const table = createTable({
    seatCount,
    startingStack: 200,
    smallBlind: 5,
    bigBlind: 10,
    seed: 1,
    ...setup,
  });
  const rng = makeRng(table.seed ^ 0x5eed);
  const reports: TableHandReport[] = [];
  for (let i = 0; i < hands; i++) reports.push(playRandomHand(table, rng));
  return { table, reports };
}
