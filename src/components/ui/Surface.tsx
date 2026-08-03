/**
 * Containers, and the decision of when not to use one.
 *
 * The audit's finding was cardification: every metric, paragraph and heading on
 * the profile lived in its own rounded box, so the boxes stopped meaning
 * anything. There are two containers here and a rule for choosing:
 *
 *   <Group>   a heading, a hairline, and content. No box. Use this by default —
 *             whitespace and a rule group things perfectly well.
 *   <Panel>   a real surface: border, gradient, shadow. Use it when the thing
 *             inside is a distinct object you could point at (the table setup,
 *             a verdict banner), not merely the next section down the page.
 *
 * `Section` is `Panel` under its old name, so `report/ui.tsx` can migrate by
 * changing one import line.
 */

import type { ReactNode } from "react";
import { LINE, RADIUS, SURFACE } from "./tokens";

// ---------------------------------------------------------------------------
// Group — the default
// ---------------------------------------------------------------------------

export interface GroupProps {
  title: string;
  /**
   * One sentence under the title. Deliberately sentence case and below the
   * heading rather than a tiny uppercase eyebrow above it: an eyebrow on every
   * section is the most recognisable machine-written rhythm there is.
   */
  lede?: ReactNode;
  /** Controls that belong to this group, aligned with the title. */
  actions?: ReactNode;
  wide?: boolean;
  id?: string;
  testId?: string;
  children: ReactNode;
}

export function Group({
  title,
  lede,
  actions,
  wide,
  id,
  testId,
  children,
}: GroupProps) {
  return (
    <section
      id={id}
      data-testid={testId}
      className={`min-w-0 ${wide ? "lg:col-span-2" : ""}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-lg font-semibold tracking-wide text-gold-soft sm:text-xl">
          {title}
        </h2>
        {actions}
      </div>
      {lede && (
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ivory/55">
          {lede}
        </p>
      )}
      <div
        className="mt-3 border-t pt-4"
        style={{ borderColor: LINE.goldFaint }}
      >
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel — when the container is the point
// ---------------------------------------------------------------------------

export interface PanelProps {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  id?: string;
  testId?: string;
  children: ReactNode;
}

export function Panel({
  title,
  subtitle,
  actions,
  wide,
  id,
  testId,
  children,
}: PanelProps) {
  return (
    <section
      id={id}
      data-testid={testId}
      className={`min-w-0 border p-4 shadow-xl sm:p-6 ${RADIUS.surface} ${
        wide ? "lg:col-span-2" : ""
      }`}
      style={{
        borderColor: LINE.gold,
        background: SURFACE.panel,
        boxShadow: "0 18px 40px rgba(0,0,0,0.4)",
      }}
    >
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            {title && (
              <h2 className="font-display text-lg font-semibold tracking-wide text-gold-soft sm:text-xl">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 text-sm leading-relaxed text-ivory/55">
                {subtitle}
              </p>
            )}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** The old name, for `report/*` to migrate onto without a rewrite. */
export const Section = Panel;

// ---------------------------------------------------------------------------
// Recessed area inside a panel
// ---------------------------------------------------------------------------

/** A sunk well — a place to put a table, a chart, or a scrubber. */
export function Well({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`border p-3 ${RADIUS.control}`}
      style={{ borderColor: LINE.quietFaint, background: SURFACE.sunk }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

/**
 * An empty state names the thing that would fill it and offers the control
 * that starts filling it. It never merely reports that something is empty.
 */
export function EmptyState({
  title,
  action,
  testId,
  children,
}: {
  title: string;
  action?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={`border border-dashed px-5 py-7 text-center ${RADIUS.surface}`}
      style={{ borderColor: LINE.gold, background: SURFACE.sunk }}
    >
      <p className="font-display text-base font-semibold tracking-wide text-gold-soft">
        {title}
      </p>
      <div className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-ivory/60">
        {children}
      </div>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/** The old name. Same component. */
export const EmptyPanel = EmptyState;
