import { makeCard } from "../cards";
import type { Card, RankValue, Suit } from "../../types";

/**
 * Integer card encoding: `(rank - 2) * 4 + suitIndex`, so 0..51.
 *
 * The suit order (s, h, d, c) is the one the evaluator has always used, which
 * keeps the encoding drop-in compatible with anything that already indexes by
 * it. Rank in the high bits means `n >> 2` is the rank offset and `n & 3` the
 * suit — both single instructions, which is the whole point of this module.
 */
const SUIT_INDEX: Record<Suit, number> = { s: 0, h: 1, d: 2, c: 3 };
const SUITS: Suit[] = ["s", "h", "d", "c"];

/** All 52 cards, indexed by their integer code. Lets `decodeCard` be a load. */
const DECK: Card[] = [];
for (let n = 0; n < 52; n++) {
  DECK.push(makeCard(((n >> 2) + 2) as RankValue, SUITS[n & 3]));
}

export function encodeCard(card: Card): number {
  return ((card.rank - 2) << 2) | SUIT_INDEX[card.suit];
}

/**
 * The shared `Card` instance for this code — callers must treat it as frozen.
 * Nothing in the app mutates cards, and copying here would defeat the purpose.
 */
export function decodeCard(n: number): Card {
  return DECK[n];
}

export function encodeCards(cards: Card[]): Uint8Array {
  const out = new Uint8Array(cards.length);
  for (let i = 0; i < cards.length; i++) out[i] = encodeCard(cards[i]);
  return out;
}
