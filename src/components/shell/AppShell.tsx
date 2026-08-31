/**
 * The application shell: the felt, the wordmark, and the navigation.
 *
 * Before this existed there was no persistent navigation at all. The profile -
 * the tracker, the style read, the priced leaks, the most valuable thing the
 * product computes, was reachable only by going home, choosing a table,
 * playing a hand to completion, opening the review, opening the replay, and
 * then following a link labelled "← Back to profile" from a page you had never
 * been to. Five hops, the last one signposted backwards.
 *
 * The shell mounts on every route, so:
 *
 *   - every page has a home affordance (the wordmark) and a way to reach the
 *     other two surfaces in one click;
 *   - the felt is painted once, by one component, rather than five times by
 *     five copies that had already drifted apart;
 *   - back-links stop being navigation. A page adds one only when it returns
 *     you to a specific thing you came from, and it is spelled with the
 *     destination's nav name, `← Table`, never "← Back to table" on one page
 *     and "← New table" on the next.
 *
 * The `pp-shell` class is what lets `index.css` shorten every page's
 * `min-h-[100svh]` by the header's height, including on the routes this agent
 * does not own. Without it, every route would carry a permanent scrollbar
 * exactly one header tall.
 */

import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { FeltBackground } from "../ui";

/**
 * The id a route portals its own header controls into.
 *
 * Exported so the one caller cannot drift from the one definition: a typo here
 * is not a crash, it is a silently empty header and a control the user cannot
 * find.
 */
export const HEADER_SLOT_ID = "pp-header-slot";

const NAV = [
  { to: "/table", label: "Table" },
  { to: "/review", label: "Review" },
  { to: "/profile", label: "Profile" },
  // Where you go to learn the maths itself, rather than to see what one hand
  // did. Last, because it is the only one that does not need a hand first.
  { to: "/drill", label: "Drill" },
  { to: "/learn", label: "Learn" },
];

export default function AppShell() {
  const { pathname } = useLocation();
  const navRef = useRef<HTMLUListElement>(null);

  /*
   * Keep the current page's tab visible in the nav.
   *
   * Four labels, the wordmark and Sign in do not fit across 390px at the
   * desktop padding, so both the tabs and the account control tighten under
   * 640px. This still scrolls the active tab into view if type is larger
   * than we budgeted for.
   */
  useEffect(() => {
    const active = navRef.current?.querySelector("[aria-current='page']");
    active?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [pathname]);
  // The landing page keeps the fuller felt, brighter centre, vignette, the
  // four suit watermarks, because it is the only page that is a poster.
  const flourish = pathname === "/";

  return (
    <div className="pp-shell min-h-[100svh] text-ivory">
      <FeltBackground flourish={flourish} />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:border focus:border-gold/60 focus:bg-felt-deep focus:px-3 focus:py-2 focus:font-display focus:text-sm focus:text-gold-soft"
      >
        Skip to content
      </a>

      <header
        className="sticky top-0 z-50 h-[var(--pp-header-h)] border-b backdrop-blur-md"
        style={{
          borderColor: "rgba(201,162,39,0.22)",
          background:
            "linear-gradient(180deg, rgba(6,20,13,0.92) 0%, rgba(6,20,13,0.78) 100%)",
        }}
      >
        <div
          className="mx-auto flex h-full max-w-6xl items-center gap-3 px-3 sm:gap-6 sm:px-4"
          style={{
            paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
            paddingRight: "max(0.75rem, env(safe-area-inset-right))",
          }}
        >
          {/*
           * Icon mark on a phone, full lockup from 640px up. Three nav labels
           * and the account control do not fit beside the wordmark at 390px -
           * they used to overlap it, which made "Profile" unclickable on
           * exactly the device where the nav matters most. The `aria-label`
           * keeps the accessible name identical at every width.
           */}
          <NavLink
            to="/"
            data-testid="brand"
            aria-label="Probability Poker home"
            className="flex shrink-0 items-center gap-1.5 font-display text-base font-semibold tracking-tight text-ivory transition hover:text-gold-soft sm:text-[0.95rem] sm:tracking-wide"
          >
            <span aria-hidden className="text-gold">
              ♠
            </span>
            <span aria-hidden className="hidden sm:inline">
              Probability&nbsp;Poker
            </span>
          </NavLink>

          {/*
           * `flex-1` below `lg`, `flex-none` at and above it.
           *
           * The nav has to stay the shrinkable item wherever the header slot is
           * `display: none`, which is every width under 1024px and every route
           * that hangs nothing. Making it `shrink-0` outright, as an earlier
           * pass here did, left the row with nothing that could give: brand,
           * nav and the account control were all rigid, the `overflow-x-auto`
           * on the list below could never form a scroll region because a
           * `shrink-0` parent resolves to its content's max-content width, and
           * the effect that scrolls the current tab into view became dead code.
           * At 320px, or at 390px with a raised browser font size, that pushes
           * Sign in past the right edge, which is the overlap the comment on
           * the wordmark says was already fixed once.
           */}
          <nav aria-label="Main" className="min-w-0 flex-1 lg:flex-none">
            <ul
              ref={navRef}
              className="flex min-w-0 items-center gap-1 overflow-x-auto sm:gap-2"
              style={{ scrollbarWidth: "none" }}
            >
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    data-testid={`nav-${item.label.toLowerCase()}`}
                    className={({ isActive }) =>
                      `inline-flex min-h-[34px] items-center whitespace-nowrap rounded-lg border px-1.5 py-1 font-display text-[0.75rem] tracking-wide transition sm:px-3 sm:text-sm ${
                        isActive
                          ? "border-gold/50 bg-gold/15 text-gold-soft"
                          : "border-transparent text-ivory/60 hover:bg-white/[0.04] hover:text-ivory"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          {/*
           * Where a route hangs its own controls.
           *
           * The table's mode switch and its "4-handed · Hand #1" rail used to
           * live in a second header row below the felt's own heading, and those
           * two rows were 114px of the 240px that pushed Fold and Call off the
           * bottom of a 1440x760 screen. They belong here: the bar is already
           * paid for on every route.
           *
           * A slot rather than a prop because this component cannot read the
           * table. `AppShell` is the layout route and `TableProvider` mounts
           * inside its `<Outlet />` (see App.tsx), so `useTable()` here would
           * throw on `/` and `/learn`. The table portals into this node
           * instead, which keeps the provider exactly where it is and leaves
           * the node empty on every route that has nothing to hang.
           */}
          <div
            id={HEADER_SLOT_ID}
            data-testid="header-slot"
            className="hidden min-w-0 flex-1 items-center justify-end gap-3 lg:flex"
          />

        </div>
      </header>

      <div id="main">
        <Outlet />
      </div>
    </div>
  );
}
