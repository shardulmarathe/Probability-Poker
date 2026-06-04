import type { Card, RankValue, Suit } from "../types";

const SUITS: Suit[] = ["s", "h", "d", "c"];
const RANKS: RankValue[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_TO_CHAR: Record<RankValue, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

export const SUIT_SYMBOL: Record<Suit, string> = {
  s: "\u2660", // spade
  h: "\u2665", // heart
  d: "\u2666", // diamond
  c: "\u2663", // club
};

export const SUIT_IS_RED: Record<Suit, boolean> = {
  s: false,
  h: true,
  d: true,
  c: false,
};

export function rankChar(rank: RankValue): string {
  return RANK_TO_CHAR[rank];
}

export function cardLabel(card: Card): string {
  return `${rankChar(card.rank)}${SUIT_SYMBOL[card.suit]}`;
}

export function makeCard(rank: RankValue, suit: Suit): Card {
  return { rank, suit, id: `${RANK_TO_CHAR[rank]}${suit}` };
}

export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(makeCard(rank, suit));
    }
  }
  return deck;
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle<T>(input: T[]): T[] {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Returns a new deck with the given cards removed. */
export function removeCards(deck: Card[], used: Card[]): Card[] {
  const usedIds = new Set(used.map((c) => c.id));
  return deck.filter((c) => !usedIds.has(c.id));
}
