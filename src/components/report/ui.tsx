/**
 * The review's presentational vocabulary.
 *
 * These are lifted from `pages/Analysis.tsx` rather than imported from it: that
 * page belongs to the heads-up engine and reads a different report type, and a
 * shared import would tie the two together for the sake of a border colour.
 * The visual language is deliberately identical — felt panels, gold hairlines,
 * Cinzel headings — so the two reports read as one product.
 */

import { useId, useState, type ReactNode } from "react";
import { decodeCard } from "../../poker/core/card";
import { PlayingCard } from "../PlayingCard";

export function FeltBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1100px 700px at 50% -10%, #0f3324 0%, transparent 60%), linear-gradient(180deg, #0a1c14 0%, #060f0a 100%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 25% 30%, #f4ede4 0.5px, transparent 0.6px), radial-gradient(circle at 75% 70%, #f4ede4 0.5px, transparent 0.6px)",
          backgroundSize: "26px 26px",
        }}
      />
    </div>
  );
}

export function Section({
  title,
  subtitle,
  wide,
  children,
}: {
  title: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`min-w-0 rounded-2xl border p-3 shadow-xl sm:p-6 ${wide ? "lg:col-span-2" : ""}`}
      style={{
        borderColor: "rgba(201,162,39,0.28)",
        background:
          "linear-gradient(180deg, rgba(18,53,36,0.65) 0%, rgba(11,34,24,0.75) 100%)",
        boxShadow: "0 18px 40px rgba(0,0,0,0.4)",
      }}
    >
      <div className="mb-4">
        <h2 className="font-display text-lg font-semibold tracking-wide text-gold-soft sm:text-xl">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-[0.65rem] uppercase tracking-[0.18em] text-ivory/45 sm:text-xs">
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

/** Collapsible educational accordion, collapsed by default. */
export function HowCalculated({
  label = "How Was This Calculated?",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="mt-5 overflow-hidden rounded-xl border"
      style={{ borderColor: "rgba(201,162,39,0.3)", background: "rgba(0,0,0,0.28)" }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition hover:bg-white/[0.03] sm:px-4"
      >
        <span className="flex items-center gap-2 font-display text-[0.8rem] font-semibold tracking-wide text-gold-soft sm:text-sm">
          <span className="text-base">📐</span>
          {label}
        </span>
        <span
          className="text-gold-soft transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div
          className="border-t px-3 py-4 text-sm leading-relaxed text-ivory/80 sm:px-4"
          style={{ borderColor: "rgba(201,162,39,0.2)" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-ivory/75">{children}</p>;
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 mt-4 font-display text-xs font-semibold uppercase tracking-[0.2em] text-gold-soft/90 first:mt-0">
      {children}
    </p>
  );
}

/** A boxed equation / derivation panel in monospace. */
export function Calc({ children }: { children: ReactNode }) {
  return (
    <div
      className="my-3 overflow-x-auto rounded-lg border px-3 py-3 font-mono text-[0.72rem] leading-relaxed text-ivory/90 sm:px-4 sm:text-[0.8rem]"
      style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.35)" }}
    >
      {children}
    </div>
  );
}

/** A typeset fraction (numerator over denominator). */
export function Frac({ n, d }: { n: ReactNode; d: ReactNode }) {
  return (
    <span className="mx-1 inline-flex flex-col items-center align-middle">
      <span className="px-2 pb-0.5">{n}</span>
      <span
        className="w-full px-2 pt-0.5"
        style={{ borderTop: "1px solid rgba(244,237,228,0.5)" }}
      >
        {d}
      </span>
    </span>
  );
}

export function Why({
  label = "Why it mattered",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="mt-3 rounded-lg border-l-2 px-3 py-2 text-ivory/70"
      style={{ borderColor: "#c9a227", background: "rgba(201,162,39,0.08)" }}
    >
      <span className="font-display text-xs font-semibold uppercase tracking-wider text-gold-soft">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  highlight,
  sub,
}: {
  label: string;
  value: ReactNode;
  highlight?: boolean;
  sub?: string;
}) {
  return (
    <div
      className="min-w-0 rounded-xl border p-2.5 sm:p-3"
      style={{ borderColor: "rgba(244,237,228,0.14)", background: "rgba(0,0,0,0.25)" }}
    >
      <p className="truncate text-[0.6rem] uppercase tracking-wider text-ivory/45 sm:text-xs">
        {label}
      </p>
      <p
        className={`mt-1 font-display text-base font-semibold sm:text-lg ${
          highlight ? "text-gold-soft" : "text-ivory"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[0.65rem] text-ivory/45">{sub}</p>}
    </div>
  );
}

/** A row of cards from integer card codes, as the table report stores them. */
export function CardRow({
  label,
  cards,
  size = "sm",
  empty = "No cards",
}: {
  label?: string;
  cards: number[];
  size?: "sm" | "md" | "lg";
  empty?: string;
}) {
  return (
    <div className="min-w-0">
      {label && (
        <p className="mb-1.5 text-[0.6rem] uppercase tracking-wider text-ivory/50 sm:text-xs">
          {label}
        </p>
      )}
      <div className="flex flex-wrap gap-1 sm:gap-1.5">
        {cards.length === 0 && <span className="text-sm text-ivory/40">{empty}</span>}
        {cards.map((code, i) => (
          <PlayingCard key={`${code}-${i}`} card={decodeCard(code)} size={size} />
        ))}
      </div>
    </div>
  );
}

/** Card codes as text, for use inside prose. */
export function cardText(codes: number[]): string {
  return codes.map((c) => decodeCard(c).id).join(" ") || "—";
}

export function Rail({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-full border px-2.5 py-1 font-mono text-[0.55rem] uppercase tracking-[0.2em] text-ivory/60 sm:text-[0.6rem]"
      style={{ borderColor: "rgba(201,162,39,0.3)", background: "rgba(0,0,0,0.35)" }}
    >
      {children}
    </span>
  );
}

export function Tag({
  children,
  tone = "quiet",
}: {
  children: ReactNode;
  tone?: "quiet" | "gold" | "good" | "bad";
}) {
  const tones: Record<string, { fg: string; bg: string; bd: string }> = {
    quiet: { fg: "rgba(244,237,228,0.7)", bg: "rgba(0,0,0,0.3)", bd: "rgba(244,237,228,0.16)" },
    gold: { fg: "#e2c563", bg: "rgba(201,162,39,0.15)", bd: "rgba(201,162,39,0.45)" },
    good: { fg: "#7fd3a8", bg: "rgba(95,185,143,0.12)", bd: "rgba(95,185,143,0.4)" },
    bad: { fg: "#e58a8a", bg: "rgba(210,74,74,0.12)", bd: "rgba(210,74,74,0.4)" },
  };
  const t = tones[tone];
  return (
    <span
      className="inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 font-display text-[0.6rem] font-semibold uppercase tracking-wider sm:text-[0.65rem]"
      style={{ color: t.fg, background: t.bg, borderColor: t.bd }}
    >
      {children}
    </span>
  );
}

/** A labelled proportion bar. Width and the printed number carry the value. */
export function Meter({
  label,
  value,
  text,
  color = "#e2c563",
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
 * Horizontally scrollable wrapper — a wide table scrolls inside its own box
 * rather than widening the page. The fade on the right edge is the only hint a
 * phone gets that there is more table off-screen, so it is not decoration.
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

export function EmptyPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-xl border border-dashed p-5 text-center"
      style={{ borderColor: "rgba(201,162,39,0.3)", background: "rgba(0,0,0,0.22)" }}
    >
      <p className="font-display text-sm font-semibold tracking-wide text-gold-soft">
        {title}
      </p>
      <div className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-ivory/60">
        {children}
      </div>
    </div>
  );
}

/** A radio-style chip row: street pickers, seat pickers, tab bars. */
export function ChipRow<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  testIdPrefix,
}: {
  options: { value: T; label: string; sub?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  testIdPrefix?: string;
}) {
  const id = useId();
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
      style={{ scrollbarWidth: "none" }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={`${id}-${o.value}`}
            role="tab"
            aria-selected={active}
            data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
            onClick={() => onChange(o.value)}
            className="min-h-[36px] shrink-0 rounded-lg border px-2.5 py-1.5 font-display text-[0.68rem] tracking-wide transition sm:px-3 sm:text-xs"
            style={{
              borderColor: active ? "rgba(201,162,39,0.6)" : "rgba(244,237,228,0.14)",
              background: active ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
              color: active ? "#e2c563" : "rgba(244,237,228,0.62)",
            }}
          >
            {o.label}
            {o.sub && (
              <span className="ml-1.5 font-mono text-[0.6rem] opacity-70">{o.sub}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
