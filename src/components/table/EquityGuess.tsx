/**
 * Guess your equity before Coach prints it.
 *
 * Coach's promise is that the number is there while you decide, and a number you
 * read is not a number you produced. Retrieval practice is the difference
 * between recognising an answer and being able to reach one, and the felt is
 * where it bites: on the concepts page the reader has all day, here they have a
 * hand in front of them and a price to beat.
 *
 * A BAND, NOT A SLIDER, and the reason is the felt rather than the pedagogy. The
 * table is locked to one screen and the coach line is one row; a slider plus a
 * confirm is two rows and a drag, and it pushed Fold and Call toward the fold
 * the last time something grew here. Five bands are one row of small buttons and
 * one tap. The coarseness is also honest: nobody reads equity to half a point
 * with a hand waiting, so asking for that precision would be measuring the
 * interface rather than the read.
 *
 * The bands are recorded against their own calibration kind for exactly that
 * reason. A band's width puts a floor under the absolute error that has nothing
 * to do with how well the spot was read, so pooling these with the concepts
 * page's slider estimates would corrupt the precision figure for both. See
 * `lib/calibration.ts`.
 *
 * Skipping is available and sticky for the session. A player who wants Coach to
 * behave as it always has is asked once, not once per decision, which is the
 * same contract the concepts page's gate keeps.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { pct } from "../../lib/format";
import { recordGuess } from "../../lib/calibration";
import { LINE, RADIUS, TONE } from "../ui";

/**
 * The five bands, as [lower, upper).
 *
 * Chosen around the prices a No-Limit hand actually offers rather than as even
 * fifths: the boundaries near a third and a half are where "call" and "fold"
 * change places, so they are where a misread costs something.
 */
const BANDS: readonly { lo: number; hi: number; label: string }[] = [
  { lo: 0, hi: 0.2, label: "<20" },
  { lo: 0.2, hi: 0.35, label: "20-35" },
  { lo: 0.35, hi: 0.5, label: "35-50" },
  { lo: 0.5, hi: 0.65, label: "50-65" },
  { lo: 0.65, hi: 1, label: ">65" },
];

/** A band answers for its midpoint, which is the only point it can claim. */
const midpoint = (band: { lo: number; hi: number }) => (band.lo + band.hi) / 2;

export interface EquityGuessProps {
  /** The engine's figure, revealed once an answer is in. */
  actual: number;
  /**
   * Identifies the decision. A new one re-arms the question; without it the
   * gate would stay answered for the rest of the hand and Coach would be silent
   * on every street after the first.
   */
  decisionKey: string;
  /**
   * Answered or skipped, so Coach can take the row back.
   *
   * Carries the estimate on an answer and null on a skip, because the delta
   * belongs beside Coach's conclusion rather than instead of it: a reader who
   * answers and is then shown only the real figure has been given the number
   * they were asked to produce and nothing about how close they came, which is
   * the whole of the exercise.
   */
  onResolved: (guess: number | null) => void;
}

export function EquityGuess({ actual, decisionKey, onResolved }: EquityGuessProps) {
  const [asked, setAsked] = useState(decisionKey);
  const [result, setResult] = useState<{ guess: number; actual: number } | null>(null);
  /*
   * Skip is a ref rather than state, and deliberately outlives a re-arm: it is a
   * preference for the session, not an answer to one spot. State would reset with
   * the component whenever the panel unmounts between hands.
   */
  const skipped = useRef(false);

  // A fresh decision is a fresh question, unless the player has opted out.
  useEffect(() => {
    if (decisionKey === asked) return;
    setAsked(decisionKey);
    setResult(null);
    if (skipped.current) onResolved(null);
  }, [decisionKey, asked, onResolved]);

  const answer = useCallback(
    (guess: number) => {
      setResult({ guess, actual });
      recordGuess("table-equity", guess, actual);
      onResolved(guess);
    },
    [actual, onResolved]
  );

  const skip = useCallback(() => {
    skipped.current = true;
    onResolved(null);
  }, [onResolved]);

  if (result) {
    const points = (result.guess - result.actual) * 100;
    const inside = Math.abs(points) < 7.5;
    return (
      <span
        data-testid="equity-guess-result"
        role="status"
        aria-live="polite"
        className="flex min-w-0 items-baseline gap-x-2 overflow-hidden whitespace-nowrap font-mono text-[0.68rem] leading-none"
      >
        <span className="text-ivory/45">you said {pct(result.guess, 0)}</span>
        <span className="text-ivory/25">/</span>
        <span className="font-display text-sm font-bold text-gold-soft">
          {pct(result.actual, 1)}
        </span>
        <span style={{ color: inside ? TONE.good : TONE.bad }}>
          {Math.abs(points) < 1
            ? "spot on"
            : `${Math.abs(points).toFixed(0)} points ${points > 0 ? "high" : "low"}`}
        </span>
      </span>
    );
  }

  return (
    <span
      data-testid="equity-guess"
      className="flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap"
    >
      <span className="shrink-0 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
        your equity?
      </span>
      {BANDS.map((band) => (
        <button
          key={band.label}
          type="button"
          data-testid={`equity-band-${band.label}`}
          aria-label={`${band.label} percent`}
          onClick={() => answer(midpoint(band))}
          className={`min-h-[26px] shrink-0 border px-1.5 font-mono text-[0.62rem] leading-none transition ${RADIUS.control}`}
          style={{ borderColor: LINE.quiet, background: "rgba(0,0,0,0.3)" }}
        >
          {band.label}
        </button>
      ))}
      <button
        type="button"
        data-testid="equity-guess-skip"
        onClick={skip}
        className="shrink-0 font-mono text-[0.58rem] uppercase tracking-widest text-ivory/35 transition-colors hover:text-ivory/60"
      >
        skip
      </button>
    </span>
  );
}
