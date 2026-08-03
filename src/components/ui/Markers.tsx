/**
 * Things you read but never press.
 *
 * `Rail` existed twice — a gold Cinzel chip with an 8px radius in the table's
 * header, an ivory monospace capsule in the report's — and the two appeared in
 * adjacent page headers, one hop apart, so the drift was visible without
 * leaving the flow. This is the report's version (monospace reads better for
 * counts and blind levels) at the marker radius, in one file.
 */

import type { ReactNode } from "react";
import { LINE, RADIUS, SURFACE, TONE, type Tone } from "./tokens";

/** A quiet fact about the current screen: hand number, blinds, archive size. */
export function Rail({ children }: { children: ReactNode }) {
  return (
    <span
      className={`whitespace-nowrap border px-2.5 py-1 font-mono text-[0.55rem] uppercase tracking-[0.2em] text-ivory/60 sm:text-[0.6rem] ${RADIUS.marker}`}
      style={{ borderColor: LINE.gold, background: "rgba(0,0,0,0.35)" }}
    >
      {children}
    </span>
  );
}

/** A classification applied to something on the page: a street, a verdict. */
export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  const skin: Record<Tone, { bg: string; bd: string }> = {
    neutral: { bg: "rgba(0,0,0,0.3)", bd: LINE.quiet },
    gold: { bg: "rgba(201,162,39,0.15)", bd: "rgba(201,162,39,0.45)" },
    good: { bg: "rgba(95,185,143,0.12)", bd: "rgba(95,185,143,0.4)" },
    bad: { bg: "rgba(210,74,74,0.12)", bd: "rgba(210,74,74,0.4)" },
    sim: { bg: "rgba(176,127,212,0.12)", bd: "rgba(176,127,212,0.45)" },
  };
  const s = skin[tone];
  return (
    <span
      className={`inline-block whitespace-nowrap border px-1.5 py-0.5 font-display text-[0.6rem] font-semibold uppercase tracking-wider sm:text-[0.65rem] ${RADIUS.marker}`}
      style={{
        color: tone === "neutral" ? "rgba(244,237,228,0.7)" : TONE[tone],
        background: s.bg,
        borderColor: s.bd,
      }}
    >
      {children}
    </span>
  );
}

/** A labelled proportion bar. The width and the printed number carry the value. */
export function Meter({
  label,
  value,
  text,
  color = TONE.gold,
}: {
  label: ReactNode;
  value: number;
  text: string;
  color?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-ivory/75">{label}</span>
        <span className="shrink-0 font-mono text-ivory">{text}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full"
        style={{ background: "rgba(0,0,0,0.45)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${Math.max(0, Math.min(1, value)) * 100}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

/**
 * A wide thing scrolling inside its own box rather than widening the page.
 *
 * The fade on the right edge is the only hint a phone gets that there is more
 * table off-screen, so it is not decoration.
 */
export function Scroller({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
        <div className="min-w-[34rem]">{children}</div>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-[-0.75rem] w-10 sm:hidden"
        style={{
          background:
            "linear-gradient(90deg, rgba(9,28,20,0) 0%, rgba(9,28,20,0.85) 65%, rgba(9,28,20,0.95) 100%)",
        }}
      />
    </div>
  );
}

/** A small tray for a row of markers or controls sitting on the felt. */
export function Tray({ children }: { children: ReactNode }) {
  return (
    <div
      className={`flex items-center gap-0.5 border p-0.5 ${RADIUS.action}`}
      style={{ borderColor: LINE.gold, background: SURFACE.tray }}
    >
      {children}
    </div>
  );
}
