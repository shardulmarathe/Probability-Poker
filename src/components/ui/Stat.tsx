/**
 * One metric, and the grid that holds several.
 *
 * There were three `Stat` components with three incompatible APIs — `note`/
 * `tone` on the table's coach panel, `highlight`/`sub` on the report and on the
 * legacy analysis page — which meant a number could not be moved between two
 * screens without being rewritten. This is the union of all three, spelled once:
 *
 *   label   what the number is
 *   value   the number
 *   note    the caveat, the denominator, or the unit
 *   tone    what the number means, if it means anything
 *   meter   0..1, when the number is a share and the bar helps read it
 *
 * `highlight` is gone; it said "make this gold" without saying why. `tone`
 * says why, and gold is what "gold" looks like.
 *
 * A `Stat` draws no box. Six boxed metrics in a row is the cardification the
 * profile was full of — the grid's whitespace groups them, and the container
 * they sit in (if any) carries the meaning.
 */

import type { ReactNode } from "react";
import { TONE, type Tone } from "./tokens";

export interface StatProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone;
  /** 0..1, or null when nothing was observed — a null meter draws an empty track. */
  meter?: number | null;
  /** Dim the meter when the sample behind it is too thin to trust. */
  meterThin?: boolean;
  testId?: string;
}

export function Stat({
  label,
  value,
  note,
  tone = "neutral",
  meter,
  meterThin,
  testId,
}: StatProps) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="truncate font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ivory/45">
        {label}
      </p>
      <p
        className="mt-1 font-display text-xl font-semibold leading-tight sm:text-2xl"
        style={{ color: TONE[tone] }}
      >
        {value}
      </p>
      {meter !== undefined && <Track value={meter} thin={meterThin} />}
      {note && (
        <p className="mt-1 text-[0.7rem] leading-snug text-ivory/45">{note}</p>
      )}
    </div>
  );
}

function Track({ value, thin }: { value: number | null; thin?: boolean }) {
  return (
    <div
      className="mt-1.5 h-1 w-full overflow-hidden rounded-full"
      style={{ background: "rgba(0,0,0,0.45)" }}
    >
      {value !== null && (
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${Math.max(2, Math.min(1, value) * 100)}%`,
            backgroundColor: thin ? "rgba(201,162,39,0.35)" : "#e2c563",
          }}
        />
      )}
    </div>
  );
}

/**
 * Metrics laid out by whitespace rather than by boxes.
 *
 * `columns` is the widest count; the grid steps down on narrow screens so a
 * value never wraps mid-number.
 */
export function StatGrid({
  columns = 4,
  children,
  testId,
}: {
  columns?: 2 | 3 | 4 | 6;
  children: ReactNode;
  testId?: string;
}) {
  const wide = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-4",
    6: "sm:grid-cols-3 lg:grid-cols-6",
  }[columns];
  return (
    <div
      data-testid={testId}
      className={`grid grid-cols-2 gap-x-6 gap-y-5 ${wide}`}
    >
      {children}
    </div>
  );
}
