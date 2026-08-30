/**
 * Seat positions and acting order for an N-handed table.
 *
 * Seats are indexed 0..n-1 in clockwise seating order and the button is a seat
 * index, so "one seat later" is always `(i + 1) % n`. Everything else, who
 * posts which blind, who acts first on each street, is derived from the button
 * rather than stored, which keeps rotation to a single `button++`.
 *
 * Heads-up is the case that is usually gotten wrong, and it is special twice
 * over: the button posts the small blind (not the big), and it acts first
 * preflop but last on every later street. Three-handed and up, the blinds sit
 * immediately left of the button and the small blind leads postflop.
 */

import type { Street } from "../../types";

export type PositionName = "BTN" | "SB" | "BB" | "UTG" | "HJ" | "CO";

/**
 * Position label by seat offset from the button, per table size.
 *
 * A lookup beats deriving it: the naming convention is not a clean formula
 * (heads-up has no SB seat of its own, and the middle seats pick up names in a
 * fixed order as the table grows), and the tables are small enough to read.
 * At four-handed the single non-blind, non-button seat is first to act preflop,
 * so it is named UTG; it is equivalently the cutoff.
 */
const LAYOUT: Record<number, PositionName[]> = {
  2: ["BTN", "BB"],
  3: ["BTN", "SB", "BB"],
  4: ["BTN", "SB", "BB", "UTG"],
  5: ["BTN", "SB", "BB", "UTG", "CO"],
  6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
};

export const MIN_SEATS = 2;
export const MAX_SEATS = 6;

function assertSeatCount(n: number): void {
  if (!LAYOUT[n]) {
    throw new Error(`unsupported table size: ${n} (expected ${MIN_SEATS}-${MAX_SEATS})`);
  }
}

/** Seats in clockwise order starting from `from`, inclusive. */
export function seatsFrom(from: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (from + i) % n);
}

export function positionOf(seat: number, button: number, n: number): PositionName {
  assertSeatCount(n);
  return LAYOUT[n][(seat - button + n) % n];
}

/**
 * Who posts the blinds. Heads-up the button is the small blind; otherwise the
 * blinds are the next two seats clockwise.
 */
export function blindSeats(button: number, n: number): { sb: number; bb: number } {
  assertSeatCount(n);
  return n === 2
    ? { sb: button, bb: (button + 1) % n }
    : { sb: (button + 1) % n, bb: (button + 2) % n };
}

/**
 * The seat that opens the betting on a street, ignoring folds and all-ins -
 * callers skip inactive seats themselves.
 *
 * Preflop the action starts left of the big blind, so the blinds act last and
 * the big blind gets the option. On every later street it starts left of the
 * button, so the button closes. Heads-up inverts preflop: with only two seats,
 * "left of the big blind" is the button itself.
 */
export function firstToAct(street: Street, button: number, n: number): number {
  assertSeatCount(n);
  const { sb, bb } = blindSeats(button, n);
  if (street === "preflop") return n === 2 ? button : (bb + 1) % n;
  return n === 2 ? bb : sb;
}

/** Full clockwise acting order for a street, ignoring folds and all-ins. */
export function actingOrder(street: Street, button: number, n: number): number[] {
  return seatsFrom(firstToAct(street, button, n), n);
}

/**
 * Order used to hand out indivisible chips when a pot is split: the first seat
 * left of the button. Standard casino rule, and it has to be deterministic or
 * split pots would not be reproducible from a seed.
 */
export function oddChipOrder(button: number, n: number): number[] {
  assertSeatCount(n);
  return seatsFrom((button + 1) % n, n);
}
