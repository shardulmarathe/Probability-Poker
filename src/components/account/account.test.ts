/**
 * The promises the account layer makes to a player who never signs in.
 *
 * These are the assertions that protect a claim rather than a behaviour. The
 * app has always been playable without an account and the profile page has
 * always told the player their hands do not leave the device; both are now
 * things that could quietly stop being true, and neither would fail loudly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncClient, type StorageLike } from "../../lib/api";
import { storageNotice } from "./notice";

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

// ---------------------------------------------------------------------------
// VITE_NEON_AUTH_URL unset
// ---------------------------------------------------------------------------

describe("with VITE_NEON_AUTH_URL unset", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_NEON_AUTH_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports itself unconfigured and settles as anonymous without a round trip", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const auth = await import("../../lib/auth");

    expect(auth.authConfigured).toBe(false);
    // Not "loading": there is nothing to wait for, so the UI never flickers
    // through a state that implies an account might appear.
    expect(auth.getAuthState().phase).toBe("anonymous");
    expect(auth.getAuthState().user).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses sign-in with an explanation rather than a network error", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const auth = await import("../../lib/auth");

    const inResult = await auth.signIn("a@b.co", "password123");
    const upResult = await auth.signUp("Ada", "a@b.co", "password123");
    const session = await auth.refreshSession();

    expect(inResult.ok).toBe(false);
    expect(upResult.ok).toBe(false);
    expect(inResult.error).toMatch(/not enabled/i);
    expect(session).toBeNull();
    // The placeholder auth URL must never be dialled.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the write-behind queue completely inert", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const api = await import("../../lib/api");
    await import("../../lib/auth");

    api.syncArchive({
      hands: [],
      smallBlind: 5,
      bigBlind: 10,
      heroSeat: 0,
    });
    api.saveModel({ anything: true }, 5);
    api.endLiveSession();
    await api.flushNow();

    expect(api.getSyncState().status).toBe("off");
    expect(api.getSyncState().signedIn).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The archive keeps working
// ---------------------------------------------------------------------------

describe("the archive is untouched by sync", () => {
  const realWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as { window?: unknown }).window = {
      localStorage: new MemoryStorage(),
    };
  });

  afterEach(() => {
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
  });

  it("saves and reloads a hand with no session in sight", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const store = await import("../profile/store");
    const report = {
      handNumber: 1,
      seed: 4242,
      button: 0,
      seatCount: 2,
      board: [],
      seats: [
        { seat: 0, hole: [0, 1], final: null, invested: 10, won: 20, net: 10, status: "active" },
        { seat: 1, hole: [2, 3], final: null, invested: 10, won: 0, net: -10, status: "folded" },
      ],
      pots: [{ amount: 20, eligible: [0, 1], winners: [0] }],
      decisions: [],
      actions: [],
      endStreet: "preflop",
      wentToShowdown: false,
    } as Parameters<typeof store.saveArchive>[0]["hands"][number];

    store.saveArchive({
      hands: [report],
      smallBlind: 5,
      bigBlind: 10,
      heroSeat: 0,
      updatedAt: 0,
    });

    const back = store.loadArchive();
    expect(back.hands).toHaveLength(1);
    expect(back.hands[0].seed).toBe(4242);
    // The whole point: archiving a hand made no request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("merges pulled hands without displacing the local copy of a shared seed", async () => {
    const store = await import("../profile/store");
    const make = (seed: number, invested: number) =>
      ({
        handNumber: 1,
        seed,
        button: 0,
        seatCount: 2,
        board: [],
        seats: [
          { seat: 0, hole: [0, 1], final: null, invested, won: 20, net: 20 - invested, status: "active" },
          { seat: 1, hole: [2, 3], final: null, invested: 10, won: 0, net: -10, status: "folded" },
        ],
        pots: [{ amount: 20, eligible: [0, 1], winners: [0] }],
        decisions: [],
        actions: [],
        endStreet: "preflop",
        wentToShowdown: false,
      }) as Parameters<typeof store.saveArchive>[0]["hands"][number];

    store.saveArchive({
      hands: [make(100, 10)],
      smallBlind: 5,
      bigBlind: 10,
      heroSeat: 0,
      updatedAt: 0,
    });

    // Seed 100 exists on both sides; seed 200 only on the server.
    const merged = store.mergeSyncedHands([make(100, 99), make(200, 10)]);

    expect(merged.hands.map((h) => h.seed).sort()).toEqual([100, 200]);
    // Union, not replace: the server hand is added and neither side is dropped.
    expect(merged.hands).toHaveLength(2);
    // Local wins the collision, the archive's copy of seed 100 is kept.
    expect(merged.hands.find((h) => h.seed === 100)!.seats[0].invested).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Two devices, one account
// ---------------------------------------------------------------------------

describe("reconcile on sign-in", () => {
  const realWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as { window?: unknown }).window = {
      localStorage: new MemoryStorage(),
    };
  });

  afterEach(() => {
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
    vi.restoreAllMocks();
  });

  it("unions both sides and uploads each local hand exactly once", async () => {
    const store = await import("../profile/store");
    const api = await import("../../lib/api");
    const { reconcile } = await import("./sync");

    const local = {
      handNumber: 1,
      seed: 100,
      button: 0,
      seatCount: 2,
      board: [],
      seats: [
        { seat: 0, hole: [0, 1], final: null, invested: 10, won: 20, net: 10, status: "active" },
        { seat: 1, hole: [2, 3], final: null, invested: 10, won: 0, net: -10, status: "folded" },
      ],
      pots: [{ amount: 20, eligible: [0, 1], winners: [0] }],
      decisions: [],
      actions: [],
      endStreet: "preflop",
      wentToShowdown: false,
    } as Parameters<typeof store.saveArchive>[0]["hands"][number];

    store.saveArchive({
      hands: [local],
      smallBlind: 5,
      bigBlind: 10,
      heroSeat: 0,
      updatedAt: 0,
    });

    // The account already holds a different hand, played on another device.
    const serverHand = {
      handNumber: 1,
      seed: 200,
      button: 0,
      board: [],
      seats: [
        { seat: 0, archetype: "human", hole: [4, 5], invested: 10, won: 20, status: "active" },
        { seat: 1, archetype: "tag", hole: [6, 7], invested: 10, won: 0, status: "folded" },
      ],
      pots: [{ amount: 20, eligible: [0, 1], winners: [0] }],
      endStreet: "preflop",
      wentToShowdown: false,
    };

    const calls: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input);
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
        let payload: unknown = { ok: true };
        if (path.startsWith("/api/hands"))
          payload = { items: [{ id: "h1" }], nextCursor: null };
        else if (path.startsWith("/api/hand/h1"))
          payload = { hand: serverHand, decisions: [] };
        else if (path.startsWith("/api/session/start"))
          payload = { sessionId: "srv-1" };
        else if (path.startsWith("/api/hand/record")) payload = { handId: "x" };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
        } as unknown as Response;
      })
    );

    api.sync.setSession({
      userId: "u1",
      token: "t",
      name: "Ada",
      email: "a@b.co",
    });

    const summary = await reconcile();
    await api.flushNow();

    // Neither side lost anything.
    expect(summary.pulled).toBe(1);
    expect(summary.pushed).toBe(1);
    expect(summary.shared).toBe(0);
    expect(store.loadArchive().hands.map((h) => h.seed).sort()).toEqual([100, 200]);

    // The local hand went up once, not once through the reconcile and again
    // through the archive write the reconcile itself triggers.
    const records = calls.filter((c) => c.path.startsWith("/api/hand/record"));
    expect(records).toHaveLength(1);
    expect(
      (records[0].body as { hand: { seed: number } }).hand.seed
    ).toBe(100);

    // And the hand that came *down* is never sent back up.
    expect(
      records.some((c) => (c.body as { hand: { seed: number } }).hand.seed === 200)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The claim on the profile page
// ---------------------------------------------------------------------------

describe("storageNotice", () => {
  const state = (over: Partial<import("../../lib/api").SyncState> = {}) => ({
    status: "off" as const,
    signedIn: false,
    queued: 0,
    lastError: null,
    lastSyncedAt: null,
    ...over,
  });

  it("keeps the original promise verbatim while signed out", () => {
    expect(storageNotice(state())).toBe(
      "Stored locally in this browser. Nothing leaves the device."
    );
  });

  it("never claims nothing leaves the device once something does", () => {
    for (const status of ["idle", "syncing", "pending", "error"] as const) {
      const text = storageNotice(state({ status, signedIn: true, queued: 2 }));
      expect(text).not.toMatch(/nothing leaves the device/i);
      // It still has to say the local copy exists, that is the durable half.
      expect(text).toMatch(/stored in this browser/i);
    }
  });

  it("counts the backlog so 'waiting' is never vague", () => {
    expect(storageNotice(state({ status: "pending", signedIn: true, queued: 1 }))).toMatch(
      /1 hand waiting/
    );
    expect(storageNotice(state({ status: "pending", signedIn: true, queued: 7 }))).toMatch(
      /7 hands waiting/
    );
  });
});

// ---------------------------------------------------------------------------
// Signed out, one more time, from the queue's side
// ---------------------------------------------------------------------------

describe("a signed-out queue", () => {
  it("stays at zero no matter how much is played", () => {
    const fetchSpy = vi.fn();
    const client = new SyncClient({
      storage: new MemoryStorage(),
      fetch: fetchSpy as unknown as typeof fetch,
    });

    for (let i = 1; i <= 50; i++) {
      client.syncArchive({
        hands: [],
        smallBlind: 5,
        bigBlind: 10,
        heroSeat: 0,
      });
    }

    expect(client.queueLength()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.getSyncState().status).toBe("off");
  });
});
