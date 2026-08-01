import { describe, expect, it } from "vitest";
import {
  applyBotTurn,
  applyPlayerAction,
  createInitialGame,
  generateAnalysis,
  getLegalActions,
  handSeed,
  startHand,
} from "./gameEngine";
import type { GameState } from "../types";

/**
 * Play a fixed number of hands with a scripted player, recording everything
 * observable. Any nondeterminism anywhere in the engine shows up as a diff.
 *
 * Three hands is enough to cover every class of derived value: measured over
 * the seeds used below, a transcript carries 19-26 bot decisions (each with its
 * Monte Carlo pWin), 2-3 hand records with their derived hand seeds, boards and
 * hole cards, and 2-3 regenerated analyses whose timelines span all four
 * streets (Preflop, Flop, Turn, River). Six hands only replayed more of the
 * same at twice the cost.
 */
function transcript(seed: number, hands = 3): string {
  let game: GameState = startHand(createInitialGame(seed));
  const lines: string[] = [];

  for (let h = 0; h < hands && game.status !== "game-over"; h++) {
    let steps = 0;
    while (game.status === "playing" && steps++ < 100) {
      if (game.toAct === "bot") {
        const { choice } = applyBotTurn(game);
        // Include the Monte Carlo output: this is the number that actually has
        // to be reproducible, not just the action it happened to imply.
        lines.push(
          `bot ${choice.action.type} ${choice.action.cost} p=${choice.decision.monteCarlo.pWin.toFixed(6)}`
        );
      } else {
        const legal = getLegalActions(game, "player");
        // Scripted: prefer aggression so more code paths are exercised.
        const pick =
          legal.find((a) => a.type === "raise") ??
          legal.find((a) => a.type === "bet") ??
          legal.find((a) => a.type === "call") ??
          legal[0];
        applyPlayerAction(game, pick);
        lines.push(`you ${pick.type} ${pick.cost}`);
      }
    }

    const report = game.result!.report;
    lines.push(
      `hand ${report.handNumber} seed=${report.seed} ` +
        `board=${report.community.map((c) => c.id).join(",")} ` +
        `you=${report.playerHole.map((c) => c.id).join(",")} ` +
        `bot=${report.botHole.map((c) => c.id).join(",")} ` +
        `winner=${report.winner} pot=${report.potWon}`
    );

    const full = generateAnalysis(report);
    lines.push(
      `analysis mc=${full.monteCarlo.pWin.toFixed(6)} ` +
        full.timeline.map((t) => `${t.street}:${t.playerWin.toFixed(6)}`).join(" ")
    );

    if (game.status === "hand-over") startHand(game);
  }

  return lines.join("\n");
}

describe("determinism", () => {
  it("replays a whole session identically from the same seed", () => {
    expect(transcript(0xc0ffee)).toBe(transcript(0xc0ffee));
  });

  it("produces different sessions from different seeds", () => {
    expect(transcript(1)).not.toBe(transcript(2));
  });

  it("is reproducible from seed 0", () => {
    // Guards the SplitMix32 seeding: a naive seeding scheme degenerates here.
    expect(transcript(0)).toBe(transcript(0));
    expect(transcript(0)).not.toBe(transcript(1));
  });

  it("deals a hand purely from its own derived seed", () => {
    // Two independent sessions with the same seed must deal hand N the same
    // way, which is what makes a hand shareable by seed alone.
    const a = startHand(createInitialGame(42));
    const b = startHand(createInitialGame(42));
    expect(a.playerHole.map((c) => c.id)).toEqual(b.playerHole.map((c) => c.id));
    expect(a.botHole.map((c) => c.id)).toEqual(b.botHole.map((c) => c.id));
    expect(a.deck.map((c) => c.id)).toEqual(b.deck.map((c) => c.id));
  });

  it("gives consecutive hands unrelated deals", () => {
    const g = startHand(createInitialGame(7));
    const first = g.playerHole.map((c) => c.id).join(",");
    g.status = "hand-over";
    startHand(g);
    expect(g.playerHole.map((c) => c.id).join(",")).not.toBe(first);
  });

  it("derives hand seeds that differ across hands and sessions", () => {
    expect(handSeed(5, 1)).not.toBe(handSeed(5, 2));
    expect(handSeed(5, 1)).not.toBe(handSeed(6, 1));
    expect(handSeed(5, 1)).toBe(handSeed(5, 1));
  });

  it("regenerates identical analysis for the same report", () => {
    let g = startHand(createInitialGame(99));
    let steps = 0;
    while (g.status === "playing" && steps++ < 100) {
      if (g.toAct === "bot") applyBotTurn(g);
      else applyPlayerAction(g, getLegalActions(g, "player")[0]);
    }
    const report = g.result!.report;
    expect(generateAnalysis(report)).toEqual(generateAnalysis(report));
  });
});
