/**
 * The write-behind queue's contract, exercised against a fake network.
 *
 * The four properties worth proving are the four the game depends on and cannot
 * check for itself: signed-out play writes nothing, an offline burst loses
 * nothing, a 500 backs off rather than gives up, and a reload mid-queue resumes
 * from storage — sending a duplicate that the server's `(session_id,
 * hand_number)` uniqueness is expected to absorb.
 */

import { describe, expect, it } from "vitest";
import {
  SyncClient,
  SYNC_STORAGE_KEY,
  MAX_QUEUE,
  fromServerHand,
  toDecisionPayloads,
  toHandPayload,
  type ArchiveSnapshot,
  type SessionInfo,
  type StorageLike,
  type SyncDeps,
} from "./api";
import type { TableHandReport } from "../poker/table/contract";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/**
 * A scripted server. `plan` maps a path to a queue of responses; the last one
 * repeats, so "500 then 200" and "500 forever" are both one line.
 */
function fakeNetwork(plan: Record<string, (number | "throw")[]>) {
  const calls: Call[] = [];
  const cursor: Record<string, number> = {};
  let sessionCounter = 0;

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const key = Object.keys(plan).find((p) => path.startsWith(p)) ?? path;
    const script = plan[key] ?? [200];
    const at = Math.min(cursor[key] ?? 0, script.length - 1);
    cursor[key] = (cursor[key] ?? 0) + 1;
    const outcome = script[at];

    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    if (outcome === "throw") throw new TypeError("Failed to fetch");

    let payload: unknown = { ok: true };
    if (path.startsWith("/api/session/start")) {
      sessionCounter += 1;
      payload = { sessionId: `server-session-${sessionCounter}` };
    } else if (path.startsWith("/api/hand/record")) {
      payload = { handId: `hand-${calls.length}` };
    }

    return {
      ok: outcome >= 200 && outcome < 300,
      status: outcome,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** Timers the test drives by hand, so backoff is observable and instant. */
function manualTimers() {
  const pending: { fn: () => void; at: number; id: number }[] = [];
  let clock = 1_000;
  let nextId = 1;
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.push({ fn, at: clock + ms, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = pending.findIndex((p) => p.id === h);
      if (i >= 0) pending.splice(i, 1);
    },
    /** Advance far enough to fire every scheduled callback, then run them. */
    async advance(ms: number) {
      clock += ms;
      const due = pending.filter((p) => p.at <= clock);
      for (const d of due) pending.splice(pending.indexOf(d), 1);
      for (const d of due) d.fn();
      await Promise.resolve();
    },
    pendingCount: () => pending.length,
  };
}

function deps(overrides: Partial<SyncDeps> = {}): Partial<SyncDeps> {
  return {
    storage: new MemoryStorage(),
    random: () => 0.5,
    setup: () => ({ stackBb: 100, lineup: ["tag", "station", "maniac"] }),
    ...overrides,
  };
}

const USER: SessionInfo = {
  userId: "user-a",
  token: "tok-abc",
  name: "Ada",
  email: "ada@example.com",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hand(handNumber: number, seed: number): TableHandReport {
  return {
    handNumber,
    seed,
    button: 0,
    seatCount: 4,
    board: [4, 9, 17],
    seats: [
      { seat: 0, hole: [0, 1], final: null, invested: 10, won: 40, net: 30, status: "active" },
      { seat: 1, hole: [2, 3], final: null, invested: 10, won: 0, net: -10, status: "folded" },
      { seat: 2, hole: [5, 6], final: null, invested: 10, won: 0, net: -10, status: "folded" },
      { seat: 3, hole: [7, 8], final: null, invested: 10, won: 0, net: -10, status: "folded" },
    ],
    pots: [{ amount: 40, eligible: [0, 1, 2, 3], winners: [0] }],
    decisions: [],
    actions: [
      { seat: 3, street: "preflop", action: "raise", cost: 30, potBefore: 15, toCall: 10 },
      { seat: 0, street: "preflop", action: "call", cost: 30, potBefore: 45, toCall: 30 },
    ],
    endStreet: "flop",
    wentToShowdown: false,
  };
}

function archive(hands: TableHandReport[]): ArchiveSnapshot {
  return { hands, smallBlind: 5, bigBlind: 10, heroSeat: 0 };
}

/** Sign in, take the baseline, then play `hands` — the live path's real shape. */
function playFrom(client: SyncClient, base: TableHandReport[]) {
  client.setSession(USER);
  client.syncArchive(archive(base));
}

// ---------------------------------------------------------------------------
// Signed out
// ---------------------------------------------------------------------------

describe("signed out is a first-class state", () => {
  it("queues nothing and touches no network", () => {
    const net = fakeNetwork({});
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));

    client.syncArchive(archive([hand(1, 111), hand(2, 222)]));
    client.saveModel({ a: 1 }, 10);
    client.endLiveSession();

    expect(client.queueLength()).toBe(0);
    expect(net.calls).toHaveLength(0);
    expect(client.getSyncState().status).toBe("off");
    expect(client.getSyncState().signedIn).toBe(false);
  });

  it("flushing without a session resolves without a request", async () => {
    const net = fakeNetwork({});
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    await client.flush();
    expect(net.calls).toHaveLength(0);
  });

  it("reads resolve to null rather than throwing", async () => {
    const net = fakeNetwork({});
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    expect(await client.fetchStats()).toBeNull();
    expect(await client.fetchHands()).toBeNull();
    expect(await client.fetchLeaderboard()).toBeNull();
    expect(net.calls).toHaveLength(0);
  });

  it("signing out parks queued work instead of discarding it", async () => {
    const net = fakeNetwork({ "/api/": ["throw"] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));
    await client.flush();
    const queuedWhileIn = client.queueLength();
    expect(queuedWhileIn).toBeGreaterThan(0);

    client.setSession(null);
    expect(client.getSyncState().status).toBe("off");
    expect(client.getSyncState().queued).toBe(0);
    // Parked, not dropped: the entries are still in storage.
    expect(client.queueLength()).toBe(queuedWhileIn);

    client.setSession(USER);
    expect(client.getSyncState().queued).toBe(queuedWhileIn);
  });
});

// ---------------------------------------------------------------------------
// Enqueue while offline
// ---------------------------------------------------------------------------

describe("offline", () => {
  it("loses nothing across a burst of hands with the network down", async () => {
    const net = fakeNetwork({ "/api/": ["throw"] });
    const timers = manualTimers();
    const client = new SyncClient(
      deps({ fetch: net.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );

    playFrom(client, []);
    for (let i = 1; i <= 5; i++) {
      client.syncArchive(archive(Array.from({ length: i }, (_, k) => hand(k + 1, 100 + k))));
    }
    await client.flush();

    // One session/start + five hand/record, none of them acknowledged.
    expect(client.queueLength()).toBe(6);
    const state = client.getSyncState();
    expect(state.status).toBe("error");
    expect(state.queued).toBe(6);
    expect(state.lastSyncedAt).toBeNull();
  });

  it("delivers everything, in order, once the network returns", async () => {
    // Down for the first attempt, up afterwards.
    const net = fakeNetwork({ "/api/": ["throw", 200] });
    const timers = manualTimers();
    const client = new SyncClient(
      deps({ fetch: net.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111), hand(2, 222), hand(3, 333)]));
    await client.flush();
    expect(client.queueLength()).toBe(4);

    await timers.advance(120_000);
    await client.flush();

    expect(client.queueLength()).toBe(0);
    const paths = net.calls.map((c) => c.path);
    expect(paths[0]).toBe("/api/session/start");
    expect(paths.filter((p) => p === "/api/hand/record")).toHaveLength(3);
    // The session must be created before any hand references it.
    expect(paths.indexOf("/api/session/start")).toBeLessThan(
      paths.indexOf("/api/hand/record")
    );
    expect(client.getSyncState().status).toBe("idle");
  });

  it("keeps the queue bounded when the API never recovers", async () => {
    const net = fakeNetwork({ "/api/": ["throw"] });
    const timers = manualTimers();
    const client = new SyncClient(
      deps({ fetch: net.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );

    playFrom(client, []);
    const hands: TableHandReport[] = [];
    for (let i = 1; i <= MAX_QUEUE + 60; i++) {
      hands.push(hand(i, 1000 + i));
      client.syncArchive(archive([...hands]));
    }
    expect(client.queueLength()).toBe(MAX_QUEUE);
  });
});

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

describe("retry with backoff", () => {
  it("retries a 500 rather than dropping the write", async () => {
    const net = fakeNetwork({
      "/api/session/start": [200],
      "/api/hand/record": [500, 500, 200],
    });
    const timers = manualTimers();
    const client = new SyncClient(
      deps({ fetch: net.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));

    await client.flush();
    expect(client.queueLength()).toBe(1);
    expect(client.getSyncState().status).toBe("error");

    await timers.advance(5_000);
    await client.flush();
    expect(client.queueLength()).toBe(1);

    await timers.advance(60_000);
    await client.flush();
    expect(client.queueLength()).toBe(0);

    const records = net.calls.filter((c) => c.path === "/api/hand/record");
    expect(records).toHaveLength(3);
    expect(client.getSyncState().status).toBe("idle");
    expect(client.getSyncState().lastSyncedAt).not.toBeNull();
  });

  it("backs off further with each failure, and caps", async () => {
    const net = fakeNetwork({ "/api/": [500] });
    const timers = manualTimers();
    const client = new SyncClient(
      deps({ fetch: net.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));

    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = timers.now();
      await client.flush();
      const doc = JSON.parse(
        (client as unknown as { deps: SyncDeps }).deps.storage!.getItem(SYNC_STORAGE_KEY)!
      ) as { entries: { nextAt: number }[] };
      waits.push(doc.entries[0].nextAt - before);
      await timers.advance(120_000);
    }

    // Monotonic until the cap, then flat — never zero, never unbounded.
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(60_000 * 1.3);
  });

  it("drops a permanently rejected write instead of blocking the queue", async () => {
    // 400 on the session start: it can never succeed, and everything behind it
    // depends on a session id that will never exist.
    const net = fakeNetwork({ "/api/session/start": [400], "/api/hand/record": [200] });
    const timers = manualTimers();
    const client = new SyncClient(
      deps({ fetch: net.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111), hand(2, 222)]));
    await client.flush();

    expect(client.queueLength()).toBe(0);
    expect(net.calls.filter((c) => c.path === "/api/hand/record")).toHaveLength(0);
    expect(client.getSyncState().status).toBe("idle");
  });

  it("parks on 401 without burning attempts or losing writes", async () => {
    const net = fakeNetwork({ "/api/": [401] });
    const timers = manualTimers();
    const client = new SyncClient(
      deps({ fetch: net.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));
    await client.flush();

    expect(client.queueLength()).toBe(2);
    // One attempt only — a 401 is not something a retry loop can fix.
    expect(net.calls).toHaveLength(1);
  });

  it("sends the session token as a bearer header", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));
    await client.flush();
    expect(net.calls[0].headers.authorization).toBe("Bearer tok-abc");
  });
});

// ---------------------------------------------------------------------------
// Reload mid-queue
// ---------------------------------------------------------------------------

describe("surviving a reload", () => {
  it("resumes an interrupted queue from storage", async () => {
    const storage = new MemoryStorage();
    const timers = manualTimers();
    const down = fakeNetwork({ "/api/": ["throw"] });

    const before = new SyncClient(
      deps({ storage, fetch: down.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );
    playFrom(before, []);
    before.syncArchive(archive([hand(1, 111), hand(2, 222)]));
    await before.flush();
    expect(before.queueLength()).toBe(3);

    // The tab dies here. A brand new client over the same storage is a reload.
    const up = fakeNetwork({ "/api/": [200] });
    const after = new SyncClient(
      deps({ storage, fetch: up.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );
    expect(after.queueLength()).toBe(3);

    after.setSession(USER);
    // The backoff the dead tab set is persisted with the entry, so the fresh
    // client honours it rather than hammering the server the instant it loads.
    await after.flush();
    expect(after.queueLength()).toBe(3);

    await timers.advance(120_000);
    await after.flush();

    expect(after.queueLength()).toBe(0);
    expect(up.calls.filter((c) => c.path === "/api/hand/record")).toHaveLength(2);
  });

  it("resends a hand whose response was lost, which idempotency must absorb", async () => {
    const storage = new MemoryStorage();
    const timers = manualTimers();

    // The request reaches the server and the answer never comes back — the
    // classic mid-flight reload. The entry is persisted before the attempt, so
    // it is still queued afterwards.
    const first = fakeNetwork({ "/api/session/start": [200], "/api/hand/record": ["throw"] });
    const a = new SyncClient(
      deps({ storage, fetch: first.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );
    playFrom(a, []);
    a.syncArchive(archive([hand(7, 777)]));
    await a.flush();
    expect(first.calls.filter((c) => c.path === "/api/hand/record")).toHaveLength(1);

    const second = fakeNetwork({ "/api/": [200] });
    const b = new SyncClient(
      deps({ storage, fetch: second.fetchImpl, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    );
    b.setSession(USER);
    await timers.advance(120_000);
    await b.flush();

    const resent = second.calls.filter((c) => c.path === "/api/hand/record");
    expect(resent).toHaveLength(1);

    // The duplicate the server has to absorb: same session, same hand number.
    const original = first.calls.find((c) => c.path === "/api/hand/record")!;
    const retry = resent[0];
    expect(retry.body!.sessionId).toBe(original.body!.sessionId);
    expect((retry.body!.hand as { hand_number: number }).hand_number).toBe(
      (original.body!.hand as { hand_number: number }).hand_number
    );
  });

  it("a duplicate hand/record is safe — the server answers 200 with the same id", async () => {
    // What `api/hand/record.ts` does on a repeat: 200 and the existing row.
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));
    await client.flush();

    // Replay the exact same enqueue by rewinding the client's memory of what it
    // has sent — the situation an evicted queue entry recreates.
    client.markSynced([]);
    (client as unknown as { doc: null }).doc = null;
    client.setSession(USER);
    client.syncArchive(archive([hand(1, 111), hand(2, 222)]));
    await client.flush();

    const records = net.calls.filter((c) => c.path === "/api/hand/record");
    const numbers = records.map(
      (c) => (c.body!.hand as { hand_number: number }).hand_number
    );
    expect(numbers).toContain(1);
    expect(client.queueLength()).toBe(0);
    expect(client.getSyncState().status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Session boundaries
// ---------------------------------------------------------------------------

describe("session boundaries", () => {
  it("opens a new server session when hand numbering restarts", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111), hand(2, 222)]));
    // A new table: numbering goes back to 1.
    client.syncArchive(archive([hand(1, 111), hand(2, 222), hand(1, 333)]));
    await client.flush();

    const starts = net.calls.filter((c) => c.path === "/api/session/start");
    expect(starts).toHaveLength(2);
    const records = net.calls.filter((c) => c.path === "/api/hand/record");
    expect(records).toHaveLength(3);
    // The third hand belongs to the second session.
    expect(records[2].body!.sessionId).not.toBe(records[0].body!.sessionId);
  });

  it("keeps one session while numbering advances", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));

    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));
    client.syncArchive(archive([hand(1, 111), hand(2, 222)]));
    client.syncArchive(archive([hand(1, 111), hand(2, 222), hand(3, 333)]));
    await client.flush();

    expect(net.calls.filter((c) => c.path === "/api/session/start")).toHaveLength(1);
  });

  it("does not record observer hands — nobody played them", () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    client.setSession(USER);
    client.syncArchive({ ...archive([]), heroSeat: null });
    client.syncArchive({ ...archive([hand(1, 111)]), heroSeat: null });
    expect(client.queueLength()).toBe(0);
  });

  it("coalesces model writes so only the newest is sent", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    client.setSession(USER);
    client.saveModel({ v: 1 }, 1);
    client.saveModel({ v: 2 }, 2);
    client.saveModel({ v: 3 }, 3);
    await client.flush();

    const puts = net.calls.filter((c) => c.path === "/api/model");
    expect(puts).toHaveLength(1);
    expect(puts[0].body!.handsSeen).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe("sign-in reconcile", () => {
  it("pushes only local hands the server does not already have", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    client.setSession(USER);

    const local = archive([hand(1, 111), hand(2, 222), hand(3, 333)]);
    const queued = client.pushHands(local, new Set([222]));

    expect(queued).toBe(2);
    await client.flush();
    const records = net.calls.filter((c) => c.path === "/api/hand/record");
    expect(records.map((c) => (c.body!.hand as { seed: number }).seed)).toEqual([
      111, 333,
    ]);
  });

  it("reuses the same import session on a repeated import", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    client.setSession(USER);

    const local = archive([hand(1, 111), hand(2, 222)]);
    client.pushHands(local, new Set());
    await client.flush();
    client.pushHands(local, new Set());
    await client.flush();

    // Two imports, one session: the repeats collide on (session, hand_number).
    expect(net.calls.filter((c) => c.path === "/api/session/start")).toHaveLength(1);
    const records = net.calls.filter((c) => c.path === "/api/hand/record");
    expect(records).toHaveLength(4);
    expect(new Set(records.map((c) => c.body!.sessionId)).size).toBe(1);
    expect(records[0].body!.sessionId).toBe(records[2].body!.sessionId);
  });

  it("splits an archive into runs where numbering restarts", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    client.setSession(USER);

    client.pushHands(
      archive([hand(1, 111), hand(2, 222), hand(1, 333), hand(2, 444)]),
      new Set()
    );
    await client.flush();

    expect(net.calls.filter((c) => c.path === "/api/session/start")).toHaveLength(2);
    const records = net.calls.filter((c) => c.path === "/api/hand/record");
    expect(records[0].body!.sessionId).toBe(records[1].body!.sessionId);
    expect(records[2].body!.sessionId).not.toBe(records[0].body!.sessionId);
  });

  it("pulls server hands back into archive shape", async () => {
    const source = hand(4, 4242);
    const payload = toHandPayload(source, 4, 0, ["tag", "station", "maniac"]);
    const decisions = toDecisionPayloads(source, 0, ["tag", "station", "maniac"]);

    const fetchImpl = (async (input: unknown) => {
      const path = String(input);
      const body = path.startsWith("/api/hands")
        ? { items: [{ id: "h1", handNumber: 4 }], nextCursor: null }
        : {
            hand: {
              handNumber: payload.hand_number,
              seed: payload.seed,
              button: payload.button,
              board: payload.board,
              seats: payload.seats,
              pots: payload.pots,
              endStreet: payload.end_street,
              wentToShowdown: payload.went_to_showdown,
            },
            decisions: decisions.map((d) => ({
              seat: d.seat,
              street: d.street,
              action: d.action,
              cost: d.cost,
              potBefore: d.pot_before,
              toCall: d.to_call,
            })),
          };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new SyncClient(deps({ fetch: fetchImpl }));
    client.setSession(USER);
    const { reports, seeds } = await client.pullHands(10);

    expect(seeds.has(4242)).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0].seed).toBe(source.seed);
    expect(reports[0].button).toBe(source.button);
    expect(reports[0].board).toEqual(source.board);
    expect(reports[0].seatCount).toBe(source.seatCount);
    expect(reports[0].actions).toEqual(source.actions);
    expect(reports[0].seats.map((s) => s.net)).toEqual(source.seats.map((s) => s.net));
  });

  it("markSynced stops the live path from re-sending reconciled hands", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ fetch: net.fetchImpl }));
    client.setSession(USER);

    client.markSynced([111, 222]);
    client.syncArchive(archive([hand(1, 111), hand(2, 222)]));
    expect(client.queueLength()).toBe(0);

    client.syncArchive(archive([hand(1, 111), hand(2, 222), hand(3, 333)]));
    await client.flush();
    const records = net.calls.filter((c) => c.path === "/api/hand/record");
    expect(records).toHaveLength(1);
    expect((records[0].body!.hand as { seed: number }).seed).toBe(333);
  });
});

// ---------------------------------------------------------------------------
// Wire mapping
// ---------------------------------------------------------------------------

describe("wire mapping", () => {
  it("marks exactly the hero seat as human, so stats land on the right row", () => {
    const payload = toHandPayload(hand(1, 111), 1, 0, ["tag", "station", "maniac"]);
    expect(payload.seats.filter((s) => s.archetype === "human")).toHaveLength(1);
    expect(payload.seats.find((s) => s.seat === 0)!.archetype).toBe("human");
    expect(payload.seats.find((s) => s.seat === 1)!.archetype).toBe("tag");
    expect(payload.seats.find((s) => s.seat === 3)!.archetype).toBe("maniac");
  });

  it("labels each decision with its position at the table", () => {
    const decisions = toDecisionPayloads(hand(1, 111), 0, []);
    // Button on seat 0, four-handed: seats are BTN, SB, BB, UTG.
    expect(decisions.find((d) => d.seat === 0)!.position).toBe("BTN");
    expect(decisions.find((d) => d.seat === 3)!.position).toBe("UTG");
    expect(decisions.find((d) => d.seat === 0)!.actor).toBe("human");
  });

  it("survives a malformed server hand rather than throwing", () => {
    expect(fromServerHand({}, [])).toBeNull();
    expect(fromServerHand({ seats: [] }, [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Storage hostility
// ---------------------------------------------------------------------------

describe("degrading without storage", () => {
  it("works with no storage at all", async () => {
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ storage: null, fetch: net.fetchImpl }));
    playFrom(client, []);
    client.syncArchive(archive([hand(1, 111)]));
    await client.flush();
    expect(net.calls.filter((c) => c.path === "/api/hand/record")).toHaveLength(1);
  });

  it("survives a storage that throws on write", () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const net = fakeNetwork({ "/api/": [200] });
    const client = new SyncClient(deps({ storage: hostile, fetch: net.fetchImpl }));
    playFrom(client, []);
    expect(() => client.syncArchive(archive([hand(1, 111)]))).not.toThrow();
  });

  it("ignores a corrupt persisted queue", () => {
    const storage = new MemoryStorage();
    storage.setItem(SYNC_STORAGE_KEY, "{not json");
    const client = new SyncClient(deps({ storage }));
    expect(client.queueLength()).toBe(0);
  });
});
