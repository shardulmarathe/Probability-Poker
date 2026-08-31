// @vitest-environment jsdom
/**
 * Which table a seat name is measured against.
 *
 * Names live on the table, not on the hand, so they are only trustworthy for a
 * table the same size as the one that dealt the hand being read. `seatName`
 * defaults to guarding on the archive's widest table, which is the only honest
 * answer for the profile's aggregates because they span every hand at once.
 *
 * A page showing one hand needs the other rule. The replay page did not have
 * it, so an archive holding both four- and six-handed hands measured every
 * replay against six seats, missed the live four-seat table, and fell back to
 * "Seat 2" while the review of the very same hand still said "Ultra-Tight".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { MemoryRouter } from "react-router-dom";

import { TableProvider } from "../../store/TableContext";
import { playSession } from "../../poker/replay/fixtures";
import { useProfileArchive } from "./useProfile";
import { saveArchive } from "./store";

const BLINDS = { smallBlind: 5, bigBlind: 10 };

/** A four-seat live table with three named bots, as the app boots it. */
function seedTable(): void {
  window.localStorage.setItem(
    "pp.tableOptions",
    JSON.stringify({
      seatCount: 4,
      stackBb: 100,
      ...BLINDS,
      lineup: ["nit", "tag", "station"],
      mode: "coach",
      observer: false,
    })
  );
}

/** An archive wider than the live table: six-handed hands alongside four. */
function seedMixedArchive(): void {
  saveArchive({
    hands: [
      ...playSession({ seatCount: 6, hands: 2, seed: 11, ...BLINDS }).reports,
      ...playSession({ seatCount: 4, hands: 2, seed: 22, ...BLINDS }).reports,
    ],
    ...BLINDS,
    heroSeat: 0,
    updatedAt: 1,
  });
}

/** jsdom's own storage is replaced elsewhere in the suite; own it here. */
function installStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, String(v)),
      removeItem: (k: string) => void values.delete(k),
      clear: () => values.clear(),
    },
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <TableProvider>{children}</TableProvider>
  </MemoryRouter>
);

function view() {
  return renderHook(() => useProfileArchive(), { wrapper }).result;
}

describe("seatName picks the table it measures against", () => {
  beforeEach(() => {
    installStorage();
    seedTable();
  });
  afterEach(cleanup);

  it("names seats from the live table when the archive matches it", () => {
    saveArchive({
      hands: playSession({ seatCount: 4, hands: 2, seed: 22, ...BLINDS }).reports,
      ...BLINDS,
      heroSeat: 0,
      updatedAt: 1,
    });
    const { current } = view();
    expect(current.seatCount).toBe(4);
    expect(current.seatName(0)).toBe("You");
    expect(current.seatName(1)).not.toMatch(/^Seat /);
  });

  it("falls back to seat numbers for the aggregate when sizes are mixed", () => {
    // The profile reads every hand at once, so no single table can name them.
    seedMixedArchive();
    const { current } = view();
    expect(current.seatCount).toBe(6);
    expect(current.seatName(1)).toBe("Seat 2");
  });

  it("names a four-handed hand read on its own even so", () => {
    // The regression: passing the hand's own seat count reaches the live table
    // again, which is what the replay page does and the review already did.
    seedMixedArchive();
    const { current } = view();
    expect(current.seatName(1)).toBe("Seat 2");
    expect(current.seatName(1, 4)).not.toBe("Seat 2");
    expect(current.seatName(1, 4)).not.toMatch(/^Seat /);
    expect(current.seatName(0, 4)).toBe("You");
  });

  it("still refuses to name a hand wider than the live table", () => {
    // Six-handed hand, four-seat table: chair 5 has never existed here.
    seedMixedArchive();
    const { current } = view();
    expect(current.seatName(4, 6)).toBe("Seat 5");
  });
});
