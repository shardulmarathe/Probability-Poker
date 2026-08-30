/**
 * Seat-indexed table state for an N-handed game.
 *
 * This replaces the heads-up `GameState`, where every quantity was a
 * `Record<"player" | "bot", ...>` and "the other player" was a function call.
 * With three or more seats those assumptions all break: there is no single
 * opponent, a street ends when action returns to the last aggressor rather than
 * when both sides have acted, and unequal stacks split the pot into layers.
 *
 * Everything here is mechanics, seats, chips, whose turn it is, when a betting
 * round closes. Legal action sets live in `rules/`, pot layout in `pots.ts`,
 * and the hand lifecycle on top of both.
 */

import type { Card, Street } from "../../types";
import { blindSeats, firstToAct, seatsFrom } from "./position";

export type SeatStatus = "active" | "folded" | "allin" | "out";

export interface TableSeat {
  id: number;
  name: string;
  kind: "human" | "bot";
  /** Bot personality key; undefined for humans. */
  profile?: string;
  stack: number;
  hole: Card[];
  status: SeatStatus;
  /** Chips committed on the current street. */
  streetCommit: number;
  /** Chips committed across the whole hand, drives the side-pot layers. */
  invested: number;
  /**
   * Whether this seat has acted since the last aggression. Posting a blind does
   * not count, which is what gives the big blind its option when everyone limps.
   */
  hasActed: boolean;
  /**
   * Whether this seat may still raise, as opposed to only call or fold.
   *
   * These come apart in No-Limit: an all-in for less than a full raise does
   * not reopen the betting. Seats that already acted still owe the extra chips,
   * so they must act again, but they are not allowed to re-raise. `hasActed`
   * alone cannot express that, because it would either skip them (wrong, they
   * owe chips) or hand them a raise they are not entitled to.
   */
  mayRaise: boolean;
}

export interface TableState {
  /** Session seed; each hand derives its own from this and the hand number. */
  seed: number;
  handNumber: number;
  seats: TableSeat[];
  button: number;
  street: Street;
  deck: Card[];
  board: Card[];
  /** Chips a seat must have in on this street to continue. */
  currentBet: number;
  /**
   * Size of the last bet or raise on this street. No-Limit requires a raise to
   * be at least this large again, so it has to be tracked separately from
   * `currentBet`.
   */
  lastRaiseSize: number;
  /** Last seat to bet or raise; action closes when it returns to them. */
  lastAggressor: number | null;
  toAct: number | null;
  /** Total chips committed this hand, for display. */
  pot: number;
  log: string[];
  status: "playing" | "hand-over" | "game-over";
}

// ---------------------------------------------------------------------------
// Seat queries
// ---------------------------------------------------------------------------

/** Seats that can still voluntarily act. All-in seats cannot. */
export function actingSeats(state: TableState): TableSeat[] {
  return state.seats.filter((s) => s.status === "active");
}

/** Seats that can still win a pot, active or all-in, but not folded or out. */
export function contestingSeats(state: TableState): TableSeat[] {
  return state.seats.filter((s) => s.status === "active" || s.status === "allin");
}

export function seatOf(state: TableState, id: number): TableSeat {
  const seat = state.seats[id];
  if (!seat) throw new Error(`no seat ${id}`);
  return seat;
}

/** What `seat` must add to match the current bet. */
export function toCall(state: TableState, id: number): number {
  const seat = seatOf(state, id);
  return Math.max(0, Math.min(state.currentBet - seat.streetCommit, seat.stack));
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/**
 * Move chips from a seat's stack into the pot, clamping to the stack. A seat
 * that commits its last chip becomes all-in and stops being asked to act.
 */
export function commitChips(state: TableState, id: number, amount: number): number {
  const seat = seatOf(state, id);
  const paid = Math.max(0, Math.min(amount, seat.stack));
  seat.stack -= paid;
  seat.streetCommit += paid;
  seat.invested += paid;
  state.pot += paid;
  if (seat.stack === 0 && seat.status === "active") seat.status = "allin";
  return paid;
}

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

/**
 * The next seat clockwise from `from` that can still act, or null if none can.
 * `from` itself is never returned.
 */
export function nextToAct(state: TableState, from: number): number | null {
  const n = state.seats.length;
  // Stops before wrapping back to `from`: when it is the only seat left able to
  // act there is no next actor, and returning `from` would spin the engine.
  for (let i = 1; i < n; i++) {
    const id = (from + i) % n;
    if (state.seats[id].status === "active") return id;
  }
  return null;
}

/** First seat that can act on this street, following the positional order. */
export function openingActor(state: TableState): number | null {
  const n = state.seats.length;
  const start = firstToAct(state.street, state.button, n);
  for (const id of seatsFrom(start, n)) {
    if (state.seats[id].status === "active") return id;
  }
  return null;
}

/**
 * Whether the current betting round is complete.
 *
 * A round closes when every seat that can still act has both matched the
 * current bet and acted since the last aggression. The `hasActed` flag is what
 * distinguishes "checked around" from "has not been asked yet", and it is why
 * the big blind still gets its option after a round of limps: posting the blind
 * left `hasActed` false even though `streetCommit` already equals `currentBet`.
 *
 * With nobody able to act the round is trivially closed. A single seat able
 * to act is NOT enough on its own: preflop, one live seat facing an unmatched
 * blind still owes a decision. It closes only once that seat has acted and
 * matched, like any other. The "everyone else is all-in, run the board out"
 * shortcut belongs to the caller, after `resetStreetBetting` has cleared the
 * debts, not here.
 */
export function bettingClosed(state: TableState): boolean {
  return actingSeats(state).every(
    (s) => s.hasActed && s.streetCommit === state.currentBet
  );
}

/** True when everyone but one seat has folded, the hand ends without showdown. */
export function onlyOneLeft(state: TableState): boolean {
  return contestingSeats(state).length <= 1;
}

// ---------------------------------------------------------------------------
// Street transitions
// ---------------------------------------------------------------------------

/**
 * Clear per-street betting. Called when a street ends; `invested` deliberately
 * survives because the side-pot layers are computed from whole-hand totals.
 */
export function resetStreetBetting(state: TableState): void {
  for (const seat of state.seats) {
    seat.streetCommit = 0;
    seat.hasActed = false;
    seat.mayRaise = true;
  }
  state.currentBet = 0;
  state.lastRaiseSize = 0;
  state.lastAggressor = null;
}

/**
 * Mark a seat as having acted.
 *
 * `increment` is how much the bet level went up (null for a check, call, or
 * fold). A bet or raise puts everyone else back in the decision, but it only
 * reopens their right to raise if it was a full-sized raise. A short all-in
 * that raises by less than the last raise leaves already-acted seats owing the
 * difference with no option to re-raise, which is the standard rule.
 */
export function recordAction(
  state: TableState,
  id: number,
  increment: number | null
): void {
  const seat = seatOf(state, id);
  seat.hasActed = true;
  if (increment === null) return;

  const full = increment >= state.lastRaiseSize;
  for (const other of state.seats) {
    if (other.id === id || other.status !== "active") continue;
    const hadActed = other.hasActed;
    other.hasActed = false;
    if (full) {
      other.mayRaise = true;
    } else if (hadActed) {
      // Already acted at the old level, and this jam was undersized: they owe
      // the difference but have lost the right to raise. A seat that had not
      // acted yet is unaffected, its first action can still be a raise.
      other.mayRaise = false;
    }
  }

  state.lastAggressor = id;
  // Only a full raise raises the bar for the next one. An undersized all-in
  // leaves the previous raise size standing.
  if (full) state.lastRaiseSize = increment;
}

/** Post the blinds for a fresh hand and return the seat that opens the action. */
export function postBlinds(
  state: TableState,
  smallBlind: number,
  bigBlind: number
): void {
  const n = state.seats.length;
  const { sb, bb } = blindSeats(state.button, n);
  commitChips(state, sb, smallBlind);
  commitChips(state, bb, bigBlind);

  state.currentBet = Math.max(
    state.seats[sb].streetCommit,
    state.seats[bb].streetCommit
  );
  // The big blind is the standing raise size preflop: a re-raise must be at
  // least one big blind more again.
  state.lastRaiseSize = bigBlind;
  // Blinds are forced, so neither seat has acted voluntarily yet.
  state.seats[sb].hasActed = false;
  state.seats[bb].hasActed = false;
  for (const seat of state.seats) seat.mayRaise = true;
  state.lastAggressor = null;

  state.toAct = openingActor(state);
}

/** Total chips on the table, the invariant every engine test asserts. */
export function totalChips(state: TableState): number {
  return state.seats.reduce((n, s) => n + s.stack, 0) + state.pot;
}
