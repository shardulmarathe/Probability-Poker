/**
 * Every row of mutually-exclusive choices in the product.
 *
 * There were five idioms doing this job: the review's sticky tab bar, the
 * replay's near-byte-copy of it, the report's scrollable `ChipRow`, two
 * hand-rolled seat pickers, and the setup panel's `Pills`, which, along with
 * the table's mode switch, used `aria-pressed` and declared no group role at
 * all. They differed in radius, in active background, in whether they scrolled,
 * and in what a screen reader was told they were.
 *
 * One component now. Three things vary, and each varies for a reason:
 *
 *   layout   "fill"   a fixed, small set that should divide the width, tabs
 *            "scroll" a set that can outgrow the width, seats, hands, streets
 *            "wrap"   a set that reads as a form field, seat count, depth
 *
 *   as       "tabs"    the choice swaps a panel        → tablist / tab
 *            "options" the choice sets a value         → radiogroup / radio
 *
 *   hint     the active option's explanation, printed underneath.
 *
 * That last one is not cosmetic. The table's mode blurbs ("Nothing revealed.
 * Just poker") and the replay's tab blurbs existed only as `title=` attributes,
 * which no touch device has ever shown to anyone. Passing `showHint` puts them
 * on the screen, where a first-time player can read them.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { LINE, RADIUS, SURFACE, TONE } from "./tokens";

export interface TabOption<T extends string | number> {
  value: T;
  label: string;
  /** Shown beside the label, in monospace: a count, a size, a shorthand. */
  meta?: string;
  /** One sentence explaining what choosing this does. */
  hint?: string;
  disabled?: boolean;
  /**
   * Overrides the `${testIdPrefix}-${value}` hook. Needed where the value is
   * not the stable identity, bet sizings are keyed by cost, which moves with
   * the pot, but have always been addressed in tests by their label.
   */
  testId?: string;
}

export interface TabsProps<T extends string | number> {
  options: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for assistive tech. Required, every group is about something. */
  label: string;
  layout?: "fill" | "scroll" | "wrap";
  as?: "tabs" | "options";
  /** Print the active option's `hint` under the row. */
  showHint?: boolean;
  /**
   * Where a hint is allowed to appear.
   *
   * `"block"` is the original: one line of italic prose under the row, always
   * visible, describing whichever option is active. It is the right answer on a
   * setup form, where the reader is choosing and has the room.
   *
   * `"tooltip"` shows each option's own hint on hover or keyboard focus, over
   * whatever is beside it. That is for the rows that have moved into the 52px
   * app bar, where a permanently visible blurb is exactly the 114px of chrome
   * that pushed Fold and Call off the bottom of the screen. It is deliberately
   * not `title=`: no touch device has ever shown a `title` to anyone, which is
   * the bug this component's own header comment was written about.
   */
  hintAs?: "block" | "tooltip";
  /** Renders `data-testid={`${testIdPrefix}-${value}`}` on each control. */
  testIdPrefix?: string;
  size?: "sm" | "md";
}

export function Tabs<T extends string | number>({
  options,
  value,
  onChange,
  label,
  layout = "fill",
  as = "tabs",
  showHint = false,
  hintAs = "block",
  testIdPrefix,
  size = "md",
}: TabsProps<T>) {
  const uid = useId();
  const tabs = as === "tabs";
  const active = options.find((o) => o.value === value);
  const tips = showHint && hintAs === "tooltip";

  /*
   * The chosen option shows its own hint for a moment, so a touch device gets
   * the text at all.
   *
   * Hover and focus alone are a pointer affordance, and this component's own
   * header is about the bug where an explanation existed only in a `title=`
   * that no touch device ever showed anyone. A tooltip that only opens on
   * hover repeats that bug in a new shape: on a phone the tap that would
   * reveal the hint has already committed the choice, so the reader can only
   * ever read about the option after picking it. Showing it on commit turns
   * that from a trap into a confirmation, and it costs no layout height.
   *
   * The four seconds is a fallback, not the usual path. Verified on an emulated
   * iPad (`hover: none`, `pointer: coarse`): a tap leaves the control focused,
   * so `group-focus-within` holds the hint open past this timer and it clears
   * when the reader taps away. That is the behaviour you want — a focused
   * control should keep its own description available — and the timer only
   * matters where focus is not retained.
   */
  const [justPicked, setJustPicked] = useState<T | null>(null);
  useEffect(() => {
    if (justPicked === null) return;
    const id = window.setTimeout(() => setJustPicked(null), 4000);
    return () => window.clearTimeout(id);
  }, [justPicked]);
  const pick = (next: T) => {
    onChange(next);
    if (tips) setJustPicked(next);
  };

  const row =
    layout === "fill"
      ? "flex gap-1"
      : layout === "scroll"
        ? "-mx-1 flex gap-1 overflow-x-auto px-1"
        : "flex flex-wrap gap-1.5";

  const cell =
    layout === "fill"
      ? "min-w-0 flex-1 truncate"
      : layout === "scroll"
        ? "shrink-0"
        : "min-w-[3rem] flex-1";

  // Off the tray, an inactive control needs its own hairline to read as one.
  const idleBorder = layout === "fill" ? "transparent" : LINE.quiet;

  // A "fill" row divides a fixed width between its labels, so on a phone the
  // type has to come down or "Step through" becomes "Step thro…". Everything
  // else keeps its size, it can wrap or scroll instead.
  const metrics =
    size === "sm"
      ? `min-h-[34px] py-1 text-[0.68rem] ${layout === "fill" ? "px-1.5 sm:px-2.5" : "px-2.5"}`
      : layout === "fill"
        ? "min-h-[40px] px-1.5 py-2 text-[0.72rem] sm:px-3 sm:text-sm"
        : "min-h-[40px] px-3 py-2 text-sm";

  return (
    <div className="min-w-0">
      <div
        role={tabs ? "tablist" : "radiogroup"}
        aria-label={label}
        // Only "fill" gets a tray. A wrapping set reads as a form field, and a
        // scrolling set inside a fixed border looks broken the moment it
        // overflows the border it is drawn inside.
        className={`${row} ${layout === "fill" ? `border p-1 ${RADIUS.action}` : ""}`}
        style={
          layout === "fill"
            ? { borderColor: LINE.gold, background: SURFACE.tray }
            : undefined
        }
      >
        {options.map((option, i) => {
          const on = option.value === value;
          const tipId = tips && option.hint ? `${uid}-tip-${i}` : undefined;
          const control = (
            <button
              key={`${uid}-${i}`}
              type="button"
              role={tabs ? "tab" : "radio"}
              {...(tabs ? { "aria-selected": on } : { "aria-checked": on })}
              aria-describedby={tipId}
              disabled={option.disabled}
              data-testid={
                option.testId ??
                (testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined)
              }
              onClick={() => pick(option.value)}
              className={`${tips ? "w-full" : cell} ${metrics} ${RADIUS.control} border font-display font-semibold tracking-wide transition disabled:cursor-not-allowed disabled:opacity-30`}
              style={{
                borderColor: on ? "rgba(201,162,39,0.6)" : idleBorder,
                background: on ? SURFACE.goldWashStrong : "transparent",
                color: on ? TONE.gold : "rgba(244,237,228,0.62)",
              }}
            >
              {option.label}
              {option.meta && (
                <span className="ml-1.5 font-mono text-[0.62rem] opacity-70">
                  {option.meta}
                </span>
              )}
            </button>
          );

          if (!tipId) return control;

          // Hover *and* focus-within, so the blurb is reachable from a keyboard
          // and not only from a mouse, plus a brief forced open on commit so a
          // touch device sees it at all. The hover and focus halves stay in CSS
          // rather than state: an open/closed boolean per option would
          // re-render the whole row on every pointer move across a control that
          // lives in the header of every table hand.
          const shown = justPicked === option.value;
          return (
            <span key={`${uid}-w-${i}`} className={`group relative ${cell}`}>
              {control}
              <span
                role="tooltip"
                id={tipId}
                /* The hook the block variant carried. Switching a row to
                   tooltips must not silently delete a test's only handle on
                   the hint text. */
                data-testid={testIdPrefix ? `${testIdPrefix}-hint` : undefined}
                className={`pointer-events-none absolute left-1/2 top-[calc(100%+0.5rem)] z-50 w-56 -translate-x-1/2 border px-2.5 py-2 text-left font-cormorant text-[0.9rem] italic leading-snug text-ivory/80 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 ${
                  shown ? "visible opacity-100" : "invisible opacity-0"
                }`}
                style={{
                  borderColor: LINE.gold,
                  background: "rgba(6,20,13,0.97)",
                  borderRadius: "0.5rem",
                }}
              >
                {option.hint}
              </span>
            </span>
          );
        })}
      </div>

      {showHint && hintAs === "block" && active?.hint && (
        <p
          className="mt-2 font-cormorant text-[0.95rem] italic leading-snug text-ivory/60"
          data-testid={testIdPrefix ? `${testIdPrefix}-hint` : undefined}
        >
          {active.hint}
        </p>
      )}
    </div>
  );
}

/**
 * A tab row that stays put while its panel scrolls under it.
 *
 * The review and the replay each grew their own copy of this wrapper, gradient
 * and all. The gradient is doing real work, it fades the content out from
 * under the bar instead of chopping it, so it is kept, once.
 */
export function StickyTabs({ children }: { children: ReactNode }) {
  return (
    <div
      className="sticky top-0 z-30 -mx-3 px-3 py-2 sm:-mx-4 sm:px-4"
      style={{
        background:
          "linear-gradient(180deg, rgba(6,15,10,0.96) 0%, rgba(6,15,10,0.82) 70%, rgba(6,15,10,0) 100%)",
        backdropFilter: "blur(6px)",
      }}
    >
      {children}
    </div>
  );
}
