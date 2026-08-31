/**
 * The spots a player got wrong, queued to be asked again.
 *
 * A leak the profile has priced is a diagnosis. It changes nothing on its own:
 * a player can read "you call below the price, 9 times, $951" every session and
 * keep doing it, which is the failure mode the whole leak-finding genre has.
 * What closes the loop is being put back in the spot.
 *
 * That is cheap here in a way it is not elsewhere. A hand replays exactly from
 * its deal seed, so a queue does not have to store a position, a board or a
 * range: it stores a seed and an index into that hand's actions, and the spot
 * is recovered from the archive. And `coach/evLoss.ts` has already priced every
 * line available at that index, so an attempt is scored against the number the
 * profile is already showing rather than against a second opinion computed
 * later.
 *
 * SCHEDULING IS COUNTED IN DRILLS, NOT IN DAYS. The obvious design is a spaced
 * repetition interval in wall-clock time, which is right for vocabulary and
 * wrong here: somebody who plays in two long sittings a month should not be
 * told an item is "not due", and somebody who opens the app daily should not
 * face the same twelve spots every morning. So an item's interval is a count of
 * other drills that must pass before it comes back (`BOX_INTERVAL`), which
 * spaces on effort rather than on the calendar and needs no clock at all. The
 * store is therefore deterministic, which is also why it is testable.
 *
 * BOXES, LEITNER-STYLE. Right answers promote, a wrong answer sends the item
 * back to box 0. Reaching `RETIRE_BOX` drops the item, on the argument the rest
 * of this product makes about sample size: three correct answers spaced across
 * other work is the point where the spot stops being evidence of a leak. It is
 * not a claim that the leak is fixed, and the profile still prices it.
 *
 * localStorage is the source of truth, the same as `tableOptions.ts`,
 * `components/profile/store.ts`, `opponentMemory.ts` and `calibration.ts`.
 * Everything read back is untrusted and degrades to an empty queue rather than
 * throwing, because the page reloads into the same stored value and a throw
 * would brick it permanently. Writes swallow quota errors.
 */

import type { DecisionEvLoss, LeakKind } from "../poker/coach/evLoss";

const STORAGE_KEY = "pp.drills.v1";

export const DRILL_VERSION = 1;

/**
 * How many other drills must pass before an item in each box is asked again.
 *
 * Box 0 is `0`, so a spot just answered wrong comes back in the same session
 * rather than waiting: the answer is still available to recall rather than to
 * reconstruct, which is the difference the whole exercise turns on.
 */
export const BOX_INTERVAL: readonly number[] = [0, 2, 5, 12];

/** Answering correctly from here drops the item. */
export const RETIRE_BOX = BOX_INTERVAL.length;

/**
 * Items kept. A queue longer than this is not a study plan, and the ranking
 * below means the ones dropped are the cheapest mistakes, never the costliest.
 */
export const MAX_ITEMS = 60;

export interface DrillItem {
  /** The deal seed, which is what actually recovers the hand. */
  seed: number;
  /** Only for display; hand numbers restart with every new table. */
  handNumber: number;
  /** Index into the report's `actions`. */
  index: number;
  seat: number;
  /** What the mistake was, or null when the taxonomy could not classify it. */
  kind: LeakKind | null;
  /** `|modelEvLoss|` when enqueued. Positive. The ranking key. */
  cost: number;
  box: number;
  /** The queue's drill counter when this item was last asked. */
  askedAt: number;
  /** Consecutive correct answers. Reset to 0 by a wrong one. */
  streak: number;
}

export interface DrillQueue {
  version: number;
  /** Total drills answered, ever. The clock the intervals are measured in. */
  drills: number;
  items: DrillItem[];
}

export function emptyQueue(): DrillQueue {
  return { version: DRILL_VERSION, drills: 0, items: [] };
}

// ---------------------------------------------------------------------------
// Reading untrusted storage
// ---------------------------------------------------------------------------

const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;

const finite = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;

function normalizeItem(raw: unknown): DrillItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const seed = finite(r.seed, 0, Number.MAX_SAFE_INTEGER);
  const index = whole(r.index, 0, 10_000);
  const seat = whole(r.seat, 0, 5);
  const cost = finite(r.cost, 0, 1e12);
  const box = whole(r.box, 0, RETIRE_BOX - 1);
  const askedAt = whole(r.askedAt, 0, Number.MAX_SAFE_INTEGER);
  const streak = whole(r.streak, 0, 1000);
  if (
    seed === null || index === null || seat === null || cost === null ||
    box === null || askedAt === null || streak === null
  ) {
    return null;
  }
  return {
    seed,
    handNumber: whole(r.handNumber, 1, Number.MAX_SAFE_INTEGER) ?? 1,
    index,
    seat,
    // An unknown kind is dropped to null rather than rejected: the item is
    // still a priced mistake worth asking about, it just cannot be labelled.
    kind: typeof r.kind === "string" ? (r.kind as LeakKind) : null,
    cost,
    box,
    askedAt,
    streak,
  };
}

export function normalizeQueue(raw: unknown): DrillQueue {
  if (!raw || typeof raw !== "object") return emptyQueue();
  const r = raw as Record<string, unknown>;
  if (r.version !== DRILL_VERSION) return emptyQueue();
  const items = Array.isArray(r.items)
    ? r.items.map(normalizeItem).filter((i): i is DrillItem => i !== null)
    : [];
  // Deduplicated on the way in as well as on the way out: a hand-edited file
  // could carry the same spot twice, and the second copy would be asked as if
  // it were a different mistake.
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const key = `${i.seed}:${i.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    version: DRILL_VERSION,
    drills: whole(r.drills, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    items: unique.slice(0, MAX_ITEMS),
  };
}

export function loadQueue(): DrillQueue {
  if (typeof window === "undefined") return emptyQueue();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeQueue(JSON.parse(raw)) : emptyQueue();
  } catch {
    return emptyQueue();
  }
}

export function saveQueue(queue: DrillQueue): DrillQueue {
  if (typeof window === "undefined") return queue;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    /* private browsing or quota: the queue just does not persist */
  }
  return queue;
}

export function clearQueue(): DrillQueue {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  }
  return emptyQueue();
}

// ---------------------------------------------------------------------------
// Filling the queue
// ---------------------------------------------------------------------------

/**
 * Fold priced mistakes into the queue.
 *
 * `seedOf` maps a hand number to its deal seed, because a `DecisionEvLoss`
 * carries the number (which restarts with every table) and the queue needs the
 * seed (which does not). A decision whose hand is no longer in the archive is
 * skipped rather than stored: the spot could not be recovered to ask about.
 *
 * An item already queued is left exactly as it is, including its box. Meeting
 * the same mistake again is not a reason to reset progress on it, and the
 * archive is re-analysed on every visit to the profile, so the alternative
 * would clear the schedule roughly every time the page was opened.
 */
export function enqueueLeaks(
  decisions: readonly DecisionEvLoss[],
  seedOf: (handNumber: number) => number | undefined,
  queue: DrillQueue = loadQueue()
): DrillQueue {
  const existing = new Set(queue.items.map((i) => `${i.seed}:${i.index}`));
  const additions: DrillItem[] = [];

  for (const d of decisions) {
    // Only real mistakes, and only under the model lens. `results-oriented` is
    // the bucket for a correct decision that lost, so drilling it would be
    // asking somebody to repeat the right answer and calling it practice.
    if (d.modelEvLoss >= 0) continue;
    if (d.kind === "results-oriented") continue;
    const seed = seedOf(d.handNumber);
    if (seed === undefined) continue;
    const key = `${seed}:${d.index}`;
    if (existing.has(key)) continue;
    existing.add(key);
    additions.push({
      seed,
      handNumber: d.handNumber,
      index: d.index,
      seat: d.seat,
      kind: d.kind,
      cost: Math.abs(d.modelEvLoss),
      box: 0,
      askedAt: queue.drills,
      streak: 0,
    });
  }

  // Costliest first when trimming, so a full queue drops cheap mistakes rather
  // than whichever happened to arrive last.
  const items = [...queue.items, ...additions]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, MAX_ITEMS);

  return { ...queue, items };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/** Whether enough other drills have passed for this item to come back. */
export function isDue(item: DrillItem, queue: DrillQueue): boolean {
  return queue.drills - item.askedAt >= (BOX_INTERVAL[item.box] ?? 0);
}

export function dueItems(queue: DrillQueue): DrillItem[] {
  return queue.items
    .filter((i) => isDue(i, queue))
    // Lowest box first, so a spot answered wrong is asked before a spot on its
    // third pass, then costliest first within a box.
    .sort((a, b) => a.box - b.box || b.cost - a.cost);
}

export function nextDrill(queue: DrillQueue): DrillItem | null {
  return dueItems(queue)[0] ?? null;
}

/**
 * Record an attempt: promote on a correct answer, back to box 0 on a wrong one,
 * and drop the item once it has been answered correctly out of the last box.
 *
 * `drills` increments on every attempt, right or wrong, because it is the clock
 * the intervals are measured in and a wrong answer is still work done.
 */
export function recordAttempt(
  item: DrillItem,
  correct: boolean,
  queue: DrillQueue = loadQueue()
): DrillQueue {
  const drills = queue.drills + 1;
  const key = `${item.seed}:${item.index}`;
  const items: DrillItem[] = [];

  for (const current of queue.items) {
    if (`${current.seed}:${current.index}` !== key) {
      items.push(current);
      continue;
    }
    if (correct) {
      const box = current.box + 1;
      // Retired. Not "fixed": the profile still prices the leak, this queue has
      // just stopped asking about this particular spot.
      if (box >= RETIRE_BOX) continue;
      items.push({ ...current, box, streak: current.streak + 1, askedAt: drills });
    } else {
      items.push({ ...current, box: 0, streak: 0, askedAt: drills });
    }
  }

  return { version: DRILL_VERSION, drills, items };
}

/** Counts for a headline: how many are queued, and how many can be asked now. */
export function queueSummary(queue: DrillQueue): {
  total: number;
  due: number;
  drills: number;
} {
  return { total: queue.items.length, due: dueItems(queue).length, drills: queue.drills };
}
