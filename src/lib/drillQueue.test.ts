import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BOX_INTERVAL,
  DRILL_VERSION,
  MAX_ITEMS,
  RETIRE_BOX,
  clearQueue,
  dueItems,
  emptyQueue,
  enqueueLeaks,
  isDue,
  loadQueue,
  nextDrill,
  queueSummary,
  recordAttempt,
  saveQueue,
  type DrillItem,
  type DrillQueue,
} from "./drillQueue";
import type { DecisionEvLoss, LeakKind } from "../poker/coach/evLoss";

const KEY = "pp.drills.v1";

function installStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    },
  };
  return store;
}

function installFullStorage(): void {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    },
  };
}

/** A priced decision, only the fields the queue reads. */
function decision(over: Partial<DecisionEvLoss> = {}): DecisionEvLoss {
  return {
    handNumber: 1,
    index: 3,
    seat: 0,
    modelEvLoss: -120,
    kind: "call-below-price" as LeakKind,
    ...over,
  } as DecisionEvLoss;
}

function item(over: Partial<DrillItem> = {}): DrillItem {
  return {
    seed: 111,
    handNumber: 1,
    index: 3,
    seat: 0,
    kind: "call-below-price",
    cost: 120,
    box: 0,
    askedAt: 0,
    streak: 0,
    ...over,
  };
}

let store: Record<string, string>;
beforeEach(() => {
  store = installStorage();
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// ---------------------------------------------------------------------------

describe("enqueueLeaks", () => {
  const seedOf = (hand: number) => (hand === 1 ? 111 : hand === 2 ? 222 : undefined);

  it("queues a priced mistake, keyed by seed rather than hand number", () => {
    const q = enqueueLeaks([decision()], seedOf, emptyQueue());
    expect(q.items).toHaveLength(1);
    expect(q.items[0].seed).toBe(111);
    expect(q.items[0].cost).toBe(120);
    expect(q.items[0].box).toBe(0);
  });

  it("skips a decision that was not a mistake", () => {
    const q = enqueueLeaks([decision({ modelEvLoss: 0 })], seedOf, emptyQueue());
    expect(q.items).toHaveLength(0);
  });

  it("skips results-oriented, which is the correct decision that lost", () => {
    // Drilling it would ask the player to repeat the right answer and call that
    // practice, and the taxonomy exists precisely to keep the two apart.
    const q = enqueueLeaks(
      [decision({ kind: "results-oriented", modelEvLoss: -400 })],
      seedOf,
      emptyQueue()
    );
    expect(q.items).toHaveLength(0);
  });

  it("skips a hand no longer in the archive, because the spot cannot be recovered", () => {
    const q = enqueueLeaks([decision({ handNumber: 99 })], seedOf, emptyQueue());
    expect(q.items).toHaveLength(0);
  });

  it("does not reset an item's box when the same mistake is re-analysed", () => {
    // The archive is re-priced on every visit to the profile, so resetting here
    // would wipe the schedule roughly every time the page was opened.
    const started: DrillQueue = {
      version: DRILL_VERSION,
      drills: 9,
      items: [item({ box: 2, streak: 2, askedAt: 4 })],
    };
    const q = enqueueLeaks([decision()], seedOf, started);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].box).toBe(2);
    expect(q.items[0].streak).toBe(2);
    expect(q.items[0].askedAt).toBe(4);
  });

  it("treats the same index in different hands as different spots", () => {
    const q = enqueueLeaks(
      [decision({ handNumber: 1 }), decision({ handNumber: 2 })],
      seedOf,
      emptyQueue()
    );
    expect(q.items).toHaveLength(2);
    expect(q.items.map((i) => i.seed).sort()).toEqual([111, 222]);
  });

  it("drops the cheapest mistakes when full, never the costliest", () => {
    const many = Array.from({ length: MAX_ITEMS + 20 }, (_, i) =>
      decision({ index: i, modelEvLoss: -(i + 1) })
    );
    const q = enqueueLeaks(many, () => 111, emptyQueue());
    expect(q.items).toHaveLength(MAX_ITEMS);
    const costs = q.items.map((i) => i.cost);
    expect(Math.min(...costs)).toBe(MAX_ITEMS + 20 - MAX_ITEMS + 1);
    expect(Math.max(...costs)).toBe(MAX_ITEMS + 20);
  });
});

describe("scheduling", () => {
  it("counts intervals in drills answered, not in time", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 5,
      items: [item({ box: 1, askedAt: 4 })],
    };
    // Box 1 waits BOX_INTERVAL[1] drills; only one has passed.
    expect(BOX_INTERVAL[1]).toBeGreaterThan(1);
    expect(isDue(q.items[0], q)).toBe(false);
    expect(isDue(q.items[0], { ...q, drills: 4 + BOX_INTERVAL[1] })).toBe(true);
  });

  it("asks a spot just answered wrong again in the same session", () => {
    // Box 0 has a zero interval on purpose: the answer is still available to
    // recall rather than to reconstruct, which is the whole exercise.
    expect(BOX_INTERVAL[0]).toBe(0);
    const q: DrillQueue = { version: DRILL_VERSION, drills: 3, items: [item({ askedAt: 3 })] };
    expect(isDue(q.items[0], q)).toBe(true);
  });

  it("orders by box first, then by cost", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 100,
      items: [
        item({ index: 1, box: 2, cost: 900 }),
        item({ index: 2, box: 0, cost: 10 }),
        item({ index: 3, box: 0, cost: 500 }),
      ],
    };
    expect(dueItems(q).map((i) => i.index)).toEqual([3, 2, 1]);
    expect(nextDrill(q)?.index).toBe(3);
  });

  it("has nothing to ask when every item is waiting", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 0,
      items: [item({ box: 3, askedAt: 0 })],
    };
    expect(nextDrill(q)).toBeNull();
  });
});

describe("recordAttempt", () => {
  it("promotes on a correct answer and defers it", () => {
    const q: DrillQueue = { version: DRILL_VERSION, drills: 7, items: [item({ box: 0 })] };
    const next = recordAttempt(q.items[0], true, q);
    expect(next.drills).toBe(8);
    expect(next.items[0].box).toBe(1);
    expect(next.items[0].streak).toBe(1);
    expect(next.items[0].askedAt).toBe(8);
  });

  it("sends a wrong answer back to box 0 and clears the streak", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 7,
      items: [item({ box: 2, streak: 2 })],
    };
    const next = recordAttempt(q.items[0], false, q);
    expect(next.items[0].box).toBe(0);
    expect(next.items[0].streak).toBe(0);
  });

  it("counts a wrong answer as work done, so other items still advance", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 7,
      items: [item({ index: 1 }), item({ index: 2, box: 1, askedAt: 7 })],
    };
    const next = recordAttempt(q.items[0], false, q);
    expect(next.drills).toBe(8);
  });

  it("retires an item answered correctly out of the last box", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 0,
      items: [item({ box: RETIRE_BOX - 1, streak: RETIRE_BOX - 1 })],
    };
    expect(recordAttempt(q.items[0], true, q).items).toHaveLength(0);
  });

  it("leaves every other item untouched", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 3,
      items: [item({ index: 1 }), item({ index: 2, box: 2, streak: 2, askedAt: 1 })],
    };
    const next = recordAttempt(q.items[0], true, q);
    const other = next.items.find((i) => i.index === 2)!;
    expect(other.box).toBe(2);
    expect(other.streak).toBe(2);
    expect(other.askedAt).toBe(1);
  });

  it("takes three correct answers to clear a spot", () => {
    let q: DrillQueue = { version: DRILL_VERSION, drills: 0, items: [item()] };
    for (let i = 0; i < RETIRE_BOX - 1; i++) {
      q = recordAttempt(q.items[0], true, q);
      expect(q.items).toHaveLength(1);
    }
    q = recordAttempt(q.items[0], true, q);
    expect(q.items).toHaveLength(0);
    expect(q.drills).toBe(RETIRE_BOX);
  });
});

describe("storage", () => {
  it("round-trips through localStorage", () => {
    saveQueue({ version: DRILL_VERSION, drills: 4, items: [item({ box: 1 })] });
    const back = loadQueue();
    expect(back.drills).toBe(4);
    expect(back.items[0].box).toBe(1);
  });

  it("starts empty rather than throwing on a corrupt row", () => {
    store[KEY] = "{not json";
    expect(loadQueue()).toEqual(emptyQueue());
  });

  it("discards a queue written by another version", () => {
    store[KEY] = JSON.stringify({ version: 99, drills: 50, items: [item()] });
    expect(loadQueue().items).toHaveLength(0);
  });

  it("drops an item with an out-of-range field and keeps the rest", () => {
    store[KEY] = JSON.stringify({
      version: DRILL_VERSION,
      drills: 1,
      items: [item({ index: 2 }), { ...item({ index: 3 }), box: 99 }, item({ index: 4 })],
    });
    expect(loadQueue().items.map((i) => i.index)).toEqual([2, 4]);
  });

  it("nulls an unrecognised kind rather than dropping a priced spot", () => {
    store[KEY] = JSON.stringify({
      version: DRILL_VERSION,
      drills: 0,
      items: [{ ...item(), kind: 42 }],
    });
    const back = loadQueue();
    expect(back.items).toHaveLength(1);
    expect(back.items[0].kind).toBeNull();
  });

  it("deduplicates a hand-edited file that carries one spot twice", () => {
    store[KEY] = JSON.stringify({
      version: DRILL_VERSION,
      drills: 0,
      items: [item(), item()],
    });
    expect(loadQueue().items).toHaveLength(1);
  });

  it("caps what it reads back, not just what it writes", () => {
    store[KEY] = JSON.stringify({
      version: DRILL_VERSION,
      drills: 0,
      items: Array.from({ length: MAX_ITEMS + 30 }, (_, i) => item({ index: i })),
    });
    expect(loadQueue().items).toHaveLength(MAX_ITEMS);
  });

  it("does not throw when storage refuses the write", () => {
    installFullStorage();
    expect(() => saveQueue(emptyQueue())).not.toThrow();
    expect(() => clearQueue()).not.toThrow();
  });

  it("works with no window at all", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(loadQueue()).toEqual(emptyQueue());
    expect(() => saveQueue(emptyQueue())).not.toThrow();
  });
});

describe("queueSummary", () => {
  it("separates what is queued from what can be asked now", () => {
    const q: DrillQueue = {
      version: DRILL_VERSION,
      drills: 1,
      items: [item({ index: 1, box: 0, askedAt: 1 }), item({ index: 2, box: 3, askedAt: 1 })],
    };
    expect(queueSummary(q)).toEqual({ total: 2, due: 1, drills: 1 });
  });
});
