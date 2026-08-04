/**
 * Rebuilding the table a recorded hand was played on.
 *
 * A `TableHandReport` is not quite a complete description of its own table. It
 * carries the seed, the button, the seat count and everything that happened,
 * but not the blinds and not the stacks anybody sat down with. Both are needed
 * before the engine can be asked to deal the hand again, so both are recovered
 * here, the blinds exactly (they are implied by the first preflop record), the
 * stacks only as far as they matter.
 *
 * "As far as they matter" is the interesting half. Entry stacks are genuinely
 * not recoverable: a seat that finished with chips could have started with any
 * amount above what it put in. What *is* recoverable is the only thing the
 * lifecycle reads them for, whether a seat ran out. A seat recorded `allin`
 * started with exactly its `invested`; every other seat started with strictly
 * more, and any such value replays identically, because each of its recorded
 * costs is then affordable and none of its legal actions is capped. So the
 * all-in seats are pinned and the rest are given a plausible stack, and the
 * fidelity check in `reconstruct.ts` is what proves the distinction was drawn
 * in the right place.
 */

import type { SeatSetup, Table } from "../table/engine";
import { createTable } from "../table/engine";
import type { TableHandReport } from "../table/contract";
import { blindSeats, MAX_SEATS, MIN_SEATS } from "../table/position";
import type { TableConfig } from "../table/rules";
import { sessionSeedForHand } from "./seed";

/** Blinds used when a report is too degenerate to imply its own. */
export const FALLBACK_BLINDS: TableConfig = { smallBlind: 5, bigBlind: 10 };

/** Stack depth, in big blinds, given to seats whose entry stack is unknown. */
export const ASSUMED_DEPTH_BB = 100;

export interface ReplaySeatSetup {
  name?: string;
  /** Bot archetype id. Only read when a replay asks bots to decide. */
  profile?: string;
  kind?: "human" | "bot";
}

export interface ReplayTableOptions {
  /**
   * The blinds the hand was played at. Supply them when known, the live table
   * always is. Omitted, they are inferred from the first preflop record.
   */
  config?: TableConfig;
  /** Entry stack for seats that did not go all-in. See the module comment. */
  startingStack?: number;
  /**
   * Exact entry stacks, overriding everything above. `replayHand` uses this to
   * feed back the stacks it recovered from the record on an earlier pass.
   */
  stacks?: number[];
  seats?: ReplaySeatSetup[];
}

/**
 * Why a report cannot be replayed at all, or null when it can be.
 *
 * Reports reaching this can come from localStorage, so nothing about their
 * shape is assumed. A report that fails here is skipped; one that passes may
 * still fail the fidelity check, which is a different and louder problem.
 */
export function replayBlocker(report: TableHandReport): string | null {
  if (!report || typeof report !== "object") return "not a hand report";
  const n = report.seatCount;
  if (!Number.isInteger(n) || n < MIN_SEATS || n > MAX_SEATS) {
    return `seat count ${String(n)} outside ${MIN_SEATS}-${MAX_SEATS}`;
  }
  if (!Number.isInteger(report.button) || report.button < 0 || report.button >= n) {
    return `button ${String(report.button)} is not a seat`;
  }
  if (!Number.isFinite(report.seed)) return "no deal seed";
  if (!Array.isArray(report.seats) || report.seats.length !== n) {
    return `${report.seats?.length ?? 0} seat results for ${n} seats`;
  }
  if (!Array.isArray(report.actions)) return "no action list";
  for (const seat of report.seats) {
    if (!Number.isInteger(seat.seat) || seat.seat < 0 || seat.seat >= n) {
      return `seat result ${String(seat.seat)} is not a seat`;
    }
    if (!Number.isFinite(seat.invested) || seat.invested < 0) {
      return `seat ${seat.seat} invested ${String(seat.invested)}`;
    }
  }
  for (const action of report.actions) {
    if (!Number.isInteger(action.seat) || action.seat < 0 || action.seat >= n) {
      return `action by seat ${String(action.seat)}, which is not a seat`;
    }
    if (!Number.isFinite(action.cost) || action.cost < 0) {
      return `action costing ${String(action.cost)}`;
    }
  }
  return null;
}

/**
 * The blinds implied by the first preflop record.
 *
 * At the moment the first seat acts the pot holds exactly the two blinds, and
 * what that seat owes is the big blind less whatever it already posted. Three-
 * handed and up the opener posted nothing, so its `toCall` *is* the big blind;
 * heads-up the opener is the small blind, and the two facts give a pair of
 * equations instead.
 *
 * Returns the fallback rather than a wrong answer whenever the arithmetic does
 * not come out whole, a blind posted short by an already-crippled stack breaks
 * the premise, and a silently wrong blind would produce a hand that replays
 * *almost* correctly, which is worse than one that visibly does not.
 */
export function inferBlinds(report: TableHandReport): TableConfig {
  const first = report.actions.find((a) => a.street === "preflop");
  if (!first) return FALLBACK_BLINDS;

  const { sb: sbSeat } = blindSeats(report.button, report.seatCount);
  const pot = first.potBefore;
  const owed = first.toCall;

  // Heads-up the button posts the small blind and opens the action.
  const bigBlind =
    report.seatCount === 2 && first.seat === sbSeat ? (pot + owed) / 2 : owed;
  const smallBlind = pot - bigBlind;

  const sane =
    Number.isInteger(smallBlind) &&
    Number.isInteger(bigBlind) &&
    smallBlind > 0 &&
    bigBlind >= smallBlind;
  return sane ? { smallBlind, bigBlind } : FALLBACK_BLINDS;
}

/** A supplied config, or the inferred one when it is unusable. */
export function resolveConfig(
  report: TableHandReport,
  config?: TableConfig
): TableConfig {
  if (
    config &&
    Number.isInteger(config.smallBlind) &&
    Number.isInteger(config.bigBlind) &&
    config.smallBlind > 0 &&
    config.bigBlind >= config.smallBlind
  ) {
    return { smallBlind: config.smallBlind, bigBlind: config.bigBlind };
  }
  return inferBlinds(report);
}

/**
 * Entry stacks: exact for the seats that ran out, plausible for the rest.
 *
 * The `+ 1` on the floor is load-bearing. A seat given exactly its `invested`
 * would be marked all-in the moment it finished paying, which changes both the
 * side-pot layout and whether the round is closed, so a seat that did *not*
 * bust must start with strictly more than it spent.
 */
export function entryStacks(
  report: TableHandReport,
  assumed: number
): number[] {
  return report.seats.map((seat) =>
    seat.status === "allin"
      ? Math.max(1, seat.invested)
      : Math.max(assumed, seat.invested + 1)
  );
}

/** Stack depth to assume when the caller does not know it. */
function assumedStack(report: TableHandReport, config: TableConfig): number {
  const deepest = report.seats.reduce((n, s) => Math.max(n, s.invested), 0);
  return Math.max(ASSUMED_DEPTH_BB * config.bigBlind, deepest * 2, config.bigBlind);
}

export interface ReplayTable {
  table: Table;
  config: TableConfig;
  /** Entry stack given to each seat. */
  stacks: number[];
  /** Session seed the table was built on, see `seed.ts`. */
  sessionSeed: number;
  handNumber: number;
}

/**
 * A table positioned so that one `startHand` deals exactly this report's hand.
 *
 * `startHand` rotates the button and increments the hand number before dealing,
 * so both are set one step behind. Stacks are written after `createTable`
 * because it takes a single depth for the whole table and these differ per seat.
 */
export function buildReplayTable(
  report: TableHandReport,
  options: ReplayTableOptions = {}
): ReplayTable {
  const blocker = replayBlocker(report);
  if (blocker) throw new Error(`cannot replay hand: ${blocker}`);

  const n = report.seatCount;
  const config = resolveConfig(report, options.config);
  const assumed =
    options.startingStack !== undefined &&
    Number.isFinite(options.startingStack) &&
    options.startingStack > 0
      ? Math.round(options.startingStack)
      : assumedStack(report, config);
  const given = options.stacks;
  const stacks =
    given &&
    given.length === n &&
    given.every((s) => Number.isInteger(s) && s > 0)
      ? [...given]
      : entryStacks(report, assumed);

  // Hand numbers are 1-based; `startHand` will take this to `handNumber`.
  const handNumber = Number.isInteger(report.handNumber) && report.handNumber > 0
    ? report.handNumber
    : 1;
  const sessionSeed = sessionSeedForHand(report.seed, handNumber);

  const seats: SeatSetup[] = Array.from({ length: n }, (_, id) => ({
    name: options.seats?.[id]?.name ?? (id === 0 ? "You" : `Seat ${id + 1}`),
    kind: options.seats?.[id]?.kind ?? (id === 0 ? "human" : "bot"),
    profile: options.seats?.[id]?.profile,
  }));

  const table = createTable({
    seatCount: n,
    startingStack: Math.max(...stacks),
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    seed: sessionSeed,
    seats,
  });

  table.handNumber = handNumber - 1;
  table.button = (report.button - 1 + n) % n;
  for (let id = 0; id < n; id++) table.seats[id].stack = stacks[id];

  return { table, config, stacks, sessionSeed, handNumber };
}
