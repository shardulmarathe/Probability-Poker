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
import {
  mergeShards,
  planShards,
  runEquity,
  runEquitySync,
  runMultiwayEquity,
  runMultiwayEquitySync,
} from "./pool";
import {
  runAnyShard,
  runMultiwayShard,
  runShard,
  type AnyShardJob,
  type AnyShardResult,
  type MultiwayShardJob,
  type ShardJob,
  type WorkerMessage,
} from "../../workers/equity.worker";
import { encodeCard, encodeCards } from "../core/card";
import { makeRng } from "../core/rng";
import { runBeliefMonteCarlo } from "../monteCarlo";
import { makeCard, makeDeck, removeCards } from "../cards";
import {
  finalizeMultiway,
  mergeMultiwayCounts,
  rangesFor,
  remainingPool,
  runMultiway,
} from "./multiway";
import {
  COMBO_COUNT,
  comboCardA,
  comboCardB,
  comboIndex,
  uniformRange,
  type Range,
} from "../model/range";
import { INITIAL_BELIEF } from "../../data/constants";
import type { BeliefDistribution, Card, RankValue, Suit } from "../../types";
import type { EquityRequest } from "../table/contract";

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
 *, the one thing `postMessage` does that an in-process call does not.
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

// ---- Multiway fixtures ----------------------------------------------------

const RANKS: Record<string, RankValue> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};
function codes(...s: string[]): number[] {
  return s.map((c) => encodeCard(makeCard(RANKS[c[0]], c[1] as Suit)));
}

/** A multiway decision: the hero against `n` seats with distinguishable reads. */
function multiwayJob(
  seed: number,
  n = 3,
  boardCards = 3,
  sims = 4000
): EquityRequest {
  const board = codes("Jh", "7c", "2d", "9s", "4h").slice(0, boardCards);
  const beliefs: Record<number, BeliefDistribution> = {};
  for (let i = 0; i < n; i++) {
    // Distinct per seat, so a bug that collapsed the field onto one belief or
    // shuffled the seat order would change the answer.
    beliefs[i + 1] = {
      weak: 0.2 + 0.1 * i,
      medium: 0.5 - 0.05 * i,
      strong: 0.3 - 0.05 * i,
    };
  }
  return {
    heroHole: codes("Qs", "Qd"),
    board,
    opponents: Array.from({ length: n }, (_, i) => i + 1),
    beliefs,
    simulations: sims,
    seed,
  };
}

/**
 * The same field, but with an explicit `Range` per seat instead of a three-tier
 * read, the shape `decider.ts` actually builds. Seat i tilts toward combos
 * whose low card code is congruent to i, which is arbitrary but distinguishable:
 * a bug that shared one range across the field, or shuffled the seat order,
 * changes the answer.
 */
function multiwayRangeJob(seed: number, n = 3, boardCards = 3, sims = 4000): EquityRequest {
  const base = multiwayJob(seed, n, boardCards, sims);
  const ranges: Record<number, Range> = {};
  base.opponents.forEach((id, i) => {
    const range = uniformRange();
    for (let c = 0; c < COMBO_COUNT; c++) {
      if ((comboCardA(c) + comboCardB(c)) % (n + 1) === i) range[c] *= 6;
    }
    ranges[id] = range;
  });
  return { ...base, ranges };
}

/** The multiway job replayed the way the worker path does, clones and all. */
function viaMultiwayWorkerTransport(req: EquityRequest) {
  const wire = {
    kind: "multiway" as const,
    heroHole: Uint8Array.from(req.heroHole),
    board: Uint8Array.from(req.board),
    pool: remainingPool(req.heroHole, req.board),
    ranges: rangesFor(req),
  };
  const parts = planShards(req.simulations, req.seed).map((s, i) => {
    const msg: MultiwayShardJob = { ...wire, id: i, sims: s.sims, seed: s.seed };
    return structuredClone(runMultiwayShard(structuredClone(msg)));
  });
  return finalizeMultiway(
    mergeMultiwayCounts(parts, req.opponents.length),
    req.opponents
  );
}

describe("equity pool: sharding", () => {
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

describe("equity pool: determinism", () => {
  it("is a pure function of seed and sim count", () => {
    const j = job(0xc0ffee);
    expect(runEquitySync(j)).toEqual(runEquitySync(j));
  });

  it("gives different seeds different estimates", () => {
    // Same deal both times, `job(seed)` picks the cards from the seed too, so
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

describe("equity pool: worker and in-process paths agree", () => {
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

describe("equity pool: sharding vs a single stream", () => {
  it("agrees with an unsharded run to within sampling error", () => {
    // Different streams, so not identical, but four shards of one estimator
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
    // `toBeCloseTo(x, 2)` (±0.005) is only 1.4 SE, a coin flip on the tail.
    // 4 SE is a real assertion; the CI brackets below are the sharp ones.
    expect(Math.abs(sharded.pWin - single.pWin)).toBeLessThan(0.014);
    expect(sharded.ciWin.lo).toBeLessThan(single.pWin);
    expect(sharded.ciWin.hi).toBeGreaterThan(single.pWin);
  });
});

describe("equity pool: multiway", () => {
  it("routes a multiway job through the same shard plan as a heads-up one", () => {
    // The split must stay a function of (seed, sims) only. A multiway job that
    // planned its own shards, by field size, say, would make the answer
    // depend on the table, and a 2-core machine disagree with a 16-core one.
    const req = multiwayJob(0x5a1, 4, 3, 4001);
    const plan = planShards(req.simulations, req.seed);
    expect(plan.map((s) => s.sims)).toEqual([1001, 1000, 1000, 1000]);
    expect(plan).toEqual(planShards(4001, req.seed));
  });

  it("produces identical results across the message boundary", () => {
    for (const board of [0, 3, 4, 5]) {
      for (const n of [1, 2, 5]) {
        const req = multiwayJob(0x3ee + board + n, n, board, 4000);
        expect(viaMultiwayWorkerTransport(req)).toEqual(
          runMultiwayEquitySync(req)
        );
      }
    }
  });

  it("carries explicit per-combo ranges across the message boundary too", () => {
    // 1326 Float64s per seat now cross `postMessage`, not three numbers. A
    // structured clone of a typed array is the one thing the in-process path
    // does not exercise, and the whole read rides on it.
    for (const board of [0, 3, 5]) {
      for (const n of [1, 3]) {
        const req = multiwayRangeJob(0x4ee + board + n, n, board, 4000);
        expect(viaMultiwayWorkerTransport(req)).toEqual(
          runMultiwayEquitySync(req)
        );
      }
    }
  });

  it("draws a pinned range's only combo and nothing else", () => {
    // End to end through the shard planner and the merge: a seat whose range
    // allows exactly one holding must be dealt exactly that holding, so the
    // hero's equity is the deterministic showdown against it.
    const req = multiwayJob(0x9111, 1, 5, 4000);
    const jacks = codes("Jd", "Js");
    const only = new Float64Array(COMBO_COUNT) as Range;
    only[comboIndex(jacks[0], jacks[1])] = 1;
    const r = runMultiwayEquitySync({ ...req, ranges: { 1: only } });
    // Hero QQ on J-7-2-9-4 against JJ: a set of jacks, every single time.
    expect(r.pWin).toBe(0);
    expect(r.pLoss).toBe(1);
    expect(r.simulations).toBe(4000);
  });

  it("is a pure function of seed, sims and the field", () => {
    const req = multiwayJob(0xc0c0, 3);
    expect(runMultiwayEquitySync(req)).toEqual(runMultiwayEquitySync(req));
    const other = runMultiwayEquitySync({ ...req, seed: req.seed + 1 });
    expect(other.wins).not.toBe(runMultiwayEquitySync(req).wins);
  });

  it("keeps every count and every seat key intact through the merge", () => {
    const req = multiwayJob(0x11, 4, 3, 5000);
    const r = runMultiwayEquitySync(req);
    expect(r.simulations).toBe(5000);
    expect(r.wins + r.ties + r.losses).toBe(5000);
    expect(r.pWin + r.pTie + r.pLoss).toBeCloseTo(1, 12);
    expect(r.equity).toBeGreaterThanOrEqual(r.pWin);
    expect(r.equity).toBeLessThanOrEqual(r.pWin + r.pTie);
    expect(Object.keys(r.perOpponent).map(Number)).toEqual(req.opponents);
  });

  it("falls back in-process when there is no Worker (Node)", async () => {
    expect(typeof Worker).toBe("undefined");
    const req = multiwayJob(0xfa12, 3);
    await expect(runMultiwayEquity(req)).resolves.toEqual(
      runMultiwayEquitySync(req)
    );
  });

  it("agrees with an unsharded run to within sampling error", () => {
    // Four shards of one estimator draw different streams, so not identical -
    // but they must still be estimating the same quantity.
    const req = multiwayJob(0xbee5, 3, 3, 40_000);
    const sharded = runMultiwayEquitySync(req);
    const single = runMultiway(req);
    expect(Math.abs(sharded.equity - single.equity)).toBeLessThan(0.014);
    expect(sharded.ciWin.lo).toBeLessThan(single.pWin);
    expect(sharded.ciWin.hi).toBeGreaterThan(single.pWin);
    for (const id of req.opponents) {
      expect(
        Math.abs(sharded.perOpponent[id] - single.perOpponent[id])
      ).toBeLessThan(0.014);
    }
  });

  it("leaves the heads-up path untouched", () => {
    // Both job types now share one worker, one pending map and one dispatcher;
    // the tag has to keep them apart in both directions.
    const j = job(0x4ead);
    const wire = {
      botHole: encodeCards(j.botHole),
      community: encodeCards(j.community),
      pool: encodeCards(j.pool),
      belief: j.belief,
    };
    const msg: ShardJob = { ...wire, id: 1, sims: 100, seed: 5 };
    expect(runAnyShard(msg)).toEqual(runShard(msg));

    const mw = multiwayJob(0x4eae, 2);
    const mwMsg: MultiwayShardJob = {
      kind: "multiway",
      heroHole: Uint8Array.from(mw.heroHole),
      board: Uint8Array.from(mw.board),
      pool: remainingPool(mw.heroHole, mw.board),
      ranges: rangesFor(mw),
      id: 2,
      sims: 100,
      seed: 5,
    };
    expect(runAnyShard(mwMsg)).toEqual(runMultiwayShard(mwMsg));
  });
});

// ---- Fake worker ----------------------------------------------------------

/** How a fake worker answers: normally, newest-first, never, or by dying. */
type Behavior = "reply" | "reverse" | "silent" | "error";

const fake = {
  behavior: "reply" as Behavior,
  /** Constructor throws from this build index on; `Infinity` = never. */
  throwFrom: Infinity,
  /**
   * Milliseconds a worker spends fetching and compiling its module graph before
   * it can answer anything, the real cost the pool used to charge to the shard.
   */
  bootMs: 0,
  built: 0,
  live: 0,
  /** Shard seeds each worker was handed, in dispatch order. */
  routed: [] as number[][],
};

function resetFake(): void {
  fake.behavior = "reply";
  fake.throwFrom = Infinity;
  fake.bootMs = 0;
  fake.built = 0;
  fake.live = 0;
  fake.routed = [];
}

/**
 * Speaks the real worker's protocol: a `ready` announcement once the module
 * graph has notionally loaded, then a `ShardJob` in and a structured-cloned
 * `ShardResult` back on `onmessage`, answered on a timer so shards land in an
 * order the pool did not choose. It can also be told to boot slowly, to stay
 * silent or to die, the three failure modes the pool has to survive, and only
 * the first of them is survivable by waiting.
 */
class FakeWorker {
  onmessage: ((e: { data: WorkerMessage }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private readonly slot: number;
  private held: AnyShardResult[] = [];
  private dead = false;
  private booted = false;
  private queued: AnyShardJob[] = [];

  constructor(_url: URL, _opts?: { type?: string }) {
    // What Chrome does when the page's CSP forbids the worker URL.
    if (fake.built >= fake.throwFrom) {
      throw new Error("SecurityError: violates the document's worker-src");
    }
    this.slot = fake.built++;
    fake.live++;
    fake.routed[this.slot] = [];
    // A real worker cannot answer, or announce itself, until its module graph
    // has loaded; jobs posted before that sit on the port. Modelling the wait
    // is the whole point of this fake now.
    setTimeout(() => {
      if (this.dead) return;
      this.booted = true;
      this.onmessage?.({ data: { ready: true } });
      const waiting = this.queued;
      this.queued = [];
      for (const job of waiting) this.answer(job);
    }, fake.bootMs);
  }

  postMessage(job: AnyShardJob): void {
    fake.routed[this.slot].push(job.seed);
    if (this.booted) this.answer(job);
    else this.queued.push(job);
  }

  private answer(job: AnyShardJob): void {
    if (fake.behavior === "silent") return;
    if (fake.behavior === "error") {
      setTimeout(() => {
        if (!this.dead) this.onerror?.(new Error("worker died"));
      }, 1);
      return;
    }
    // `runAnyShard`, not `runShard`: the real worker tags on `kind`, and this
    // fake has to route both job types the same way or the multiway tests
    // below would be testing a transport the app does not have.
    const reply = structuredClone(runAnyShard(structuredClone(job)));
    if (fake.behavior === "reverse") {
      // Dispatch is synchronous, so the whole batch is in hand before this
      // timer fires, and every reply comes back newest-first.
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

  /** A terminated worker delivers nothing more, not a reply, not an error. */
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

describe("equity pool: worker path", () => {
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
  // Leave `Worker`/`navigator` undefined again, other tests assert on that.
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

    // A CSP verdict does not change, so no retry, and with no half-filled
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
    // `onerror` never fires here, only the per-shard deadline settles this.
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(4); // the shards really were dispatched...
    expect(fake.routed.flat()).toHaveLength(4);
    expect(fake.live).toBe(0); // ...and the deadline retired the pool
  });

  /*
   * The bug: a worker that is merely still loading is not a worker that has
   * failed, and the pool used to be unable to tell the difference.
   *
   * `SHARD_TIMEOUT_MS` started at `postMessage`, which for the first job a
   * worker ever gets is before the worker has executed a line. The browser is
   * still fetching and compiling the module graph behind `equity.worker.ts`,
   * and on a loaded machine that outruns the 400ms a shard is allowed. The
   * deadline then retired four healthy workers, and since `MAX_POOL_BUILDS` is
   * 2 the second occurrence latched `unavailable`, so every decision for the
   * rest of the page ran on the main thread. Observed in a Rosetta-translated
   * Chrome against the dev server as "shard 1 timed out" followed by "worker
   * pool failed twice", both inside the first two decisions of the session.
   *
   * A 600ms boot is past both the boot grace and the old shard deadline, so
   * before the fix this test found `fake.live` at 0 and the pool gone.
   */
  it("waits out a slow boot in-process without retiring the pool", async () => {
    const pool = await freshPool(5);
    fake.bootMs = 600;
    const j = smallJob(0xb007);

    // The decision itself is not held hostage to the boot: it falls back.
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(4);
    expect(fake.routed.flat()).toHaveLength(4); // the shards were dispatched...
    expect(fake.live).toBe(4); // ...and nothing was terminated for being slow
    expect(warnings.some((w) => String(w[0]).includes("failed twice"))).toBe(
      false
    );

    // And a boot is paid once: the next decision finds the pool warm, uses the
    // same four workers, and needs no rebuild.
    await new Promise((r) => setTimeout(r, 700));
    await expect(pool.runEquity(j)).resolves.toEqual(runEquitySync(j));
    expect(fake.built).toBe(4);
    expect(fake.live).toBe(4);
    expect(fake.routed.flat()).toHaveLength(8);
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

  it("returns the same multiway numbers whatever the core count", async () => {
    const req = multiwayJob(0x3c0e5, 4, 3, 1200);
    const expected = runMultiwayEquitySync(req);
    const seeds = planShards(req.simulations, req.seed).map((s) => s.seed);
    for (const cores of [1, 2, 3, 5, 16]) {
      const pool = await freshPool(cores);
      await expect(pool.runMultiwayEquity(req)).resolves.toEqual(expected);
      const n = workersFor(cores);
      expect(fake.built).toBe(n);
      // Same shard seeds as the heads-up path: the split never sees the field.
      expect(fake.routed.flat()).toHaveLength(seeds.length);
      seeds.forEach((seed, i) => expect(fake.routed[i % n]).toContain(seed));
    }
  });

  it("correlates multiway replies by id when they race", async () => {
    const pool = await freshPool(1); // one worker takes all four shards
    fake.behavior = "reverse";
    const req = multiwayJob(0x3adc0de, 5, 3, 1200);
    await expect(pool.runMultiwayEquity(req)).resolves.toEqual(
      runMultiwayEquitySync(req)
    );
  });

  it("interleaves heads-up and multiway jobs on the same pool", async () => {
    // One `pending` map keyed by a shared id counter serves both; a reply must
    // never be handed to the other kind of job waiting alongside it.
    const pool = await freshPool(5);
    const hu = job(0x1f1, 3, 1200);
    const mw = multiwayJob(0x1f2, 3, 3, 1200);
    const [a, b] = await Promise.all([
      pool.runEquity(hu),
      pool.runMultiwayEquity(mw),
    ]);
    expect(a).toEqual(runEquitySync(hu));
    expect(b).toEqual(runMultiwayEquitySync(mw));
  });

  it("falls back in-process when a multiway worker dies", async () => {
    const pool = await freshPool(5);
    fake.behavior = "error";
    const req = multiwayJob(0x3e12, 3, 3, 1200);
    await expect(pool.runMultiwayEquity(req)).resolves.toEqual(
      runMultiwayEquitySync(req)
    );
    expect(fake.live).toBe(0);
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
