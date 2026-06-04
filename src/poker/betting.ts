import { BET_SIZE, MAX_RAISES_PER_STREET } from "../data/constants";
import type { GameState, LegalAction, Seat } from "../types";

export function otherSeat(seat: Seat): Seat {
  return seat === "player" ? "bot" : "player";
}

function bankrollOf(state: GameState, seat: Seat): number {
  return seat === "player" ? state.playerBankroll : state.botBankroll;
}

/**
 * Compute the legal actions available to `seat` in the current betting round.
 * Costs are clamped to the seat's remaining stack (all-in handling).
 */
export function getLegalActions(state: GameState, seat: Seat): LegalAction[] {
  if (state.street === "showdown") return [];

  const betSize = BET_SIZE[state.street];
  const stack = bankrollOf(state, seat);
  const committed = state.streetCommit[seat];
  const toCall = state.currentBet - committed;
  const canRaiseMore = state.raisesThisStreet < MAX_RAISES_PER_STREET;

  const actions: LegalAction[] = [];

  if (stack <= 0) {
    // Already all-in: can only check through.
    if (toCall <= 0) {
      actions.push({ type: "check", amount: committed, cost: 0, label: "Check" });
    } else {
      actions.push({ type: "call", amount: committed, cost: 0, label: "Call (all-in)" });
    }
    return actions;
  }

  if (toCall <= 0) {
    actions.push({ type: "check", amount: committed, cost: 0, label: "Check" });

    if (state.currentBet === 0) {
      // Opening bet.
      if (canRaiseMore) {
        const cost = Math.min(betSize, stack);
        actions.push({
          type: "bet",
          amount: committed + cost,
          cost,
          label: `Bet $${betSize}`,
        });
      }
    } else if (canRaiseMore) {
      // Option to raise (e.g. big blind after a limp).
      const newLevel = state.currentBet * 2;
      const cost = Math.min(newLevel - committed, stack);
      if (cost > 0) {
        actions.push({
          type: "raise",
          amount: committed + cost,
          cost,
          label: `Raise to $${committed + cost}`,
        });
      }
    }
    return actions;
  }

  // Facing a bet: fold / call / (raise).
  actions.push({ type: "fold", amount: committed, cost: 0, label: "Fold" });

  const callCost = Math.min(toCall, stack);
  actions.push({
    type: "call",
    amount: committed + callCost,
    cost: callCost,
    label: `Call $${callCost}`,
  });

  if (canRaiseMore && stack > toCall) {
    const newLevel = state.currentBet * 2;
    const cost = Math.min(newLevel - committed, stack);
    if (cost > toCall) {
      actions.push({
        type: "raise",
        amount: committed + cost,
        cost,
        label: `Raise to $${committed + cost}`,
      });
    }
  }

  return actions;
}

export function getLegalAction(
  state: GameState,
  seat: Seat,
  type: string
): LegalAction | undefined {
  return getLegalActions(state, seat).find((a) => a.type === type);
}
