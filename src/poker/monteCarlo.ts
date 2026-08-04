import { categoryOf, scoreInts } from "./handEvaluator";
import { tierOf } from "./bayesian";
import { decodeCard, encodeCards } from "./core/card";
import type { Rng } from "./core/rng";
import { standardError, wilsonInterval } from "./core/stats";
import {
  HandCategory,
  type BeliefDistribution,
  type Card,
  type MonteCarloResult,
  type StrengthTier,
} from "../types";

/** HandCategory is a contiguous 0..8 enum, so counts live in a flat array. */
const CATEGORY_COUNT = 9;

function emptyFreq(): number[] {
  return new Array<number>(CATEGORY_COUNT).fill(0);
}

/**
 * Raw outcome counts from a run, the sufficient statistics for everything
 * `MonteCarloResult` reports. A run split across workers is merged by summing
 * these and normalizing once, which is why they are handed back unnormalized;
 * the flat `freq` array also structured-clones across a worker boundary for
 * free, unlike a `Record<HandCategory, number>`.
 */
export interface MonteCarloCounts {
  sims: number;
  wins: number;
  losses: number;
  ties: number;
  /** Made-hand category counts, indexed by `HandCategory`. */
  freq: number[];
}

function weightedTier(b: BeliefDistribution, rng: Rng): StrengthTier {
  const r = rng.next();
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
 *  - Cards become 0..51 codes at the top and stay that way, so the loop scores
 *    `Uint8Array`s through `scoreInts` and never touches a `Card` property.
 *  - Each roll-out reuses pre-allocated hand/scratch buffers (no per-sim
 *    `filter`/`concat`/`Set` allocation).
 *  - Evaluation is not memoized, the direct path costs less than the lookup
 *    would. When the board is already complete the bot's hand is scored once.
 */
export function runBeliefMonteCarlo(
  botHole: Card[],
  community: Card[],
  pool: Card[],
  belief: BeliefDistribution,
  sims: number,
  rng: Rng
): MonteCarloResult {
  return finalizeCounts(
    runBeliefCounts(botHole, community, pool, belief, sims, rng)
  );
}

/**
 * The same run, stopping at the raw counts, what a sharded run needs, since a
 * partial run is only meaningful once summed with its siblings and normalizing
 * per shard would be wrong.
 */
export function runBeliefCounts(
  botHole: Card[],
  community: Card[],
  pool: Card[],
  belief: BeliefDistribution,
  sims: number,
  rng: Rng
): MonteCarloCounts {
  return runBeliefCountsFromCodes(
    encodeCards(botHole),
    encodeCards(community),
    encodeCards(pool),
    belief,
    sims,
    rng
  );
}

/**
 * The implementation, on 0..51 card codes (see core/card.ts). Split out so the
 * equity worker, which already receives codes on the wire, can hand them
 * straight through instead of decoding to `Card[]` for this to re-encode.
 */
export function runBeliefCountsFromCodes(
  botHole: Uint8Array,
  community: Uint8Array,
  pool: Uint8Array,
  belief: BeliefDistribution,
  sims: number,
  rng: Rng
): MonteCarloCounts {
  const L = pool.length;
  const cc = community.length;
  const needed = 5 - cc;

  // Bucket every possible opponent two-card combo by tier (as pool index
  // pairs). `tierOf` wants `Card`s, but this runs once per call rather than
  // once per sim, so decoding the pool here is off the hot path.
  const poolCards = Array.from(pool, decodeCard);
  const byTier: Record<StrengthTier, number[][]> = {
    weak: [],
    medium: [],
    strong: [],
  };
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      byTier[tierOf(poolCards[i], poolCards[j])].push([i, j]);
    }
  }
  const nonEmptyTiers = (["weak", "medium", "strong"] as StrengthTier[]).filter(
    (t) => byTier[t].length > 0
  );

  // Reusable code buffers: [hole, hole, ...community, ...drawn]. Always 7
  // long, `needed` is exactly the board's shortfall, but spelled out so the
  // indexing below reads the same as the fill above.
  const handSize = 2 + cc + needed;
  const botHand = new Uint8Array(handSize);
  const oppHand = new Uint8Array(handSize);
  botHand[0] = botHole[0];
  botHand[1] = botHole[1];
  for (let k = 0; k < cc; k++) {
    botHand[2 + k] = community[k];
    oppHand[2 + k] = community[k];
  }

  // The bot's hand is fixed once the board is complete: score it just once.
  // -1 is not a reachable score, so it doubles as "not fixed".
  const fixedBotScore = needed === 0 ? scoreInts(botHand, handSize) : -1;

  const scratch = new Uint8Array(L);
  const sampleTop = L - 2; // sample drawn community from indices [0, L-3]

  const freq = emptyFreq();
  let win = 0;
  let loss = 0;
  let tie = 0;

  for (let s = 0; s < sims; s++) {
    let tier = weightedTier(belief, rng);
    if (byTier[tier].length === 0) {
      tier = nonEmptyTiers[rng.int(nonEmptyTiers.length)];
    }
    const combos = byTier[tier];
    const pair = combos[rng.int(combos.length)];
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
        const t = d + rng.int(sampleTop - d);
        const tmp = scratch[d];
        scratch[d] = scratch[t];
        scratch[t] = tmp;
        const card = pool[scratch[d]];
        botHand[2 + cc + d] = card;
        oppHand[2 + cc + d] = card;
      }
    }

    const botScore =
      fixedBotScore >= 0 ? fixedBotScore : scoreInts(botHand, handSize);
    const oppScore = scoreInts(oppHand, handSize);

    freq[categoryOf(botScore)] += 1;
    if (botScore > oppScore) win++;
    else if (botScore < oppScore) loss++;
    else tie++;
  }

  return { sims, wins: win, losses: loss, ties: tie, freq };
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
  sims: number,
  rng: Rng
): MonteCarloResult {
  const L = pool.length;
  const cc = community.length;
  const needed = 5 - cc;

  const freq = emptyFreq();
  let win = 0;
  let loss = 0;
  let tie = 0;

  // Same integer fast path as the belief run: encode once, then stay on codes.
  const poolCodes = encodeCards(pool);
  const heroCodes = encodeCards(heroHole);
  const villCodes = encodeCards(villainHole);
  const commCodes = encodeCards(community);

  // Reusable buffers.
  const handSize = 2 + cc + needed;
  const heroHand = new Uint8Array(handSize);
  const villHand = new Uint8Array(handSize);
  heroHand[0] = heroCodes[0];
  heroHand[1] = heroCodes[1];
  villHand[0] = villCodes[0];
  villHand[1] = villCodes[1];
  for (let k = 0; k < cc; k++) {
    heroHand[2 + k] = commCodes[k];
    villHand[2 + k] = commCodes[k];
  }

  // Complete board: deterministic outcome.
  if (needed === 0) {
    const heroScore = scoreInts(heroHand, handSize);
    const villScore = scoreInts(villHand, handSize);
    freq[categoryOf(heroScore)] = sims;
    if (heroScore > villScore) win = sims;
    else if (heroScore < villScore) loss = sims;
    else tie = sims;
    return finalizeCounts({ sims, wins: win, losses: loss, ties: tie, freq });
  }

  const scratch = new Uint8Array(L);

  for (let s = 0; s < sims; s++) {
    for (let k = 0; k < L; k++) scratch[k] = k;
    for (let d = 0; d < needed; d++) {
      const t = d + rng.int(L - d);
      const tmp = scratch[d];
      scratch[d] = scratch[t];
      scratch[t] = tmp;
      const card = poolCodes[scratch[d]];
      heroHand[2 + cc + d] = card;
      villHand[2 + cc + d] = card;
    }

    const heroScore = scoreInts(heroHand, handSize);
    const villScore = scoreInts(villHand, handSize);

    freq[categoryOf(heroScore)] += 1;
    if (heroScore > villScore) win++;
    else if (heroScore < villScore) loss++;
    else tie++;
  }

  return finalizeCounts({ sims, wins: win, losses: loss, ties: tie, freq });
}

function swap(arr: Uint8Array, i: number, j: number): void {
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}

/** Normalize raw counts into the reported result. Pure, so merged shard totals
 * go through exactly the same arithmetic a single run would. */
export function finalizeCounts(c: MonteCarloCounts): MonteCarloResult {
  const { sims, wins, losses, ties, freq } = c;
  const probFreq = {} as Record<HandCategory, number>;
  for (let i = 0; i < CATEGORY_COUNT; i++) {
    probFreq[i as HandCategory] = sims > 0 ? freq[i] / sims : 0;
  }
  const pWin = sims > 0 ? wins / sims : 0;
  return {
    simulations: sims,
    wins,
    losses,
    ties,
    pWin,
    pLoss: sims > 0 ? losses / sims : 0,
    pTie: sims > 0 ? ties / sims : 0,
    se: standardError(pWin, sims),
    ciWin: wilsonInterval(wins, sims),
    categoryFrequencies: probFreq,
  };
}
