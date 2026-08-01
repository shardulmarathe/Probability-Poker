import { describe, expect, it } from "vitest";
import {
  applyBotTurn,
  applyPlayerAction,
  createInitialGame,
  generateAnalysis,
  getLegalActions,
  startHand,
} from "./gameEngine";
import { STARTING_BANKROLL } from "../data/constants";
import type { ActionType, GameState } from "../types";

const TOTAL_CHIPS = STARTING_BANKROLL * 2;

/**
 * Every chip is either in a bankroll or in the live pot.
 *
 * Note: `settlePot` pays the pot out to the bankrolls when the hand resolves but
 * deliberately leaves `state.pot` set (the UI still shows the pot that was won),
 * so the pot only counts as live chips while the hand is in progress.
 */
function chipsInPlay(g: GameState): number {
  return g.playerBankroll + g.botBankroll + (g.status === "playing" ? g.pot : 0);
}

/** Pick the first available action from a preference list. */
function choose(g: GameState, prefer: ActionType[]) {
  const legal = getLegalActions(g, "player");
  expect(legal.length).toBeGreaterThan(0);
  for (const type of prefer) {
    const found = legal.find((a) => a.type === type);
    if (found) return found;
  }
  return legal[0];
}

/**
 * These two tests assert probabilistic properties, so they must not run on
 * `randomSeed()` — a failure would be unreproducible. Every `createInitialGame`
 * call site gets a fixed but *distinct* seed (restarts after a bust included),
 * so a run still explores many different deals rather than replaying one.
 */
const CHIP_SEED = 1001; // "conserves chips" session; restarts use 1002, 1003, …
const FOLD_SEED = 2001; // "under pressure" session; restarts use 2002, 2003, …

describe("gameEngine — headless self-play", () => {
  it("conserves chips and terminates every hand (player checks/calls down)", () => {
    let game = startHand(createInitialGame(CHIP_SEED));
    let restarts = 0;
    let handsPlayed = 0;
    let steps = 0;
    let stepsThisHand = 0;
    const HANDS = 15;
    const MAX_STEPS = 100_000;

    while (handsPlayed < HANDS && steps < MAX_STEPS) {
      steps++;
      stepsThisHand++;
      expect(chipsInPlay(game)).toBe(TOTAL_CHIPS);
      expect(Number.isInteger(game.playerBankroll)).toBe(true);
      expect(Number.isInteger(game.botBankroll)).toBe(true);
      // A hand is at most 4 streets x 5 actions; anything more means a stall.
      expect(stepsThisHand).toBeLessThan(100);

      if (game.status === "playing") {
        // The engine must always name someone to act while the hand is live.
        expect(game.toAct).not.toBeNull();
        if (game.toAct === "bot") {
          applyBotTurn(game);
        } else {
          // Never fold, so most hands reach showdown.
          applyPlayerAction(game, choose(game, ["check", "call"]));
        }
        continue;
      }

      // The hand has fully resolved.
      expect(game.toAct).toBeNull();
      expect(game.playerBankroll + game.botBankroll).toBe(TOTAL_CHIPS);

      const report = game.result!.report;
      expect(report.analysisReady).toBe(false); // cheap report defers analysis

      const full = generateAnalysis(report);
      expect(full.analysisReady).toBe(true);
      const mc = full.monteCarlo;
      expect(mc.pWin + mc.pLoss + mc.pTie).toBeCloseTo(1, 9);
      expect(full.timeline.length).toBeGreaterThan(0);

      handsPlayed++;
      stepsThisHand = 0;
      const busted = game.playerBankroll <= 0 || game.botBankroll <= 0;
      game = busted
        ? startHand(createInitialGame(CHIP_SEED + ++restarts))
        : startHand(game);
      expect(game.status).toBe("playing");
    }

    expect(handsPlayed).toBe(HANDS);
    expect(steps).toBeLessThan(MAX_STEPS);
  });

  it("keeps chips conserved and makes the bot fold sometimes under pressure", () => {
    let game = startHand(createInitialGame(FOLD_SEED));
    let restarts = 0;
    let handsPlayed = 0;
    let steps = 0;
    let decisions = 0;
    let folds = 0;
    const HANDS = 20;
    const MAX_STEPS = 100_000;

    while (handsPlayed < HANDS && steps < MAX_STEPS) {
      steps++;
      expect(chipsInPlay(game)).toBe(TOTAL_CHIPS);

      if (game.status === "playing") {
        if (game.toAct === "bot") {
          const { choice } = applyBotTurn(game);
          decisions++;
          if (choice.action.type === "fold") folds++;
        } else {
          // Maximum aggression: always bet/raise if it is legal.
          applyPlayerAction(game, choose(game, ["raise", "bet", "call", "check"]));
        }
        continue;
      }

      handsPlayed++;
      const busted = game.playerBankroll <= 0 || game.botBankroll <= 0;
      game = busted
        ? startHand(createInitialGame(FOLD_SEED + ++restarts))
        : startHand(game);
    }

    expect(handsPlayed).toBe(HANDS);
    expect(steps).toBeLessThan(MAX_STEPS);

    // Measured under the seeds above: 20 hands / 1 bust-restart / 283 steps
    // produce decisions=139, folds=6, fold rate 4.32%. Because the run is now
    // fully seeded those numbers are exact, so the bounds below are real
    // margins rather than hopeful ones — each is ~2x (sample size, fold count)
    // or ~8x (fold rate) away from the measured value, wide enough to survive
    // strategy tuning but tight enough to fail if the bot stops folding or
    // turns into a nit.
    expect(decisions).toBeGreaterThanOrEqual(100); // measured 139
    expect(folds).toBeGreaterThanOrEqual(3); // measured 6: EV-driven folding happens
    expect(folds / decisions).toBeLessThan(0.35); // measured 0.043: not a nit
  });
});
