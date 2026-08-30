/**
 * A computed number, behind the reader's own estimate of it.
 *
 * Everything else in `ui/` shows the reader a figure. `Prose.Reveal` hides a
 * derivation behind a control, which is disclosure: the number is on the screen
 * and the working is one press away. This is the opposite trade, and the reason
 * it is not another `Reveal`: the reader has to produce a number before the
 * engine's appears. Recognising a figure is not being able to produce one, and
 * only the second is a skill, so the price of the answer is an attempt at it.
 *
 * SCORED AS CALIBRATION, NOT AS A QUIZ. The output is a signed gap and its
 * direction, "6 points high", never a mark. There is no correct answer to
 * "estimate this equity" that a slider could match, and a red cross for missing
 * a Monte Carlo figure by two points would teach the reader that estimating is
 * something to avoid. The gap and its sign are the whole lesson: which way you
 * lean, and by how much.
 *
 * SKIPPABLE, DELIBERATELY. `/learn` is an explanation before it is an exercise,
 * and somebody who came to understand pot odds must not be held behind a
 * question about them. Skip reveals the same content and records nothing, and
 * it stays skipped for the rest of the visit (see `resetKey`), so a reader who
 * has declined once is not asked again every time they move a knob.
 *
 * The quantity is passed in rather than switched on: `format` prints a value in
 * its own units (`lib/format.pct` for equity, `money` for chips), `formatGap`
 * prints the size of a miss, which is often a different unit from the value
 * (the gap between two percentages is points, not a percentage), and `kind`
 * names the bucket `lib/calibration.ts` accumulates into.
 */

import { useId, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { LINE, RADIUS, SURFACE, TONE } from "./tokens";
import {
  calibrationFor,
  recordGuess,
  type CalibrationEntry,
  type CalibrationKind,
} from "../../lib/calibration";

export interface GuessRevealProps {
  /** What to estimate, as a noun phrase: "the equity at 32,000 trials". */
  label: string;
  /**
   * The engine's number, in the same units as the guess.
   *
   * This component never computes it and never rounds it into the reader's
   * grid: it gates a display and nothing else, so a caller must pass the same
   * value it would have printed unguarded.
   */
  actual: number;
  /** Prints a value in this quantity's units. `pct` and `money` both fit. */
  format: (value: number) => string;
  /**
   * Prints the size of a miss, given a non-negative magnitude. The direction is
   * worded separately, so this must not print a sign. Defaults to `format`.
   */
  formatGap?: (magnitude: number) => string;
  /** Words for a guess that is too high and too low, in that order. */
  direction?: readonly [string, string];
  min: number;
  max: number;
  step: number;
  /** Where the control starts. Deliberately not near the answer. */
  initial: number;
  /** A slider for a quantity with a natural range, a field for an amount. */
  /** The calibration bucket this estimate belongs to. */
  kind: CalibrationKind;
  /**
   * An interval already computed for `actual`, printed on reveal with whether
   * the estimate landed inside it. Omit where the quantity is exact.
   */
  interval?: { lo: number; hi: number };
  /** Names the interval in the reveal line. */
  /**
   * Re-arms the question when the quantity underneath changes.
   *
   * A new matchup or a fresh sample is a new number, so the old reveal is stale
   * and asking again is the point of the exercise. A skip is not re-armed: that
   * reader has said no once.
   */
  resetKey?: string;
  testId?: string;
  /** The real display, rendered once the reader has guessed or skipped. */
  children: ReactNode;
}

export function GuessReveal({
  label,
  actual,
  format,
  formatGap,
  direction = ["high", "low"],
  min,
  max,
  step,
  initial,
  kind,
  interval,
  resetKey = "",
  testId,
  children,
}: GuessRevealProps) {
  const uid = useId();
  const [draft, setDraft] = useState(initial);
  const [guess, setGuess] = useState<number | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [history, setHistory] = useState<CalibrationEntry | null>(null);

  /*
   * State reset during render, not in an effect.
   *
   * An effect would paint the previous answer against the new quantity for a
   * frame before clearing it, which is the one thing this component must never
   * do: a stale revealed figure beside a fresh matchup is a wrong number on the
   * screen. Comparing the key to what the state was armed for is React's own
   * answer to a prop-derived reset and costs one extra render at most, on a
   * control the reader has just interacted with.
   */
  const [armedFor, setArmedFor] = useState(resetKey);
  if (armedFor !== resetKey) {
    setArmedFor(resetKey);
    setDraft(initial);
    setGuess(null);
    setHistory(null);
  }

  const open = guess !== null || skipped;

  const commit = () => {
    setGuess(draft);
    // Storage failure is swallowed inside the store, so a reader in private
    // browsing still gets their delta; only the running average is lost.
    setHistory(calibrationFor(kind, recordGuess(kind, draft, actual)));
  };

  const gap = guess === null ? 0 : guess - actual;
  const magnitude = Math.abs(gap);
  const printGap = formatGap ?? format;
  const inside =
    interval && guess !== null && guess >= interval.lo && guess <= interval.hi;

  return (
    <div className="my-3" data-testid={testId}>
      {!open && (
        <div
          className={`border p-3 ${RADIUS.control}`}
          style={{ borderColor: LINE.gold, background: SURFACE.sunk }}
        >
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <label
              htmlFor={`${uid}-guess`}
              className="font-display text-[0.78rem] font-semibold tracking-wide text-gold-soft"
            >
              Your estimate: {label}
            </label>
            <span
              aria-hidden
              className="font-mono text-sm text-ivory/80"
              data-testid={testId ? `${testId}-draft` : undefined}
            >
              {format(draft)}
            </span>
          </div>

          <div className="flex items-center gap-2">
              <span aria-hidden className="shrink-0 font-mono text-[0.6rem] text-ivory/35">
                {format(min)}
              </span>
              <input
                id={`${uid}-guess`}
                type="range"
                className="min-w-0 flex-1 cursor-pointer"
                style={{ accentColor: "#c9a227" }}
                min={min}
                max={max}
                step={step}
                value={draft}
                aria-valuetext={format(draft)}
                onChange={(e) => setDraft(Number(e.target.value))}
                data-testid={testId ? `${testId}-input` : undefined}
              />
              <span aria-hidden className="shrink-0 font-mono text-[0.6rem] text-ivory/35">
                {format(max)}
              </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={commit}
              data-testid={testId ? `${testId}-commit` : undefined}
            >
              Lock it in
            </Button>
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => setSkipped(true)}
              data-testid={testId ? `${testId}-skip` : undefined}
            >
              Just show me
            </Button>
          </div>
        </div>
      )}

      {guess !== null && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-3 border-l-2 px-3 py-2 ${RADIUS.control}`}
          style={{ borderColor: "#c9a227", background: SURFACE.goldWash }}
          data-testid={testId ? `${testId}-result` : undefined}
        >
          <p className="font-mono text-[0.72rem] leading-relaxed text-ivory/75">
            You said <span className="text-ivory">{format(guess)}</span>, it is{" "}
            <span style={{ color: TONE.gold }}>{format(actual)}</span>:{" "}
            {magnitude === 0 ? (
              "exactly the number."
            ) : (
              <>
                {printGap(magnitude)} {gap > 0 ? direction[0] : direction[1]}.
              </>
            )}
          </p>
          {interval && (
            <p className="mt-1 font-mono text-[0.66rem] leading-relaxed text-ivory/45">
              95% interval {format(interval.lo)} - {format(interval.hi)}, your
              estimate falls {inside ? "inside" : "outside"} it.
            </p>
          )}
          {history && history.count >= 3 && (
            <p className="mt-1 font-mono text-[0.66rem] leading-relaxed text-ivory/45">
              Across your last {history.count} estimates of this quantity:{" "}
              {Math.abs(history.meanSignedError) === 0
                ? "no lean either way"
                : `${printGap(Math.abs(history.meanSignedError))} ${
                    history.meanSignedError > 0 ? direction[0] : direction[1]
                  } on average`}
              , {printGap(history.meanAbsError)} out either way.
            </p>
          )}
        </div>
      )}

      {open && children}
    </div>
  );
}
