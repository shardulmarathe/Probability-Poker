/**
 * The top of a page: what it is, in one heading and one sentence.
 *
 * Every route now has an `<h1>` — `/table` and `/game` had none at all, which
 * meant a screen reader's document outline for the main activity of the product
 * started at "Hand #4". `compact` is for the table, where the felt needs the
 * vertical space and the heading earns one line rather than three.
 */

import { Link } from "react-router-dom";
import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  /** One sentence saying what this page is for or what state it is in. */
  lede?: ReactNode;
  /** Controls: navigation to a sibling surface, a destructive reset, a picker. */
  actions?: ReactNode;
  /** Rails and tags describing the current state. */
  meta?: ReactNode;
  compact?: boolean;
}

export function PageHeader({
  title,
  lede,
  actions,
  meta,
  compact = false,
}: PageHeaderProps) {
  if (compact) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-lg font-bold tracking-tight text-gold-soft sm:text-xl">
            {title}
          </h1>
          {lede && (
            <p className="min-w-0 text-[0.75rem] leading-snug text-ivory/50 sm:text-[0.8rem]">
              {lede}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {actions}
          {meta}
        </div>
      </div>
    );
  }

  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-display text-[clamp(1.5rem,6vw,2.1rem)] font-bold tracking-tight text-gold-soft">
          {title}
        </h1>
        {lede && (
          <p className="mt-1.5 max-w-xl text-[0.85rem] leading-relaxed text-ivory/60 sm:text-sm">
            {lede}
          </p>
        )}
      </div>
      {(actions || meta) && (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {meta}
        </div>
      )}
    </header>
  );
}

/**
 * The one back-link form in the product.
 *
 * There were four vocabularies — "← New table", "← Back to table" pointing at
 * two different destinations, "← Back to profile", "← Probability Poker". The
 * rule now: a back-link names its destination exactly as the nav names it, and
 * only exists when it returns you to something specific you came from. General
 * movement is the nav's job.
 */
export function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-[34px] items-center font-display text-xs tracking-wide text-ivory/60 transition hover:text-gold-soft sm:text-sm"
    >
      <span aria-hidden className="mr-1.5">
        ←
      </span>
      {children}
    </Link>
  );
}

/**
 * The standard page body: centred, padded, and clear of the notch.
 *
 * Pages still render their own `<main>` so the shell does not have to know how
 * tall any of them is; this is only the column inside it.
 */
export function PageBody({
  children,
  width = "wide",
}: {
  children: ReactNode;
  width?: "wide" | "narrow" | "full";
}) {
  const max =
    width === "narrow" ? "max-w-4xl" : width === "full" ? "max-w-6xl" : "max-w-5xl";
  return (
    <div
      className={`relative z-10 mx-auto ${max} px-3 pb-14 pt-5 sm:px-4 sm:pt-7`}
      style={{
        paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
        paddingRight: "max(0.75rem, env(safe-area-inset-right))",
      }}
    >
      {children}
    </div>
  );
}
