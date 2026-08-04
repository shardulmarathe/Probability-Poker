import {
  HAND_CATEGORY_NAMES,
  HandCategory,
  type Card,
  type HandResult,
} from "../types";

const BASE = 15;

/** Fold a category plus up to 5 ordered kickers into a single comparable score. */
function encode(category: HandCategory, kickers: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * BASE + (kickers[i] ?? 0);
  }
  return score;
}

// Place values of the base-15 score above, so the hot path can add a kicker
// straight into its slot instead of running encode()'s loop.
const P1 = BASE; // kicker 5
const P2 = P1 * BASE; // kicker 4
const P3 = P2 * BASE; // kicker 3
const P4 = P3 * BASE; // kicker 2
const P5 = P4 * BASE; // kicker 1 / category multiplier

// ---------------------------------------------------------------------------
// Lookup tables, keyed by a 13-bit rank mask (bit i set => rank i+2 present)
// ---------------------------------------------------------------------------
//
// 13 bits is small enough to index directly, which turns every "scan the ranks
// from the ace down" loop in the old evaluator into a single array load. Built
// once at module load; ~96 KB total.

const MASKS = 1 << 13;

/** Rank (2..14) of the highest card in the mask, 0 for an empty mask. */
const HIGH = new Uint8Array(MASKS);
/** The same card as a one-bit mask, so it can be cleared without a shift. */
const HIGH_BIT = new Uint16Array(MASKS);
/** Number of distinct ranks in the mask, flush detection reads this. */
const POP = new Uint8Array(MASKS);
/** High card of the best straight in the mask, 0 if none. Includes the wheel. */
const STRAIGHT = new Uint8Array(MASKS);
/** Top 2 / 3 / 5 ranks as base-15 digits; callers scale them into their slot. */
const KICK2 = new Uint8Array(MASKS);
const KICK3 = new Uint16Array(MASKS);
const KICK5 = new Uint32Array(MASKS);

for (let mask = 1; mask < MASKS; mask++) {
  const ranks: number[] = [];
  for (let i = 12; i >= 0; i--) {
    if (mask & (1 << i)) ranks.push(i + 2);
  }

  HIGH[mask] = ranks[0];
  HIGH_BIT[mask] = 1 << (ranks[0] - 2);
  POP[mask] = ranks.length;

  // Built through encode() itself so the digit layout can't drift. HighCard is
  // 0, so it contributes nothing and only the kickers survive; a mask with too
  // few ranks pads with trailing zeros, exactly as encode() does.
  KICK2[mask] = encode(HandCategory.HighCard, [0, 0, 0, ...ranks.slice(0, 2)]);
  KICK3[mask] = encode(HandCategory.HighCard, [0, 0, ...ranks.slice(0, 3)]);
  KICK5[mask] = encode(HandCategory.HighCard, ranks.slice(0, 5));

  // Rank r lives at bit r-2, so a straight to `high` is 5 consecutive bits
  // ending at high-2.
  for (let high = 14; high >= 6; high--) {
    const need = 0x1f << (high - 6);
    if ((mask & need) === need) {
      STRAIGHT[mask] = high;
      break;
    }
  }
  // The wheel (A-2-3-4-5) is the one straight that is not consecutive in bits.
  if (STRAIGHT[mask] === 0 && (mask & 0x100f) === 0x100f) STRAIGHT[mask] = 5;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Suit char code -> suit index (s:0, h:1, d:2, c:3).
 *
 * INVARIANT: this must stay identical to `SUIT_INDEX`/`SUITS` in core/card.ts.
 * It is a third copy only because indexing a typed array by char code beats a
 * string-keyed property load in the per-card loop; importing the record would
 * cost exactly what this table exists to avoid.
 */
const SUIT_OF_CHAR = new Uint8Array(128);
SUIT_OF_CHAR[115] = 0; // s
SUIT_OF_CHAR[104] = 1; // h
SUIT_OF_CHAR[100] = 2; // d
SUIT_OF_CHAR[99] = 3; // c

/**
 * Per-suit rank masks. Module-level so the hot path allocates nothing; JS is
 * single-threaded and no evaluation yields, so reuse is safe.
 */
const SUIT_MASKS = new Int32Array(4);

/**
 * Evaluate the best 5-card hand from 5, 6, or 7 cards.
 *
 * No memoization: the direct path now costs less than the Map lookup (plus
 * boxed-number key) that used to guard it, and it has no 400k-entry cliff.
 */
export function evaluate(cards: Card[]): HandResult {
  SUIT_MASKS[0] = 0;
  SUIT_MASKS[1] = 0;
  SUIT_MASKS[2] = 0;
  SUIT_MASKS[3] = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    SUIT_MASKS[SUIT_OF_CHAR[c.suit.charCodeAt(0)]] |= 1 << (c.rank - 2);
  }
  return toResult(
    scoreMasks(SUIT_MASKS[0], SUIT_MASKS[1], SUIT_MASKS[2], SUIT_MASKS[3])
  );
}

/**
 * Score `count` integer-encoded cards (see core/card.ts). This is the hot path
 * the Monte Carlo runs on: the score alone is enough to compare hands, and
 * skipping the HandResult saves an allocation per call. Pair it with
 * `categoryOf` when the category is also needed.
 */
export function scoreInts(cards: Uint8Array | number[], count: number): number {
  SUIT_MASKS[0] = 0;
  SUIT_MASKS[1] = 0;
  SUIT_MASKS[2] = 0;
  SUIT_MASKS[3] = 0;
  for (let i = 0; i < count; i++) {
    const c = cards[i];
    SUIT_MASKS[c & 3] |= 1 << (c >> 2);
  }
  return scoreMasks(
    SUIT_MASKS[0],
    SUIT_MASKS[1],
    SUIT_MASKS[2],
    SUIT_MASKS[3]
  );
}

/**
 * The whole evaluator, in bit operations over the four per-suit rank masks.
 * Category order matches the old branch ladder exactly.
 */
function scoreMasks(s0: number, s1: number, s2: number, s3: number): number {
  // At most one suit can hold 5 of 7 cards, so the first hit is the flush.
  let flush = 0;
  if (POP[s0] >= 5) flush = s0;
  else if (POP[s1] >= 5) flush = s1;
  else if (POP[s2] >= 5) flush = s2;
  else if (POP[s3] >= 5) flush = s3;

  if (flush !== 0) {
    const sf = STRAIGHT[flush];
    if (sf !== 0) return HandCategory.StraightFlush * P5 + sf * P4;
  }

  // "Rank appears in at least k suits" masks. A rank is in >=3 suits iff it is
  // in both of one pair of suits and in at least one of the other pair.
  const u = s0 | s1;
  const v = s2 | s3;
  const both1 = s0 & s1;
  const both2 = s2 & s3;
  const m1 = u | v;
  const m2 = both1 | both2 | (u & v);
  const m3 = (both1 & v) | (both2 & u);
  const m4 = both1 & both2;

  if (m4 !== 0) {
    const quadBit = HIGH_BIT[m4];
    return (
      HandCategory.FourOfAKind * P5 +
      HIGH[m4] * P4 +
      HIGH[m1 & ~quadBit] * P3
    );
  }

  // With quads ruled out, m3 is exactly the trips.
  const trip = HIGH[m3];
  const tripBit = HIGH_BIT[m3];
  if (trip !== 0) {
    // A second trip plays as the pair, and m2 already contains it.
    const under = m2 & ~tripBit;
    if (under !== 0) {
      return HandCategory.FullHouse * P5 + trip * P4 + HIGH[under] * P3;
    }
  }

  if (flush !== 0) return HandCategory.Flush * P5 + KICK5[flush];

  const straight = STRAIGHT[m1];
  if (straight !== 0) return HandCategory.Straight * P5 + straight * P4;

  if (trip !== 0) {
    return (
      HandCategory.ThreeOfAKind * P5 + trip * P4 + KICK2[m1 & ~tripBit] * P2
    );
  }

  if (m2 !== 0) {
    const pair1 = HIGH[m2];
    const pair1Bit = HIGH_BIT[m2];
    const rest = m2 & ~pair1Bit;
    if (rest !== 0) {
      // A third pair still supplies a kicker, so exclude only the two that play.
      return (
        HandCategory.TwoPair * P5 +
        pair1 * P4 +
        HIGH[rest] * P3 +
        HIGH[m1 & ~pair1Bit & ~HIGH_BIT[rest]] * P2
      );
    }
    return HandCategory.Pair * P5 + pair1 * P4 + KICK3[m1 & ~pair1Bit] * P1;
  }

  return HandCategory.HighCard * P5 + KICK5[m1];
}

/**
 * The category `encode` packed into a score: its leading base-15 digit. Lets a
 * caller histogram a raw `scoreInts` result without building a `HandResult`.
 */
export function categoryOf(score: number): HandCategory {
  return ((score / P5) | 0) as HandCategory;
}

function toResult(score: number): HandResult {
  const category = categoryOf(score);
  return { category, score, name: HAND_CATEGORY_NAMES[category] };
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
