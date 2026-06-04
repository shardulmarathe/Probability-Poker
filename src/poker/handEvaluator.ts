import {
  HAND_CATEGORY_NAMES,
  HandCategory,
  type Card,
  type HandResult,
  type Suit,
} from "../types";

const BASE = 15;
const SUIT_INDEX: Record<Suit, number> = { s: 0, h: 1, d: 2, c: 3 };

/** Fold a category plus up to 5 ordered kickers into a single comparable score. */
function encode(category: HandCategory, kickers: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * BASE + (kickers[i] ?? 0);
  }
  return score;
}

/**
 * High card of the best 5-card straight encoded in a 15-bit rank mask
 * (bit r set => rank r present), or 0. Handles the wheel (A-2-3-4-5).
 */
function straightHigh(rankMask: number): number {
  let m = rankMask;
  // Treat the Ace (bit 14) as low (bit 1) as well.
  if (m & (1 << 14)) m |= 1 << 1;
  for (let high = 14; high >= 5; high--) {
    if (((m >> (high - 4)) & 0x1f) === 0x1f) return high;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Memoized evaluation
// ---------------------------------------------------------------------------

const cache = new Map<number, HandResult>();
const MAX_CACHE = 400_000;

/**
 * Evaluate the best 5-card hand from 5, 6, or 7 cards.
 *
 * Results are memoized by a 52-bit card-set bitmask. This is a large win for
 * the Monte Carlo loops, where the bot's own hand is constant across every
 * roll-out on a complete board (and varies over only a handful of cards on the
 * turn), so most repeat evaluations become O(1) cache hits.
 */
export function evaluate(cards: Card[]): HandResult {
  // counts[r] = number of cards of rank r (2..14)
  const counts = new Uint8Array(15);
  const suitCount = new Uint8Array(4);
  const suitRankMask = new Uint16Array(4);
  let rankMask = 0;
  let key = 0;

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const si = SUIT_INDEX[c.suit];
    counts[c.rank]++;
    suitCount[si]++;
    suitRankMask[si] |= 1 << c.rank;
    rankMask |= 1 << c.rank;
    // Card index 0..51 -> contribute a distinct power of two to the key.
    key += 2 ** ((c.rank - 2) * 4 + si);
  }

  const hit = cache.get(key);
  if (hit) return hit;

  const res = classify(counts, suitCount, suitRankMask, rankMask);
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, res);
  return res;
}

function classify(
  counts: Uint8Array,
  suitCount: Uint8Array,
  suitRankMask: Uint16Array,
  rankMask: number
): HandResult {
  // Flush detection.
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] >= 5) {
      flushSuit = s;
      break;
    }
  }

  // Straight flush.
  if (flushSuit >= 0) {
    const sfHigh = straightHigh(suitRankMask[flushSuit]);
    if (sfHigh) return make(HandCategory.StraightFlush, [sfHigh]);
  }

  // Bucket ranks by count (high to low so collected ranks stay descending).
  let quad = 0;
  let trip1 = 0;
  let trip2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const c = counts[r];
    if (c === 4) quad = r;
    else if (c === 3) {
      if (trip1 === 0) trip1 = r;
      else if (trip2 === 0) trip2 = r;
    } else if (c === 2) {
      if (pair1 === 0) pair1 = r;
      else if (pair2 === 0) pair2 = r;
    }
  }

  // Four of a kind.
  if (quad) {
    return make(HandCategory.FourOfAKind, [quad, highest(counts, quad, 0)]);
  }

  // Full house (trips + pair, or two sets of trips).
  if (trip1 && (pair1 || trip2)) {
    const pairRank = Math.max(pair1, trip2);
    return make(HandCategory.FullHouse, [trip1, pairRank]);
  }

  // Flush.
  if (flushSuit >= 0) {
    return make(HandCategory.Flush, topFromMask(suitRankMask[flushSuit], 5));
  }

  // Straight.
  const sHigh = straightHigh(rankMask);
  if (sHigh) return make(HandCategory.Straight, [sHigh]);

  // Three of a kind.
  if (trip1) {
    return make(HandCategory.ThreeOfAKind, [
      trip1,
      ...topRanks(counts, 2, trip1, 0),
    ]);
  }

  // Two pair.
  if (pair1 && pair2) {
    return make(HandCategory.TwoPair, [
      pair1,
      pair2,
      highest(counts, pair1, pair2),
    ]);
  }

  // One pair.
  if (pair1) {
    return make(HandCategory.Pair, [pair1, ...topRanks(counts, 3, pair1, 0)]);
  }

  // High card.
  return make(HandCategory.HighCard, topRanks(counts, 5, 0, 0));
}

/** Highest rank with count > 0, skipping up to two excluded ranks. */
function highest(counts: Uint8Array, exclude1: number, exclude2: number): number {
  for (let r = 14; r >= 2; r--) {
    if (counts[r] > 0 && r !== exclude1 && r !== exclude2) return r;
  }
  return 0;
}

/** Top `n` ranks (descending) with count > 0, skipping excluded ranks. */
function topRanks(
  counts: Uint8Array,
  n: number,
  exclude1: number,
  exclude2: number
): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) {
    if (counts[r] > 0 && r !== exclude1 && r !== exclude2) out.push(r);
  }
  return out;
}

/** Top `n` ranks (descending) set in a rank bitmask. */
function topFromMask(mask: number, n: number): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) {
    if (mask & (1 << r)) out.push(r);
  }
  return out;
}

function make(category: HandCategory, kickers: number[]): HandResult {
  return {
    category,
    score: encode(category, kickers),
    name: HAND_CATEGORY_NAMES[category],
  };
}

/**
 * Compare two seven-card holdings.
 * Returns 1 if a wins, -1 if b wins, 0 if tie.
 */
export function compareHands(a: Card[], b: Card[]): number {
  const ra = evaluate(a);
  const rb = evaluate(b);
  if (ra.score > rb.score) return 1;
  if (ra.score < rb.score) return -1;
  return 0;
}
