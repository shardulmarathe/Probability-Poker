/**
 * Precision reporting for Monte Carlo estimates.
 *
 * Every probability the engine shows is a sample mean over N Bernoulli trials,
 * so it carries sampling error. The review's Math tab quotes the crude
 * worst-case bound ±100/√N (which assumes p = 0.5); these helpers report the
 * actual interval for the estimate that was measured.
 */

/** z for a two-sided 95% interval, the only confidence level the UI reports. */
const Z_95 = 1.959964;

export interface Interval {
  lo: number;
  hi: number;
}

/**
 * Standard error of a sample proportion: √(p(1-p)/n).
 *
 * This is the textbook (Wald) error. It is what §2 of TECHNICAL_WRITEUP.md
 * derives, and it is fine for reporting a ± on a mid-range estimate, but it
 * collapses to 0 when p hits 0 or 1, which is why the interval below is not
 * built from it.
 */
export function standardError(p: number, n: number): number {
  if (n <= 0) return 0;
  return Math.sqrt((p * (1 - p)) / n);
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Preferred over the Wald interval p ± z·SE because it stays inside [0, 1] and
 * stays sensible at the extremes. That matters here: river equities are very
 * often exactly 0 or 1, where Wald reports a nonsensical zero-width interval
 * while Wilson still reflects the finite sample size.
 *
 * @param k successes observed
 * @param n trials
 */
export function wilsonInterval(k: number, n: number): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };

  const p = k / n;
  const z = Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  // At the extremes the bound is exactly 0 (or 1) in real arithmetic, but
  // center and halfWidth are equal only to within rounding, leaving ~1e-20
  // dust. Snap those two cases rather than clamping with an epsilon.
  return {
    lo: k === 0 ? 0 : Math.max(0, center - halfWidth),
    hi: k === n ? 1 : Math.min(1, center + halfWidth),
  };
}
