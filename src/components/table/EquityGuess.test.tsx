// @vitest-environment jsdom
/**
 * The gate that sits on the felt.
 *
 * What matters here is the contract with a player who is on the clock: the
 * figure is hidden until they answer, one tap answers it, a new decision asks
 * again, and asking to be left alone is honoured for the rest of the session
 * rather than for one spot.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EquityGuess } from "./EquityGuess";
import { clearCalibration, loadCalibration } from "../../lib/calibration";

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

beforeEach(() => {
  installStorage();
  clearCalibration();
});
afterEach(cleanup);

describe("asking", () => {
  it("offers bands rather than a slider, so the row stays one row", () => {
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />);
    for (const band of ["<20", "20-35", "35-50", "50-65", ">65"]) {
      expect(screen.getByTestId(`equity-band-${band}`)).toBeTruthy();
    }
  });

  it("shows no figure before an answer", () => {
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />);
    expect(document.body.textContent).not.toMatch(/42/);
  });

  it("labels each band for a screen reader", () => {
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />);
    expect(screen.getByTestId("equity-band-35-50").getAttribute("aria-label")).toBe(
      "35-50 percent"
    );
  });
});

describe("answering", () => {
  it("reveals the figure and reports the gap", () => {
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />);
    fireEvent.click(screen.getByTestId("equity-band-20-35"));
    const line = screen.getByTestId("equity-guess-result").textContent ?? "";
    // The band answers for its midpoint, 27.5%, which is 14 points under 42%.
    expect(line).toMatch(/28%/);
    expect(line).toMatch(/42\.0%/);
    expect(line).toMatch(/14 points low/);
  });

  it("records against its own kind, not the concepts page's", () => {
    // A band's width floors the absolute error, so pooling the two would corrupt
    // the precision figure for both.
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />);
    fireEvent.click(screen.getByTestId("equity-band-50-65"));
    const stored = loadCalibration().byKind;
    expect(stored["table-equity"]?.count).toBe(1);
    expect(stored.equity).toBeUndefined();
  });

  it("keeps the sign convention: over the figure is positive", () => {
    render(<EquityGuess actual={0.3} decisionKey="d1" onResolved={() => {}} />);
    fireEvent.click(screen.getByTestId("equity-band-50-65"));
    // Midpoint 57.5% against 30% is +27.5 points.
    expect(loadCalibration().byKind["table-equity"]?.meanSignedError).toBeCloseTo(
      0.275,
      3
    );
  });

  it("announces the result rather than only drawing it", () => {
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />);
    fireEvent.click(screen.getByTestId("equity-band-35-50"));
    const el = screen.getByTestId("equity-guess-result");
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });

  it("tells the caller it is resolved, so Coach can take the row back", () => {
    let resolved = 0;
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => resolved++} />);
    fireEvent.click(screen.getByTestId("equity-band-35-50"));
    expect(resolved).toBe(1);
  });
});

describe("a new decision", () => {
  it("asks again", () => {
    const { rerender } = render(
      <EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />
    );
    fireEvent.click(screen.getByTestId("equity-band-35-50"));
    expect(screen.getByTestId("equity-guess-result")).toBeTruthy();

    rerender(<EquityGuess actual={0.7} decisionKey="d2" onResolved={() => {}} />);
    // A hand has several decisions and each is its own question.
    expect(screen.getByTestId("equity-guess")).toBeTruthy();
    expect(screen.queryByTestId("equity-guess-result")).toBeNull();
  });
});

describe("skipping", () => {
  it("records nothing, because no estimate was made", () => {
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => {}} />);
    fireEvent.click(screen.getByTestId("equity-guess-skip"));
    expect(loadCalibration().byKind["table-equity"]).toBeUndefined();
  });

  it("hands the row straight back", () => {
    let resolved = 0;
    render(<EquityGuess actual={0.42} decisionKey="d1" onResolved={() => resolved++} />);
    fireEvent.click(screen.getByTestId("equity-guess-skip"));
    expect(resolved).toBe(1);
  });

  it("is honoured for the session, not for one spot", () => {
    // A player who wants Coach to behave as it always has is asked once.
    let resolved = 0;
    const { rerender } = render(
      <EquityGuess actual={0.42} decisionKey="d1" onResolved={() => resolved++} />
    );
    fireEvent.click(screen.getByTestId("equity-guess-skip"));
    expect(resolved).toBe(1);

    rerender(<EquityGuess actual={0.7} decisionKey="d2" onResolved={() => resolved++} />);
    // Re-arming a skipped gate must resolve it again immediately rather than
    // putting the question back in front of somebody who declined it.
    expect(resolved).toBe(2);
  });
});
