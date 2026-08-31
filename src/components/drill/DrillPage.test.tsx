// @vitest-environment jsdom
/**
 * The drill page under test.
 *
 * Written because the three defects the browser turned up in this feature were
 * all invisible to the type checker and to the logic suite: scripted demo hands
 * were being queued and then silently pruned, the verdict printed "raiseed", and
 * an unresolvable seat wore the human's monogram. Two of those are here, and the
 * third is in the seat component.
 *
 * The hands are real: `playSession` runs the production engine over a seeded
 * table, so the spot a drill recovers is a spot that genuinely happened rather
 * than a hand-written fixture that might not be reachable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import DrillPage from "./DrillPage";
import { playSession } from "../../poker/replay/fixtures";
import { analyzeHands } from "../../poker/coach/evLoss";
import { saveArchive, type ProfileArchive } from "../profile/store";
import {
  RETIRE_BOX,
  enqueueLeaks,
  loadQueue,
  saveQueue,
  emptyQueue,
} from "../../lib/drillQueue";
import type { TableHandReport } from "../../poker/table/contract";

function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

const draw = () =>
  render(
    <MemoryRouter>
      <DrillPage />
    </MemoryRouter>
  );

/** Real engine hands, and the seat that actually made priced mistakes in them. */
function realSession(): { reports: TableHandReport[]; seat: number } {
  const { reports } = playSession({ seatCount: 3, hands: 14 });
  for (let seat = 0; seat < 3; seat++) {
    const priced = analyzeHands(reports, seat)
      .hands.flatMap((h) => h.decisions)
      .filter((d) => d.modelEvLoss < 0 && d.kind !== "results-oriented");
    if (priced.length > 0) return { reports, seat };
  }
  throw new Error("fixture produced no priced mistake to drill");
}

function seedArchive(reports: TableHandReport[], heroSeat: number): void {
  const archive: ProfileArchive = {
    hands: reports,
    smallBlind: 5,
    bigBlind: 10,
    heroSeat,
    updatedAt: Date.now(),
  };
  saveArchive(archive);
}

function queueFrom(reports: TableHandReport[], seat: number): number {
  const seedOf = new Map(reports.map((r) => [r.handNumber, r.seed]));
  const decisions = analyzeHands(reports, seat).hands.flatMap((h) => h.decisions);
  const queue = enqueueLeaks(decisions, (n) => seedOf.get(n), emptyQueue());
  saveQueue(queue);
  return queue.items.length;
}

beforeEach(() => {
  installStorage();
});
afterEach(cleanup);

describe("with nothing queued", () => {
  it("explains where drills come from instead of showing an empty shell", () => {
    draw();
    expect(screen.getByText(/Nothing queued yet/)).toBeTruthy();
    expect(screen.getByTestId("drill").getAttribute("data-due")).toBe("0");
  });

  it("offers no answer buttons, because there is no question", () => {
    draw();
    expect(screen.queryByTestId("drill-fold")).toBeNull();
  });
});

describe("with a real mistake queued", () => {
  it("asks the spot and offers the three action classes", () => {
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    expect(queueFrom(reports, seat)).toBeGreaterThan(0);

    draw();
    expect(screen.getByText(/What is the best line\?/)).toBeTruthy();
    expect(screen.getByTestId("drill-fold")).toBeTruthy();
    expect(screen.getByTestId("drill-passive")).toBeTruthy();
    expect(screen.getByTestId("drill-aggressive")).toBeTruthy();
  });

  it("does not reveal the answer before one is given", () => {
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    queueFrom(reports, seat);
    draw();
    expect(screen.queryByTestId("drill-verdict")).toBeNull();
  });

  it("shows the priced lines once answered, and counts the attempt", () => {
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    queueFrom(reports, seat);
    draw();

    fireEvent.click(screen.getByTestId("drill-passive"));
    expect(screen.getByTestId("drill-verdict")).toBeTruthy();
    expect(loadQueue().drills).toBe(1);
  });

  it("never prints a verb with two endings", () => {
    // "you actually raiseed" was on screen. Any action, any spot: the sentence
    // has to survive a verb that already ends in the letter it is given.
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    queueFrom(reports, seat);
    draw();
    fireEvent.click(screen.getByTestId("drill-fold"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/raiseed|folded ed|betted|checkeded/);
    expect(text).toMatch(/you actually (folded|checked|called|bet|raised)/);
  });

  it("keeps the hindsight lens out of the verdict", () => {
    // A correct call that got outdrawn is not a mistake, so the results-oriented
    // number is shown beside the answer and labelled, never as the answer.
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    queueFrom(reports, seat);
    draw();
    fireEvent.click(screen.getByTestId("drill-passive"));
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/with the cards face up/);
    expect(text).toMatch(/what only the cards knew/);
  });

  it("prices the spot from the stored analysis, not a fresh opinion", () => {
    // The EV shown must be the figure the profile already reported. If the page
    // re-derived it, the two surfaces could disagree about one decision.
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    queueFrom(reports, seat);

    const item = loadQueue().items[0];
    const report = reports.find((r) => r.seed === item.seed)!;
    const expected = analyzeHands([report], item.seat)
      .hands[0].decisions.find((d) => d.index === item.index)!;

    draw();
    fireEvent.click(screen.getByTestId("drill-passive"));
    const text = document.body.textContent ?? "";
    // The chosen line's cost, formatted the way the page formats it.
    const cost = Math.round(Math.abs(expected.modelEvLoss));
    expect(text).toContain(String(cost));
  });
});

describe("a queued spot whose hand has left the archive", () => {
  it("is dropped rather than asked about forever", () => {
    // The archive is capped, so an item can outlive the hand it points at.
    // Guessing at the spot is not an option, so the item goes.
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    queueFrom(reports, seat);
    const before = loadQueue().items.length;
    expect(before).toBeGreaterThan(0);

    // The queue survives, the hands do not.
    saveArchive({
      hands: [],
      smallBlind: 5,
      bigBlind: 10,
      heroSeat: seat,
      updatedAt: Date.now(),
    });

    draw();
    expect(loadQueue().items).toHaveLength(0);
    expect(screen.getByText(/Nothing queued yet/)).toBeTruthy();
  });
});

describe("the schedule", () => {
  it("takes several correct answers to clear one spot", () => {
    const { reports, seat } = realSession();
    seedArchive(reports, seat);
    queueFrom(reports, seat);

    const item = loadQueue().items[0];
    const report = reports.find((r) => r.seed === item.seed)!;
    const decision = analyzeHands([report], item.seat)
      .hands[0].decisions.find((d) => d.index === item.index)!;
    const best = decision.modelBestAction;
    const button =
      best === "fold"
        ? "drill-fold"
        : best === "bet" || best === "raise"
          ? "drill-aggressive"
          : "drill-passive";

    // One right answer promotes rather than retires.
    draw();
    fireEvent.click(screen.getByTestId(button));
    const after = loadQueue().items.find(
      (i) => i.seed === item.seed && i.index === item.index
    );
    expect(after?.box).toBe(1);
    expect(RETIRE_BOX).toBeGreaterThan(1);
  });
});
