/**
 * Worker pool for the bot's equity estimate.
 *
 * A decision's Monte Carlo run is split into a fixed number of shards, each
 * with its own derived seed, and the shards are spread across a small set of
 * long-lived workers. Splitting the run is what buys the extra samples; keeping
 * the workers alive is what makes it worth doing at all, spawning a worker
 * costs more than the whole run.
 */

import {
  isWorkerReady,
  runMultiwayShard,
  runShard,
  type AnyShardJob,
  type AnyShardResult,
  type MultiwayShardJob,
  type MultiwayShardResult,
  type ShardJob,
  type ShardResult,
  type WorkerMessage,
} from "../../workers/equity.worker";
import { encodeCards } from "../core/card";
import { hashSeed } from "../core/rng";
import { finalizeCounts, type MonteCarloCounts } from "../monteCarlo";
import {
  finalizeMultiway,
  mergeMultiwayCounts,
  rangesFor,
  remainingPool,
} from "./multiway";
import type { BeliefDistribution, Card, MonteCarloResult } from "../../types";
import type { EquityRequest, MultiwayEquity } from "../table/contract";

export interface EquityJob {
  botHole: Card[];
  community: Card[];
  pool: Card[];
  belief: BeliefDistribution;
  sims: number;
  /** Base seed. Shard i draws from `hashSeed(seed, i)`. */
  seed: number;
}

/**
 * The split is a constant, deliberately decoupled from the worker count: the
 * result must be a function of (seed, sims) alone, so a 2-core machine and a
 * 16-core one have to sum the same shards from the same streams. Cores only
 * decide who runs which shard, never what the shards are.
 */
const SHARDS = 4;
const CATEGORY_COUNT = 9;

export interface Shard {
  sims: number;
  seed: number;
}

/** Sims per shard; the remainder goes to the low shards so the total is exact. */
export function planShards(sims: number, seed: number): Shard[] {
  const base = Math.floor(sims / SHARDS);
  const extra = sims % SHARDS;
  const out: Shard[] = [];
  for (let i = 0; i < SHARDS; i++) {
    const n = base + (i < extra ? 1 : 0);
    // Seed stays keyed to i, so dropping empty shards cannot shift streams.
    if (n > 0) out.push({ sims: n, seed: hashSeed(seed, i) });
  }
  return out;
}

/**
 * Sum shard counts and normalize once. Integer addition, taken in shard order
 * rather than completion order, the merged numbers must not depend on which
 * worker happened to finish first.
 */
export function mergeShards(parts: MonteCarloCounts[]): MonteCarloResult {
  const total: MonteCarloCounts = {
    sims: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    freq: new Array<number>(CATEGORY_COUNT).fill(0),
  };
  for (const p of parts) {
    total.sims += p.sims;
    total.wins += p.wins;
    total.losses += p.losses;
    total.ties += p.ties;
    for (let i = 0; i < CATEGORY_COUNT; i++) total.freq[i] += p.freq[i];
  }
  return finalizeCounts(total);
}

// ---- Worker lifecycle -----------------------------------------------------

let workers: Worker[] | null = null;
let unavailable = false;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (r: AnyShardResult) => void; reject: (e: unknown) => void }
>();

/**
 * How many times the pool may be built. Worker failures are not always
 * permanent, an OOM-killed worker, a `postMessage` dropped across a bfcache
 * restore, and latching on the first one would push every later decision onto
 * the main thread for the life of the page. One rebuild; a second failure is
 * treated as real and the downgrade becomes permanent.
 */
const MAX_POOL_BUILDS = 2;
let poolBuilds = 0;

/**
 * Per-shard reply deadline. A worker that loads but never answers leaves the
 * decision unsettled forever, `onerror` catches a worker that crashes, not one
 * that is wedged (stalled module fetch, a message lost on bfcache restore). A
 * shard is ~9ms, so 400ms is ~40x the expected time: far outside any plausible
 * jitter, and still short enough that the sync fallback finishes well inside the
 * bot's ~1.2s thinking beat.
 */
const SHARD_TIMEOUT_MS = 400;

/**
 * A multiway shard scores one hand per seat where a heads-up shard scores two,
 * so its unit of work grows with the field and a fixed deadline would start
 * retiring healthy workers at a full table. Scaling by the opponent count keeps
 * the same ~40x headroom against the work actually dispatched.
 */
function multiwayTimeout(opponents: number): number {
  return SHARD_TIMEOUT_MS * Math.max(1, opponents);
}

/**
 * How long a shard waits for its worker to finish booting before it gives up
 * on the worker *for this decision only*.
 *
 * THE BUG THIS PREVENTS. The shard deadline used to start ticking at
 * `postMessage`, and for the first job a worker ever receives that is before
 * the worker has run a line of code: the browser is still fetching and
 * compiling the module graph behind `equity.worker.ts` (a dozen separate
 * requests against the dev server, one chunk in production). On a loaded
 * machine that is routinely longer than the 400ms a *shard* is allowed, so the
 * deadline fired on a perfectly healthy worker, `retire` terminated the whole
 * pool, and because `MAX_POOL_BUILDS` is 2 the second occurrence latched
 * `unavailable` for the life of the page. Every decision from the third on ran
 * on the main thread, which is exactly the stutter the fallback's own comment
 * warns about, and nothing in the UI said why.
 *
 * Measured against the dev server in a Rosetta-translated Chrome, which starves
 * the renderer much as a busy machine does: `shard 1` - the first dispatch of
 * the session - timed out, and so did `shard 5`, the first dispatch after the
 * one permitted rebuild. Two warnings, and the pool was gone for good inside
 * the first two decisions.
 *
 * A worker that has not booted is not a broken worker. Exceeding this grace
 * costs the decision its shards, it falls back in-process, which is what the
 * in-process path is for, and it costs tens of milliseconds. It does not
 * terminate anything and does not count against `MAX_POOL_BUILDS`, so the next
 * decision gets the workers that have since warmed up. Short on purpose for the
 * same reason: waiting longer buys nothing a fallback that already works cannot
 * give, and every millisecond of it is a bot sitting silent on the clock.
 */
const WORKER_BOOT_MS = 250;

/**
 * Boot state per worker, keyed off the worker itself so the pool stays a plain
 * `Worker[]` and `retire` needs no changes. Entries die with their worker.
 */
const bootState = new WeakMap<
  Worker,
  { ready: boolean; waiters: Array<() => void> }
>();

/**
 * Called for *any* message, not only the `ready` announcement: a shard result
 * proves the worker is up just as well, and that keeps the pool correct against
 * a cached worker bundle that predates the handshake.
 */
function markBooted(worker: Worker): void {
  const state = bootState.get(worker);
  if (!state || state.ready) return;
  state.ready = true;
  const waiting = state.waiters;
  state.waiters = [];
  for (const wake of waiting) wake();
}

function workerCount(): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  // Leave a core for the main thread; never more workers than there are shards.
  return Math.min(SHARDS, Math.max(1, (cores || 2) - 1));
}

function ensureWorkers(): Worker[] | null {
  if (unavailable) return null;
  if (workers) return workers;
  // Node (tests, scripts/*) has no `Worker`; the caller falls back in-process.
  if (typeof Worker === "undefined") {
    unavailable = true;
    return null;
  }
  if (poolBuilds >= MAX_POOL_BUILDS) {
    unavailable = true;
    return null;
  }
  poolBuilds++;
  // Build into a local: a half-filled pool must never be published, or the
  // scheduler indexes past its own workers on the next call.
  const built: Worker[] = [];
  try {
    for (let i = 0; i < workerCount(); i++) {
      const w = new Worker(
        new URL("../../workers/equity.worker.ts", import.meta.url),
        { type: "module" }
      );
      bootState.set(w, { ready: false, waiters: [] });
      w.onmessage = (e: MessageEvent<WorkerMessage>) => {
        markBooted(w);
        if (isWorkerReady(e.data)) return;
        const slot = pending.get(e.data.id);
        if (!slot) return;
        pending.delete(e.data.id);
        slot.resolve(e.data);
      };
      w.onerror = retire;
      built.push(w);
    }
  } catch (err) {
    // `new Worker` throws synchronously when the page's CSP forbids the URL
    // (Chrome raises `SecurityError`). That verdict will not change on a retry,
    // so unlike a runtime failure it is permanent from the first occurrence.
    for (const w of built) w.terminate();
    unavailable = true;
    // eslint-disable-next-line no-console
    console.warn(
      "equity: worker construction failed; decisions now run on the main thread",
      err
    );
    return null;
  }
  workers = built;
  return workers;
}

/**
 * A broken worker must not leave a decision hanging forever. Fail everything
 * in flight and drop the pool; the next call rebuilds it once, and only a
 * second failure downgrades the page for good.
 */
function retire(err: unknown): void {
  for (const w of workers ?? []) w.terminate();
  workers = null;
  for (const slot of pending.values()) slot.reject(err);
  pending.clear();
  if (!unavailable && poolBuilds >= MAX_POOL_BUILDS) {
    unavailable = true;
    // eslint-disable-next-line no-console
    console.warn(
      "equity: worker pool failed twice; decisions now run on the main thread",
      err
    );
  }
}

/**
 * `R` is asserted, not checked: `id` is unique per dispatch, so the reply keyed
 * to it is necessarily the answer to the job just sent, and a job's type fixes
 * its reply's type. Nothing on the wire is trusted beyond that correlation.
 *
 * Two deadlines, because there are two ways to be late and they deserve
 * different verdicts. Until the worker has announced itself, `WORKER_BOOT_MS`
 * runs and expiring it abandons this shard while leaving the pool alone. Once
 * it has, `timeoutMs` runs and expiring it means the worker took a job it could
 * answer and did not, which is what `retire` is for. Only one is ever armed.
 */
function dispatch<R extends AnyShardResult>(
  worker: Worker,
  job: AnyShardJob,
  timeoutMs: number
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Settling always cancels whichever deadline is armed, so a deadline can
    // only fire while this shard is genuinely outstanding.
    let settled = false;
    const settle = (): void => {
      settled = true;
      clearTimeout(timer);
    };
    const armShardDeadline = (): void => {
      timer = setTimeout(
        () => retire(new Error(`equity: shard ${job.id} timed out`)),
        timeoutMs
      );
    };

    const boot = bootState.get(worker);
    if (!boot || boot.ready) {
      armShardDeadline();
    } else {
      timer = setTimeout(() => {
        // Drop the slot rather than rejecting through it: the worker may still
        // boot and answer, and a reply with no slot is discarded for free.
        settle();
        pending.delete(job.id);
        reject(
          new Error(`equity: worker still booting, shard ${job.id} not waited on`)
        );
      }, WORKER_BOOT_MS);
      boot.waiters.push(() => {
        // The grace may already have expired and handed this shard to the
        // in-process path. Arming a shard deadline for a reply nobody is
        // waiting on any more would retire a healthy pool a beat later, which
        // is the very failure this whole handshake exists to stop.
        if (settled) return;
        clearTimeout(timer);
        armShardDeadline();
      });
    }

    pending.set(job.id, {
      resolve: (r) => {
        settle();
        resolve(r as R);
      },
      reject: (e) => {
        settle();
        reject(e);
      },
    });
    // Posted before the worker is up on purpose: the browser queues messages on
    // the port and delivers them once the module has evaluated, so the shard is
    // already running by the time `ready` comes back.
    worker.postMessage(job);
  });
}

// ---- Public entry points --------------------------------------------------

/**
 * Run every shard here, on the calling thread. It goes through the same encode
 * step and the same `runShard` the workers use, that is what makes the two
 * paths identical by construction rather than by keeping two copies in step.
 * (`id` only correlates replies, so it is unused on this path.)
 */
export function runEquitySync(job: EquityJob): MonteCarloResult {
  const wire = encodeJob(job);
  return mergeShards(
    planShards(job.sims, job.seed).map((s) =>
      runShard({ ...wire, id: 0, sims: s.sims, seed: s.seed })
    )
  );
}

/**
 * Run the shards across the worker pool, falling back to `runEquitySync` when
 * there are no workers (Node) or the pool has failed. The numbers are identical
 * either way, but the fallback is not free and not invisible: it blocks the
 * calling thread for the whole run, ~36ms preflop, ~23ms on the flop, i.e. two
 * or three dropped frames, worse on slower hardware.
 */
export async function runEquity(job: EquityJob): Promise<MonteCarloResult> {
  try {
    // Inside the try: `new Worker` can throw synchronously (CSP), and that has
    // to fall back like any other worker failure instead of escaping to the
    // caller, where it would strand the decision that awaited it.
    const ws = ensureWorkers();
    if (!ws || ws.length === 0) return runEquitySync(job);

    const wire = encodeJob(job);
    const shards = planShards(job.sims, job.seed);
    // `Promise.all` resolves in input order, so the merge sees shard order.
    const parts = await Promise.all(
      shards.map((s, i) =>
        dispatch<ShardResult>(
          ws[i % ws.length],
          { ...wire, id: nextId++, sims: s.sims, seed: s.seed },
          SHARD_TIMEOUT_MS
        )
      )
    );
    return mergeShards(parts);
  } catch (err) {
    // Swallowing this silently hides a real main-thread stall; say so once per
    // failed decision, which `retire`'s latch bounds to a handful of lines.
    // eslint-disable-next-line no-console
    console.warn("equity: shard dispatch failed; running in-process", err);
    return runEquitySync(job);
  }
}

/** Encode once per job; every shard clones the same compact arrays. */
function encodeJob(job: EquityJob): Omit<ShardJob, "id" | "sims" | "seed"> {
  return {
    botHole: encodeCards(job.botHole),
    community: encodeCards(job.community),
    pool: encodeCards(job.pool),
    belief: job.belief,
  };
}

// ---- Multiway -------------------------------------------------------------
//
// The same scheduler, a different unit of work. Shards are planned by the same
// `planShards`, so a multiway run inherits the property that matters: the split
// is a function of (seed, sims) alone and never of the machine's core count.

/**
 * Resolve the request into the wire shape once: seat-keyed ranges become an
 * index-aligned array, and the deck-minus-what-is-visible pool is derived here
 * rather than being carried in the request, so a caller cannot desynchronize
 * the two.
 *
 * Once per job, not once per shard. `rangesFor` classifies the board and copies
 * a 1326-slot range per seat; every shard then clones the same arrays, which is
 * also what makes the four shards provably see identical inputs.
 */
function encodeMultiwayJob(
  req: EquityRequest
): Omit<MultiwayShardJob, "id" | "sims" | "seed"> {
  return {
    kind: "multiway",
    heroHole: Uint8Array.from(req.heroHole),
    board: Uint8Array.from(req.board),
    pool: remainingPool(req.heroHole, req.board),
    ranges: rangesFor(req),
  };
}

/** Every shard on the calling thread, through the same `runMultiwayShard` the
 * workers use, the two paths are identical by construction, not by upkeep. */
export function runMultiwayEquitySync(req: EquityRequest): MultiwayEquity {
  const wire = encodeMultiwayJob(req);
  const parts = planShards(req.simulations, req.seed).map((s) =>
    runMultiwayShard({ ...wire, id: 0, sims: s.sims, seed: s.seed })
  );
  return finalizeMultiway(
    mergeMultiwayCounts(parts, req.opponents.length),
    req.opponents
  );
}

/**
 * The multiway run across the worker pool, falling back to
 * `runMultiwayEquitySync` when there are no workers (Node) or the pool has
 * failed. Same numbers either way; the fallback blocks the calling thread and
 * costs roughly (opponents + 1) / 2 times what a heads-up run does.
 */
export async function runMultiwayEquity(
  req: EquityRequest
): Promise<MultiwayEquity> {
  try {
    // Inside the try for the same reason the heads-up path is: `new Worker` can
    // throw synchronously under CSP, and that must fall back rather than
    // stranding the decision that awaited it.
    const ws = ensureWorkers();
    if (!ws || ws.length === 0) return runMultiwayEquitySync(req);

    const wire = encodeMultiwayJob(req);
    const shards = planShards(req.simulations, req.seed);
    const timeout = multiwayTimeout(req.opponents.length);
    // `Promise.all` resolves in input order, so the merge sees shard order.
    const parts = await Promise.all(
      shards.map((s, i) =>
        dispatch<MultiwayShardResult>(
          ws[i % ws.length],
          { ...wire, id: nextId++, sims: s.sims, seed: s.seed },
          timeout
        )
      )
    );
    return finalizeMultiway(
      mergeMultiwayCounts(parts, req.opponents.length),
      req.opponents
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "equity: multiway shard dispatch failed; running in-process",
      err
    );
    return runMultiwayEquitySync(req);
  }
}
