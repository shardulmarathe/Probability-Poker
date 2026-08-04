/**
 * Where the hands are, said accurately in every state.
 *
 * `Profile.tsx` currently prints one fixed line under the archive:
 *
 *     "Stored locally in this browser. Nothing leaves the device."
 *
 * That was true when it was written and is the sort of sentence a product only
 * gets to be wrong about once. It is a promise, not a description, and the
 * moment a single hand is uploaded it becomes a lie printed directly above the
 * button that uploaded it. A leaderboard endpoint existing in the same repo
 * already made it read as one.
 *
 * The fix is not to soften it into something vague enough to always be true.
 * `storageNotice` returns the sentence that is *exactly* true right now, which
 * means the signed-out wording is the original promise, unweakened, because
 * signed out, it really is the whole truth.
 *
 * This is a plain function of the sync state so the copy lives in one place and
 * cannot drift from what the queue is actually doing.
 */

import type { SyncState } from "../../lib/api";

export function storageNotice(state: SyncState): string {
  switch (state.status) {
    case "off":
      // Unchanged, and still exactly true: no session means no request is made
      // and nothing is queued to be made later.
      return "Stored locally in this browser. Nothing leaves the device.";
    case "idle":
      return "Stored in this browser and copied to your account.";
    case "syncing":
      return "Stored in this browser. Copying to your account now.";
    case "pending":
      return state.queued === 1
        ? "Stored in this browser. 1 hand waiting to copy to your account."
        : `Stored in this browser. ${state.queued} hands waiting to copy to your account.`;
    case "error":
      return "Stored in this browser. The copy to your account is retrying.";
  }
}
