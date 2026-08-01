import { describe, expect, it } from "vitest";
import { decodeCard, encodeCard, encodeCards } from "./card";
import { makeDeck } from "../cards";
import { evaluate, scoreInts } from "../handEvaluator";
import type { Card, Suit } from "../../types";

/** The suit order the evaluator has always used; the encoding must preserve it. */
const SUIT_INDEX: Record<Suit, number> = { s: 0, h: 1, d: 2, c: 3 };

const deck = makeDeck();

describe("card encoding", () => {
  it("is a bijection onto 0..51", () => {
    const codes = new Set(deck.map(encodeCard));
    expect(codes.size).toBe(52);
    expect(Math.min(...codes)).toBe(0);
    expect(Math.max(...codes)).toBe(51);
  });

  it("follows (rank - 2) * 4 + suitIndex", () => {
    for (const c of deck) {
      expect(encodeCard(c)).toBe((c.rank - 2) * 4 + SUIT_INDEX[c.suit]);
    }
  });

  it("round trips through decodeCard", () => {
    for (const c of deck) {
      const back = decodeCard(encodeCard(c));
      expect(back.id).toBe(c.id);
      expect(back.rank).toBe(c.rank);
      expect(back.suit).toBe(c.suit);
    }
  });

  it("encodeCards matches encodeCard elementwise", () => {
    const encoded = encodeCards(deck);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(52);
    deck.forEach((c, i) => expect(encoded[i]).toBe(encodeCard(c)));
  });
});

describe("integer fast path agrees with the Card path", () => {
  it("matches evaluate() on 5-, 6- and 7-card hands", () => {
    // Deterministic xorshift so a failure is reproducible.
    let state = 0x2545f491;
    const rnd = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state |= 0;
      return (state >>> 0) / 4294967296;
    };

    const idx = new Uint8Array(52);
    for (let i = 0; i < 52; i++) idx[i] = i;
    const ints = new Uint8Array(7);

    for (let t = 0; t < 50_000; t++) {
      const size = 5 + (t % 3);
      const cards: Card[] = [];
      for (let d = 0; d < size; d++) {
        const j = d + ((rnd() * (52 - d)) | 0);
        const tmp = idx[d];
        idx[d] = idx[j];
        idx[j] = tmp;
        const card = deck[idx[d]];
        cards.push(card);
        ints[d] = encodeCard(card);
      }

      // scoreInts is what the Monte Carlo hot loop actually calls, so this is
      // the assertion that matters: it must agree with the Card path exactly.
      expect(scoreInts(ints, size)).toBe(evaluate(cards).score);
    }
  });
});
