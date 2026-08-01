import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mergeShards, planShards, runEquity, runEquitySync } from "./pool";
import {
  runShard,
  type ShardJob,
  type ShardResult,
} from "../../workers/equity.worker";
import { encodeCards } from "../core/card";
import { makeRng } from "../core/rng";
import { runBeliefMonteCarlo } from "../monteCarlo";
import { makeDeck, removeCards } from "../cards";
import { INITIAL_BELIEF } from "../../data/constants";
import type { Card } from "../../types";

/** A concrete decision to estimate: bot holds the first two cards of a shuffle. */
function job(seed: number, boardCards = 3, sims = 4000) {
  const deck = makeRng(seed).shuffle(makeDeck());
  const botHole = deck.slice(0, 2);
  const community = deck.slice(2, 2 + boardCards);
  const pool: Card[] = removeCards(makeDeck(), [...botHole, ...community]);
  return { botHole, community, pool, belief: INITIAL_BELIEF, sims, seed };
}

/**
 * Replay a job the way the worker path does: encode the cards, hand each shard
 * to `runShard`, and push both the job and the reply through `structuredClone`
 * — the one thing `postMessage` does that an in-process call does not.
 */
function viaWorkerTransport(j: ReturnType<typeof job>) {
  const wire = {
    botHole: encodeCards(j.botHole),
    community: encodeCards(j.community),
    pool: encodeCards(j.pool),
    belief: j.belief,
  };
  return mergeShards(
    planShards(j.sims, j.seed).map((s, i) => {
      const msg: ShardJob = { ...wire, id: i, sims: s.sims, seed: s.seed };
      return structuredClone(runShard(structuredClone(msg)));
    })
  );
}

describe("equity pool — sharding", () => {
  it("splits sims exactly, with a distinct seed per shard", () => {
    const shards = planShards(4001, 0xabc);
    expect(shards.reduce((n, s) => n + s.sims, 0)).toBe(4001);
    expect(shards.map((s) => s.sims)).toEqual([1001, 1000, 1000, 1000]);
    expect(new Set(shards.map((s) => s.seed)).size).toBe(shards.length);
  });

  it("drops empty shards but keeps the surviving seeds pinned to their index", () => {
    const two = planShards(2, 7);
    expect(two.map((s) => s.sims)).toEqual([1, 1]);
    // Shard 0 and 1 must draw the same streams they would in a full-size run.
    expect(two.map((s) => s.seed)).toEqual(
      planShards(400, 7)
        .slice(0, 2)
        .map((s) => s.seed)
    );
  });

  it("merges by summing counts, independent of the order shards arrive in", () => {
    const parts = planShards(3000, 5).map((s, i) => ({
      sims: s.sims,
      wins: 100 + i,
      losses: 200 + i,
      ties: 300 + i,
      freq: new Array(9).fill(i + 1),
    }));
    const merged = mergeShards(parts);
    const reversed = mergeShards([...parts].reverse());
    expect(merged).toEqual(reversed);
    expect(merged.simulations).toBe(3000);
    expect(merged.wins).toBe(100 + 101 + 102 + 103);
    expect(merged.pWin).toBeCloseTo(merged.wins / 3000, 12);
  });
});

describe("equity pool — determinism", () => {
  it("is a pure function of seed and sim count", () => {
    const j = job(0xc0ffee);
    expect(runEquitySync(j)).toEqual(runEquitySync(j));
  });

  it("gives different seeds different estimates", () => {
    // Same deal both times — `job(seed)` picks the cards from the seed too, so
    // varying it would compare two different scenarios and would still pass if
    // `job.seed` never reached the Monte Carlo stream at all.
    const deal = job(0xd1ce);
    const a = runEquitySync({ ...deal, seed: 1 });
    const b = runEquitySync({ ...deal, seed: 2 });
    expect(a.pWin).not.toBe(b.pWin);
    expect(a.wins).not.toBe(b.wins);
  });

  it("reports counts that add up to the sims requested", () => {
    const mc = runEquitySync(job(31, 4, 5000));
    expect(mc.simulations).toBe(5000);
    expect(mc.wins + mc.losses + mc.ties).toBe(5000);
    expect(mc.pWin + mc.pLoss + mc.pTie).toBeCloseTo(1, 12);
    const cats = Object.values(mc.categoryFrequencies) as number[];
    expect(cats.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("stays deterministic on every street, including a complete board", () => {
    for (const board of [0, 3, 4, 5]) {
      const j = job(90 + board, board, 2000);
      expect(runEquitySync(j)).toEqual(runEquitySync(j));
    }
  });
});

describe("equity pool — worker and in-process paths agree", () => {
  it("produces identical results across the message boundary", () => {
    for (const board of [0, 3, 4, 5]) {
      const j = job(0x5eed + board, board, 4000);
      expect(viaWorkerTransport(j)).toEqual(runEquitySync(j));
    }
  });

  it("falls back in-process when there is no Worker (Node)", async () => {
    expect(typeof Worker).toBe("undefined");
    const j = job(0xfa11);
    await expect(runEquity(j)).resolves.toEqual(runEquitySync(j));
  });
});

describe("equity pool — sharding vs a single stream", () => {
  it("agrees with an unsharded run to within sampling error", () => {
    // Different streams, so not identical — but four shards of one estimator
    // must still estimate the same quantity.
    const j = job(0xbeef, 3, 40000);
    const sharded = runEquitySync(j);
    const single = runBeliefMonteCarlo(
      j.botHole,
      j.community,
      j.pool,
      j.belief,
      j.sims,
      makeRng(j.seed)
    );
    // Two independent 40k estimates: the SE of their difference is ~0.0035, so
    // `toBeCloseTo(x, 2)` (±0.005) is only 1.4 SE — a coin flip on the tail.
    // 4 SE is a real assertion; the CI brackets below are the sharp ones.
    expect(Math.abs(sharded.pWin - single.pWin)).toBeLessThan(0.014);
    expect(sharded.ciWin.lo).toBeLessThan(single.pWin);
    expect(sharded.ciWin.hi).toBeGreaterThan(single.pWin);
  });
});

// ---- Fake worker ----------------------------------------------------------

/** How a fake worker answers: normally, newest-first, never, or by dying. */
type Behavior = "reply" | "reverse" | "silent" | "error";

const fake = {
  behavior: "reply" as Behavior,
  /** Constructor throws from this build index on; `Infinity` = never. */
  throwFrom: Infinity,
  built: 0,
  live: 0,
  /** Shard seeds each worker was handed, in dispatch order. */
  routed: [] as number[][],
};

function resetFake(): void {
  fake.behavior = "reply";
  fake.throwFrom = Infinity;
  fake.built = 0;
  fake.live = 0;
  fake.routed = [];
}

/**
 * Speaks the real worker's protocol — a `ShardJob` in, a structured-cloned
 * `ShardResult` back on `onmessage` — but answers on a timer so shards land in
 * an order the pool did not choose. It can also be told to stay silent or to
 * die, the two failure modes the pool has to survive.
 */
class FakeWorker {
  onmessage: ((e: { data: ShardResult }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private readonly slot: number;
  private held: ShardResult[] = [];
  private dead = false;

  constructor(_url: URL, _opts?: { type?: string }) {
    // What Chrome does when the page's CSP forbids the worker URL.
    if (fake.built >= fake.throwFrom) {
      throw new Error("SecurityError: violates the document's worker-src");
    }
    this.slot = fake.built++;
    fake.live++;
    fake.routed[this.slot] = [];
  }

  postMessage(job: ShardJob): void {
    fake.routed[this.slot].push(job.seed);
    if (fake.behavior === "silent") return;
    if (fake.behavior === "error") {
      setTimeout(() => {
        if (!this.dead) this.onerror?.(new Error("worker died"));
      }, 1);
      return;
    }
    const reply = structuredClone(runShard(structuredClone(job)));
    if (fake.behavior === "reverse") {
      // Dispatch is synchronous, so the whole batch is in hand before this
      // timer fires — and every reply comes back newest-first.
      this.held.push(reply);
      setTimeout(() => {
        const batch = this.held.reverse();
        this.held = [];
        if (!this.dead) for (const r of batch) this.onmessage?.({ data: r });
      }, 2);
      return;
    }
    setTimeout(() => {
      if (!this.dead) this.onmessage?.({ data: reply });
    }, Math.random() * 6);
  }

  /** A terminated worker delivers nothing more — not a reply, not an error. */
  terminate(): void {
    if (this.dead) return;
    this.dead = true;
    fake.live--;
  }
}

/** Mirrors `workerCount()`: min(SHARDS, max(1, cores - 1)), SHARDS = 4. */
function workersFor(cores: number): number {
  return Math.min(4, Math.max(1, cores - 1));
}

/**
 * A pool module with its own worker state. The pool caches its workers and
 * latches failures in module scope, so each test needs a fresh instance.
 */
async function freshPool(cores: number): Promise<typeof import("./pool")> {
  resetFake();
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("navigator", { hardwareConcurrency: cores });
  vi.resetModules();
  return import("./pool");
}

describe("equity pool — worker path", () => {
  const warnings: unknown[][] = [];

  beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    warnings.length = 0;
  });
  // Leave `Worker`/`navigator` undefined again — other tests assert on that.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const smallJob = (seed: number) => job(seed, 3, 1200);

  it("hands each shard to `i % ws.length` and matches the in-process run", async () => {
    const pool = await freshPool(5); // 4 workers, one shard apiece
    const j = smallJob(0x51e0);
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(4);
    expect(fake.routed.map((r) => r.length)).toEqual([1, 1, 1, 1]);
    expect(fake.routed.flat()).toEqual(
      planShards(j.sims, j.seed).map((s) => s.seed)
    );
  });

  it("returns the same numbers whatever the core count", async () => {
    const j = smallJob(0x0c0e5);
    const expected = runEquitySync(j);
    const seeds = planShards(j.sims, j.seed).map((s) => s.seed);
    for (const cores of [1, 2, 3, 5, 16]) {
      const pool = await freshPool(cores);
      await expect(pool.runEquity(j)).resolves.toEqual(expected);
      const n = workersFor(cores);
      expect(fake.built).toBe(n);
      expect(fake.routed).toHaveLength(n);
      // Every shard dispatched exactly once, to the worker its index picks.
      expect(fake.routed.flat()).toHaveLength(seeds.length);
      seeds.forEach((seed, i) => expect(fake.routed[i % n]).toContain(seed));
    }
  });

  it("correlates replies by id when they come back newest-first", async () => {
    const pool = await freshPool(1); // one worker takes all four shards
    fake.behavior = "reverse";
    const j = smallJob(0xbadc0de);
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.routed).toEqual([planShards(j.sims, j.seed).map((s) => s.seed)]);
  });

  it("merges in shard order however the replies race", async () => {
    const j = smallJob(0x1717);
    const expected = runEquitySync(j);
    // Delivery jitter is random, so repeat: any completion order, same answer.
    for (let run = 0; run < 8; run++) {
      const pool = await freshPool(8);
      await expect(pool.runEquity(j)).resolves.toEqual(expected);
    }
  });

  it("falls back when `new Worker` throws, and keeps no partial pool", async () => {
    const pool = await freshPool(5);
    fake.throwFrom = 2; // two build, the third is refused
    const j = smallJob(0xc5b);
    // This used to reject: `ensureWorkers` ran outside the try, so the throw
    // escaped `runEquity` entirely.
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(2);
    expect(fake.live).toBe(0); // the two that were built got terminated

    // A CSP verdict does not change, so no retry — and with no half-filled
    // `workers` array left behind, the second call cannot accidentally succeed.
    fake.throwFrom = Infinity;
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(2);
    expect(warnings.some((w) => String(w[0]).includes("construction failed"))).toBe(
      true
    );
  });

  it("times out a worker that never replies instead of hanging", async () => {
    const pool = await freshPool(5);
    fake.behavior = "silent";
    const j = smallJob(0x51e7);
    // `onerror` never fires here — only the per-shard deadline settles this.
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(4); // the shards really were dispatched...
    expect(fake.routed.flat()).toHaveLength(4);
    expect(fake.live).toBe(0); // ...and the deadline retired the pool
  });

  it("rebuilds the pool once after a worker error", async () => {
    const pool = await freshPool(5);
    fake.behavior = "error";
    const j = smallJob(0xe12);
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(4);
    expect(fake.live).toBe(0); // retire() terminated them

    // One transient failure must not push every later decision onto the main
    // thread for the life of the page.
    fake.behavior = "reply";
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(8);
    expect(fake.live).toBe(4);
  });

  it("gives up for good after the rebuild fails too, and says so", async () => {
    const pool = await freshPool(5);
    fake.behavior = "error";
    const j = smallJob(0xe13);
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(8);

    fake.behavior = "reply";
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(8); // no third pool
    expect(warnings.some((w) => String(w[0]).includes("failed twice"))).toBe(
      true
    );
  });
});
