/**
 * Seeded, deterministic RNG (xoshiro128** with SplitMix32 seeding).
 *
 * Every generator is independent, no module-level state, so each Monte Carlo
 * worker can own its own stream without coordinating with the others.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Fisher-Yates shuffle, returns a NEW array. */
  shuffle<T>(input: T[]): T[];
}

const TWO_32 = 4294967296;

/**
 * SplitMix32 finalizer: one avalanche round over a 32-bit word. It is a
 * bijection, which is what makes the seeding below safe (see `makeRng`).
 */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

/** Combine arbitrary integer parts into a well-mixed 32-bit seed. */
export function hashSeed(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) h = mix32(h ^ (p | 0));
  return h >>> 0;
}

export function makeRng(seed: number): Rng {
  // xoshiro's state must not be all-zero, and it mixes slowly out of a
  // low-entropy start, so expand the seed through SplitMix32 rather than
  // dropping it into the state directly. Advancing the Weyl counter before
  // mixing means seed 0 still yields four distinct, well-spread words; since
  // mix32 is injective at most one of them can be zero.
  const s = new Uint32Array(4);
  let w = seed | 0;
  for (let i = 0; i < 4; i++) {
    w = (w + 0x9e3779b9) | 0;
    s[i] = mix32(w);
  }

  /** Raw 32-bit output. Uint32Array stores handle the unsigned wrapping. */
  function u32(): number {
    const s1 = s[1];
    const q = Math.imul(s1, 5);
    const r = Math.imul((q << 7) | (q >>> 25), 9); // rotl(s1 * 5, 7) * 9
    const t = s1 << 9;
    s[2] ^= s[0];
    s[3] ^= s1;
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return r >>> 0;
  }

  function int(n: number): number {
    if (n <= 1) return 0;
    // `Math.floor(next() * n)` would be biased (and launders the draw through a
    // 53-bit float). Instead reject the ragged tail of the 32-bit range so the
    // surviving values are an exact multiple of n, then take the remainder.
    const limit = TWO_32 - (TWO_32 % n);
    let r = u32();
    while (r >= limit) r = u32();
    return r % n;
  }

  function shuffle<T>(input: T[]): T[] {
    const arr = input.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  return { next: () => u32() / TWO_32, int, shuffle };
}
