import { makeDeck, removeCards, shuffle } from "../src/poker/cards";
import { evaluate } from "../src/poker/handEvaluator";
import { runBeliefMonteCarlo } from "../src/poker/monteCarlo";
import { DECISION_SIMS, INITIAL_BELIEF } from "../src/data/constants";
import type { Card } from "../src/types";

function bench(label: string, fn: () => void, iters = 1): number {
  // warm up
  fn();
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const total = performance.now() - start;
  const per = total / iters;
  console.log(`${label.padEnd(38)} ${per.toFixed(2)} ms`);
  return per;
}

// Raw evaluator throughput.
{
  const deck = shuffle(makeDeck());
  const seven = deck.slice(0, 7);
  const N = 200000;
  const start = performance.now();
  let acc = 0;
  for (let i = 0; i < N; i++) acc += evaluate(seven).score;
  const total = performance.now() - start;
  console.log(
    `evaluate throughput: ${((N / total) * 1000 / 1e6).toFixed(2)} M evals/s (acc=${acc % 7})`
  );
}

// Belief Monte Carlo at each street.
function scenario(communityCount: number) {
  const deck = shuffle(makeDeck());
  const botHole = deck.slice(0, 2);
  const community = deck.slice(4, 4 + communityCount);
  const pool: Card[] = removeCards(makeDeck(), [...botHole, ...community]);
  return { botHole, community, pool };
}

console.log("\n--- runBeliefMonteCarlo (per-street decision sims) ---");
let worst = 0;
for (const [name, cc, sims] of [
  ["preflop", 0, DECISION_SIMS.preflop],
  ["flop", 3, DECISION_SIMS.flop],
  ["turn", 4, DECISION_SIMS.turn],
  ["river", 5, DECISION_SIMS.river],
] as const) {
  // Fresh scenario each iteration so the evaluator cache is realistically cold
  // for that board (mimics a real new hand).
  const per = bench(`${name} @ ${sims} sims`, () => {
    const s = scenario(cc);
    runBeliefMonteCarlo(s.botHole, s.community, s.pool, INITIAL_BELIEF, sims);
  }, 10);
  worst = Math.max(worst, per);
}
console.log(
  `\nworst-case decision: ${worst.toFixed(2)} ms  (budget 500 ms) -> ${
    worst < 500 ? "OK" : "TOO SLOW"
  }`
);
