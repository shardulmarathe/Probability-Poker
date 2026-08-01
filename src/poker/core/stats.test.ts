import { describe, expect, it } from "vitest";
import { standardError, wilsonInterval } from "./stats";

describe("standardError", () => {
  it("is maximal at p = 0.5", () => {
    const at50 = standardError(0.5, 1000);
    expect(at50).toBeGreaterThan(standardError(0.2, 1000));
    expect(at50).toBeGreaterThan(standardError(0.8, 1000));
    expect(at50).toBeCloseTo(0.5 / Math.sqrt(1000), 12);
  });

  it("shrinks as 1/sqrt(n)", () => {
    const a = standardError(0.5, 1000);
    const b = standardError(0.5, 4000);
    expect(a / b).toBeCloseTo(2, 10);
  });

  it("returns 0 for a degenerate sample size", () => {
    expect(standardError(0.5, 0)).toBe(0);
  });
});

describe("wilsonInterval", () => {
  it("brackets the point estimate", () => {
    const { lo, hi } = wilsonInterval(3500, 7000);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });

  it("stays inside [0, 1] at the extremes", () => {
    const none = wilsonInterval(0, 5000);
    expect(none.lo).toBe(0);
    expect(none.hi).toBeGreaterThan(0);
    expect(none.hi).toBeLessThan(0.01);

    const all = wilsonInterval(5000, 5000);
    expect(all.hi).toBe(1);
    expect(all.lo).toBeLessThan(1);
    expect(all.lo).toBeGreaterThan(0.99);
  });

  it("has non-zero width at p = 0 where Wald would collapse", () => {
    // The whole reason Wilson is used: Wald gives p ± z·√(0/n) = a point.
    expect(standardError(0, 5000)).toBe(0);
    const w = wilsonInterval(0, 5000);
    expect(w.hi - w.lo).toBeGreaterThan(0);
  });

  it("matches the published value for 5 successes in 50 trials", () => {
    // Standard worked example: 95% Wilson for 10% on n=50 is ~(0.0435, 0.2136).
    const { lo, hi } = wilsonInterval(5, 50);
    expect(lo).toBeCloseTo(0.0435, 3);
    expect(hi).toBeCloseTo(0.2136, 3);
  });

  it("narrows as n grows", () => {
    const small = wilsonInterval(500, 1000);
    const large = wilsonInterval(5000, 10000);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });

  it("degenerates to the full range with no trials", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("wilsonInterval against the closed form", () => {
  it("matches the roots of the score equation it is derived from", () => {
    // Wilson's bounds are the two solutions of (p̂ − p)² = z²·p(1−p)/n. Solving
    // that quadratic independently is a genuine cross-check of the formula
    // rather than a restatement of the implementation.
    const z = 1.959964;
    for (const [k, n] of [
      [5, 50],
      [1, 3],
      [37, 100],
      [999, 1000],
      [123456, 500000],
    ] as const) {
      const p = k / n;
      const a = 1 + (z * z) / n;
      const b = -(2 * p + (z * z) / n);
      const c = p * p;
      const disc = Math.sqrt(b * b - 4 * a * c);
      const { lo, hi } = wilsonInterval(k, n);
      expect(lo).toBeCloseTo((-b - disc) / (2 * a), 9);
      expect(hi).toBeCloseTo((-b + disc) / (2 * a), 9);
    }
  });
});
