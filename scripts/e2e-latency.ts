import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createInitialGame,
  startHand,
} from "../src/poker/gameEngine";
import { decideBotAction } from "../src/poker/botStrategy";
import { cardLabel } from "../src/poker/cards";
import { makeDeck, shuffle } from "../src/poker/cards";
import { INITIAL_BELIEF } from "../src/data/constants";
import type { GameState, Street } from "../src/types";

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build a realistic state with the bot to act, facing a bet, at a street. */
function stateAt(street: Exclude<Street, "showdown">): GameState {
  const g = startHand(createInitialGame());
  const deck = shuffle(makeDeck());
  // Deterministic-ish: give the bot a hand and lay out a board.
  g.botHole = [deck[0], deck[1]];
  g.playerHole = [deck[2], deck[3]];
  const boardCount = street === "preflop" ? 0 : street === "flop" ? 3 : street === "turn" ? 4 : 5;
  g.community = deck.slice(4, 4 + boardCount);
  g.street = street;
  g.belief = { ...INITIAL_BELIEF };
  // Bot faces a $10 bet -> call / raise / fold are all legal.
  g.currentBet = 10;
  g.streetCommit = { player: 10, bot: 0 };
  g.invested = { player: 10, bot: 0 };
  g.pot = 10;
  g.raisesThisStreet = 1;
  g.acted = { player: true, bot: false };
  g.toAct = "bot";
  return g;
}

/** Proxy for one card's DOM (a div + two spans), matching PlayingCard's output. */
function cardEl(label: string, key: number) {
  return createElement(
    "div",
    { key, className: "h-20 w-14 rounded-xl bg-white" },
    createElement("span", { className: "leading-none" }, label[0]),
    createElement("span", { className: "leading-none" }, label[1])
  );
}

/** A representative table render: 9 cards + a couple of wrappers, like the Game page. */
function renderTableProxy(state: GameState): number {
  const cards = [...state.botHole, ...state.community, ...state.playerHole];
  const start = performance.now();
  renderToStaticMarkup(
    createElement(
      "div",
      null,
      ...cards.map((c, i) => cardEl(cardLabel(c), i))
    )
  );
  return performance.now() - start;
}

const ITERS = 20;
const rows: Record<string, Record<string, number>> = {};

for (const street of ["preflop", "flop", "turn", "river"] as const) {
  let mc = 0;
  let ev = 0;
  let clone = 0;
  let decision = 0;
  let render = 0;

  // Warm up (prime the evaluator cache + JIT).
  decideBotAction(stateAt(street));
  renderTableProxy(stateAt(street));

  for (let i = 0; i < ITERS; i++) {
    const state = stateAt(street);

    const c0 = performance.now();
    structuredClone(state);
    clone += performance.now() - c0;

    const d0 = performance.now();
    const choice = decideBotAction(state);
    decision += performance.now() - d0;
    mc += choice.timings.mc;
    ev += choice.timings.ev;

    render += renderTableProxy(state);
  }

  const compute = (clone + decision) / ITERS;
  const renderAvg = render / ITERS;
  rows[street] = {
    "Monte Carlo": round(mc / ITERS),
    "EV calc": round(ev / ITERS),
    "State clone": round(clone / ITERS),
    "Compute total": round(compute),
    "React render": round(renderAvg),
    "TOTAL latency": round(compute + renderAvg),
  };
}

console.log("\nEnd-to-end bot decision latency breakdown (ms, avg of 20):\n");
console.table(rows);

const worst = Math.max(...Object.values(rows).map((r) => r["TOTAL latency"]));
console.log(
  `\nWorst-case total: ${round(worst)} ms  (budget 100 ms) -> ${
    worst < 100 ? "OK ✅" : "OVER BUDGET ❌"
  }`
);
