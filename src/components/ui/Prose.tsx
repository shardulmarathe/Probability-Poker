/**
 * The explanatory voice: leads, sub-headings, worked equations, asides.
 *
 * These are how the product teaches, and they were duplicated between the
 * report and the legacy analysis page — same job, different margins. One copy.
 */

import { useState, type ReactNode } from "react";
import { LINE, RADIUS, TONE } from "./tokens";

/** The opening sentence of an explanation. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="mb-3 leading-relaxed text-ivory/75">{children}</p>;
}

/**
 * A sub-heading inside an explanation.
 *
 * Uppercase and tracked out — which is the eyebrow treatment the section
 * headers deliberately avoid. It earns it here: these appear several to a
 * panel, marking steps in a derivation, where a run of small caps is a table of
 * contents rather than a tic.
 */
export function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 mt-4 font-display text-xs font-semibold uppercase tracking-[0.2em] text-gold-soft/90 first:mt-0">
      {children}
    </p>
  );
}

/** A boxed equation or derivation, in monospace. */
export function Calc({ children }: { children: ReactNode }) {
  return (
    <div
      className={`my-3 overflow-x-auto border px-3 py-3 font-mono text-[0.72rem] leading-relaxed text-ivory/90 sm:px-4 sm:text-[0.8rem] ${RADIUS.control}`}
      style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.35)" }}
    >
      {children}
    </div>
  );
}

/** A typeset fraction: numerator over denominator. */
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

/**
 * An aside that qualifies what is above it — why it mattered, what it does not
 * mean, what the sample cannot support.
 */
export function Note({
  label,
  tone = "gold",
  testId,
  children,
}: {
  label?: string;
  tone?: "gold" | "bad";
  testId?: string;
  children: ReactNode;
}) {
  const ink = tone === "bad" ? "#d24a4a" : "#c9a227";
  return (
    <div
      data-testid={testId}
      className={`mt-3 border-l-2 px-3 py-2.5 ${RADIUS.control}`}
      style={{
        borderColor: ink,
        background:
          tone === "bad" ? "rgba(210,74,74,0.10)" : "rgba(201,162,39,0.08)",
      }}
    >
      {label && (
        <span
          className="font-display text-xs font-semibold uppercase tracking-wider"
          style={{ color: tone === "bad" ? TONE.bad : TONE.gold }}
        >
          {label}
        </span>
      )}
      <div className={`text-[0.8rem] leading-relaxed text-ivory/75 ${label ? "mt-1" : ""}`}>
        {children}
      </div>
    </div>
  );
}

/** The old name from the report. Same component, label defaulted. */
export function Why({
  label = "Why it mattered",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return <Note label={label}>{children}</Note>;
}

/**
 * A derivation the reader can open, collapsed by default.
 *
 * Collapsed rather than absent because the maths is the product's argument, and
 * collapsed rather than always-open because a page of algebra above the numbers
 * it explains is a page nobody reads.
 */
export function HowCalculated({
  label = "How is this calculated?",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`mt-5 overflow-hidden border ${RADIUS.control}`}
      style={{ borderColor: LINE.gold, background: "rgba(0,0,0,0.28)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition hover:bg-white/[0.03] sm:px-4"
      >
        <span className="font-display text-[0.8rem] font-semibold tracking-wide text-gold-soft sm:text-sm">
          {label}
        </span>
        <span
          aria-hidden
          className="text-gold-soft transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div
          className="border-t px-3 py-4 text-sm leading-relaxed text-ivory/80 sm:px-4"
          style={{ borderColor: LINE.goldFaint }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
