import { describe, expect, it } from "vitest";
import { makeCard, makeDeck, removeCards } from "./cards";

describe("makeDeck", () => {
  it("returns 52 unique cards covering every rank and suit", () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
    expect(new Set(deck.map((c) => c.suit)).size).toBe(4);
    expect(new Set(deck.map((c) => c.rank)).size).toBe(13);
    for (const suit of ["s", "h", "d", "c"] as const) {
      expect(deck.filter((c) => c.suit === suit)).toHaveLength(13);
    }
  });

  it("returns a fresh array each call", () => {
    expect(makeDeck()).not.toBe(makeDeck());
  });
});

describe("removeCards", () => {
  it("removes the given cards and leaves the input untouched", () => {
    const deck = makeDeck();
    const used = [makeCard(14, "s"), makeCard(2, "c"), makeCard(10, "d")];
    const left = removeCards(deck, used);

    expect(left).toHaveLength(49);
    expect(deck).toHaveLength(52);
    for (const card of used) {
      expect(left.some((c) => c.id === card.id)).toBe(false);
    }
  });

  it("matches on card identity, not object identity", () => {
    // A structurally equal card built separately must still be removed.
    expect(removeCards(makeDeck(), [makeCard(13, "h")])).toHaveLength(51);
  });

  it("is a no-op when nothing is used", () => {
    expect(removeCards(makeDeck(), [])).toHaveLength(52);
  });
});

// Shuffling moved to `core/rng.ts` and is covered by rng.test.ts.
