/**
 * Shared furniture for the N-handed table: the felt, the badges, the bubbles,
 * the chips, and the geometry that decides where a seat sits.
 *
 * Everything here is presentation. It reads the same vocabulary as the heads-up
 * table — deep green felt, gold rims, Cinzel display type, one soft animation
 * per event — and adds exactly one thing that table did not need: a seat's
 * position is now a number rather than "top" or "bottom".
 */

import { useEffect, useState, type ReactNode } from "react";
import type { ThinkStep } from "../../store/TableContext";

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

/**
 * Whether the layout is running in its compact form.
 *
 * A media query rather than a breakpoint class because the seat geometry itself
 * changes — six seats on a 390px screen need a different ellipse, not a smaller
 * one — and that is arithmetic, not CSS.
 */
export function useNarrow(query = "(max-width: 767px)"): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

// ---------------------------------------------------------------------------
// Seat geometry
// ---------------------------------------------------------------------------

export interface SeatPoint {
  /** Percent of the table's width and height. */
  x: number;
  y: number;
}

/** Middle of the board — the target every chip flies to. */
export const POT_CENTRE: SeatPoint = { x: 50, y: 48 };

/**
 * Top edge of the centre column (board, then the street and pot pills).
 *
 * Anchored by its top rather than centred for the same reason the seats are:
 * the seat directly above it grows downward as Study mode adds a read, and the
 * one thing that must not move is where the board starts.
 *
 * These percentages and `MIN_FELT` below are one calculation, not two. At four
 * and six-handed a seat sits directly above the board, so the felt has to hold
 * a full stack — seat, board, pot, hero — without overlap:
 *
 *   board top   0.40H  >=  0.02H + 177 (seat) + 10   ->  H >= 492
 *   hero top    0.84H - 56  >=  0.40H + 150 + 15     ->  H >= 502
 *
 * Hence a 32rem floor on wide screens. Below it the page scrolls, which is the
 * honest failure: a short window gets a scrollbar, never a seat on top of the
 * flop.
 *
 * A phone runs the same sum against a compact seat (~130px) and a narrower
 * board, and lands on a 25rem floor. Its board sits lower in the felt than the
 * desktop's: a phone's control bar is short, so the felt ends up ~650px tall,
 * and a board anchored high leaves one enormous void between the pot and the
 * hero instead of a little breathing room on either side of it.
 */
export const boardTop = (narrow: boolean): number => (narrow ? 42 : 40);

/**
 * Seat anchors for an `n`-handed table, seat 0 first.
 *
 * Seat 0 is pinned bottom-centre — the human's chair, and in observer mode it
 * stays there so one layout serves both. The rest are spread around the top arc
 * of an ellipse: for `k` opponents the arc from 180° to 0° is cut into `k + 1`
 * equal steps and the seats take the interior points, which comes out symmetric
 * at every table size without a table of hand-tuned coordinates.
 *
 * The arc gives the *top edge* of an opponent's card, not its centre. That is
 * the whole difficulty of this layout: at four-handed one seat sits directly
 * above the board, and a seat centred on the arc grows both upward (off the
 * felt) and downward (into the community cards) as its contents change. Pinning
 * the top edge makes a seat grow in one direction only, which is what lets
 * Study mode add a read and a blurb without moving anything else.
 */
export function seatLayout(n: number, narrow: boolean): SeatPoint[] {
  const rx = narrow ? 42 : 41;
  const ry = narrow ? 26 : 28;
  const cy = narrow ? 28 : 30;
  const points: SeatPoint[] = [{ x: 50, y: narrow ? 86 : 84 }];
  const k = n - 1;
  for (let j = 0; j < k; j++) {
    const rad = ((180 - ((j + 1) * 180) / (k + 1)) * Math.PI) / 180;
    points.push({ x: 50 + rx * Math.cos(rad), y: cy - ry * Math.sin(rad) });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Injected styles
// ---------------------------------------------------------------------------

/**
 * Two things the utility classes cannot express: a chip that flies from an
 * arbitrary seat to the pot, and a range input that looks like it belongs on a
 * card table. Both are keyed off CSS variables set per element, so one rule
 * serves every seat and every stack depth.
 */
export function TableStyles() {
  return (
    <style>{`
.pp-t-chip {
  position: absolute;
  width: 28px; height: 28px; margin: -14px 0 0 -14px;
  border-radius: 9999px;
  border: 2px dashed #e2c563;
  background: radial-gradient(circle at 50% 35%, #a30222 0%, #7a0019 70%);
  box-shadow: 0 4px 10px rgba(0,0,0,0.45);
  animation: pp-t-fly 0.46s cubic-bezier(0.4, 0, 0.2, 1) both;
}
@keyframes pp-t-fly {
  0%   { left: var(--sx); top: var(--sy); opacity: 0; transform: scale(0.45); }
  22%  { opacity: 1; }
  78%  { left: var(--px); top: var(--py); opacity: 1; transform: scale(1); }
  100% { left: var(--px); top: var(--py); opacity: 0; transform: scale(0.85); }
}

.pp-t-slider {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 8px; border-radius: 9999px;
  outline: none; cursor: pointer;
}
.pp-t-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 24px; height: 24px; border-radius: 9999px;
  background: radial-gradient(circle at 34% 28%, #f6e6ae 0%, #c9a227 58%, #8a6c11 100%);
  border: 2px solid #0b2218;
  box-shadow: 0 2px 10px rgba(0,0,0,0.55);
}
.pp-t-slider::-moz-range-thumb {
  width: 22px; height: 22px; border-radius: 9999px; border: 2px solid #0b2218;
  background: radial-gradient(circle at 34% 28%, #f6e6ae 0%, #c9a227 58%, #8a6c11 100%);
  box-shadow: 0 2px 10px rgba(0,0,0,0.55);
}
.pp-t-slider:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px rgba(201,162,39,0.35); }

.pp-t-sheet { animation: pp-t-sheet 0.24s cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes pp-t-sheet {
  from { opacity: 0; transform: translateY(28px); }
  to   { opacity: 1; transform: translateY(0); }
}

.pp-t-win { animation: pp-t-win 1.1s ease-in-out infinite; }
@keyframes pp-t-win {
  0%, 100% { box-shadow: 0 0 0 0 rgba(226,197,99,0); }
  50%      { box-shadow: 0 0 26px 3px rgba(226,197,99,0.55); }
}

@media (prefers-reduced-motion: reduce) {
  .pp-t-chip, .pp-t-sheet, .pp-t-win { animation: none; opacity: 1; }
}
`}</style>
  );
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

export function FeltBackground() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1100px 700px at 50% -10%, #0f3324 0%, transparent 60%), linear-gradient(180deg, #0a1c14 0%, #060f0a 100%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 25% 30%, #f4ede4 0.5px, transparent 0.6px), radial-gradient(circle at 75% 70%, #f4ede4 0.5px, transparent 0.6px)",
          backgroundSize: "26px 26px",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type BadgeTone = "dealer" | "blind" | "quiet";

export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  const style =
    tone === "dealer"
      ? { background: "#c9a227", color: "#0d0d0d" }
      : tone === "blind"
        ? {
            background: "rgba(0,0,0,0.4)",
            color: "#e2c563",
            border: "1px solid rgba(201,162,39,0.55)",
          }
        : {
            background: "rgba(0,0,0,0.35)",
            color: "rgba(244,237,228,0.7)",
            border: "1px solid rgba(244,237,228,0.2)",
          };
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-none tracking-wide"
      style={style}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

const BUBBLE_SKIN = {
  borderColor: "rgba(201,162,39,0.5)",
  background: "linear-gradient(180deg, #fbf7ef 0%, #efe6d4 100%)",
  color: "#1a1a1a",
};

export function SpeechBubble({
  text,
  side,
}: {
  text: string;
  side: "top" | "bottom";
}) {
  const pos = side === "top" ? "bottom-full mb-2" : "top-full mt-2";
  return (
    <div
      className={`pp-bubble pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 whitespace-nowrap ${pos}`}
    >
      <div
        className="rounded-xl border px-3 py-1.5 font-display text-xs font-semibold shadow-xl sm:text-sm"
        style={BUBBLE_SKIN}
      >
        {text}
      </div>
    </div>
  );
}

export function ThoughtBubble({
  step,
  side,
}: {
  step: ThinkStep;
  side: "top" | "bottom";
}) {
  const pos = side === "top" ? "bottom-full mb-2" : "top-full mt-2";
  return (
    <div
      className={`pp-bubble pointer-events-none absolute left-1/2 z-30 w-[min(13rem,60vw)] -translate-x-1/2 ${pos}`}
    >
      <div className="rounded-xl border px-3 py-2 shadow-xl" style={BUBBLE_SKIN}>
        {/* Re-keying on the step index re-runs the fade for each new message. */}
        <div key={step.step} className="pp-thought">
          <div className="flex items-center gap-1.5 font-display text-[0.7rem] font-semibold sm:text-xs">
            {step.title}
            <span className="flex gap-0.5">
              <Dot delay="0s" />
              <Dot delay="0.2s" />
              <Dot delay="0.4s" />
            </span>
          </div>
          {step.detail && (
            <div className="mt-0.5 font-mono text-[0.6rem]" style={{ color: "#7a0019" }}>
              {step.detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="pp-dot inline-block h-1 w-1 rounded-full"
      style={{ background: "#7a0019", animationDelay: delay }}
    />
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export function ChipLayer({
  chips,
  points,
}: {
  chips: { id: number; seat: number }[];
  points: SeatPoint[];
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {chips.map((chip) => {
        const from = points[chip.seat] ?? POT_CENTRE;
        return (
          <span
            key={chip.id}
            className="pp-t-chip"
            style={
              {
                "--sx": `${from.x}%`,
                "--sy": `${from.y}%`,
                "--px": `${POT_CENTRE.x}%`,
                "--py": `${POT_CENTRE.y}%`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

export function Rail({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-lg border px-2.5 py-1 font-display text-[0.65rem] tracking-widest text-gold-soft sm:px-3 sm:py-1.5 sm:text-xs"
      style={{
        borderColor: "rgba(201,162,39,0.35)",
        background: "rgba(0,0,0,0.3)",
      }}
    >
      {children}
    </span>
  );
}

/** A 3-segment weak/medium/strong read, as a bar. */
export function BeliefBar({
  belief,
  width = "3.5rem",
}: {
  belief: { weak: number; medium: number; strong: number };
  width?: string;
}) {
  const parts: [string, number][] = [
    ["#94a3b8", belief.weak],
    ["#e2c563", belief.medium],
    ["#a30222", belief.strong],
  ];
  return (
    <span
      className="inline-flex h-1.5 overflow-hidden rounded-full"
      style={{ width, background: "rgba(0,0,0,0.45)" }}
      title={`weak ${Math.round(belief.weak * 100)}% · medium ${Math.round(
        belief.medium * 100
      )}% · strong ${Math.round(belief.strong * 100)}%`}
    >
      {parts.map(([color, value]) => (
        <span key={color} style={{ background: color, width: `${value * 100}%` }} />
      ))}
    </span>
  );
}
