/**
 * What the bots remember about the person sitting at the table.
 *
 * `model/likelihood.ts` defines the estimate. P(action | bucket, street,
 * position, facing) over a six-level backoff, and `model/learn.ts` knows how to
 * accumulate one. Neither of them knows what a hand is. This file is the seam:
 * it turns a finished `TableHandReport` into the observations that model wants,
 * keeps the result across sessions, and hands the decider a `SeatModels` that
 * points the learned estimate at exactly one seat.
 *
 * SCOPE, WHICH IS THE WHOLE DESIGN. A learned model is a claim about one
 * player. This module accumulates one, from one seat's actions, and
 * `seatModelsFor` applies it to that same seat and to nobody else. A bot
 * modelling another bot still gets the data-free prior, because nothing has been
 * observed about that bot, the observations here belong to the human.
 *
 * OFF THE DECISION PATH. A decision only ever *reads* a model, at the same
 * O(levels) cost it has always paid; nothing here is called while a seat is
 * thinking. Recording happens once, when a hand is already over, and the
 * localStorage write is deferred and coalesced (`scheduleSave`) so even that
 * does not land inside a render.
 *
 * Everything read back out of storage is untrusted, in the same sense
 * `tableOptions.ts` and `components/profile/store.ts` mean it: a corrupt value
 * must degrade to "I have observed nothing" rather than throw, because the page
 * reloads into the same stored value and a throw would brick it permanently.
 */

import type { TableHandReport } from "../poker/table/contract";
import { MAX_SEATS, MIN_SEATS, positionOf } from "../poker/table/position";
import { classifyHole, makeBoardContext } from "../poker/model/buckets";
import {
  BOARD_CARDS_AT,
  actionContexts,
  defaultSeatModels,
  modelForSeat,
  type SeatModels,
} from "../poker/model/decider";
import {
  ACTIONS,
  createLikelihoodModel,
  type Bucket,
  type LearnStreet,
  type LikelihoodModel,
  type PriorId,
} from "../poker/model/likelihood";
import {
  modelFromJSON,
  modelStats,
  modelToJSON,
  observeMany,
  type Observation,
} from "../poker/model/learn";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

const STORAGE_KEY = "pp.opponentMemory.v1";

export const MEMORY_VERSION = 1;

/**
 * The root of the backoff, pinned.
 *
 * `decider.OPPONENT_MODEL` is built on `"poker"`, and a model is only comparable
 * to, or mergeable with, one built on the same prior: the prior *is* what the
 * counts are corrections to. A stored model on a different root is an estimate
 * of a different quantity, so it is discarded rather than adopted.
 */
const MEMORY_PRIOR: PriorId = "poker";

/**
 * Hands whose ids are remembered for de-duplication. Matches the archive's
 * `MAX_STORED_HANDS`, so a hand can only be re-recorded once it has fallen out
 * of the archive that would have fed it in again.
 */
export const MAX_TRACKED_HANDS = 400;

/**
 * Ceiling on stored observations. Nothing legitimate approaches it, 400 hands
 * is a few thousand decisions, so a value past it means the row was edited, and
 * counts that large would pin every likelihood at its empirical frequency and
 * make the model unmovable by real play.
 */
const MAX_OBSERVATIONS = 10_000_000;

export interface OpponentMemory {
  version: typeof MEMORY_VERSION;
  /** The accumulating estimate of how the observed seat plays. */
  model: LikelihoodModel;
  /**
   * Deal seeds already folded in, oldest first.
   *
   * Recording is not idempotent, counts add, and the same report reaches this
   * module from more than one direction: the live hand-over effect, and the
   * archive being replayed on load. The deal seed is the closest thing a report
   * carries to an identity (`profile/store.dedupe` keys on it for the same
   * reason), so it is what makes a second pass a no-op.
   */
  seeds: number[];
  updatedAt: number;
}

export function emptyMemory(): OpponentMemory {
  return {
    version: MEMORY_VERSION,
    model: createLikelihoodModel(MEMORY_PRIOR),
    seeds: [],
    updatedAt: 0,
  };
}

export interface MemoryStats {
  /** Hands folded in, what the UI should call "hands observed". */
  hands: number;
  /** Decisions recorded, attributed or not. */
  observations: number;
  /** Of those, decisions from hands that were revealed at showdown. */
  attributed: number;
  /** Of those, decisions from hands whose cards were never seen. */
  unattributed: number;
  /** Non-empty cells across all six backoff levels. */
  cells: number;
}

export function memoryStats(memory: OpponentMemory): MemoryStats {
  return { hands: memory.seeds.length, ...modelStats(memory.model) };
}

// ---------------------------------------------------------------------------
// Turning a finished hand into observations
// ---------------------------------------------------------------------------

/**
 * The seat's hand class as it stood on each street, computed once per street.
 *
 * A flop bet has to be recorded against the flop, not against the river the hand
 * eventually ran out to. This is the same slicing `decider.streetBuckets` does
 * when it reads the model back, and it has to be, or a decision would be
 * *counted* under its river bucket and *looked up* under its flop bucket, a
 * silent mismatch that no test of either side alone would catch. That is why
 * `BOARD_CARDS_AT` is imported rather than restated.
 *
 * It is also why `learn.recordHand` is not used here. `recordHand` shares one
 * bucket across a whole hand, which is right when the bucket is a preflop hand
 * class and wrong once it is board-relative: the same two cards are Air on the
 * flop and a Monster on the river, and the model conditions on which.
 */
function bucketByStreet(
  hole: number[],
  board: number[]
): (street: LearnStreet) => Bucket {
  const cache = new Map<LearnStreet, Bucket>();
  return (street) => {
    let hit = cache.get(street);
    if (hit === undefined) {
      const visible = Math.min(BOARD_CARDS_AT[street], board.length);
      hit = classifyHole(hole[0], hole[1], makeBoardContext(board.slice(0, visible)));
      cache.set(street, hit);
    }
    return hit;
  };
}

const ACTION_SET: ReadonlySet<string> = new Set<string>(ACTIONS);

/**
 * Whether this hand revealed `seat`'s cards.
 *
 * WHAT A FOLD TEACHES, AND WHAT IT DOES NOT. See the long note in `learn.ts`.
 * At a showdown the cards are turned over, so every decision in that hand can be
 * conditioned on the class the player turned out to hold. On a fold they cannot:
 * the hand was mucked, and any bucket assigned to it would be fabricated and
 * would then be laundered through the backoff into a number shown to the player
 * as a fact about their own play. So an unrevealed hand records `bucket: null`,
 * which `learn.observe` writes to the two bucket-free levels and no further.
 *
 * That is not a wasted hand. Those levels are the shrinkage target for every
 * bucket-conditioned one, so folds still move every bucket, together, which
 * compresses the likelihood ratio rather than sharpening it. Learning that a
 * player raises constantly without ever seeing what they raise *with* should
 * make a raise mean less, and it does.
 *
 * The condition is `final !== null`, which the engine sets exactly when the seat
 * was still live at a showdown, not merely `wentToShowdown`, which is true of
 * the whole hand including the seats that folded out of it along the way.
 */
function wasRevealed(report: TableHandReport, seat: number): boolean {
  if (!report.wentToShowdown) return false;
  const result = report.seats.find((s) => s.seat === seat);
  return !!result && result.final !== null && result.hole.length === 2;
}

/**
 * Every decision `seat` took in one finished hand, in the form the model
 * records: action, hand class (or null), street, position, facing.
 *
 * Pure, it allocates and returns, and touches no model. That is deliberate:
 * `observe` validates strictly and throws, and a half-written model would be
 * worse than a dropped hand, so the whole list is built before any of it is
 * committed.
 */
export function handObservations(
  report: TableHandReport,
  seat: number
): Observation[] {
  const seatCount = report.seatCount;
  // `positionOf` throws on a table size or seat it cannot lay out, and this is
  // reachable from an archived report that predates a change to either.
  if (!Number.isInteger(seatCount) || seatCount < MIN_SEATS || seatCount > MAX_SEATS) {
    return [];
  }
  if (!Number.isInteger(seat) || seat < 0 || seat >= seatCount) return [];
  if (
    !Number.isInteger(report.button) ||
    report.button < 0 ||
    report.button >= seatCount
  ) {
    return [];
  }
  if (!Array.isArray(report.actions)) return [];

  const position = positionOf(seat, report.button, seatCount);
  const revealed = wasRevealed(report, seat);
  const hole = report.seats.find((s) => s.seat === seat)?.hole ?? [];
  const bucketAt = revealed
    ? bucketByStreet(hole, report.board ?? [])
    : () => null;

  const contexts = actionContexts(report.actions);
  const out: Observation[] = [];
  for (let i = 0; i < report.actions.length; i++) {
    const record = report.actions[i];
    if (record.seat !== seat) continue;
    // A record carrying an action this build does not know is dropped on its
    // own rather than taking the hand with it: each decision is an independent
    // draw at its own node, so the rest of the hand is still good evidence.
    if (!ACTION_SET.has(record.action)) continue;
    const { street, facing } = contexts[i];
    out.push({ action: record.action, bucket: bucketAt(street), street, position, facing });
  }
  return out;
}

/**
 * Fold one finished hand into the memory, in place.
 *
 * In place because that is `learn.ts`'s convention for accumulation onto a model
 * you already own. Returns the number of decisions recorded, 0 for a hand
 * already seen, and also 0 for a hand the seat never acted in, which are the
 * same thing as far as the model is concerned.
 */
export function recordReport(
  memory: OpponentMemory,
  report: TableHandReport,
  seat: number
): number {
  const id = report.seed;
  if (typeof id !== "number" || !Number.isFinite(id)) return 0;
  if (memory.seeds.includes(id)) return 0;

  const observations = handObservations(report, seat);
  observeMany(memory.model, observations);

  memory.seeds.push(id);
  if (memory.seeds.length > MAX_TRACKED_HANDS) {
    memory.seeds.splice(0, memory.seeds.length - MAX_TRACKED_HANDS);
  }
  return observations.length;
}

/** Fold a whole archive in, oldest first. Returns decisions recorded. */
export function recordReports(
  memory: OpponentMemory,
  reports: TableHandReport[],
  seat: number
): number {
  let n = 0;
  for (const report of reports) n += recordReport(memory, report, seat);
  return n;
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

/**
 * The learned model, pointed at the one seat it describes.
 *
 * `seat` is the human's. A null seat is observer mode, nobody at the table is
 * the person this memory is about, and every seat falls back to the prior.
 *
 * An empty memory is not merely *close* to the default, it is the default:
 * `betaMean(0, 0, m)` is exactly `m`, so a model with no cells cannot move a
 * single lookup at any level of the backoff. `decider.test.ts` asserts that a
 * whole session plays out bit-identically through one.
 */
export function seatModelsFor(
  seat: number | null,
  memory: OpponentMemory
): SeatModels {
  return seat === null ? defaultSeatModels : modelForSeat(seat, memory.model);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Clamp anything from storage back into a usable memory, or start over. */
export function normalizeMemory(raw: unknown): OpponentMemory {
  if (!raw || typeof raw !== "object") return emptyMemory();
  const r = raw as Record<string, unknown>;
  if (r.version !== MEMORY_VERSION) return emptyMemory();

  let model: LikelihoodModel;
  try {
    // The only paranoid reader in the chain, by design, see `learn.ts`.
    model = modelFromJSON(r.model);
  } catch {
    return emptyMemory();
  }
  if (model.prior !== MEMORY_PRIOR) return emptyMemory();
  if (model.observations > MAX_OBSERVATIONS) return emptyMemory();

  const seeds: number[] = [];
  if (Array.isArray(r.seeds)) {
    for (const value of r.seeds) {
      if (typeof value === "number" && Number.isFinite(value)) seeds.push(value);
    }
  }

  return {
    version: MEMORY_VERSION,
    model,
    seeds: seeds.slice(-MAX_TRACKED_HANDS),
    updatedAt:
      typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt)
        ? r.updatedAt
        : 0,
  };
}

export function loadMemory(): OpponentMemory {
  if (typeof window === "undefined") return emptyMemory();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyMemory();
    return normalizeMemory(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage must never block sitting down.
    return emptyMemory();
  }
}

export function saveMemory(memory: OpponentMemory): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: MEMORY_VERSION,
        // Sorted key order, so two sessions that saw the same hands store the
        // same bytes and a stored row stays diffable.
        model: modelToJSON(memory.model),
        seeds: memory.seeds.slice(-MAX_TRACKED_HANDS),
        updatedAt: Date.now(),
      })
    );
  } catch {
    /* private browsing / quota, the memory just will not persist */
  }
}

/** Forget everything and clear the stored copy. */
export function clearMemory(): OpponentMemory {
  pending = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  }
  return emptyMemory();
}

// ---------------------------------------------------------------------------
// Deferred writes
// ---------------------------------------------------------------------------
//
// Serialising ~600 cells and handing them to localStorage is a synchronous main
// thread write. It is small, but it is not zero, and it has no business
// happening inside the effect that ends a hand. Deferring it past the current
// task keeps the rule that learning never sits between a player and a decision;
// coalescing means a burst of hands costs one write rather than one each.

let pending: OpponentMemory | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSave(memory: OpponentMemory): void {
  pending = memory;
  if (timer !== null) return;
  timer = setTimeout(flushMemoryWrites, 0);
}

/** Write any deferred memory now. Idempotent; safe to call on unload. */
export function flushMemoryWrites(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const memory = pending;
  pending = null;
  if (memory) saveMemory(memory);
}
