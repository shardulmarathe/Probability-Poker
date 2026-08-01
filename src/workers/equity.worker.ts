/**
 * One slice of a belief-weighted Monte Carlo run, off the main thread.
 *
 * The shard *logic* lives here rather than in the pool because the pool holds
 * the `new Worker(new URL(...))` reference to this file — importing the pool
 * back would make the two modules a bundling cycle. So this module is the unit
 * of work, and `pool.ts` is only the scheduler. The pool imports `runShard`
 * directly for its in-process fallback, which is what makes the two paths
 * numerically identical by construction rather than by careful duplication.
 */

import { makeRng } from "../poker/core/rng";
import {
  runBeliefCountsFromCodes,
  type MonteCarloCounts,
} from "../poker/monteCarlo";
import type { BeliefDistribution } from "../types";

/**
 * Cards cross the wire as 0..51 codes (see `poker/core/card`), so a job is a
 * few dozen bytes instead of a structured clone of ~55 `Card` objects.
 */
export interface ShardJob {
  /** Correlates the reply with its caller; workers reply out of order. */
  id: number;
  botHole: Uint8Array;
  community: Uint8Array;
  pool: Uint8Array;
  belief: BeliefDistribution;
  sims: number;
  seed: number;
}

export interface ShardResult extends MonteCarloCounts {
  id: number;
}

export function runShard(job: ShardJob): ShardResult {
  // The Monte Carlo runs on codes internally, so the wire format is already
  // the format it wants — no decode/re-encode round trip here.
  const counts = runBeliefCountsFromCodes(
    job.botHole,
    job.community,
    job.pool,
    job.belief,
    job.sims,
    makeRng(job.seed)
  );
  return { id: job.id, ...counts };
}

// Only install the message handler when this really is a worker: the main
// thread imports the module too (for the fallback), and Node/vitest has no
// `self` at all. `document` is the cheap discriminator that needs no lib
// beyond DOM — lib.webworker conflicts with lib.dom in one program.
if (typeof self !== "undefined" && typeof document === "undefined") {
  // DOM types `self` as a Window, whose `postMessage` takes a target origin.
  // Narrow it to the dedicated-worker shape locally.
  const ctx = self as unknown as {
    postMessage(result: ShardResult): void;
    addEventListener(
      type: "message",
      handler: (event: MessageEvent<ShardJob>) => void
    ): void;
  };
  ctx.addEventListener("message", (event) => ctx.postMessage(runShard(event.data)));
}
