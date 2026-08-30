/**
 * A scrubbable timeline of one hand.
 *
 * The engine mutates a single `Table` in place, which is right for playing and
 * useless for reviewing: by the time a hand is over, every intermediate state
 * it passed through has been overwritten. A frame is a copy of the parts a
 * reader cares about, taken after each action, so a UI can move back and forth
 * without re-running anything.
 *
 * Frames are taken after `applyAction` returns rather than around it, so a
 * frame includes whatever the engine did in response, the street advancing,
 * the board landing, the pot being settled. Frame 0 is the deal: hole cards
 * out, blinds posted, nobody voluntarily acted yet.
 */

import { encodeCards } from "../core/card";
import type { ActionRecord } from "../table/contract";
import type { Table } from "../table/engine";
import type { SeatStatus } from "../table/state";
import type { Street } from "../../types";

export interface ReplaySeatFrame {
  seat: number;
  name: string;
  /** Hole cards as integer codes, empty before the deal. */
  hole: number[];
  stack: number;
  /** Chips this seat has put in on the current street. */
  streetCommit: number;
  /** Chips this seat has put in over the whole hand. */
  invested: number;
  status: SeatStatus;
}

export interface ReplayFrame {
  /** 0 is the deal; frame `k` is the state after the `k`th action. */
  index: number;
  /**
   * The action that produced this frame, as the engine recorded it, or null on
   * frame 0. Read off the engine rather than copied from the source report, so
   * a simulated line carries records of the same shape as a real one.
   */
  action: ActionRecord | null;
  street: Street;
  board: number[];
  pot: number;
  /** Seat on the clock, or null once the hand is settled. */
  toAct: number | null;
  status: Table["status"];
  seats: ReplaySeatFrame[];
  /** The engine's narration up to this point, in full. */
  log: string[];
}

/** Copy the readable state of a table into a frame. */
export function snapshot(table: Table, index: number): ReplayFrame {
  const last = table.actions[table.actions.length - 1];
  return {
    index,
    action: index === 0 || !last ? null : { ...last },
    street: table.street,
    board: Array.from(encodeCards(table.board)),
    pot: table.pot,
    toAct: table.toAct,
    status: table.status,
    seats: table.seats.map((seat) => ({
      seat: seat.id,
      name: seat.name,
      hole: Array.from(encodeCards(seat.hole)),
      stack: seat.stack,
      streetCommit: seat.streetCommit,
      invested: seat.invested,
      status: seat.status,
    })),
    log: [...table.log],
  };
}

/** The frame a seat's `k`th action produced, or null if it never acted. */
export function frameOfAction(
  frames: ReplayFrame[],
  actionIndex: number
): ReplayFrame | null {
  return frames[actionIndex + 1] ?? null;
}
