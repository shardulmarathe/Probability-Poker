import type { LegalAction, MonteCarloResult } from "../types";

/**
 * Forward-looking (pot-odds) expected value of an action, measured from the
 * decision point. Sunk chips already in the pot are ignored — only the chips
 * risked *now* and the pot that can be won matter. This is what makes folding
 * correct: the bot folds whenever calling is a losing proposition.
 *
 *   - Fold:  EV = 0                      (baseline — risk nothing, win nothing)
 *   - Check: EV = pWin · pot             (no chips risked)
 *   - Call:  EV = pWin · pot − pLoss · cost
 *   - Bet/Raise: opponent is assumed to match the extra, so the pot you can win
 *     grows by that extra:
 *            EV = pWin · (pot + extra) − pLoss · cost,  extra = cost − toCall
 *
 * Ties are treated as chip-neutral (their contribution is ~0).
 */
export function actionEv(
  action: LegalAction,
  mc: MonteCarloResult,
  pot: number,
  toCall: number
): number {
  if (action.type === "fold") return 0;
  const extra = Math.max(0, action.cost - toCall);
  return mc.pWin * (pot + extra) - mc.pLoss * action.cost;
}
