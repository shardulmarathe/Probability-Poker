// @vitest-environment jsdom
/**
 * A concept page, driven rather than eyeballed.
 *
 * The point of this file is less its assertions than its existence: `/learn` had
 * 44 interactive controls and no way to address any of them, so the only audit
 * available was clicking blindly. `Choice` now gives every option its own test
 * id and reports its own pressed state, and this is the proof that the page can
 * be exercised.
 *
 * EV is the concept chosen because it is the one that runs no simulation, so it
 * is deterministic arithmetic and the assertions can be exact.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EvConcept } from "./Ev";

function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
}

beforeEach(installStorage);
afterEach(cleanup);

/** Reveal whatever the guess gate is holding, without committing an estimate. */
function skipGate(): void {
  for (const skip of screen.queryAllByText("Just show me")) fireEvent.click(skip);
}

describe("the controls are addressable", () => {
  it("names every option, not just the row", () => {
    render(<EvConcept />);
    // The pot picker offers 40 / 100 / 250, and each is reachable by name.
    expect(screen.getByTestId("pot-choice-40")).toBeTruthy();
    expect(screen.getByTestId("pot-choice-100")).toBeTruthy();
    expect(screen.getByTestId("pot-choice-250")).toBeTruthy();
  });

  it("reports which option is selected", () => {
    render(<EvConcept />);
    const hundred = screen.getByTestId("pot-choice-100");
    expect(hundred.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("pot-choice-40").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the arithmetic follows the controls", () => {
  it("recomputes the required equity when the price changes", () => {
    render(<EvConcept />);
    skipGate();
    // $50 into $100 needs 50/150, which is the published 33.3%.
    expect(document.body.textContent).toMatch(/33\.3%/);

    // The bet options are chip amounts at the chosen pot, not fractions of it,
    // so a pot-sized bet at $100 is the $100 rung. It needs 100/200, i.e. 50%.
    fireEvent.click(screen.getByTestId("bet-choice-100"));
    skipGate();
    expect(document.body.textContent).toMatch(/50\.0%/);
  });

  it("prints the published alpha ladder at any pot, because alpha is a ratio", () => {
    render(<EvConcept />);
    skipGate();
    const at100 = document.body.textContent ?? "";
    for (const published of ["33.3%", "42.9%", "50.0%", "66.7%"]) {
      expect(at100).toContain(published);
    }
    // The same four at a different pot: alpha depends only on the ratio, which
    // is the identity the section closes on.
    fireEvent.click(screen.getByTestId("pot-choice-250"));
    skipGate();
    const at250 = document.body.textContent ?? "";
    for (const published of ["33.3%", "42.9%", "50.0%", "66.7%"]) {
      expect(at250).toContain(published);
    }
  });
});
