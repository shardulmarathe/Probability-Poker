/**
 * The two controls every concept on this page shares.
 *
 * They sat at the top of `LearnPage.tsx` while the page was one 1,283-line file
 * that rendered all seven concepts at once. The page is now a selector plus
 * whichever concept is chosen, so each concept lives in its own module under
 * `concepts/` — and two modules that both need `Choice` must not reach into
 * each other to get it. That is how the report ended up with two copies of a
 * dozen primitives, which then drifted within days. One copy, here.
 *
 * Neither of these belongs in `ui/`: `Choice` is a deliberately smaller, quieter
 * control than `ui/Tabs`, because on this page the concept selector is the tab
 * row and a demo's own knobs must not compete with it.
 */

import type { ReactNode } from "react";
import { LINE, RADIUS } from "../ui";

/** A row of mutually exclusive choices. A concept's only knob. */
export function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="mb-1 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
        {label}
      </p>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              onClick={() => onChange(o.value)}
              className={`min-h-[32px] border px-2.5 py-1 font-display text-[0.65rem] tracking-wide transition ${RADIUS.control}`}
              style={{
                borderColor: active ? "rgba(201,162,39,0.6)" : LINE.quiet,
                background: active ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
                color: active ? "#e2c563" : "rgba(244,237,228,0.55)",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The button that runs something expensive. Named for what it will do. */
export function RunButton({
  onClick,
  children,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`min-h-[38px] border px-4 py-2 font-display text-sm font-semibold tracking-wide transition hover:-translate-y-px ${RADIUS.action}`}
      style={{
        borderColor: "rgba(201,162,39,0.55)",
        background: "rgba(201,162,39,0.15)",
        color: "#e2c563",
      }}
    >
      {children}
    </button>
  );
}
