import {
  applyBotTurn,
  applyPlayerAction,
  createInitialGame,
  generateAnalysis,
  getLegalActions,
  startHand,
} from "../src/poker/gameEngine";
import { STARTING_BANKROLL } from "../src/data/constants";
import { evaluate } from "../src/poker/handEvaluator";
import { makeCard } from "../src/poker/cards";

// 1. Sanity-check the hand evaluator.
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) process.exitCode = 1;
}

const royal = evaluate([
  makeCard(14, "s"),
  makeCard(13, "s"),
  makeCard(12, "s"),
  makeCard(11, "s"),
  makeCard(10, "s"),
  makeCard(2, "h"),
  makeCard(3, "d"),
]);
check("royal flush is straight flush (cat 8)", royal.category === 8);

const quads = evaluate([
  makeCard(9, "s"),
  makeCard(9, "h"),
  makeCard(9, "d"),
  makeCard(9, "c"),
  makeCard(2, "s"),
]);
check("four nines is quads (cat 7)", quads.category === 7);

const wheel = evaluate([
  makeCard(14, "s"),
  makeCard(2, "h"),
  makeCard(3, "d"),
  makeCard(4, "c"),
  makeCard(5, "s"),
  makeCard(13, "h"),
]);
check("A-2-3-4-5 is a straight (cat 4)", wheel.category === 4);

const boatBeatsFlush = (() => {
  const fh = evaluate([
    makeCard(10, "s"),
    makeCard(10, "h"),
    makeCard(10, "d"),
    makeCard(4, "c"),
    makeCard(4, "s"),
  ]);
  const fl = evaluate([
    makeCard(14, "h"),
    makeCard(11, "h"),
    makeCard(8, "h"),
    makeCard(5, "h"),
    makeCard(2, "h"),
  ]);
  return fh.score > fl.score;
})();
check("full house beats flush", boatBeatsFlush);

// 2. Auto-play many full hands; the player calls/checks down every street.
let game = startHand(createInitialGame());
let handsPlayed = 0;
let guard = 0;

while (handsPlayed < 40 && guard < 100000) {
  guard++;
  if (game.status === "playing") {
    if (game.toAct === "bot") {
      applyBotTurn(game);
    } else if (game.toAct === "player") {
      const legal = getLegalActions(game, "player");
      // Prefer check, else call, else first legal (never fold so hands reach showdown often).
      const choice =
        legal.find((a) => a.type === "check") ??
        legal.find((a) => a.type === "call") ??
        legal[0];
      applyPlayerAction(game, choice);
    } else {
      throw new Error("Playing but nobody to act");
    }
  } else if (game.status === "hand-over") {
    const r = game.result!;
    // Conservation: bankrolls should always sum to 2 × starting stack.
    const total = game.playerBankroll + game.botBankroll;
    if (total !== STARTING_BANKROLL * 2) {
      console.log(
        `FAIL  bankroll conservation broke: ${total} (hand ${game.handNumber})`
      );
      process.exitCode = 1;
    }
    // Cheap report should defer analysis.
    if (r.report.analysisReady) {
      console.log("FAIL  cheap report should not be analysis-ready");
      process.exitCode = 1;
    }
    // Generated analysis should have sane probabilities.
    const full = generateAnalysis(r.report);
    const mc = full.monteCarlo;
    const sum = mc.pWin + mc.pLoss + mc.pTie;
    if (!full.analysisReady || Math.abs(sum - 1) > 1e-9) {
      console.log(`FAIL  analysis MC probs sum to ${sum}`);
      process.exitCode = 1;
    }
    if (full.timeline.length === 0) {
      console.log("FAIL  analysis produced no timeline points");
      process.exitCode = 1;
    }
    handsPlayed++;
    startHand(game);
  } else {
    // game-over
    break;
  }
}

check(`played ${handsPlayed} hands without deadlock`, handsPlayed >= 1);
check("loop did not hit the guard limit", guard < 100000);
console.log(
  `Final bankrolls: player=${game.playerBankroll} bot=${game.botBankroll}, status=${game.status}`
);

// 3. Aggression test: an always-betting/raising player should make the bot
//    fold its weak hands a meaningful fraction of the time (EV-driven folding).
{
  let g = startHand(createInitialGame());
  const botActions: Record<string, number> = {};
  let folds = 0;
  let total = 0;
  let played = 0;
  let safety = 0;
  while (played < 300 && safety < 1_000_000) {
    safety++;
    if (g.status === "playing") {
      if (g.toAct === "bot") {
        const { choice } = applyBotTurn(g);
        botActions[choice.action.type] = (botActions[choice.action.type] ?? 0) + 1;
        total++;
        if (choice.action.type === "fold") folds++;
      } else {
        const legal = getLegalActions(g, "player");
        const choice =
          legal.find((a) => a.type === "raise") ??
          legal.find((a) => a.type === "bet") ??
          legal.find((a) => a.type === "call") ??
          legal.find((a) => a.type === "check") ??
          legal[0];
        applyPlayerAction(g, choice);
      }
    } else {
      // hand-over or game-over — keep the match alive to gather decisions.
      played++;
      g.playerBankroll = STARTING_BANKROLL;
      g.botBankroll = STARTING_BANKROLL;
      g.status = "playing";
      startHand(g);
    }
  }
  const foldRate = total > 0 ? folds / total : 0;
  console.log(
    `Bot decisions vs aggression: ${JSON.stringify(botActions)} (${(
      foldRate * 100
    ).toFixed(1)}% folds over ${total} decisions, ${played} hands)`
  );
  check("bot folds some hands under pressure", folds > 0);
  check("bot does not fold everything", foldRate < 0.9);
}
