/**
 * The account slot: one control, every route, three states.
 *
 *   not configured   Renders nothing. A deploy without `VITE_NEON_AUTH_URL` has
 *                    no account service, and an offer that cannot be accepted is
 *                    worse than no offer.
 *   signed out       A quiet gold "Sign in". Never a wall, never a modal on
 *                    load, the game is complete without it.
 *   signed in        Initial, name, and the sync dot; opens a small panel with
 *                    where the hands are and a way out.
 *
 * Self-contained by design: it takes no required props and reaches for nothing
 * the shell has to provide, so mounting it is `<AccountMenu />` and nothing else.
 */

import { useEffect, useRef, useState } from "react";
import { authConfigured, signOut } from "../../lib/auth";
import { flushNow } from "../../lib/api";
import { useAccountBootstrap, useSync } from "./useAccount";
import { AccountDialog } from "./AccountDialog";
import { SyncBadge, syncHint } from "./SyncBadge";
import { BUTTON, LINE, SURFACE } from "./skin";
import { resetReconcile } from "./sync";

export interface AccountMenuProps {
  /** Extra classes for the outer element, so the shell can place it. */
  className?: string;
}

export function AccountMenu({ className = "" }: AccountMenuProps) {
  const auth = useAccountBootstrap();
  const sync = useSync();
  const [dialog, setDialog] = useState(false);
  const [panel, setPanel] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setPanel(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [panel]);

  // An unconfigured deploy is a supported configuration, not a broken one.
  if (!authConfigured) return null;

  // "loading" only ever lasts one round trip, and a control that appears as
  // "Sign in" and then swaps to a name is worse than one that arrives late.
  if (auth.phase === "loading") {
    return (
      <div
        data-slot="account"
        className={`flex items-center gap-2 ${className}`}
        aria-hidden
      >
        <span className="h-[34px] w-[86px] rounded-lg bg-ivory/5" />
      </div>
    );
  }

  if (auth.phase === "anonymous") {
    return (
      <div data-slot="account" className={`flex items-center gap-2 ${className}`}>
        <button
          type="button"
          onClick={() => setDialog(true)}
          data-testid="account-signin"
          className={`${BUTTON.base} ${BUTTON.secondary} min-h-[34px] px-2 py-1.5 text-[0.7rem] sm:px-3 sm:text-xs`}
        >
          Sign in
        </button>
        <AccountDialog open={dialog} onClose={() => setDialog(false)} />
      </div>
    );
  }

  const user = auth.user!;
  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();

  return (
    <div
      ref={root}
      data-slot="account"
      className={`relative flex items-center gap-2 ${className}`}
    >
      <button
        type="button"
        onClick={() => setPanel((v) => !v)}
        aria-expanded={panel}
        data-testid="account-menu"
        className="flex min-h-[34px] items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-ivory/5"
        style={{ border: `1px solid ${panel ? LINE.goldStrong : LINE.quiet}` }}
      >
        <span
          aria-hidden
          className="grid h-[22px] w-[22px] place-items-center rounded-full font-display text-[0.7rem] text-felt-deep"
          style={{ background: "linear-gradient(160deg,#e2c563,#c9a227)" }}
        >
          {initial}
        </span>
        <span className="hidden max-w-[9rem] truncate font-display text-xs tracking-wide text-ivory/80 sm:inline">
          {user.name}
        </span>
        <SyncBadge state={sync} />
      </button>

      {panel && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[17rem] rounded-2xl p-4 shadow-[0_24px_60px_-18px_rgba(0,0,0,0.85)]"
          style={{ background: SURFACE.panel, border: `1px solid ${LINE.gold}` }}
        >
          <p className="truncate font-display text-sm tracking-wide text-gold-soft">
            {user.name}
          </p>
          <p className="mt-0.5 truncate text-[0.68rem] text-ivory/40">{user.email}</p>

          <div
            className="mt-3 rounded-lg px-3 py-2.5"
            style={{ background: SURFACE.sunk, border: `1px solid ${LINE.quiet}` }}
          >
            <SyncBadge state={sync} verbose />
            <p className="mt-1.5 text-[0.68rem] leading-relaxed text-ivory/45">
              {syncHint(sync)}
            </p>
            {sync.status === "error" && (
              <button
                type="button"
                onClick={() => void flushNow()}
                className="mt-2 font-display text-[0.62rem] uppercase tracking-[0.18em] text-gold-soft/80 transition hover:text-gold-soft"
              >
                Retry now
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={async () => {
              resetReconcile(user.id);
              await signOut();
              setPanel(false);
            }}
            data-testid="account-signout"
            className={`${BUTTON.base} ${BUTTON.quiet} mt-3 min-h-[34px] w-full px-3 py-1.5 text-xs`}
          >
            Sign out
          </button>
          <p className="mt-2 text-center text-[0.62rem] leading-relaxed text-ivory/30">
            Signing out keeps this browser's hands. It only stops the copy.
          </p>
        </div>
      )}
    </div>
  );
}
