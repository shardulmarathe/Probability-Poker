import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIRROR_ID, loadMirrorProfile } from "./mirrorSeat";
import { saveArchive, type ProfileArchive } from "../components/profile/store";
import { MIN_CLASSIFY_HANDS } from "../poker/coach/archetype";
import { playSession } from "../poker/replay/fixtures";
import type { TableHandReport } from "../poker/table/contract";

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

function seed(hands: TableHandReport[], heroSeat = 0): void {
  const archive: ProfileArchive = {
    hands,
    smallBlind: 5,
    bigBlind: 10,
    heroSeat,
    updatedAt: Date.now(),
  };
  saveArchive(archive);
}

beforeEach(() => {
  installStorage();
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("loadMirrorProfile", () => {
  it("is null with no archive at all", () => {
    expect(loadMirrorProfile()).toBeNull();
  });

  it("is null with an archive too thin to describe a style", () => {
    // The same bar the style verdict holds itself to. A mirror built from nine
    // hands is a caricature, and the point of the seat is recognition.
    const { reports } = playSession({ seatCount: 3, hands: MIN_CLASSIFY_HANDS - 5 });
    seed(reports);
    expect(loadMirrorProfile()).toBeNull();
  });

  it("builds a profile once the archive can support one", () => {
    const { reports } = playSession({ seatCount: 3, hands: MIN_CLASSIFY_HANDS + 10 });
    seed(reports);
    const profile = loadMirrorProfile();
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe(MIRROR_ID);
    expect(Number.isFinite(profile!.aggression)).toBe(true);
    expect(Number.isFinite(profile!.entryThreshold)).toBe(true);
  });

  it("measures the seat the archive says the player occupied", () => {
    // The stats are per-seat and the player's chair moves between tables, so
    // reading the wrong seat would mirror an opponent.
    const { reports } = playSession({ seatCount: 3, hands: MIN_CLASSIFY_HANDS + 10 });
    seed(reports, 0);
    const first = loadMirrorProfile();
    seed(reports, 1);
    const second = loadMirrorProfile();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Two different seats in the same hands played differently, so the derived
    // profiles must not be identical. If they were, the seat is being ignored.
    const differs =
      first!.entryThreshold !== second!.entryThreshold ||
      first!.aggression !== second!.aggression ||
      first!.blurb !== second!.blurb;
    expect(differs).toBe(true);
  });

  it("does not throw when storage is unavailable", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => loadMirrorProfile()).not.toThrow();
    expect(loadMirrorProfile()).toBeNull();
  });
});
