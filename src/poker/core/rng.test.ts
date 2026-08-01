import { describe, it, expect } from "vitest";
import { makeRng, hashSeed } from "./rng";

function take(seed: number, count: number): number[] {
  const rng = makeRng(seed);
  return Array.from({ length: count }, () => rng.next());
}

describe("makeRng", () => {
  it("matches a reference xoshiro128** implementation exactly", () => {
    // Known-answer test. Every other assertion here is statistical, so a
    // swapped state index or a wrong rotate constant would still yield a
    // perfectly good PRNG and pass silently — only pinned output catches it.
    // These five words were produced by an independent BigInt port of
    // xoshiro128** + SplitMix32 written from the algorithm spec.
    const rng = makeRng(12345);
    // next() = u32 / 2^32; scaling by a power of two is exact in IEEE754, so
    // this recovers the raw 32-bit outputs without rounding error.
    const raw = Array.from({ length: 5 }, () => rng.next() * 4294967296);
    expect(raw).toEqual([
      1093274547, 203003357, 3741353573, 3803725158, 4178738660,
    ]);
  });

  it("produces identical sequences for the same seed", () => {
    expect(take(12345, 100)).toEqual(take(12345, 100));
  });

  it("diverges for different seeds", () => {
    const a = take(1, 50);
    const b = take(2, 50);
    expect(a).not.toEqual(b);
    // Adjacent seeds must not merely be offset copies of each other.
    expect(a.filter((v, i) => v === b[i]).length).toBe(0);
  });

  it("gives well-spread state even for degenerate seeds", () => {
    // Seed 0 is the case a naive seeding scheme degenerates on, so pin its
    // output too rather than relying on a near-unfalsifiable spread check.
    // Also cross-checked against the BigInt reference.
    const zero = makeRng(0);
    expect(Array.from({ length: 4 }, () => zero.next() * 4294967296)).toEqual([
      1789933344, 44971166, 2521387044, 3848737593,
    ]);

    for (const seed of [0, 1, -1]) {
      const first = take(seed, 8);
      expect(new Set(first).size).toBe(8);
    }
  });

  it("returns independent generators (no shared state)", () => {
    const a = makeRng(7);
    const b = makeRng(7);
    a.next();
    a.next();
    // b must be unaffected by a's draws.
    expect(b.next()).toBe(makeRng(7).next());
  });

  describe("next", () => {
    it("stays in [0, 1)", () => {
      const rng = makeRng(99);
      // Aggregate rather than assert per draw: 20k expect() calls cost ~300ms
      // and prove nothing more than the violation count does.
      let violations = 0;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < 20000; i++) {
        const v = rng.next();
        if (!(v >= 0 && v < 1)) violations++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      expect(violations).toBe(0);
      // Report the observed extremes too, so a failure says how far out it went.
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThan(1);
    });

    it("has a mean near 0.5", () => {
      const rng = makeRng(4242);
      let sum = 0;
      const n = 100000;
      for (let i = 0; i < n; i++) sum += rng.next();
      expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.01);
    });
  });

  describe("int", () => {
    it("stays in [0, n)", () => {
      const rng = makeRng(31337);
      for (const n of [2, 3, 7, 52, 1000]) {
        // Aggregated for speed; 25k expect() calls cost ~480ms for the same
        // information a violation count carries.
        let violations = 0;
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < 5000; i++) {
          const v = rng.int(n);
          if (!Number.isInteger(v) || v < 0 || v >= n) violations++;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        expect(violations, `int(${n}) out-of-range draws`).toBe(0);
        expect(min, `int(${n}) min`).toBeGreaterThanOrEqual(0);
        expect(max, `int(${n}) max`).toBeLessThan(n);
      }
    });

    it("collapses to 0 for degenerate n", () => {
      const rng = makeRng(5);
      expect(rng.int(1)).toBe(0);
      expect(rng.int(0)).toBe(0);
    });

    it("is roughly uniform over a large sample", () => {
      const rng = makeRng(2024);
      const buckets = 52;
      const draws = 520000;
      const counts = new Array<number>(buckets).fill(0);
      for (let i = 0; i < draws; i++) counts[rng.int(buckets)]++;

      expect(counts.every((c) => c > 0)).toBe(true);

      // Chi-square goodness of fit; 51 df has a ~0.1% critical value near 96,
      // so a bound of 150 is a loose sanity check rather than a tight test.
      const expected = draws / buckets;
      const chi2 = counts.reduce(
        (acc, c) => acc + ((c - expected) * (c - expected)) / expected,
        0
      );
      expect(chi2).toBeLessThan(150);
    });

    it("is uniform for n that does not divide 2^32 evenly", () => {
      const rng = makeRng(777);
      const buckets = 3;
      const draws = 300000;
      const counts = [0, 0, 0];
      for (let i = 0; i < draws; i++) counts[rng.int(buckets)]++;
      for (const c of counts) {
        expect(Math.abs(c - draws / buckets)).toBeLessThan(draws * 0.01);
      }
    });
  });

  describe("shuffle", () => {
    const source = Array.from({ length: 52 }, (_, i) => i);

    it("returns a permutation without mutating the input", () => {
      const input = source.slice();
      const out = makeRng(8).shuffle(input);
      expect(input).toEqual(source);
      expect(out).not.toBe(input);
      expect(out.slice().sort((a, b) => a - b)).toEqual(source);
    });

    it("actually reorders", () => {
      expect(makeRng(8).shuffle(source)).not.toEqual(source);
    });

    it("is identical for the same seed and differs across seeds", () => {
      expect(makeRng(63).shuffle(source)).toEqual(makeRng(63).shuffle(source));
      expect(makeRng(63).shuffle(source)).not.toEqual(
        makeRng(64).shuffle(source)
      );
    });

    it("handles empty and single-element arrays", () => {
      const rng = makeRng(1);
      expect(rng.shuffle([])).toEqual([]);
      expect(rng.shuffle(["a"])).toEqual(["a"]);
    });

    it("spreads each element across all positions", () => {
      // Position histogram for element 0 over many shuffles of [0..5].
      const small = [0, 1, 2, 3, 4, 5];
      const rng = makeRng(555);
      const positions = new Array<number>(6).fill(0);
      const runs = 60000;
      for (let i = 0; i < runs; i++) positions[rng.shuffle(small).indexOf(0)]++;
      for (const p of positions) {
        expect(Math.abs(p - runs / 6)).toBeLessThan(runs * 0.02);
      }
    });
  });
});

describe("hashSeed", () => {
  it("is deterministic", () => {
    expect(hashSeed(1, 2, 3)).toBe(hashSeed(1, 2, 3));
  });

  it("returns an unsigned 32-bit integer", () => {
    for (const parts of [[0], [1], [-1, 0], [2 ** 31, 7], []]) {
      const h = hashSeed(...parts);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("is order sensitive and avalanches on small changes", () => {
    expect(hashSeed(1, 2)).not.toBe(hashSeed(2, 1));
    expect(hashSeed(0, 0)).not.toBe(hashSeed(0, 1));
  });

  it("rarely collides across a large key space", () => {
    const seen = new Set<number>();
    for (let a = 0; a < 100; a++) {
      for (let b = 0; b < 100; b++) seen.add(hashSeed(a, b));
    }
    expect(seen.size).toBe(10000);
  });

  it("feeds distinct streams into makeRng", () => {
    const x = makeRng(hashSeed(1, 0)).next();
    const y = makeRng(hashSeed(1, 1)).next();
    expect(x).not.toBe(y);
  });
});
