/**
 * How good the reader's own estimates are, which is the one number this product
 * can report and a solver cannot.
 *
 * EV lost is what every trainer reports, and against a solver's baseline they
 * report it better. Calibration is a different claim: not "how much did your
 * decisions cost" but "how well do you know what you do not know". It falls
 * straight out of the guess gates on `/learn`, it is the natural output of a
 * probability course, and it is directly actionable in a way a bb/100 figure is
 * not, because "you run six points optimistic on equity" names a correction
 * rather than a deficit.
 *
 * Read only. Nothing here records a guess; `GuessReveal` does that at the point
 * the reader commits one, and this reports the rolling summary it left behind.
 *
 * The card is absent, not empty, until a quantity has three estimates in it.
 * One guess is not a bias and printing a direction from it would be teaching
 * sampling error, which is the same standard the style verdict holds itself to
 * with `MIN_CLASSIFY_HANDS`.
 */

import { useMemo } from "react";
import {
  CALIBRATION_KINDS,
  calibrationFor,
  loadCalibration,
  type CalibrationEntry,
  type CalibrationKind,
} from "../../lib/calibration";
import { pct } from "../../lib/format";
import { Group, RADIUS } from "../ui";

/** Estimates a quantity needs before a direction is worth naming. */
export const MIN_CALIBRATION_GUESSES = 3;

const LABELS: Record<CalibrationKind, { name: string; concept: string }> = {
  equity: { name: "Equity", concept: "monte-carlo" },
  "required-equity": { name: "The price a call needs", concept: "ev" },
};

/**
 * "6.2 points optimistic", or "well calibrated" when the bias is inside the
 * noise its own sample supports.
 *
 * Both quantities are probabilities, so the error is reported in percentage
 * points rather than as a percentage of a percentage, which is the reading
 * everyone actually wants and the one the guess gate itself prints.
 */
function bias(entry: CalibrationEntry): string {
  const points = entry.meanSignedError * 100;
  if (Math.abs(points) < 1) return "well calibrated";
  return `${Math.abs(points).toFixed(1)} points ${points > 0 ? "optimistic" : "pessimistic"}`;
}

export function CalibrationCard() {
  // Read once. The summary only changes when a guess is committed on another
  // page, and this component is not mounted then.
  const entries = useMemo(() => {
    const summary = loadCalibration();
    return CALIBRATION_KINDS.map((kind) => ({
      kind,
      entry: calibrationFor(kind, summary),
    })).filter(
      (row): row is { kind: CalibrationKind; entry: CalibrationEntry } =>
        row.entry !== null && row.entry.count >= MIN_CALIBRATION_GUESSES
    );
  }, []);

  if (entries.length === 0) return null;

  return (
    <Group
      title="How good your estimates are"
      lede="Measured from the guesses you committed before seeing the answer, on the concepts page."
    >
      <div className="flex flex-col gap-2.5" data-testid="calibration">
        {entries.map(({ kind, entry }) => (
          <div
            key={kind}
            data-testid={`calibration-${kind}`}
            className={`border p-3.5 ${RADIUS.surface}`}
            style={{ borderColor: "rgba(244,237,228,0.12)" }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="font-display text-sm text-ivory">
                {LABELS[kind].name}
              </p>
              <p className="font-mono text-xs text-gold-soft">{bias(entry)}</p>
            </div>
            <p className="mt-1 font-mono text-[0.66rem] text-ivory/45">
              {entry.count} estimate{entry.count === 1 ? "" : "s"}, off by{" "}
              {pct(entry.meanAbsError, 1)} on average either way
            </p>
          </div>
        ))}
      </div>
    </Group>
  );
}
