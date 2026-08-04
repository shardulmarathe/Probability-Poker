/**
 * Shared furniture for the N-handed table: the felt, the badges, the bubbles,
 * the chips, and the geometry that decides where a seat sits.
 *
 * Everything here is presentation. It reads the same vocabulary as the heads-up
 * table, deep green felt, gold rims, Cinzel display type, one soft animation
 * per event, and adds exactly one thing that table did not need: a seat's
 * position is now a number rather than "top" or "bottom".
 *
 * What is *not* here any more: `FeltBackground` and `Rail`. Both existed in
 * `components/ui` as well, and both had drifted, the felt in texture opacity,
 * the rail into a different font, colour and radius from the one used on the
 * review page one hop away. This file keeps only what is specific to a table
 * with seats around it.
 */

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

/**
 * Whether the layout is running in its compact form.
 *
 * A media query rather than a breakpoint class because the seat geometry itself
 * changes, six seats on a 390px screen need a different ellipse, not a smaller
 * one, and that is arithmetic, not CSS.
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

/** Middle of the board, the target every chip flies to. */
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
 * a full stack, seat, board, pot, hero, without overlap:
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
 * Seat 0 is pinned bottom-centre, the human's chair, and in observer mode it
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
  width: 26px; height: 26px; margin: -13px 0 0 -13px;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.45), inset 0 -1px 2px rgba(0,0,0,0.45),
              inset 0 1px 1px rgba(255,255,255,0.2), 0 4px 8px rgba(0,0,0,0.5);
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

@media (prefers-reduced-motion: reduce) {
  .pp-t-chip, .pp-t-sheet { animation: none; opacity: 1; }
}
`}</style>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type BadgeTone = "dealer" | "blind" | "quiet";

/**
 * A position marker.
 *
 * `dealer` is the one that exists as an object: at a real table the button is a
 * pressed ivory puck with the word engraved into it, and it is the single most
 * recognisable thing on the cloth after the cards. So it is drawn as one -
 * moulded edge, lit top, a shadow under it, rather than as a gold pill that
 * happens to say BTN. The other two are labels, and are drawn as labels.
 */
export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  const style =
    tone === "dealer"
      ? {
          background: "linear-gradient(180deg, #fdf9ee 0%, #ddd2ba 100%)",
          color: "#231a08",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(0,0,0,0.22), var(--pp-shadow-contact)",
        }
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

/**
 * Which way a bubble opens.
 *
 * A bubble centred on the seat that owns it hangs half its width past that
 * seat, and the seats at the ends of the arc sit within half a bubble of the
 * screen edge, so on a phone the rightmost bot's "Running simulations…" was
 * sliced off by the viewport. Edge seats anchor their bubble to the inside
 * instead of centring it.
 */
export type BubbleAlign = "center" | "left" | "right";

/** Anchor a bubble by where its seat sits across the felt. */
export function bubbleAlign(x: number): BubbleAlign {
  if (x < 22) return "left";
  if (x > 78) return "right";
  return "center";
}

const ALIGN: Record<BubbleAlign, string> = {
  center: "left-1/2 -translate-x-1/2",
  left: "left-0",
  right: "right-0",
};

/**
 * How far a bubble sits from the chair it belongs to.
 *
 * A seat on the top arc pushes its chips *downward*, toward the pot, and says
 * what it did in the same direction, so the bet pill and the bubble were
 * landing in the same place and printing through each other. `clearance` is
 * "there is a bet pill in this slot": the bubble steps past it rather than over
 * it.
 */
function offset(side: "top" | "bottom", clearance: boolean): string {
  if (side === "top") return clearance ? "bottom-full mb-9" : "bottom-full mb-2";
  return clearance ? "top-full mt-9" : "top-full mt-2";
}

export function SpeechBubble({
  text,
  side,
  align = "center",
  clearance = false,
}: {
  text: string;
  side: "top" | "bottom";
  align?: BubbleAlign;
  clearance?: boolean;
}) {
  const pos = offset(side, clearance);
  return (
    <div
      className={`pp-bubble pointer-events-none absolute z-30 max-w-[80vw] whitespace-nowrap ${ALIGN[align]} ${pos}`}
    >
      {/* Fully round, per the radius grammar's `marker`: this is one short line
          you read and never press. It was the only 12px corner on the felt. */}
      <div
        className="rounded-full border px-3.5 py-1.5 font-display text-xs font-semibold sm:text-sm"
        style={{ ...BUBBLE_SKIN, boxShadow: "var(--pp-shadow-lift)" }}
      >
        {text}
      </div>
    </div>
  );
}

/**
 * Where a bot's thinking hangs off its chair.
 *
 * Placement only, no skin, no border, no background. What used to live here
 * was a cream speech bubble that paraphrased the decision in one line; the
 * transcript that replaced it (`Thinking`) brings its own surface and its own
 * account of the pipeline, and it is a panel rather than a bubble, so wrapping
 * it in a second bordered box would be two frames around one thing.
 *
 * `pointer-events-none` because it hangs over the cloth and the seats beneath
 * it: it is something you read, never something you press.
 */
export function ThoughtPocket({
  side,
  align = "center",
  clearance = false,
  children,
}: {
  side: "top" | "bottom";
  align?: BubbleAlign;
  clearance?: boolean;
  children: React.ReactNode;
}) {
  const pos = offset(side, clearance);
  return (
    <div
      className={`pp-bubble pointer-events-none absolute z-30 w-[min(20rem,62vw)] ${ALIGN[align]} ${pos}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips
//
// A chip is a moulded clay disc, not a coloured circle: it has edge spots, a
// recessed centre face, and enough thickness that a stack of them is visibly a
// stack. All of that is `.pp-chip` in index.css; what lives here is only the
// denomination ladder, which colours a table of this stake would actually be
// racked with, and the arithmetic that turns an amount into chips.
// ---------------------------------------------------------------------------

interface Denomination {
  /** Multiple of the big blind this chip is worth. */
  bb: number;
  body: string;
  spot: string;
}

/**
 * Four colours, deliberately. A rack with one chip per rung is a toy; a rack
 * with eight is a Christmas tree on green cloth. These are the four a live game
 * actually spreads, restated in blinds so a 5/10 table and a 50/100 table rack
 * the same way.
 */
const DENOMINATIONS: Denomination[] = [
  { bb: 10, body: "#161616", spot: "#e2c563" },
  { bb: 5, body: "#c9a227", spot: "#2a1d05" },
  { bb: 2, body: "#7a0019", spot: "#f4ede4" },
  { bb: 1, body: "#e8e0d2", spot: "#7a0019" },
];

/**
 * Break an amount into stacks, largest denomination first.
 *
 * Capped at three stacks of five, because past that the pile stops reading as
 * chips and starts reading as a bar chart, and the number is printed right
 * beside it anyway. The cap is honest about itself: the tallest stack is drawn
 * tall, not accurate.
 */
export function chipStacks(
  amount: number,
  bigBlind: number,
  maxStacks = 3,
  maxHeight = 5
): { denomination: Denomination; count: number }[] {
  if (amount <= 0 || bigBlind <= 0) return [];
  const out: { denomination: Denomination; count: number }[] = [];
  let left = amount;
  for (const denomination of DENOMINATIONS) {
    if (out.length >= maxStacks) break;
    const unit = denomination.bb * bigBlind;
    const n = Math.floor(left / unit);
    if (n <= 0) continue;
    out.push({ denomination, count: Math.min(n, maxHeight) });
    left -= n * unit;
  }
  // Anything under one big blind still bought something, show a single chip
  // rather than nothing, or a min-raise looks like a check.
  if (out.length === 0) out.push({ denomination: DENOMINATIONS[3], count: 1 });
  return out;
}

/**
 * One stack, drawn from the bottom up: `count - 1` edges, then a face on top.
 * `size` is the chip's diameter in px.
 */
export function ChipStack({
  count,
  body,
  spot,
  size = 13,
}: {
  count: number;
  body: string;
  spot: string;
  size?: number;
}) {
  // How much of each chip below the top one you can see. A chip is about a
  // fifth as thick as it is wide, foreshortened by looking down at the table.
  const step = Math.max(2, Math.round(size / 5));
  const vars = {
    "--pp-chip-body": body,
    "--pp-chip-spot": spot,
  } as React.CSSProperties;
  return (
    <span
      className="pp-chip-stack"
      style={{ width: size, height: size + step * (count - 1) }}
    >
      {Array.from({ length: count - 1 }, (_, i) => (
        <span
          key={i}
          className="pp-chip-edge"
          // +1 so consecutive edges overlap rather than leaving a hairline gap.
          style={{ ...vars, width: size, height: step + 1, bottom: i * step }}
        />
      ))}
      <span
        className="pp-chip"
        style={{ ...vars, width: size, height: size, bottom: (count - 1) * step }}
      />
    </span>
  );
}

/** The chips actually sitting in the middle of the table. */
export function PotChips({
  pot,
  bigBlind,
  size = 13,
}: {
  pot: number;
  bigBlind: number;
  size?: number;
}) {
  const stacks = chipStacks(pot, bigBlind);
  if (pot <= 0) return null;
  return (
    <span className="flex items-end gap-[3px]" aria-hidden>
      {stacks.map((s, i) => (
        <ChipStack
          key={i}
          count={s.count}
          body={s.denomination.body}
          spot={s.denomination.spot}
          size={size}
        />
      ))}
    </span>
  );
}

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
            className="pp-chip pp-t-chip"
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

/** A 3-segment weak/medium/strong read, as a bar. */
export function BeliefBar({
  belief,
  width = "3.5rem",
}: {
  belief: { weak: number; medium: number; strong: number };
  width?: string;
}) {
  // `weak` used to be `#94a3b8`. Tailwind's slate-400, the last surviving
  // pixel of the blue theme this product dropped. It read as a fourth brand
  // colour on green cloth. Weak is now simply unlit ivory.
  const parts: [string, number][] = [
    ["rgba(244,237,228,0.34)", belief.weak],
    ["#c9a227", belief.medium],
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
