/**
 * The style read, with its confidence shown as loudly as the label.
 *
 * A classifier that says "TAG" after twelve hands is not wrong so much as
 * meaningless, `sampleConfidence` puts twelve hands at about 0.11, and a UI
 * that prints the label in large type and buries the number teaches the player
 * to believe it. So the confidence drives the presentation: below the sample
 * floor the label is explicitly a guess, the reasons stay open, and the meter
 * says how far off a usable read still is.
 *
 * The thresholds and the reasons both come from `archetype.ts`. Nothing here
 * decides anything about style; it decides how much to insist on it.
 *
 * "What decided it" is the one part that folds away. It is the audit trail for
 * a verdict the reader has not questioned yet, three lines of monospace under
 * the label they actually came for, and printing it always was a third of this
 * card's height spent answering an unasked question. It stays open while the
 * read is provisional, because then the audit trail *is* the warning: a guess
 * that hides its reasoning reads as a fact.
 */

import {
  CONFIDENCE_HALF_HANDS,
  MIN_CLASSIFY_HANDS,
  STYLE_BLURBS,
  type StyleVerdict,
} from "../../poker/coach/archetype";
import { Note, Reveal, Tag } from "../ui";

/** Where a read stops being a coin flip. Presentation only. */
const USABLE_CONFIDENCE = 0.4;

function tone(verdict: StyleVerdict): "neutral" | "gold" {
  if (verdict.provisional) return "neutral";
  return verdict.confidence >= USABLE_CONFIDENCE ? "gold" : "neutral";
}

export function ArchetypeCard({ verdict }: { verdict: StyleVerdict }) {
  const pct = Math.round(verdict.confidence * 100);
  const shortOf = Math.max(0, MIN_CLASSIFY_HANDS - verdict.hands);

  return (
    <div data-testid="archetype" data-style={verdict.style} data-provisional={verdict.provisional}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className="font-display text-2xl font-bold sm:text-3xl"
          style={{ color: verdict.provisional ? "rgba(244,237,228,0.72)" : "#e2c563" }}
        >
          {verdict.style}
        </span>
        <Tag tone={tone(verdict)}>
          {verdict.provisional ? "Provisional read" : "Read"}
        </Tag>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ivory/70">
        {STYLE_BLURBS[verdict.style]}
      </p>

      {/* ---------------------- Confidence ---------------------- */}
      <div className="mt-4">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="font-display text-sm font-semibold tracking-wide text-ivory/70">
            Confidence
          </span>
          <span
            className="font-mono text-sm"
            data-testid="confidence"
            style={{ color: verdict.confidence >= USABLE_CONFIDENCE ? "#e2c563" : "#e58a8a" }}
          >
            {pct}%
          </span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full"
          style={{ background: "rgba(0,0,0,0.5)" }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.max(1, pct)}%`,
              backgroundColor:
                verdict.confidence >= USABLE_CONFIDENCE ? "#c9a227" : "rgba(210,74,74,0.75)",
            }}
          />
        </div>
      </div>

      {/* --------------------- The honest bit -------------------- */}
      <Note tone={verdict.provisional ? "bad" : "gold"} testId="confidence-note">
        {verdict.provisional ? (
          <>
            This is a guess. {verdict.hands} hand{verdict.hands === 1 ? "" : "s"} is
            well under the {MIN_CLASSIFY_HANDS} a label needs to mean anything
            {shortOf > 0 ? ` — ${shortOf} to go` : ""}. Expect it to change.
          </>
        ) : verdict.confidence < USABLE_CONFIDENCE ? (
          <>
            A working read, not a settled one. Confidence reaches 50% at{" "}
            {CONFIDENCE_HALF_HANDS} hands, and sitting near a threshold holds it
            down further.
          </>
        ) : (
          <>
            Measured over {verdict.hands} hands. Confidence still rises with the
            sample — it passes 50% at {CONFIDENCE_HALF_HANDS} hands — and drops
            when VPIP sits on a cut point.
          </>
        )}
      </Note>

      {/* ------------------------ Reasons ----------------------- */}
      {verdict.reasons.length > 0 && (
        <Reveal
          label="What decided it"
          // The first reason is the one the classifier weighed most, so the
          // closed row still names the cut the verdict turned on rather than
          // sitting there saying only that more text exists.
          summary={verdict.reasons[0]}
          defaultOpen={verdict.provisional}
          tone="quiet"
          testId="archetype-reasons"
        >
          <ul className="space-y-1">
            {verdict.reasons.map((reason, i) => (
              <li key={i} className="flex gap-2 text-[0.78rem] leading-relaxed text-ivory/60">
                <span className="text-gold-soft/60">·</span>
                <span className="font-mono">{reason}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      )}
    </div>
  );
}
