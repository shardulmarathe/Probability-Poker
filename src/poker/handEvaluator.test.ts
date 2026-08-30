import { describe, expect, it } from "vitest";
import { compareHands, evaluate } from "./handEvaluator";
import { cardLabel, makeCard as c, makeDeck } from "./cards";
import { HandCategory, type Card, type Suit } from "../types";

// ---------------------------------------------------------------------------
// Brute-force reference evaluator (local to this file on purpose: it must not
// share any code with the implementation it is checking).
//
// Scores one exact 5-card hand as category * 15^5 + five kickers, then takes the
// max over all C(7,5) = 21 five-card subsets of a 7-card holding.
// ---------------------------------------------------------------------------

const CAT_UNIT = 15 ** 5;

function enc(cat: number, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0): number {
  return ((((cat * 15 + k0) * 15 + k1) * 15 + k2) * 15 + k3) * 15 + k4;
}

// Scratch buffers reused across the millions of calls in the property test.
const rk = new Int32Array(5);
const su: Suit[] = ["s", "s", "s", "s", "s"];
const cnt = new Int32Array(15);
const kick = new Int32Array(5);

/** Score the 5 cards currently in `rk`/`su`. */
function score5(): number {
  // Insertion sort ranks descending.
  for (let i = 1; i < 5; i++) {
    const v = rk[i];
    let j = i - 1;
    while (j >= 0 && rk[j] < v) {
      rk[j + 1] = rk[j];
      j--;
    }
    rk[j + 1] = v;
  }

  const flush =
    su[0] === su[1] && su[1] === su[2] && su[2] === su[3] && su[3] === su[4];

  cnt.fill(0);
  for (let i = 0; i < 5; i++) cnt[rk[i]]++;

  let distinct = 0;
  for (let r = 2; r <= 14; r++) if (cnt[r] > 0) distinct++;

  let straight = 0;
  if (distinct === 5) {
    if (rk[0] - rk[4] === 4) straight = rk[0];
    else if (rk[0] === 14 && rk[1] === 5 && rk[4] === 2) straight = 5; // wheel
  }

  if (flush && straight) return enc(HandCategory.StraightFlush, straight);

  let quad = 0;
  let trip = 0;
  let pairHi = 0;
  let pairLo = 0;
  let nk = 0;
  for (let r = 14; r >= 2; r--) {
    switch (cnt[r]) {
      case 4:
        quad = r;
        break;
      case 3:
        trip = r;
        break;
      case 2:
        if (pairHi === 0) pairHi = r;
        else pairLo = r;
        break;
      case 1:
        kick[nk++] = r;
        break;
    }
  }

  if (quad) return enc(HandCategory.FourOfAKind, quad, kick[0]);
  if (trip && pairHi) return enc(HandCategory.FullHouse, trip, pairHi);
  if (flush) return enc(HandCategory.Flush, rk[0], rk[1], rk[2], rk[3], rk[4]);
  if (straight) return enc(HandCategory.Straight, straight);
  if (trip) return enc(HandCategory.ThreeOfAKind, trip, kick[0], kick[1]);
  if (pairLo) return enc(HandCategory.TwoPair, pairHi, pairLo, kick[0]);
  if (pairHi) return enc(HandCategory.Pair, pairHi, kick[0], kick[1], kick[2]);
  return enc(HandCategory.HighCard, rk[0], rk[1], rk[2], rk[3], rk[4]);
}

/** Flattened list of the 21 five-card index combinations of 7 cards. */
const COMBOS = (() => {
  const out: number[] = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let d = b + 1; d < 7; d++)
        for (let e = d + 1; e < 7; e++)
          for (let f = e + 1; f < 7; f++) out.push(a, b, d, e, f);
  return Int32Array.from(out);
})();

const r7 = new Int32Array(7);
const s7: Suit[] = ["s", "s", "s", "s", "s", "s", "s"];

/** Best-of-21 reference score for a 7-card holding. */
function referenceScore(seven: Card[]): number {
  for (let i = 0; i < 7; i++) {
    r7[i] = seven[i].rank;
    s7[i] = seven[i].suit;
  }
  let best = -1;
  for (let combo = 0; combo < 21; combo++) {
    const o = combo * 5;
    for (let k = 0; k < 5; k++) {
      const idx = COMBOS[o + k];
      rk[k] = r7[idx];
      su[k] = s7[idx];
    }
    const s = score5();
    if (s > best) best = s;
  }
  return best;
}

function referenceCategory(score: number): HandCategory {
  return Math.floor(score / CAT_UNIT) as HandCategory;
}

/** Deterministic PRNG so any failure reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const show = (cards: Card[]) => cards.map(cardLabel).join(" ");

// ---------------------------------------------------------------------------

describe("evaluate vs brute-force reference", () => {
  it("agrees on category and ordering over 100k random 7-card deals", () => {
    const rand = mulberry32(0xc0ffee);
    const deck = makeDeck();
    const DEALS = 100_000;
    const failures: string[] = [];
    let dealt = 0;

    for (let n = 0; n < DEALS && failures.length < 5; n++) {
      dealt++;
      // Partial Fisher-Yates: 5 board cards + two 2-card holdings.
      for (let i = 0; i < 9; i++) {
        const j = i + Math.floor(rand() * (52 - i));
        const t = deck[i];
        deck[i] = deck[j];
        deck[j] = t;
      }
      const a = [deck[0], deck[1], deck[2], deck[3], deck[4], deck[5], deck[6]];
      const b = [deck[0], deck[1], deck[2], deck[3], deck[4], deck[7], deck[8]];

      const refA = referenceScore(a);
      const refB = referenceScore(b);
      const gotA = evaluate(a);
      const gotB = evaluate(b);

      if (gotA.category !== referenceCategory(refA)) {
        failures.push(
          `deal ${n}: [${show(a)}] category ${gotA.category} != ${referenceCategory(refA)}`
        );
      }
      if (gotB.category !== referenceCategory(refB)) {
        failures.push(
          `deal ${n}: [${show(b)}] category ${gotB.category} != ${referenceCategory(refB)}`
        );
      }
      if (Math.sign(compareHands(a, b)) !== Math.sign(refA - refB)) {
        failures.push(
          `deal ${n}: ordering [${show(a)}] vs [${show(b)}] ` +
            `got ${Math.sign(compareHands(a, b))} want ${Math.sign(refA - refB)}`
        );
      }
    }

    expect(failures).toEqual([]);
    expect(dealt).toBe(DEALS); // the loop bails early on failure, prove it did not
  });
});

describe("evaluate: tricky paths", () => {
  it("reads A-2-3-4-5 as a five-high straight, not ace-high", () => {
    const wheel = [c(14, "s"), c(2, "h"), c(3, "d"), c(4, "c"), c(5, "s"), c(13, "h")];
    const sixHigh = [c(6, "s"), c(5, "h"), c(4, "d"), c(3, "c"), c(2, "s"), c(13, "d")];
    expect(evaluate(wheel).category).toBe(HandCategory.Straight);
    expect(compareHands(wheel, sixHigh)).toBe(-1);
  });

  it("ranks Broadway as the best straight", () => {
    const broadway = [c(14, "s"), c(13, "h"), c(12, "d"), c(11, "c"), c(10, "s"), c(2, "h"), c(3, "d")];
    const kingHigh = [c(13, "s"), c(12, "h"), c(11, "d"), c(10, "c"), c(9, "s"), c(2, "h"), c(3, "d")];
    const wheel = [c(14, "s"), c(2, "h"), c(3, "d"), c(4, "c"), c(5, "s"), c(13, "h"), c(7, "d")];
    expect(evaluate(broadway).category).toBe(HandCategory.Straight);
    expect(compareHands(broadway, kingHigh)).toBe(1);
    expect(compareHands(broadway, wheel)).toBe(1);
  });

  it("prefers the straight flush over the higher plain flush in the same suit", () => {
    // Six spades: the best flush is A-9-8-7-6 but 9-8-7-6-5 is a straight flush.
    const sf = [c(9, "s"), c(8, "s"), c(7, "s"), c(6, "s"), c(5, "s"), c(14, "s"), c(2, "h")];
    const aceFlush = [c(14, "h"), c(13, "h"), c(12, "h"), c(11, "h"), c(9, "h"), c(2, "s"), c(3, "c")];
    expect(evaluate(sf).category).toBe(HandCategory.StraightFlush);
    expect(evaluate(aceFlush).category).toBe(HandCategory.Flush);
    expect(compareHands(sf, aceFlush)).toBe(1);
  });

  it("recognises the steel wheel (A-2-3-4-5 suited)", () => {
    const steel = [c(14, "s"), c(2, "s"), c(3, "s"), c(4, "s"), c(5, "s"), c(13, "h"), c(9, "d")];
    expect(evaluate(steel).category).toBe(HandCategory.StraightFlush);
  });

  it("ranks a flush above a straight when the board makes both", () => {
    const both = [c(14, "h"), c(13, "h"), c(12, "h"), c(11, "h"), c(2, "h"), c(10, "s"), c(4, "c")];
    expect(evaluate(both).category).toBe(HandCategory.Flush);
  });

  it("picks the best kicker alongside quads", () => {
    const aceKicker = [c(9, "s"), c(9, "h"), c(9, "d"), c(9, "c"), c(14, "s"), c(13, "h"), c(2, "d")];
    const kingKicker = [c(9, "s"), c(9, "h"), c(9, "d"), c(9, "c"), c(13, "s"), c(12, "h"), c(2, "d")];
    expect(evaluate(aceKicker).category).toBe(HandCategory.FourOfAKind);
    expect(compareHands(aceKicker, kingKicker)).toBe(1);
  });

  it("builds a full house from two sets of trips using the higher trips", () => {
    const twoTrips = [c(13, "s"), c(13, "h"), c(13, "d"), c(9, "s"), c(9, "h"), c(9, "d"), c(2, "c")];
    const kingsFullOfNines = [c(13, "c"), c(13, "h"), c(13, "d"), c(9, "s"), c(9, "h"), c(4, "c"), c(3, "d")];
    const kingsFullOfEights = [c(13, "s"), c(13, "h"), c(13, "d"), c(8, "s"), c(8, "h"), c(2, "c"), c(3, "d")];
    expect(evaluate(twoTrips).category).toBe(HandCategory.FullHouse);
    expect(compareHands(twoTrips, kingsFullOfNines)).toBe(0);
    expect(compareHands(twoTrips, kingsFullOfEights)).toBe(1);
  });

  it("picks the top two pairs and the best remaining kicker from three pairs", () => {
    const queenKicker = [c(14, "s"), c(14, "h"), c(13, "s"), c(13, "h"), c(12, "s"), c(12, "h"), c(2, "d")];
    const jackKicker = [c(14, "d"), c(14, "c"), c(13, "d"), c(13, "c"), c(11, "s"), c(11, "h"), c(2, "s")];
    const sameKicker = [c(14, "d"), c(14, "c"), c(13, "d"), c(13, "c"), c(12, "d"), c(7, "s"), c(2, "s")];
    expect(evaluate(queenKicker).category).toBe(HandCategory.TwoPair);
    expect(compareHands(queenKicker, jackKicker)).toBe(1);
    expect(compareHands(queenKicker, sameKicker)).toBe(0);
  });

  it("takes the top five of six suited cards for a flush", () => {
    const sixSuited = [c(14, "h"), c(13, "h"), c(9, "h"), c(7, "h"), c(5, "h"), c(3, "h"), c(2, "c")];
    const fiveSuited = [c(14, "h"), c(13, "h"), c(9, "h"), c(7, "h"), c(5, "h"), c(2, "d"), c(3, "c")];
    const better = [c(14, "h"), c(13, "h"), c(9, "h"), c(8, "h"), c(5, "h"), c(3, "h"), c(2, "c")];
    expect(evaluate(sixSuited).category).toBe(HandCategory.Flush);
    // The sixth suited card (3h) must be discarded, not counted.
    expect(compareHands(sixSuited, fiveSuited)).toBe(0);
    expect(compareHands(better, sixSuited)).toBe(1);
  });
});

// Ported verbatim from scripts/simulate.ts §1.
describe("evaluate: simulate.ts sanity checks", () => {
  it("classifies a royal flush as a straight flush", () => {
    const royal = evaluate([
      c(14, "s"), c(13, "s"), c(12, "s"), c(11, "s"), c(10, "s"), c(2, "h"), c(3, "d"),
    ]);
    expect(royal.category).toBe(HandCategory.StraightFlush);
  });

  it("classifies four nines as quads", () => {
    const quads = evaluate([c(9, "s"), c(9, "h"), c(9, "d"), c(9, "c"), c(2, "s")]);
    expect(quads.category).toBe(HandCategory.FourOfAKind);
  });

  it("classifies A-2-3-4-5 as a straight", () => {
    const wheel = evaluate([
      c(14, "s"), c(2, "h"), c(3, "d"), c(4, "c"), c(5, "s"), c(13, "h"),
    ]);
    expect(wheel.category).toBe(HandCategory.Straight);
  });

  it("scores a full house above a flush", () => {
    const fullHouse = evaluate([c(10, "s"), c(10, "h"), c(10, "d"), c(4, "c"), c(4, "s")]);
    const flush = evaluate([c(14, "h"), c(11, "h"), c(8, "h"), c(5, "h"), c(2, "h")]);
    expect(fullHouse.score).toBeGreaterThan(flush.score);
  });
});
