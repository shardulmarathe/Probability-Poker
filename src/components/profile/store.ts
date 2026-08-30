/**
 * The player profile's own copy of the hand history.
 *
 * `TableContext` holds the session's hands, and loses them the moment the tab
 * reloads. The profile is a record of how somebody plays, which is only worth
 * anything across sessions, so it keeps its own archive in localStorage.
 *
 * Everything read back out is untrusted, and the normalisation below is not
 * defensive programming for its own sake. A stored report drives `createTable`
 * (through the replay) and `positionOf` (through the tracker), and both throw
 * on out-of-range input, a seat count of 9, a button that is not a seat. A
 * throw there is a white screen on a page that reloads into the same stored
 * value, so the bad hand would brick the profile permanently. Anything that
 * does not normalise cleanly is dropped, and the rest of the archive survives.
 *
 * Bot decisions are deliberately not persisted. They are the largest part of a
 * report by an order of magnitude, a Monte Carlo audit trail per move, and
 * nothing the profile computes reads them: `computeStats`, `classifyStats` and
 * `analyzeHands` all work from `actions`, `seats`, `pots` and the board.
 *
 * The scripted demo has its own namespace rather than merging into the player
 * archive because the profile's entire claim is "this is how YOU play". Mixing
 * in 60 hands from a scripted driver would make the style verdict and every
 * leak figure a lie.
 */

import type { ActionType, Street } from "../../types";
import { HAND_CATEGORY_NAMES, HandCategory } from "../../types";
import type {
  ActionRecord,
  PotRecord,
  SeatResult,
  TableHandReport,
} from "../../poker/table/contract";
import { MAX_SEATS, MIN_SEATS } from "../../poker/table/position";
import type { SeatStatus } from "../../poker/table/state";

export type ArchiveScope = "player" | "demo";

const STORAGE_KEYS: Record<ArchiveScope, string> = {
  player: "pp.profile.v1",
  demo: "pp.demo.v1",
};

let archiveScope: ArchiveScope = "player";

export function setArchiveScope(scope: ArchiveScope): void {
  archiveScope = scope;
}

export function getArchiveScope(): ArchiveScope {
  return archiveScope;
}

function storageKey(): string {
  return STORAGE_KEYS[archiveScope];
}

/**
 * Hands kept. Roughly 1.5 KB each once decisions are stripped, so the whole
 * archive stays comfortably inside a 5 MB quota, and the tracker's confidence
 * curve has long since flattened by here (`CONFIDENCE_HALF_HANDS` is 100).
 */
export const MAX_STORED_HANDS = 400;

export interface ProfileArchive {
  /** Finished hands, oldest first. */
  hands: TableHandReport[];
  /** Blinds the hands were played at, the report does not carry them. */
  smallBlind: number;
  bigBlind: number;
  /** The seat the player occupied. Null while watching the bots. */
  heroSeat: number | null;
  updatedAt: number;
}

const EMPTY_ARCHIVE: ProfileArchive = {
  hands: [],
  smallBlind: 5,
  bigBlind: 10,
  heroSeat: 0,
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const STREETS: ReadonlySet<string> = new Set([
  "preflop",
  "flop",
  "turn",
  "river",
  "showdown",
]);
const ACTION_TYPES: ReadonlySet<string> = new Set([
  "fold",
  "check",
  "call",
  "bet",
  "raise",
]);
const SEAT_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "folded",
  "allin",
  "out",
]);

/** A whole number within bounds, or null. Strings from JSON are rejected. */
function whole(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** A finite number within bounds, or null. */
function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

/** A list of distinct card codes of exactly one of the allowed lengths. */
function cardList(value: unknown, lengths: number[]): number[] | null {
  if (!Array.isArray(value) || !lengths.includes(value.length)) return null;
  const out: number[] = [];
  for (const code of value) {
    const card = whole(code, 0, 51);
    if (card === null || out.includes(card)) return null;
    out.push(card);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function normalizeSeat(raw: unknown, seatCount: number): SeatResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const seat = whole(r.seat, 0, seatCount - 1);
  if (seat === null) return null;

  // A seat that was dealt in holds two cards; one that was not holds none.
  const hole = cardList(r.hole, [0, 2]);
  if (hole === null) return null;

  const invested = finite(r.invested, 0, Number.MAX_SAFE_INTEGER);
  const won = finite(r.won, 0, Number.MAX_SAFE_INTEGER);
  if (invested === null || won === null) return null;

  const status = typeof r.status === "string" && SEAT_STATUSES.has(r.status)
    ? (r.status as SeatStatus)
    : null;
  if (!status) return null;

  // `net` is derived, so a stored value that disagrees with its own components
  // means the record was edited; recompute rather than trust it.
  const net = won - invested;

  let final: SeatResult["final"] = null;
  if (r.final && typeof r.final === "object") {
    const f = r.final as Record<string, unknown>;
    const category = whole(f.category, HandCategory.HighCard, HandCategory.StraightFlush);
    const score = finite(f.score, 0, Number.MAX_SAFE_INTEGER);
    if (category !== null && score !== null) {
      final = {
        category: category as HandCategory,
        score,
        // Re-derived rather than read: a stored name that disagrees with its
        // own category would print a lie next to the cards that disprove it.
        name: HAND_CATEGORY_NAMES[category as HandCategory],
      };
    }
  }

  return { seat, hole, final, invested, won, net, status };
}

function normalizeAction(raw: unknown, seatCount: number): ActionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const seat = whole(r.seat, 0, seatCount - 1);
  const cost = finite(r.cost, 0, Number.MAX_SAFE_INTEGER);
  const potBefore = finite(r.potBefore, 0, Number.MAX_SAFE_INTEGER);
  const toCall = finite(r.toCall, 0, Number.MAX_SAFE_INTEGER);
  if (seat === null || cost === null || potBefore === null || toCall === null) {
    return null;
  }
  if (typeof r.street !== "string" || !STREETS.has(r.street)) return null;
  if (typeof r.action !== "string" || !ACTION_TYPES.has(r.action)) return null;

  return {
    seat,
    street: r.street as Street,
    action: r.action as ActionType,
    cost,
    potBefore,
    toCall,
  };
}

function normalizePot(raw: unknown, seatCount: number): PotRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const amount = finite(r.amount, 0, Number.MAX_SAFE_INTEGER);
  if (amount === null) return null;

  const seats = (value: unknown): number[] | null => {
    if (!Array.isArray(value)) return null;
    const out: number[] = [];
    for (const id of value) {
      const seat = whole(id, 0, seatCount - 1);
      if (seat === null) return null;
      out.push(seat);
    }
    return out;
  };

  const eligible = seats(r.eligible);
  const winners = seats(r.winners);
  if (!eligible || !winners) return null;
  return { amount, eligible, winners };
}

/**
 * One stored hand, or null if it cannot be trusted.
 *
 * The card-uniqueness check at the end is not paranoia about the engine, which
 * cannot deal a duplicate. It guards the equity samplers in `analyzeHands`,
 * which build a deck by removing the known cards: a repeated card leaves the
 * deck one short of what the sampler expects to draw from.
 */
export function normalizeReport(raw: unknown): TableHandReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const seatCount = whole(r.seatCount, MIN_SEATS, MAX_SEATS);
  if (seatCount === null) return null;

  const handNumber = whole(r.handNumber, 1, Number.MAX_SAFE_INTEGER);
  const button = whole(r.button, 0, seatCount - 1);
  const seed = whole(r.seed, 0, 0xffffffff);
  if (handNumber === null || button === null || seed === null) return null;

  const board = cardList(r.board, [0, 3, 4, 5]);
  if (board === null) return null;

  if (!Array.isArray(r.seats) || r.seats.length !== seatCount) return null;
  const seats: SeatResult[] = [];
  const claimed = new Set<number>();
  for (const entry of r.seats) {
    const seat = normalizeSeat(entry, seatCount);
    if (!seat || claimed.has(seat.seat)) return null;
    claimed.add(seat.seat);
    seats.push(seat);
  }
  seats.sort((a, b) => a.seat - b.seat);

  if (!Array.isArray(r.actions)) return null;
  const actions: ActionRecord[] = [];
  for (const entry of r.actions) {
    const action = normalizeAction(entry, seatCount);
    if (!action) return null;
    actions.push(action);
  }

  if (!Array.isArray(r.pots)) return null;
  const pots: PotRecord[] = [];
  for (const entry of r.pots) {
    const pot = normalizePot(entry, seatCount);
    if (!pot) return null;
    pots.push(pot);
  }

  if (typeof r.endStreet !== "string" || !STREETS.has(r.endStreet)) return null;

  const dealt = [...board, ...seats.flatMap((s) => s.hole)];
  if (new Set(dealt).size !== dealt.length) return null;

  return {
    handNumber,
    seed,
    button,
    seatCount,
    board,
    seats,
    pots,
    // Stripped on the way in as well as on the way out: a stored decision list
    // is either absent or something this build no longer understands.
    decisions: [],
    actions,
    endStreet: r.endStreet as Street,
    wentToShowdown: r.wentToShowdown === true,
  };
}

/** Drop the audit trail before storing. See the module comment. */
function forStorage(report: TableHandReport): TableHandReport {
  return { ...report, decisions: [] };
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

export function normalizeArchive(raw: unknown): ProfileArchive {
  if (!raw || typeof raw !== "object") return EMPTY_ARCHIVE;
  const r = raw as Record<string, unknown>;

  const smallBlind = whole(r.smallBlind, 1, 1_000_000) ?? EMPTY_ARCHIVE.smallBlind;
  const bigBlind = Math.max(
    smallBlind,
    whole(r.bigBlind, 1, 1_000_000) ?? EMPTY_ARCHIVE.bigBlind
  );

  const hands: TableHandReport[] = [];
  if (Array.isArray(r.hands)) {
    for (const entry of r.hands) {
      const report = normalizeReport(entry);
      if (report) hands.push(report);
    }
  }

  return {
    hands: dedupe(hands).slice(-MAX_STORED_HANDS),
    smallBlind,
    bigBlind,
    heroSeat: whole(r.heroSeat, 0, MAX_SEATS - 1),
    updatedAt: finite(r.updatedAt, 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}

/**
 * One entry per hand, keyed by its deal seed.
 *
 * Not by hand number: those restart at 1 whenever a new table is built, so two
 * sessions in the archive would collide on every one of them. The deal seed is
 * a 32-bit hash of the session seed and the hand number, which is as close to
 * an identity as a report carries.
 */
function dedupe(hands: TableHandReport[]): TableHandReport[] {
  const bySeed = new Map<number, TableHandReport>();
  for (const hand of hands) bySeed.set(hand.seed, hand);
  return [...bySeed.values()];
}

export function loadArchive(): ProfileArchive {
  if (typeof window === "undefined") return EMPTY_ARCHIVE;
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return EMPTY_ARCHIVE;
    return normalizeArchive(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage must never block the page.
    return EMPTY_ARCHIVE;
  }
}

export function saveArchive(archive: ProfileArchive): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        ...archive,
        hands: archive.hands.slice(-MAX_STORED_HANDS).map(forStorage),
        updatedAt: Date.now(),
      })
    );
  } catch {
    /* private browsing / quota, the archive just will not persist */
  }
}

export function clearArchive(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey());
  } catch {
    /* nothing to do */
  }
}

/**
 * Fold this session's hands into the archive, newest last.
 *
 * Live hands win over stored ones for the same seed: the live report still has
 * its decisions attached, and the review pages read those.
 */
export function mergeHands(
  stored: TableHandReport[],
  live: TableHandReport[]
): TableHandReport[] {
  const fresh = live.map(normalizeReportLive).filter((r): r is TableHandReport => !!r);
  return dedupe([...stored, ...fresh]).slice(-MAX_STORED_HANDS);
}

/**
 * A live report needs the same shape check as a stored one, it is the same
 * data, but keeps its decisions, which have not been through storage.
 */
function normalizeReportLive(report: TableHandReport): TableHandReport | null {
  const clean = normalizeReport(report);
  if (!clean) return null;
  return { ...clean, decisions: report.decisions ?? [] };
}
