/**
 * Reconciling a device's archive with an account's, once per sign-in.
 *
 * The interesting case is the one that has to be got right rather than the one
 * that happens most: a phone with forty hands on it signs into an account that
 * already has three hundred from a laptop. Neither side is stale, neither side
 * is authoritative, and the wrong answer here is any answer that loses hands.
 *
 * **The rule is union, keyed by deal seed. Nothing is deleted on either side.**
 *
 *   1. Pull first. Newest-first, bounded, and only to learn which seeds the
 *      account already holds, which is also what makes step 3 idempotent
 *      without trusting any client-side bookkeeping to have survived.
 *   2. Merge down. Server hands the device has never seen go into the archive.
 *      A seed present on both sides keeps the *local* copy, because the round
 *      trip cannot restore a showdown category the archive never stored, and
 *      because that is the copy the replay pages were built from.
 *   3. Push up. Local hands the account has never seen are queued for upload.
 *      Never a delete, never an overwrite, `hand/record` only ever inserts.
 *
 * A deal seed is a 32-bit hash of the session seed and the hand number, so two
 * devices playing different tables cannot collide, and the same hand recorded
 * twice cannot duplicate. `store.ts` already keys its own dedupe on it.
 *
 * The single lossy edge is the archive's 400-hand cap: merging more than that
 * trims oldest-first. Those hands are not gone, they are on the server, and
 * `fetchHands` still reaches them. Nothing this function does removes a row.
 */

import { loadArchive, mergeSyncedHands } from "../profile/store";
import { sync } from "../../lib/api";

export interface ReconcileSummary {
  /** Hands the server had that this device did not. */
  pulled: number;
  /** Hands this device had that the account did not; queued for upload. */
  pushed: number;
  /** Hands both sides already had. */
  shared: number;
}

const EMPTY: ReconcileSummary = { pulled: 0, pushed: 0, shared: 0 };

/**
 * Runs at most once per signed-in user per page load. Reconciling twice is
 * harmless, every step is idempotent, but it costs a burst of requests.
 */
const done = new Set<string>();

export async function reconcile(): Promise<ReconcileSummary> {
  const session = sync.getSession();
  if (!session || done.has(session.userId)) return EMPTY;
  done.add(session.userId);

  try {
    const { reports, seeds } = await sync.pullHands();

    const before = loadArchive();
    const localSeeds = new Set(before.hands.map((h) => h.seed));
    const shared = [...seeds].filter((s) => localSeeds.has(s)).length;
    const fresh = reports.filter((r) => !localSeeds.has(r.seed));

    // Claim every seed either side already knows about *before* touching the
    // archive. `mergeSyncedHands` calls `saveArchive`, which re-enters the
    // write-behind path, and that path would otherwise treat this device's
    // history as hands that had just been dealt, queueing them through a live
    // session with hand numbers that restart per table. Step 3 below is the
    // one that uploads them, grouped into the runs they were actually played in.
    sync.markSynced([...seeds, ...localSeeds]);

    if (fresh.length > 0) mergeSyncedHands(fresh);

    const pushed = sync.pushHands(before, seeds);

    return { pulled: fresh.length, pushed, shared };
  } catch {
    // A reconcile that cannot reach the server is a no-op, not a failure the
    // player has to deal with. The archive is untouched and play continues.
    return EMPTY;
  }
}

/** Forget that a user has been reconciled. Used on sign-out. */
export function resetReconcile(userId?: string): void {
  if (userId) done.delete(userId);
  else done.clear();
}
