/**
 * What the queue is doing, in one dot and three words.
 *
 * Every state here is a *statement about where the hands are*, because that is
 * the only question the indicator exists to answer. "Error" is deliberately not
 * red-alarming: a failed flush costs nothing — the hands are on the device and
 * the queue is still retrying — so it reads as a warm amber note rather than a
 * fault the player is being asked to fix.
 */

import type { SyncState } from "../../lib/api";
import { TONE } from "./skin";

const COPY: Record<SyncState["status"], { dot: string; label: string; hint: string }> = {
  off: {
    dot: "rgba(244,237,228,0.30)",
    label: "Local only",
    hint: "Hands are stored in this browser and nowhere else.",
  },
  idle: {
    dot: TONE.good,
    label: "Synced",
    hint: "Every hand on this device is saved to your account.",
  },
  syncing: {
    dot: TONE.gold,
    label: "Syncing",
    hint: "Saving hands to your account.",
  },
  pending: {
    dot: TONE.gold,
    label: "Queued",
    hint: "Hands are waiting to upload. Play is unaffected.",
  },
  error: {
    dot: TONE.warn,
    label: "Retrying",
    hint: "Cannot reach the server. Hands are safe on this device and will upload when it returns.",
  },
};

/**
 * The one keyframe this folder needs, carried with it.
 *
 * `index.css` owns the app's animation vocabulary and none of it is a pulse.
 * Injecting the rule here rather than adding to that file keeps the account
 * components droppable into the shell as a unit — the same reason
 * `table/chrome.tsx` ships its own `<style>`.
 */
function BadgeStyles() {
  return (
    <style>{`
@keyframes pp-sync-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .pp-sync-dot { animation: none !important; }
}
`}</style>
  );
}

export function SyncBadge({ state, verbose }: { state: SyncState; verbose?: boolean }) {
  const copy = COPY[state.status];
  const count = state.queued > 0 ? ` · ${state.queued}` : "";

  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
      title={copy.hint}
    >
      <BadgeStyles />
      <span
        aria-hidden
        className="pp-sync-dot inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: copy.dot,
          boxShadow: `0 0 6px ${copy.dot}`,
          animation:
            state.status === "syncing"
              ? "pp-sync-pulse 1.4s ease-in-out infinite"
              : undefined,
        }}
      />
      <span className="font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/50">
        {copy.label}
        {count}
      </span>
      {verbose && (
        <span className="sr-only">{copy.hint}</span>
      )}
    </span>
  );
}

/** The one-line description of where hands live, for the account panel. */
export function syncHint(state: SyncState): string {
  return COPY[state.status].hint;
}
