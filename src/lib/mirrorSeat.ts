/**
 * The one path from the stored archive to a mirrored seat.
 *
 * Two places need the player's style as a `BotProfile` and they cannot share it
 * through the store: `TableSetupPanel` sits on the landing page, which is
 * outside `TableProvider` (see `App.tsx`), while the decider needs it inside.
 * So the derivation lives here and both import it, rather than each reading the
 * archive and computing its own answer.
 *
 * The archive reader is in `components/profile/store.ts`, which is where the
 * profile page keeps it. Importing a component module from `lib/` is the wrong
 * direction and worth naming: that file is app-level persistence that happens
 * to live under `components/`, and moving it is a larger change than this seat
 * justifies. The dependency is one function and it is read-only.
 */

import { computeStats } from "../poker/coach/stats";
import { mirrorProfile } from "../poker/model/mirror";
import type { BotProfile } from "../poker/table/contract";
import { loadArchive } from "../components/profile/store";

export { MIRROR_ID } from "../poker/model/mirror";

/**
 * The player's measured style as a seat, or null when the archive cannot
 * support one.
 *
 * Reads the whole archive rather than the current session: a mirror is a claim
 * about how somebody plays, and the largest honest sample is the right one. The
 * seat it measures is the archive's own `heroSeat`, because the stats are
 * per-seat and the player's chair moves between tables.
 */
export function loadMirrorProfile(): BotProfile | null {
  const archive = loadArchive();
  if (archive.hands.length === 0) return null;
  const seat = archive.heroSeat ?? 0;
  return mirrorProfile(computeStats(archive.hands, seat));
}
