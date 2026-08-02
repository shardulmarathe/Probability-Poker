/**
 * Classifying a playing style from tracker stats.
 *
 * Deliberately a handful of published thresholds over three numbers rather than
 * a fitted model. A player told "you are a calling station" is owed the reason,
 * and "the classifier said so" is not one. Every cut point below is exported, so
 * the UI can show the seat's numbers against the same bars this file used, and a
 * disagreement is an argument about a threshold rather than about a black box.
 *
 * The two axes are the ones the game actually turns on:
 *
 *   how WIDE  — VPIP, the share of hands entered voluntarily.
 *   how HARD  — AF (bets+raises per call, postflop) and the share of entered
 *               hands that were raised preflop. Either one alone is easy to
 *               fool: a seat that never calls has no AF, and a seat that opens
 *               wide but gives up postflop has a fine PFR ratio.
 *
 * Confidence is reported separately and is driven by sample size, because a
 * label from twelve hands is noise and the API has to say so out loud rather
 * than print "LAG" with the same weight it would after a thousand hands. There
 * is no threshold below which classification is refused — the label is still the
 * best guess available — but `provisional` and `confidence` mark it.
 *
 * Ground truth for the thresholds is `../model/profiles.ts`: the bot roster's
 * styles are parameters, not opinions, so running a roster of known bots through
 * real hands and asking whether their labels come back is a genuine test rather
 * than a self-consistency check. `ARCHETYPE_STYLE` records the expected answers.
 */

import type { BuiltArchetype } from "../model/profiles";
import { percent, rate, type PlayerStats } from "./stats";

/**
 * The five styles.
 *
 * Two quadrants collapse. Tight-passive has no separate label — a rock and a nit
 * differ in width but play the same losing way, and both land on `Nit`. The
 * maniac is not a sixth quadrant either: it is loose-aggressive taken past the
 * point where the label `LAG` still describes anything useful.
 */
export type PlayStyle = "Nit" | "TAG" | "LAG" | "Calling Station" | "Maniac";

export const PLAY_STYLES: readonly PlayStyle[] = [
  "Nit",
  "TAG",
  "LAG",
  "Calling Station",
  "Maniac",
] as const;

export const STYLE_BLURBS: Record<PlayStyle, string> = {
  Nit: "Tight and passive. Folds too much preflop and gets no value from the hands it does play.",
  TAG: "Tight and aggressive. Few hands, played hard — the textbook winning style.",
  LAG: "Loose and aggressive. Wide ranges backed by real pressure; hard to put on a hand.",
  "Calling Station": "Loose and passive. Sees a lot of flops and pays them off rather than betting them.",
  Maniac: "Loose past sense and relentlessly aggressive. Enormous variance in both directions.",
};

// ---------------------------------------------------------------------------
// Thresholds — every one of them exported, on purpose
// ---------------------------------------------------------------------------

/** Below this VPIP a seat is a nit however it plays the few hands it enters. */
export const NIT_VPIP = 15;

/** The tight/loose divide. Roughly the 6-max break-even opening range. */
export const TIGHT_VPIP = 24;

/** Above this VPIP the seat is playing hands that cannot be played for value. */
export const MANIAC_VPIP = 45;

/** Postflop bets+raises per call at or above which a seat reads as aggressive. */
export const AGGRESSIVE_AF = 1.5;

/** Share of *entered* hands that were raised preflop, at or above which likewise. */
export const AGGRESSIVE_PFR_RATIO = 0.5;

/** Aggression a loose seat must clear before "maniac" beats "LAG". */
export const MANIAC_AF = 2;

/** …or this PFR, for a seat aggressive enough preflop to never reach a call. */
export const MANIAC_PFR = 30;

/** Sample at which confidence reaches one half. */
export const CONFIDENCE_HALF_HANDS = 100;

/** Below this many hands the label is a guess and is flagged `provisional`. */
export const MIN_CLASSIFY_HANDS = 30;

/** VPIP points from the nearest boundary at which the margin penalty clears. */
export const VPIP_MARGIN_FULL = 8;

/** VPIP cut points a verdict can sit near. Used only by the margin penalty. */
const VPIP_BOUNDARIES = [NIT_VPIP, TIGHT_VPIP, MANIAC_VPIP];

// ---------------------------------------------------------------------------
// The vector
// ---------------------------------------------------------------------------

export interface StyleVector {
  /** Hands the stats were measured over. Drives confidence, never the label. */
  hands: number;
  /** VPIP as a percentage, 0..100. */
  vpip: number;
  /** PFR as a percentage, 0..100. */
  pfr: number;
  /**
   * Postflop aggression factor, or null when the seat never called postflop —
   * which is a real state and must not read as zero aggression.
   */
  af: number | null;
  /**
   * PFR / VPIP: of the hands entered, how many were entered by raising.
   * Null when the seat entered none. Separates a wide raiser from a wide
   * limper, which raw VPIP cannot.
   */
  pfrRatio: number | null;
}

export function vectorFromStats(stats: PlayerStats): StyleVector {
  const t = stats.total;
  const vpip = percent(t.vpip) ?? 0;
  const pfr = percent(t.pfr) ?? 0;
  return {
    hands: t.hands,
    vpip,
    pfr,
    af: rate(t.af),
    pfrRatio: t.vpip.n > 0 ? t.pfr.n / t.vpip.n : null,
  };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * How much the sample alone is worth, 0..1.
 *
 * `n / (n + K)`: zero at no hands, one half at `K`, asymptotically one. Chosen
 * over a hard cutoff because there is no hand count at which a read switches
 * from worthless to sound, and over a linear ramp because the marginal hand is
 * worth far more at 20 hands than at 900. K = 100 puts the half-way point where
 * VPIP and PFR are conventionally said to stabilise; AF needs several times that,
 * which is part of why AF alone never decides a label here.
 */
export function sampleConfidence(hands: number): number {
  if (hands <= 0) return 0;
  return hands / (hands + CONFIDENCE_HALF_HANDS);
}

/**
 * Penalty for sitting on a cut point. A seat at 24.1% VPIP is not "a LAG" in any
 * meaningful sense — it is a coin flip between two labels — and the confidence
 * should say so even at a large sample. Bounded below at 0.6 so a borderline
 * seat with a huge sample still reads as better known than a clear-cut seat with
 * a tiny one; the sample term is meant to dominate.
 */
function marginFactor(vpip: number): number {
  let nearest = Infinity;
  for (const b of VPIP_BOUNDARIES) nearest = Math.min(nearest, Math.abs(vpip - b));
  return 0.6 + 0.4 * Math.min(1, nearest / VPIP_MARGIN_FULL);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface StyleVerdict {
  style: PlayStyle;
  /** 0..1. Rises with sample size; falls near a threshold. */
  confidence: number;
  hands: number;
  /** True below `MIN_CLASSIFY_HANDS` — the label is a guess, show it as one. */
  provisional: boolean;
  vector: StyleVector;
  /** The thresholds that fired, in the order the rules were applied. */
  reasons: string[];
}

/** Either aggression signal clearing its bar is enough; see `StyleVector`. */
function isAggressive(v: StyleVector): boolean {
  if (v.af !== null && v.af >= AGGRESSIVE_AF) return true;
  return v.pfrRatio !== null && v.pfrRatio >= AGGRESSIVE_PFR_RATIO;
}

/**
 * The rules, in order. Each may veto the ones below it.
 *
 *   1. Maniac  — loose past `MANIAC_VPIP` *and* aggressive past `MANIAC_AF` or
 *                `MANIAC_PFR`. Both halves are required: a seat playing 70% of
 *                hands passively is a station, not a maniac.
 *   2. Nit     — under `NIT_VPIP` on width alone, or merely tight and passive.
 *                Tight-passive has no label of its own (see `PlayStyle`).
 *   3. TAG     — tight and aggressive.
 *   4. LAG     — loose and aggressive, short of maniac.
 *   5. Station — what is left: loose and passive.
 */
export function classify(v: StyleVector): StyleVerdict {
  const reasons: string[] = [];
  const aggressive = isAggressive(v);
  const tight = v.vpip < TIGHT_VPIP;

  reasons.push(
    `VPIP ${v.vpip.toFixed(1)}% (${tight ? "tight" : "loose"}; cuts at ${NIT_VPIP}/${TIGHT_VPIP}/${MANIAC_VPIP})`
  );
  reasons.push(
    `AF ${v.af === null ? "n/a" : v.af.toFixed(2)}, PFR/VPIP ${
      v.pfrRatio === null ? "n/a" : v.pfrRatio.toFixed(2)
    } (${aggressive ? "aggressive" : "passive"}; bars at ${AGGRESSIVE_AF} / ${AGGRESSIVE_PFR_RATIO})`
  );

  let style: PlayStyle;
  if (
    v.vpip >= MANIAC_VPIP &&
    ((v.af !== null && v.af >= MANIAC_AF) || v.pfr >= MANIAC_PFR)
  ) {
    style = "Maniac";
    reasons.push(`VPIP >= ${MANIAC_VPIP} with maniac-level aggression`);
  } else if (v.vpip < NIT_VPIP) {
    style = "Nit";
    reasons.push(`VPIP < ${NIT_VPIP}: too tight to be anything else`);
  } else if (tight && !aggressive) {
    style = "Nit";
    reasons.push("tight and passive — the same losing shape as a nit");
  } else if (aggressive) {
    style = tight ? "TAG" : "LAG";
    reasons.push(tight ? "tight and aggressive" : "loose and aggressive");
  } else {
    style = "Calling Station";
    reasons.push("loose and passive");
  }

  const confidence = sampleConfidence(v.hands) * marginFactor(v.vpip);
  return {
    style,
    confidence,
    hands: v.hands,
    provisional: v.hands < MIN_CLASSIFY_HANDS,
    vector: v,
    reasons,
  };
}

/** `classify` straight off a computed stat line. */
export function classifyStats(stats: PlayerStats): StyleVerdict {
  return classify(vectorFromStats(stats));
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * The style each bot in `../model/profiles.ts` is built to play.
 *
 * These are not this file's opinion — they are the parameters the roster was
 * written from (entry threshold, aggression multiplier, bluff rate), restated as
 * labels. Running the roster through real hands and asking whether `classify`
 * recovers these is the validation that the thresholds above are calibrated to
 * something outside this module.
 *
 * `professor` maps to null because it genuinely has no style: its entry gate is
 * disabled and its aggression multiplier is exactly 1, so it folds when the
 * price says fold and raises when the price says raise. Its VPIP is a property
 * of the prices it is offered, not of the bot, and asserting any label for it
 * would be asserting something about the table rather than the classifier.
 */
export const ARCHETYPE_STYLE: Record<BuiltArchetype, PlayStyle | null> = {
  nit: "Nit",
  rock: "Nit",
  tag: "TAG",
  professor: null,
  lag: "LAG",
  station: "Calling Station",
  maniac: "Maniac",
};
