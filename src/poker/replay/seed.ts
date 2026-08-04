/**
 * Recovering the session seed a recorded hand was dealt from.
 *
 * A `TableHandReport` stores the *hand* seed, `handSeed(sessionSeed, n)`, but
 * `engine.deal` derives that value itself, from the table's session seed and
 * hand number. So to make the real engine deal a recorded hand, the session
 * seed has to be run backwards out of the recorded one.
 *
 * The alternative was to re-implement the deal inside the replay: shuffle from
 * `report.seed` directly and push the cards into a table. That works, and it is
 * why this file needs justifying, it buys one thing, which is that replay
 * exercises `startHand` and `deal` unmodified. A replay that re-implements the
 * deal cannot detect a change in the deal, and detecting exactly that is what
 * the fidelity check is for.
 *
 * The inversion is available because `hashSeed` folds its parts through
 * SplitMix32's finalizer, and that finalizer is a bijection on uint32, a
 * property `rng.ts` already relies on for its seeding. `mix32` is not exported,
 * so it is restated here; `seed.test.ts` pins the pair against the exported
 * `hashSeed` over the whole construction, which is the only claim that matters.
 */

import { hashSeed } from "../core/rng";

/** `hashSeed`'s starting accumulator, the golden-ratio constant it seeds with. */
const GOLDEN = 0x9e3779b9;

/** The two odd multipliers in SplitMix32's finalizer. */
const MUL_A = 0x21f0aaad;
const MUL_B = 0x735a2d97;

/**
 * Multiplicative inverse mod 2^32, by Newton iteration. Every odd number has
 * one, and five doublings take the two correct bits of `a` itself past 32.
 */
function inverseMod32(a: number): number {
  let x = a;
  for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(a, x));
  return x >>> 0;
}

const INV_A = inverseMod32(MUL_A);
const INV_B = inverseMod32(MUL_B);

/**
 * Undo `x ^= x >>> shift`.
 *
 * The top `shift` bits survive the xor untouched, so they recover the next
 * `shift` bits down, and so on. Iterating `x = y ^ (x >>> shift)` reaches a
 * fixed point once the shift has walked the full width.
 */
function unshiftXor(y: number, shift: number): number {
  let x = y >>> 0;
  for (let i = shift; i < 32; i += shift) x = (y ^ (x >>> shift)) >>> 0;
  return x >>> 0;
}

/**
 * SplitMix32's finalizer, as `rng.ts` writes it.
 *
 * Exported only so the test can assert the round trip directly. That check is
 * redundant with the one on `sessionSeedForHand`, and worth having anyway: it
 * localises a failure to the bijection rather than to the whole construction.
 */
export function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), MUL_A);
  x = Math.imul(x ^ (x >>> 15), MUL_B);
  return (x ^ (x >>> 15)) >>> 0;
}

/** Its inverse: `unmix32(mix32(x)) === x` for every uint32 `x`. */
export function unmix32(y: number): number {
  let x = unshiftXor(y >>> 0, 15);
  x = Math.imul(x, INV_B) >>> 0;
  x = unshiftXor(x, 15);
  x = Math.imul(x, INV_A) >>> 0;
  return unshiftXor(x, 16);
}

/**
 * A session seed `s` with `handSeed(s, handNumber) === handSeedValue`.
 *
 * Not *the* session seed the hand was originally dealt from, `hashSeed` is
 * two-to-one in neither direction but the pair `(seed, handNumber)` is free, so
 * this fixes the hand number and solves for the seed. It deals the same cards,
 * which is the entire requirement, and it makes the replay reproducible from
 * the report alone rather than from a session the report does not carry.
 */
export function sessionSeedForHand(
  handSeedValue: number,
  handNumber: number
): number {
  const target = handSeedValue >>> 0;
  const inner = (unmix32(target) ^ (handNumber | 0)) >>> 0;
  return (GOLDEN ^ unmix32(inner)) >>> 0;
}

/** Self-check used by the fidelity assertions and the tests. */
export function seedRecoveryHolds(
  handSeedValue: number,
  handNumber: number
): boolean {
  return (
    hashSeed(sessionSeedForHand(handSeedValue, handNumber), handNumber) ===
    (handSeedValue >>> 0)
  );
}
