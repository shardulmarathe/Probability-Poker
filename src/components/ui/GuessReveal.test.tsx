// @vitest-environment jsdom
/**
 * The retrieval gate under test.
 *
 * This is the first component suite in the repo, and it exists because the three
 * bugs found in the last round of work were all UI bugs that a green type check
 * and 973 logic tests could not see. What is checked here is behaviour a reader
 * depends on rather than markup: that the gate hides the value until it is
 * answered, that skipping is available and sticky, that the reported gap has the
 * right sign and direction, and that nothing is recorded when the reader skips.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { GuessReveal } from "./GuessReveal";
import { clearCalibration, loadCalibration } from "../../lib/calibration";
import { pct } from "../../lib/format";

/** Real localStorage is not in jsdom's default environment. */
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

/** Points rather than a percentage of a percentage, as both call sites do. */
const asPoints = (magnitude: number) => `${(magnitude * 100).toFixed(1)} points`;

function setup(actual = 0.484, extra: Record<string, unknown> = {}) {
  render(
    <GuessReveal
      label="equity against the field"
      actual={actual}
      format={(v) => pct(v, 1)}
      min={0}
      max={1}
      step={0.005}
      initial={0.5}
      kind="equity"
      testId="gate"
      {...extra}
    >
      <p data-testid="answer">the real figure</p>
    </GuessReveal>
  );
}

/** The shape production uses: a points gap and named directions. */
const production = {
  formatGap: asPoints,
  direction: ["optimistic", "pessimistic"] as const,
};

const slide = (to: number) =>
  fireEvent.change(screen.getByTestId("gate-input"), { target: { value: String(to) } });

beforeEach(() => {
  installStorage();
  clearCalibration();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("before an answer", () => {
  it("hides the value it is gating", () => {
    setup();
    expect(screen.queryByTestId("answer")).toBeNull();
  });

  it("offers both a commit and a way out", () => {
    setup();
    expect(screen.getByTestId("gate-commit")).toBeTruthy();
    expect(screen.getByTestId("gate-skip")).toBeTruthy();
  });

  it("labels the input, so it is reachable without sight of the layout", () => {
    setup();
    const input = screen.getByTestId("gate-input") as HTMLInputElement;
    expect(input.id).toBeTruthy();
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toContain("equity against the field");
  });

  it("records nothing yet", () => {
    setup();
    slide(0.7);
    expect(loadCalibration().byKind.equity).toBeUndefined();
  });
});

describe("committing an estimate", () => {
  it("reveals the gated value", () => {
    setup();
    slide(0.55);
    fireEvent.click(screen.getByTestId("gate-commit"));
    expect(screen.getByTestId("answer")).toBeTruthy();
  });

  it("reports the gap with its direction, not a right or wrong mark", () => {
    setup(0.484, production);
    slide(0.555);
    fireEvent.click(screen.getByTestId("gate-commit"));
    const result = screen.getByTestId("gate-result").textContent ?? "";
    // 55.5% against 48.4% is 7.1 points, and the direction word is the caller's.
    // The number and the direction both matter: "wrong" would teach nothing
    // about which way the reader leans.
    expect(result).toMatch(/7\.1 points optimistic/);
    expect(result).not.toMatch(/correct|incorrect|wrong|right/i);
  });

  it("names the other direction when the estimate came in low", () => {
    setup(0.484, production);
    slide(0.4);
    fireEvent.click(screen.getByTestId("gate-commit"));
    expect(screen.getByTestId("gate-result").textContent).toMatch(
      /8\.4 points pessimistic/
    );
  });

  it("falls back to the value formatter when no gap formatter is given", () => {
    // Both call sites pass one, so this pins the default rather than the
    // behaviour anyone relies on: the gap reads as a percentage of the same
    // quantity, which is why a points formatter is worth passing.
    setup(0.484);
    slide(0.555);
    fireEvent.click(screen.getByTestId("gate-commit"));
    expect(screen.getByTestId("gate-result").textContent).toMatch(/7\.1%/);
  });

  it("announces the result to a screen reader rather than only drawing it", () => {
    setup();
    slide(0.6);
    fireEvent.click(screen.getByTestId("gate-commit"));
    const result = screen.getByTestId("gate-result");
    expect(result.getAttribute("role")).toBe("status");
    expect(result.getAttribute("aria-live")).toBe("polite");
  });

  it("folds the guess into the stored calibration, signed guess minus actual", () => {
    setup(0.484);
    slide(0.555);
    fireEvent.click(screen.getByTestId("gate-commit"));
    const entry = loadCalibration().byKind.equity;
    expect(entry?.count).toBe(1);
    // Positive means the reader estimated high, which is the convention
    // `calibration.ts` fixes in its header.
    expect(entry?.meanSignedError).toBeCloseTo(0.071, 3);
  });
});

describe("skipping", () => {
  it("reveals the value", () => {
    setup();
    fireEvent.click(screen.getByTestId("gate-skip"));
    expect(screen.getByTestId("answer")).toBeTruthy();
  });

  it("records nothing, because no estimate was made", () => {
    setup();
    fireEvent.click(screen.getByTestId("gate-skip"));
    expect(loadCalibration().byKind.equity).toBeUndefined();
  });

  it("prints no result line, because there is no gap to report", () => {
    setup();
    fireEvent.click(screen.getByTestId("gate-skip"));
    expect(screen.queryByTestId("gate-result")).toBeNull();
  });
});

describe("re-arming", () => {
  it("asks again when the quantity changes", () => {
    const { rerender } = render(
      <GuessReveal
        label="equity"
        actual={0.4}
        format={(v) => pct(v, 1)}
        min={0}
        max={1}
        step={0.005}
        initial={0.5}
        kind="equity"
        resetKey="spot-a"
        testId="gate"
      >
        <p data-testid="answer">a</p>
      </GuessReveal>
    );
    fireEvent.click(screen.getByTestId("gate-commit"));
    expect(screen.getByTestId("answer")).toBeTruthy();

    rerender(
      <GuessReveal
        label="equity"
        actual={0.9}
        format={(v) => pct(v, 1)}
        min={0}
        max={1}
        step={0.005}
        initial={0.5}
        kind="equity"
        resetKey="spot-b"
        testId="gate"
      >
        <p data-testid="answer">b</p>
      </GuessReveal>
    );
    // A new spot is a new question, so the gate closes again.
    expect(screen.queryByTestId("answer")).toBeNull();
  });

  it("stays skipped across a change, because skip is a mode not an answer", () => {
    const props = (actual: number, resetKey: string) => ({
      label: "equity",
      actual,
      format: (v: number) => pct(v, 1),
      min: 0,
      max: 1,
      step: 0.005,
      initial: 0.5,
      kind: "equity" as const,
      resetKey,
      testId: "gate",
    });
    const { rerender } = render(
      <GuessReveal {...props(0.4, "a")}>
        <p data-testid="answer">a</p>
      </GuessReveal>
    );
    fireEvent.click(screen.getByTestId("gate-skip"));
    rerender(
      <GuessReveal {...props(0.9, "b")}>
        <p data-testid="answer">b</p>
      </GuessReveal>
    );
    // A reader who asked to be left alone is asked once, not once per spot.
    expect(screen.getByTestId("answer")).toBeTruthy();
  });
});

describe("storage failure", () => {
  it("still shows the reader their gap when the write is refused", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("quota", "QuotaExceededError");
        },
        removeItem: () => {},
      },
    });
    setup(0.5, production);
    slide(0.6);
    expect(() => fireEvent.click(screen.getByTestId("gate-commit"))).not.toThrow();
    expect(screen.getByTestId("gate-result").textContent).toMatch(/10\.0 points/);
  });
});
