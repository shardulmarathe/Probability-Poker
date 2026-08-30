import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CALIBRATION_VERSION,
  MAX_SAMPLES,
  calibrationFor,
  clearCalibration,
  emptyCalibration,
  foldGuess,
  loadCalibration,
  normalizeCalibration,
  recordGuess,
  saveCalibration,
  type CalibrationSummary,
} from "./calibration";

const KEY = "pp.calibration.v1";

/** A `window.localStorage` good enough for the module under test. */
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

/** Storage that refuses every write, the private-browsing / quota case. */
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

function uninstallStorage(): void {
  delete (globalThis as { window?: unknown }).window;
}

let store: Record<string, string>;

beforeEach(() => {
  store = installStorage();
});

afterEach(() => {
  uninstallStorage();
});

// ---------------------------------------------------------------------------
// Untrusted storage
// ---------------------------------------------------------------------------

describe("loadCalibration", () => {
  it("returns an empty summary when nothing is stored", () => {
    expect(loadCalibration()).toEqual(emptyCalibration());
  });

  it("survives a value that is not JSON", () => {
    store[KEY] = "{not json";
    expect(() => loadCalibration()).not.toThrow();
    expect(loadCalibration().byKind).toEqual({});
  });

  it("survives every shape a hand-edited row can take", () => {
    const rubbish = [
      "null",
      '"a string"',
      "42",
      "[]",
      "{}",
      '{"version":99,"byKind":{"equity":{"count":1,"meanSignedError":0,"meanAbsError":0}}}',
      '{"version":1,"byKind":null}',
      '{"version":1,"byKind":"equity"}',
      '{"version":1,"byKind":[1,2,3]}',
      '{"version":1,"byKind":{"equity":null}}',
    ];
    for (const raw of rubbish) {
      store[KEY] = raw;
      expect(() => loadCalibration()).not.toThrow();
      expect(loadCalibration().byKind).toEqual({});
    }
  });

  it("works with no window at all, as a module import on a server would", () => {
    uninstallStorage();
    expect(loadCalibration()).toEqual(emptyCalibration());
    expect(() => saveCalibration(emptyCalibration())).not.toThrow();
    expect(() => recordGuess("equity", 0.5, 0.6)).not.toThrow();
    expect(() => clearCalibration()).not.toThrow();
  });

  it("does not throw when storage refuses the write", () => {
    installFullStorage();
    expect(() => recordGuess("equity", 0.5, 0.6)).not.toThrow();
    expect(() => clearCalibration()).not.toThrow();
    // The delta still has to be returned to the caller, the reader sees their
    // feedback even when nothing can persist.
    expect(recordGuess("equity", 0.5, 0.6).byKind.equity?.count).toBe(1);
  });
});

describe("normalizeCalibration", () => {
  const entry = { count: 2, meanSignedError: 0.05, meanAbsError: 0.05, updatedAt: 7 };

  it("keeps a well-formed entry", () => {
    const summary = normalizeCalibration({
      version: CALIBRATION_VERSION,
      byKind: { equity: entry },
      updatedAt: 9,
    });
    expect(summary.byKind.equity).toEqual(entry);
    expect(summary.updatedAt).toBe(9);
  });

  it("drops keys that are not quantities it knows", () => {
    // Through JSON.parse, so "__proto__" arrives as an own property the way it
    // would from storage rather than as a prototype assignment.
    const summary = normalizeCalibration(
      JSON.parse(
        JSON.stringify({
          version: CALIBRATION_VERSION,
          byKind: { equity: entry, "spot-price": entry },
        }).replace('"spot-price"', '"__proto__"')
      )
    );
    expect(Object.keys(summary.byKind)).toEqual(["equity"]);
  });

  it("drops a bad entry and keeps its neighbours", () => {
    const summary = normalizeCalibration({
      version: CALIBRATION_VERSION,
      byKind: {
        equity: entry,
        // An absolute error below the signed one is arithmetically impossible.
        "required-equity": { count: 3, meanSignedError: 0.4, meanAbsError: 0.1 },
        chips: { count: 0, meanSignedError: 0, meanAbsError: 0 },
      },
    });
    expect(Object.keys(summary.byKind)).toEqual(["equity"]);
  });

  it("rejects counts outside the window and non-finite errors", () => {
    const bad = [
      { count: MAX_SAMPLES + 1, meanSignedError: 0, meanAbsError: 0 },
      { count: 1.5, meanSignedError: 0, meanAbsError: 0 },
      { count: -1, meanSignedError: 0, meanAbsError: 0 },
      { count: "2", meanSignedError: 0, meanAbsError: 0 },
      { count: 1, meanSignedError: null, meanAbsError: 0 },
      { count: 1, meanSignedError: 0, meanAbsError: 1e12 },
    ];
    for (const value of bad) {
      const summary = normalizeCalibration({
        version: CALIBRATION_VERSION,
        byKind: { equity: value },
      });
      expect(summary.byKind.equity).toBeUndefined();
    }
  });

  it("defaults a missing timestamp rather than dropping the entry", () => {
    const summary = normalizeCalibration({
      version: CALIBRATION_VERSION,
      byKind: { chips: { count: 1, meanSignedError: 5, meanAbsError: 5 } },
      updatedAt: "yesterday",
    });
    expect(summary.byKind.chips?.updatedAt).toBe(0);
    expect(summary.updatedAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rolling summary
// ---------------------------------------------------------------------------

describe("foldGuess", () => {
  it("records the first guess as its own error", () => {
    const first = foldGuess(undefined, 0.5, 0.62, 100);
    expect(first.count).toBe(1);
    expect(first.meanSignedError).toBeCloseTo(-0.12, 10);
    expect(first.meanAbsError).toBeCloseTo(0.12, 10);
    expect(first.updatedAt).toBe(100);
  });

  it("takes the exact arithmetic mean inside the window", () => {
    // Errors of +0.10, −0.30, +0.20: signed mean 0, absolute mean 0.2.
    let entry = foldGuess(undefined, 0.6, 0.5);
    entry = foldGuess(entry, 0.2, 0.5);
    entry = foldGuess(entry, 0.7, 0.5);
    expect(entry.count).toBe(3);
    expect(entry.meanSignedError).toBeCloseTo(0, 10);
    expect(entry.meanAbsError).toBeCloseTo(0.2, 10);
  });

  it("keeps the two means consistent: |signed| never exceeds absolute", () => {
    let entry = foldGuess(undefined, 0.9, 0.1);
    for (let i = 0; i < 200; i++) {
      entry = foldGuess(entry, i % 2 === 0 ? 0.9 : 0.1, 0.5);
      expect(Math.abs(entry.meanSignedError)).toBeLessThanOrEqual(
        entry.meanAbsError + 1e-12
      );
    }
  });

  it("caps the count and keeps averaging past the cap", () => {
    let entry = foldGuess(undefined, 0.5, 0.5);
    for (let i = 0; i < MAX_SAMPLES * 4; i++) entry = foldGuess(entry, 0.5, 0.5);
    expect(entry.count).toBe(MAX_SAMPLES);
    expect(entry.meanSignedError).toBeCloseTo(0, 10);

    // At the cap the mean is a moving average at weight 1/MAX_SAMPLES, so one
    // fresh error moves it by exactly that fraction of its distance.
    const moved = foldGuess(entry, 1, 0);
    expect(moved.count).toBe(MAX_SAMPLES);
    expect(moved.meanSignedError).toBeCloseTo(1 / MAX_SAMPLES, 10);
  });

  it("forgets an old bias within a few windows", () => {
    // Twenty guesses ten points optimistic, then a long level run: the entry
    // must end up saying "level", which a lifetime mean would never do.
    let entry = foldGuess(undefined, 0.6, 0.5);
    for (let i = 0; i < 19; i++) entry = foldGuess(entry, 0.6, 0.5);
    expect(entry.meanSignedError).toBeCloseTo(0.1, 10);
    for (let i = 0; i < MAX_SAMPLES * 6; i++) entry = foldGuess(entry, 0.5, 0.5);
    expect(Math.abs(entry.meanSignedError)).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("recordGuess", () => {
  it("accumulates across reloads, which is the whole point of the module", () => {
    recordGuess("equity", 0.5, 0.6);
    recordGuess("equity", 0.4, 0.6);
    // A second session reads the same row back.
    const reloaded = loadCalibration();
    expect(reloaded.byKind.equity?.count).toBe(2);
    expect(reloaded.byKind.equity?.meanSignedError).toBeCloseTo(-0.15, 10);
    expect(reloaded.byKind.equity?.meanAbsError).toBeCloseTo(0.15, 10);
  });

  it("keeps the quantities apart", () => {
    recordGuess("equity", 0.5, 0.6);
    recordGuess("required-equity", 0.5, 0.333);
    recordGuess("chips", 120, 100);
    const summary = loadCalibration();
    expect(summary.byKind.equity?.count).toBe(1);
    expect(summary.byKind.chips?.meanSignedError).toBeCloseTo(20, 10);
    expect(calibrationFor("required-equity", summary)?.count).toBe(1);
    expect(calibrationFor("required-equity")?.count).toBe(1);
  });

  it("ignores a guess or an actual that is not a finite number", () => {
    recordGuess("equity", 0.5, 0.6);
    for (const [guess, actual] of [
      [Number.NaN, 0.5],
      [0.5, Number.NaN],
      [Number.POSITIVE_INFINITY, 0.5],
      [1e12, 0.5],
    ]) {
      recordGuess("equity", guess, actual);
    }
    expect(loadCalibration().byKind.equity?.count).toBe(1);
  });

  it("stays small on disk however long the reader keeps guessing", () => {
    for (let i = 0; i < 500; i++) {
      recordGuess("equity", (i % 100) / 100, 0.5);
      recordGuess("chips", i, 100);
    }
    const summary = loadCalibration();
    expect(summary.byKind.equity?.count).toBe(MAX_SAMPLES);
    expect(summary.byKind.chips?.count).toBe(MAX_SAMPLES);
    // Three numbers and a timestamp per quantity, and there are three
    // quantities: a stored row that grows with use is the bug this asserts on.
    expect(store[KEY].length).toBeLessThan(500);
  });

  it("recovers from a corrupt row by starting the count over, not by throwing", () => {
    store[KEY] = '{"version":1,"byKind":{"equity":{"count":900}}}';
    const summary = recordGuess("equity", 0.5, 0.6);
    expect(summary.byKind.equity?.count).toBe(1);
  });
});

describe("calibrationFor", () => {
  it("is null before anything has been guessed", () => {
    expect(calibrationFor("equity")).toBeNull();
  });

  it("reads from a summary handed in, without touching storage", () => {
    const summary: CalibrationSummary = {
      version: CALIBRATION_VERSION,
      byKind: { chips: { count: 4, meanSignedError: -3, meanAbsError: 9, updatedAt: 1 } },
      updatedAt: 1,
    };
    expect(calibrationFor("chips", summary)?.meanAbsError).toBe(9);
    expect(calibrationFor("equity", summary)).toBeNull();
  });
});

describe("clearCalibration", () => {
  it("forgets everything", () => {
    recordGuess("equity", 0.5, 0.6);
    expect(clearCalibration()).toEqual(emptyCalibration());
    expect(KEY in store).toBe(false);
    expect(loadCalibration()).toEqual(emptyCalibration());
  });
});
