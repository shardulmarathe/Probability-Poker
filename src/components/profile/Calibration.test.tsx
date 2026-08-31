// @vitest-environment jsdom
/**
 * The one number this product reports that a solver cannot.
 *
 * EV lost is what every trainer reports and a solver reports it better. How well
 * somebody knows what they do not know is the claim that falls out of a
 * probability course, and it is measured here from guesses committed on the
 * concepts page. What these tests hold is the honesty bar: below three estimates
 * the card is absent rather than confident, and the direction word is derived
 * from the sign convention rather than guessed at by the surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CalibrationCard, MIN_CALIBRATION_GUESSES } from "./Calibration";
import { CALIBRATION_VERSION } from "../../lib/calibration";

const KEY = "pp.calibration.v1";

function installStorage(seed?: unknown): void {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(KEY, JSON.stringify(seed));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
}

const entry = (over: Record<string, number> = {}) => ({
  count: 7,
  meanSignedError: 0.062,
  meanAbsError: 0.081,
  updatedAt: 1,
  ...over,
});

afterEach(cleanup);
beforeEach(() => installStorage());

describe("with nothing measured", () => {
  it("renders nothing at all rather than an empty card", () => {
    const { container } = render(<CalibrationCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on a corrupt row", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => "{not json", setItem: () => {}, removeItem: () => {} },
    });
    const { container } = render(<CalibrationCard />);
    expect(container.firstChild).toBeNull();
  });
});

describe("below the sample bar", () => {
  it("stays absent, because one guess is not a bias", () => {
    installStorage({
      version: CALIBRATION_VERSION,
      byKind: { equity: entry({ count: MIN_CALIBRATION_GUESSES - 1 }) },
      updatedAt: 1,
    });
    const { container } = render(<CalibrationCard />);
    expect(container.firstChild).toBeNull();
  });

  it("appears at the bar", () => {
    installStorage({
      version: CALIBRATION_VERSION,
      byKind: { equity: entry({ count: MIN_CALIBRATION_GUESSES }) },
      updatedAt: 1,
    });
    render(<CalibrationCard />);
    expect(screen.getByTestId("calibration")).toBeTruthy();
  });
});

describe("reporting a bias", () => {
  it("names the direction a positive signed error means", () => {
    // `calibration.ts` fixes error = guess - actual, so positive is estimating
    // high. For equity that reads as optimism, and the word belongs to the
    // surface rather than to the store.
    installStorage({
      version: CALIBRATION_VERSION,
      byKind: { equity: entry({ meanSignedError: 0.062 }) },
      updatedAt: 1,
    });
    render(<CalibrationCard />);
    const row = screen.getByTestId("calibration-equity").textContent ?? "";
    expect(row).toMatch(/6\.2 points optimistic/);
  });

  it("names the other direction for a negative one", () => {
    installStorage({
      version: CALIBRATION_VERSION,
      byKind: { equity: entry({ meanSignedError: -0.031 }) },
      updatedAt: 1,
    });
    render(<CalibrationCard />);
    expect(screen.getByTestId("calibration-equity").textContent).toMatch(
      /3\.1 points pessimistic/
    );
  });

  it("says well calibrated rather than naming a direction inside the noise", () => {
    installStorage({
      version: CALIBRATION_VERSION,
      byKind: { equity: entry({ meanSignedError: 0.004 }) },
      updatedAt: 1,
    });
    render(<CalibrationCard />);
    const row = screen.getByTestId("calibration-equity").textContent ?? "";
    expect(row).toMatch(/well calibrated/);
    expect(row).not.toMatch(/optimistic|pessimistic/);
  });

  it("reports each quantity separately", () => {
    installStorage({
      version: CALIBRATION_VERSION,
      byKind: {
        equity: entry({ meanSignedError: 0.062 }),
        "required-equity": entry({ meanSignedError: -0.031, count: 4 }),
      },
      updatedAt: 1,
    });
    render(<CalibrationCard />);
    expect(screen.getByTestId("calibration-equity")).toBeTruthy();
    expect(screen.getByTestId("calibration-required-equity")).toBeTruthy();
  });

  it("states the sample the claim rests on", () => {
    installStorage({
      version: CALIBRATION_VERSION,
      byKind: { equity: entry({ count: 7 }) },
      updatedAt: 1,
    });
    render(<CalibrationCard />);
    expect(screen.getByTestId("calibration-equity").textContent).toMatch(/7 estimates/);
  });
});
