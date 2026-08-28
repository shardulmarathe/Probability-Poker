/**
 * One slice of a belief-weighted Monte Carlo run, off the main thread.
 *
 * The shard *logic* lives here rather than in the pool because the pool holds
 * the `new Worker(new URL(...))` reference to this file, importing the pool
 * back would make the two modules a bundling cycle. So this module is the unit
 * of work, and `pool.ts` is only the scheduler. The pool imports `runShard`
 * directly for its in-process fallback, which is what makes the two paths
 * numerically identical by construction rather than by careful duplication.
 */

import { makeRng } from "../poker/core/rng";
import {
  runMultiwayCountsFromCodes,
  type MultiwayCounts,
} from "../poker/equity/multiway";
import {
  runBeliefCountsFromCodes,
  type MonteCarloCounts,
} from "../poker/monteCarlo";
import type { Range } from "../poker/model/range";
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

/**
 * A slice of a multiway run. Same wire discipline, one hero against a field.
 *
 * `kind` is the discriminator, and only this job carries it: `ShardJob` shipped
 * first and had no tag, so its *absence* is what identifies a heads-up job.
 * That keeps every existing caller and every existing message on the wire valid
 * unchanged.
 */
export interface MultiwayShardJob {
  kind: "multiway";
  id: number;
  heroHole: Uint8Array;
  board: Uint8Array;
  pool: Uint8Array;
  /**
   * One weight per hole-card combo per seat, index-aligned with the caller's
   * opponent list rather than keyed by seat id.
   *
   * 10.6 KB per seat on the wire against the 40 bytes a `BeliefDistribution[]`
   * cost, which is the price of the migration's whole point: a tier label
   * cannot express "this opponent has two pair on *this* board", and a weight
   * per combo can. Structured clone handles a `Float64Array` natively, and the
   * shard that receives it builds its own alias table.
   */
  ranges: Range[];
  sims: number;
  seed: number;
}

export interface MultiwayShardResult extends MultiwayCounts {
  id: number;
}

export type AnyShardJob = ShardJob | MultiwayShardJob;
export type AnyShardResult = ShardResult | MultiwayShardResult;

/**
 * Posted once, unprompted, the moment this module can answer a job.
 *
 * The pool needs to tell a worker that is still fetching and compiling its
 * module graph from one that has loaded and gone quiet, because the honest
 * response to the two is opposite: wait for the first, retire the second.
 * Nothing on the wire distinguished them before this message existed, so the
 * pool's shard deadline was timing healthy workers out mid-boot. See
 * `equity/pool.ts`'s `WORKER_BOOT_MS`.
 */
export interface WorkerReady {
  ready: true;
}

/** Everything a worker can send: one boot announcement, then shard results. */
export type WorkerMessage = AnyShardResult | WorkerReady;

export function isWorkerReady(msg: WorkerMessage): msg is WorkerReady {
  return (msg as WorkerReady).ready === true;
}

export function isMultiwayJob(job: AnyShardJob): job is MultiwayShardJob {
  return (job as MultiwayShardJob).kind === "multiway";
}

export function runShard(job: ShardJob): ShardResult {
  // The Monte Carlo runs on codes internally, so the wire format is already
  // the format it wants, no decode/re-encode round trip here.
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

export function runMultiwayShard(job: MultiwayShardJob): MultiwayShardResult {
  const counts = runMultiwayCountsFromCodes(
    job.heroHole,
    job.board,
    job.pool,
    job.ranges,
    job.sims,
    makeRng(job.seed)
  );
  return { id: job.id, ...counts };
}

/** Dispatch on the tag so one worker serves both job types. */
export function runAnyShard(job: AnyShardJob): AnyShardResult {
  return isMultiwayJob(job) ? runMultiwayShard(job) : runShard(job);
}

// Only install the message handler when this really is a worker: the main
// thread imports the module too (for the fallback), and Node/vitest has no
// `self` at all. `document` is the cheap discriminator that needs no lib
// beyond DOM, lib.webworker conflicts with lib.dom in one program.
if (typeof self !== "undefined" && typeof document === "undefined") {
  // DOM types `self` as a Window, whose `postMessage` takes a target origin.
  // Narrow it to the dedicated-worker shape locally.
  const ctx = self as unknown as {
    postMessage(message: WorkerMessage): void;
    addEventListener(
      type: "message",
      handler: (event: MessageEvent<AnyShardJob>) => void
    ): void;
  };
  ctx.addEventListener("message", (event) =>
    ctx.postMessage(runAnyShard(event.data))
  );
  // Announced after the handler is installed, never before: `ready` has to mean
  // "a job posted now will be answered", not "this module is halfway through
  // evaluating". Jobs that arrived during boot are already queued on the port
  // behind this message, so nothing is lost by saying so late.
  ctx.postMessage({ ready: true });
}
