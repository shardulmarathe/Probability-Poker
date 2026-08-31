// @vitest-environment jsdom
/**
 * The door between a priced mistake and the maths that explains it.
 *
 * Before `LeakPatterns` the only link to the concepts page anywhere in the app
 * was the nav bar, so a player shown what a leak cost had nowhere to go to find
 * out why it was one. These tests hold the two properties that make the section
 * worth having: patterns are ranked by what the habit costs rather than by the
 * worst single hand, and the correct-decision bucket is never filed as a leak.
 *
 * Named `Leaks.patterns.test.tsx` rather than `Leaks.test.tsx` because this
 * covers one export of a large module, and a file claiming the whole of `Leaks`
 * would overstate what is checked.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { LeakPatterns } from "./Leaks";
import type { LeakAggregate, SessionEvLoss } from "../../poker/coach/evLoss";

function aggregate(over: Partial<LeakAggregate>): LeakAggregate {
  return {
    kind: "call-below-price",
    count: 9,
    opportunities: 140,
    rate: 9 / 140,
    totalModelEvLoss: -951,
    totalHindsightEvLoss: -400,
    meanModelEvLoss: -106,
    worst: null,
    ...over,
  } as LeakAggregate;
}

const session = (leaks: LeakAggregate[]): SessionEvLoss =>
  ({ leaks, hands: [], decisionCount: 0 }) as unknown as SessionEvLoss;

const draw = (leaks: LeakAggregate[]) =>
  render(
    <MemoryRouter>
      <LeakPatterns session={session(leaks)} />
    </MemoryRouter>
  );

afterEach(cleanup);

describe("with nothing classified", () => {
  it("says a pattern needs examples rather than showing an empty list", () => {
    draw([]);
    expect(screen.getByText(/No pattern yet/)).toBeTruthy();
  });

  it("ignores a kind with no occurrences", () => {
    draw([aggregate({ count: 0, totalModelEvLoss: 0 })]);
    expect(screen.getByText(/No pattern yet/)).toBeTruthy();
  });
});

describe("ranking", () => {
  it("orders by what the habit costs, not by the worst single hand", () => {
    // A habit repeated forty times and one catastrophe are different problems,
    // and only the first is fixable by understanding something.
    draw([
      aggregate({ kind: "multiway-as-heads-up", totalModelEvLoss: -314 }),
      aggregate({ kind: "call-below-price", totalModelEvLoss: -951 }),
      aggregate({ kind: "missed-value", totalModelEvLoss: -894 }),
    ]);
    const order = [...document.querySelectorAll("[data-testid^=leak-pattern-]")].map(
      (e) => e.getAttribute("data-testid")
    );
    expect(order).toEqual([
      "leak-pattern-call-below-price",
      "leak-pattern-missed-value",
      "leak-pattern-multiway-as-heads-up",
    ]);
  });

  it("states the frequency over the spots that offered the error", () => {
    // 9 of 140, not 9 of every decision: folding well ninety times must not
    // dilute a leak away.
    draw([aggregate({ count: 9, opportunities: 140, rate: 9 / 140 })]);
    const row = screen.getByTestId("leak-pattern-call-below-price").textContent ?? "";
    expect(row).toMatch(/9 of 140 spots/);
    expect(row).toMatch(/6%/);
  });
});

describe("the door to the maths", () => {
  it("links each pattern to the concept that derives what it broke", () => {
    draw([
      aggregate({ kind: "multiway-as-heads-up", totalModelEvLoss: -300 }),
      aggregate({ kind: "call-below-price", totalModelEvLoss: -900 }),
    ]);
    const hrefs = [...document.querySelectorAll('a[href*="/learn?c="]')].map((a) =>
      a.getAttribute("href")
    );
    expect(hrefs).toContain("/learn?c=ev");
    expect(hrefs).toContain("/learn?c=multiway");
  });
});

describe("the bucket that is not a leak", () => {
  it("is never ranked among them", () => {
    // Filing a correct decision that lost as something to fix would teach the
    // exact habit the model-versus-hindsight split exists to break.
    draw([
      aggregate({ kind: "results-oriented", count: 12, totalModelEvLoss: -409 }),
      aggregate({ kind: "call-below-price", totalModelEvLoss: -100 }),
    ]);
    const ranked = [...document.querySelectorAll("[data-testid^=leak-pattern-]")].map(
      (e) => e.getAttribute("data-testid")
    );
    expect(ranked).not.toContain("leak-pattern-results-oriented");
  });

  it("is reported separately and labelled as not a leak", () => {
    draw([
      aggregate({
        kind: "results-oriented",
        count: 12,
        totalModelEvLoss: 0,
        totalHindsightEvLoss: -409,
      }),
    ]);
    const block = screen.getByTestId("leak-pattern-variance").textContent ?? "";
    expect(block).toMatch(/Not a leak/);
    expect(block).toMatch(/12 times/);
    expect(block).toMatch(/variance/i);
  });

  it("does not stand in for a pattern list when it is all there is", () => {
    draw([aggregate({ kind: "results-oriented", count: 3, totalModelEvLoss: 0 })]);
    expect(screen.getByTestId("leak-pattern-variance")).toBeTruthy();
    expect(document.querySelectorAll("[data-testid^=leak-pattern-]")).toHaveLength(1);
  });
});
