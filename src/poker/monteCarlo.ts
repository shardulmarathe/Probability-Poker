import { evaluate } from "./handEvaluator";
import { tierOf } from "./bayesian";
import {
  HandCategory,
  type BeliefDistribution,
  type Card,
  type MonteCarloResult,
  type StrengthTier,
} from "../types";

function emptyFreq(): Record<HandCategory, number> {
  return {
    [HandCategory.HighCard]: 0,
    [HandCategory.Pair]: 0,
    [HandCategory.TwoPair]: 0,
    [HandCategory.ThreeOfAKind]: 0,
    [HandCategory.Straight]: 0,
    [HandCategory.Flush]: 0,
    [HandCategory.FullHouse]: 0,
    [HandCategory.FourOfAKind]: 0,
    [HandCategory.StraightFlush]: 0,
  };
}

function weightedTier(b: BeliefDistribution): StrengthTier {
  const r = Math.random();
  if (r < b.weak) return "weak";
  if (r < b.weak + b.medium) return "medium";
  return "strong";
}

/**
 * Monte Carlo from the BOT's perspective.
 *
 * The bot does not know the player's hole cards, so they are sampled from the
 * remaining deck, weighted by the Bayesian belief over strength tiers.
 *
 * Performance notes:
 *  - The opponent's hole-card combos are bucketed by tier once, as index pairs.
 *  - Each roll-out reuses pre-allocated hand/scratch buffers (no per-sim
 *    `filter`/`concat`/`Set` allocation).
 *  - Hand evaluations are memoized, so the bot's own hand — constant on a
 *    complete board, and varying over only a few cards on the turn — is mostly
 *    served from cache. When the board is already complete it is evaluated once.
 */
export function runBeliefMonteCarlo(
  botHole: Card[],
  community: Card[],
  pool: Card[],
  belief: BeliefDistribution,
  sims: number
): MonteCarloResult {
  const L = pool.length;
  const cc = community.length;
  const needed = 5 - cc;

  // Bucket every possible opponent two-card combo by tier (as pool index pairs).
  const byTier: Record<StrengthTier, number[][]> = {
    weak: [],
    medium: [],
    strong: [],
  };
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      byTier[tierOf(pool[i], pool[j])].push([i, j]);
    }
  }
  const nonEmptyTiers = (["weak", "medium", "strong"] as StrengthTier[]).filter(
    (t) => byTier[t].length > 0
  );

  // Reusable 7-card buffers: [hole, hole, ...community, ...drawn].
  const botHand: Card[] = new Array(2 + cc + needed);
  const oppHand: Card[] = new Array(2 + cc + needed);
  botHand[0] = botHole[0];
  botHand[1] = botHole[1];
  for (let k = 0; k < cc; k++) {
    botHand[2 + k] = community[k];
    oppHand[2 + k] = community[k];
  }

  // The bot's hand is fixed once the board is complete: evaluate it just once.
  const fixedBot = needed === 0 ? evaluate(botHand) : null;

  const scratch = new Uint8Array(L);
  const sampleTop = L - 2; // sample drawn community from indices [0, L-3]

  const freq = emptyFreq();
  let win = 0;
  let loss = 0;
  let tie = 0;

  for (let s = 0; s < sims; s++) {
    let tier = weightedTier(belief);
    if (byTier[tier].length === 0) {
      tier = nonEmptyTiers[(Math.random() * nonEmptyTiers.length) | 0];
    }
    const combos = byTier[tier];
    const pair = combos[(Math.random() * combos.length) | 0];
    const a = pair[0];
    const b = pair[1];

    oppHand[0] = pool[a];
    oppHand[1] = pool[b];

    if (needed > 0) {
      // Identity permutation, then exclude the two opponent cards by moving
      // them to the tail so they can't be drawn as community cards.
      for (let k = 0; k < L; k++) scratch[k] = k;
      swap(scratch, a, L - 1);
      swap(scratch, b === L - 1 ? a : b, L - 2);

      for (let d = 0; d < needed; d++) {
        const t = d + ((Math.random() * (sampleTop - d)) | 0);
        const tmp = scratch[d];
        scratch[d] = scratch[t];
        scratch[t] = tmp;
        const card = pool[scratch[d]];
        botHand[2 + cc + d] = card;
        oppHand[2 + cc + d] = card;
      }
    }

    const botEval = fixedBot ?? evaluate(botHand);
    const oppEval = evaluate(oppHand);

    freq[botEval.category] += 1;
    if (botEval.score > oppEval.score) win++;
    else if (botEval.score < oppEval.score) loss++;
    else tie++;
  }

  return finalize(sims, win, loss, tie, freq);
}

/**
 * Full-knowledge Monte Carlo: both hole hands are known, only the remaining
 * community cards are random. Probabilities are from the HERO's perspective and
 * the category distribution is the hero's final made hand. Used for the
 * post-hand probability timeline and the representative report run.
 */
export function runFullKnowledgeMonteCarlo(
  heroHole: Card[],
  villainHole: Card[],
  community: Card[],
  pool: Card[],
  sims: number
): MonteCarloResult {
  const L = pool.length;
  const cc = community.length;
  const needed = 5 - cc;

  const freq = emptyFreq();
  let win = 0;
  let loss = 0;
  let tie = 0;

  // Reusable buffers.
  const heroHand: Card[] = new Array(2 + cc + needed);
  const villHand: Card[] = new Array(2 + cc + needed);
  heroHand[0] = heroHole[0];
  heroHand[1] = heroHole[1];
  villHand[0] = villainHole[0];
  villHand[1] = villainHole[1];
  for (let k = 0; k < cc; k++) {
    heroHand[2 + k] = community[k];
    villHand[2 + k] = community[k];
  }

  // Complete board: deterministic outcome.
  if (needed === 0) {
    const heroEval = evaluate(heroHand);
    const villEval = evaluate(villHand);
    freq[heroEval.category] = sims;
    if (heroEval.score > villEval.score) win = sims;
    else if (heroEval.score < villEval.score) loss = sims;
    else tie = sims;
    return finalize(sims, win, loss, tie, freq);
  }

  const scratch = new Uint8Array(L);

  for (let s = 0; s < sims; s++) {
    for (let k = 0; k < L; k++) scratch[k] = k;
    for (let d = 0; d < needed; d++) {
      const t = d + ((Math.random() * (L - d)) | 0);
      const tmp = scratch[d];
      scratch[d] = scratch[t];
      scratch[t] = tmp;
      const card = pool[scratch[d]];
      heroHand[2 + cc + d] = card;
      villHand[2 + cc + d] = card;
    }

    const heroEval = evaluate(heroHand);
    const villEval = evaluate(villHand);

    freq[heroEval.category] += 1;
    if (heroEval.score > villEval.score) win++;
    else if (heroEval.score < villEval.score) loss++;
    else tie++;
  }

  return finalize(sims, win, loss, tie, freq);
}

function swap(arr: Uint8Array, i: number, j: number): void {
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}

function finalize(
  sims: number,
  win: number,
  loss: number,
  tie: number,
  freq: Record<HandCategory, number>
): MonteCarloResult {
  const probFreq = emptyFreq();
  for (const key of Object.keys(freq) as unknown as HandCategory[]) {
    probFreq[key] = freq[key] / sims;
  }
  return {
    simulations: sims,
    pWin: win / sims,
    pLoss: loss / sims,
    pTie: tie / sims,
    categoryFrequencies: probFreq,
  };
}
