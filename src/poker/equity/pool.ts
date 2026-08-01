/**
 * Worker pool for the bot's equity estimate.
 *
 * A decision's Monte Carlo run is split into a fixed number of shards, each
 * with its own derived seed, and the shards are spread across a small set of
 * long-lived workers. Splitting the run is what buys the extra samples; keeping
 * the workers alive is what makes it worth doing at all — spawning a worker
 * costs more than the whole run.
 */

import {
  runShard,
  type ShardJob,
  type ShardResult,
} from "../../workers/equity.worker";
import { encodeCards } from "../core/card";
import { hashSeed } from "../core/rng";
import { finalizeCounts, type MonteCarloCounts } from "../monteCarlo";
import type { BeliefDistribution, Card, MonteCarloResult } from "../../types";

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
 * rather than completion order — the merged numbers must not depend on which
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
  { resolve: (r: ShardResult) => void; reject: (e: unknown) => void }
>();

/**
 * How many times the pool may be built. Worker failures are not always
 * permanent — an OOM-killed worker, a `postMessage` dropped across a bfcache
 * restore — and latching on the first one would push every later decision onto
 * the main thread for the life of the page. One rebuild; a second failure is
 * treated as real and the downgrade becomes permanent.
 */
const MAX_POOL_BUILDS = 2;
let poolBuilds = 0;

/**
 * Per-shard reply deadline. A worker that loads but never answers leaves the
 * decision unsettled forever — `onerror` catches a worker that crashes, not one
 * that is wedged (stalled module fetch, a message lost on bfcache restore). A
 * shard is ~9ms, so 400ms is ~40x the expected time: far outside any plausible
 * jitter, and still short enough that the sync fallback finishes well inside the
 * bot's ~1.2s thinking beat.
 */
const SHARD_TIMEOUT_MS = 400;

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
      w.onmessage = (e: MessageEvent<ShardResult>) => {
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

function dispatch(worker: Worker, job: ShardJob): Promise<ShardResult> {
  return new Promise<ShardResult>((resolve, reject) => {
    const timer = setTimeout(
      () => retire(new Error(`equity: shard ${job.id} timed out`)),
      SHARD_TIMEOUT_MS
    );
    // Settling always cancels the deadline, so it can only fire while pending.
    pending.set(job.id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    worker.postMessage(job);
  });
}

// ---- Public entry points --------------------------------------------------

/**
 * Run every shard here, on the calling thread. It goes through the same encode
 * step and the same `runShard` the workers use — that is what makes the two
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
 * calling thread for the whole run — ~36ms preflop, ~23ms on the flop, i.e. two
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
        dispatch(ws[i % ws.length], {
          ...wire,
          id: nextId++,
          sims: s.sims,
          seed: s.seed,
        })
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
