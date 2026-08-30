/**
 * No-Limit betting rules.
 *
 * The old engine's fixed-limit rules had a closed action set: bet $10, raise to
 * $20, done. No-Limit replaces the size with a continuous range, which is what
 * makes the decision genuinely hard, the bot must now choose how much, and
 * the size it picks changes how often opponents fold, so equity alone no longer
 * determines the play.
 *
 * Two things come out of here: the legal action set (with a `min`/`max` range
 * on bet/raise, for a slider) and a ladder of pot-fraction presets, which is
 * how humans actually think about sizing.
 */

import type { ActionType } from "../../types";
import {
  actingSeats,
  seatOf,
  toCall as toCallOf,
  type TableState,
} from "./state";

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
}

export interface TableAction {
  type: ActionType;
  /** Total this seat will have committed on this street after acting. */
  amount: number;
  /** Chips added now. */
  cost: number;
  label: string;
  /**
   * Legal range for `cost` on a bet or raise. `cost` itself is the minimum;
   * a caller may substitute any value in [min, max].
   */
  min?: number;
  max?: number;
}

const money = (n: number) => `$${n}`;

/**
 * The smallest legal raise.
 *
 * A raise must increase the bet by at least as much as the last one did, so
 * over a $20 bet the next raise is to $40, and over a raise from $20 to $60 the
 * next is to $100. Preflop the big blind counts as the opening raise, which is
 * why `lastRaiseSize` is seeded with it.
 */
function minRaiseTotal(state: TableState, config: TableConfig): number {
  return state.currentBet + Math.max(state.lastRaiseSize, config.bigBlind);
}

/**
 * Legal actions for a seat under No-Limit.
 *
 * Note `mayRaise`: a seat that already acted and then faced an undersized
 * all-in owes the difference but has lost the right to re-raise, so it gets
 * fold/call only (see `recordAction` in state.ts).
 */
export function legalActions(
  state: TableState,
  id: number,
  config: TableConfig
): TableAction[] {
  const seat = seatOf(state, id);
  if (seat.status !== "active" || state.street === "showdown") return [];

  const stack = seat.stack;
  const committed = seat.streetCommit;
  const toCall = toCallOf(state, id);
  const actions: TableAction[] = [];

  // Nobody left to bet against: the board just runs out.
  const opponentsLeft = actingSeats(state).some((s) => s.id !== id);

  if (toCall === 0) {
    actions.push({ type: "check", amount: committed, cost: 0, label: "Check" });

    if (seat.mayRaise && stack > 0 && opponentsLeft) {
      // An opening bet is at least one big blind, or the whole stack if that is
      // less, a short stack can always jam.
      const min = Math.min(config.bigBlind, stack);
      actions.push({
        type: "bet",
        amount: committed + min,
        cost: min,
        label: `Bet ${money(min)}`,
        min,
        max: stack,
      });
    }
    return actions;
  }

  actions.push({ type: "fold", amount: committed, cost: 0, label: "Fold" });
  actions.push({
    type: "call",
    amount: committed + toCall,
    cost: toCall,
    // A call that takes the whole stack is an all-in call; say so.
    label: toCall >= stack ? `Call ${money(toCall)} (all-in)` : `Call ${money(toCall)}`,
  });

  if (seat.mayRaise && stack > toCall && opponentsLeft) {
    // Below the full minimum the only legal raise is a jam, which is allowed
    // even though it is undersized, it just will not reopen the betting.
    const min = Math.min(minRaiseTotal(state, config) - committed, stack);
    actions.push({
      type: "raise",
      amount: committed + min,
      cost: min,
      label:
        min >= stack
          ? `All-in ${money(stack)}`
          : `Raise to ${money(committed + min)}`,
      min,
      max: stack,
    });
  }

  return actions;
}

export interface SizingOption {
  label: string;
  /** Chips added now. */
  cost: number;
  /** Total committed on this street after acting. */
  amount: number;
}

const LADDER: [string, number][] = [
  ["⅓ pot", 1 / 3],
  ["½ pot", 1 / 2],
  ["¾ pot", 3 / 4],
  ["Pot", 1],
];

/**
 * Pot-fraction presets for a bet or raise, clamped to what is actually legal.
 *
 * The pot a sizing is measured against includes the chips the seat must first
 * put in to call, betting "pot" means matching the call and then raising by
 * the resulting pot, which is why `toCall` appears twice below. Presets that
 * collapse onto the same number (common with short stacks) are deduped, and
 * an all-in is always offered last.
 */
export function sizingLadder(
  state: TableState,
  id: number,
  config: TableConfig
): SizingOption[] {
  const raise = legalActions(state, id, config).find(
    (a) => a.type === "bet" || a.type === "raise"
  );
  if (!raise || raise.min === undefined || raise.max === undefined) return [];

  const seat = seatOf(state, id);
  const toCall = toCallOf(state, id);
  const potAfterCall = state.pot + toCall;

  const costs = new Set<number>();
  for (const [, fraction] of LADDER) {
    const cost = Math.round(toCall + fraction * potAfterCall);
    if (cost >= raise.min && cost < raise.max) costs.add(cost);
  }

  const options: SizingOption[] = [];
  for (const [label, fraction] of LADDER) {
    const cost = Math.round(toCall + fraction * potAfterCall);
    if (!costs.has(cost)) continue;
    costs.delete(cost); // first label wins for a duplicated size
    options.push({
      label,
      cost,
      amount: seat.streetCommit + cost,
    });
  }

  options.push({
    label: "All-in",
    cost: raise.max,
    amount: seat.streetCommit + raise.max,
  });
  return options;
}
