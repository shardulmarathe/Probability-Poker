/**
 * The helpers more than one derivation needs.
 *
 * These were file-locals in `MathTab`, where one 2,550-line module could see
 * all of them. Split into ten files they have to live somewhere, and a copy per
 * derivation is how `possessive()` ends up saying "You's" in one panel and
 * "your" in the next. One definition, imported.
 */

import type { ReactNode } from "react";
import type {
  BotDecision,
  TableHandReport,
} from "../../../poker/table/contract";
import { EmptyPanel } from "../../ui";

export function num(v: number, digits = 3): string {
  return v.toFixed(digits);
}

/**
 * "Callin' Carla's", or "your" when the seat under review is the reader's.
 *
 * `seatName` returns the table's own label for a seat, and for the human that
 * label is "You", which reads correctly as a subject and not at all as a
 * possessive. One helper rather than a second name-for-prose function, so a new
 * sentence cannot pick the wrong one.
 */
export function possessive(name: string): string {
  return name === "You" ? "your" : `${name}'s`;
}

/** The same seat as the object of a sentence: "in the pot with you". */
export function subject(name: string): string {
  return name === "You" ? "you" : name;
}

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The decision with the most samples behind it, the best worked example. */
export function richest(decisions: BotDecision[]): BotDecision | null {
  let best: BotDecision | null = null;
  for (const d of decisions) {
    if (d.equity.simulations === 0) continue;
    if (!best || d.equity.simulations > best.equity.simulations) best = d;
  }
  return best;
}

/**
 * The decision whose fold-equity breakdown makes the best worked example: the
 * reviewed seat's own if it has one, otherwise the one that priced the most
 * sizes. Returns null when nobody ever bet, checks, calls and folds carry no
 * fold-equity term, so there is nothing to show rather than something to
 * approximate.
 */
export function bluffing(decisions: BotDecision[], focus: number): BotDecision | null {
  const priced = decisions.filter(
    (d) => d.foldEquity && Object.keys(d.foldEquity).length > 0
  );
  if (priced.length === 0) return null;
  const mine = priced.filter((d) => d.seat === focus);
  const pool = mine.length > 0 ? mine : priced;
  return pool.reduce((best, d) =>
    Object.keys(d.foldEquity!).length > Object.keys(best.foldEquity!).length ? d : best
  );
}

/**
 * A hand read back from the archive rather than played this session.
 *
 * `profile/store.ts` strips `decisions` before writing, the Monte Carlo audit
 * trail is a build-specific object and a stored one is either absent or no
 * longer understood, so a restored hand has a full action record and no
 * pricing. Every panel below that reads `BotDecision` has to say *that* rather
 * than "nobody was ever priced", which would be a claim about the hand instead
 * of a fact about the storage.
 */
export function isRestored(report: TableHandReport): boolean {
  return report.decisions.length === 0 && report.actions.length > 0;
}

/** The stated absence a decision-derived panel falls back to. */
export function NoTrail({ what }: { what: string }) {
  return (
    <EmptyPanel title="The decision trail was not stored">
      This hand came back from the archive, and the audit trail of what the
      engine priced is not part of what gets written down — only the cards, the
      chips and every action. So {what} cannot be shown for this hand. Every
      panel built from the action record works normally, here and elsewhere in
      the review.
    </EmptyPanel>
  );
}

/** Axis and grid ink for every chart in a derivation. */
export const AXIS = "rgba(244,237,228,0.45)";
export const GRID = "rgba(244,237,228,0.12)";
export const SERIES = ["#e2c563", "#7fd3a8", "#e58a8a", "#b07fd4", "#8ab4e5"];

export const tooltipStyle = {
  background: "rgba(6,15,10,0.95)",
  border: "1px solid rgba(201,162,39,0.4)",
  borderRadius: 8,
  color: "#f4ede4",
  fontSize: 12,
};

/** The opponent worth running a hand out against: the one who put in the most. */
export function mainVillain(report: TableHandReport, focus: number) {
  const others = report.seats.filter(
    (s) => s.seat !== focus && s.hole.length === 2
  );
  if (others.length === 0) return null;
  const shown = others.filter((s) => s.final !== null);
  const pool = shown.length > 0 ? shown : others;
  return pool.reduce((best, s) => (s.invested > best.invested ? s : best));
}

/**
 * The line that used to be a `Section` subtitle.
 *
 * Each derivation was a titled panel on the Math tab, and the subtitle carried
 * real content: the trial count, the street, which seat the worked example is
 * about. The caller now owns the label, so that line has to travel with the
 * body or it is lost, and "20,000 trials, flop, Callin' Carla" is exactly the
 * sentence that tells a reader whether the arithmetic below is about the
 * decision they were looking at.
 */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-ivory/45">
      {children}
    </p>
  );
}
