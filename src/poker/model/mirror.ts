/**
 * A seat that plays the way the player does.
 *
 * Every other archetype is four numbers written down in `profiles.ts`. This one
 * has no row there and cannot have: its parameters are measured from hands the
 * player has already finished, so they do not exist until a session does. That
 * is the whole reason `BuiltArchetype` excludes it and the roster does not owe
 * it an entry.
 *
 * WHAT IT IS FOR. The claim this product makes that a solver cannot is that the
 * table forms a read on one specific person. The sharpest demonstration of that
 * is to hand the read back: sit the player's own style in the other chair and
 * let them play it. A style that is uncomfortable to face is a style worth
 * changing, and that argument lands harder from the felt than from a leak table.
 *
 * WHAT IS MEASURED AND WHAT IS NOT, stated plainly because the difference
 * matters more here than anywhere else in the app:
 *
 *   entryThreshold  measured. Inverted from VPIP through the same
 *                   combo-weighted shares `profiles.ts` documents.
 *   aggression      measured. Interpolated from postflop AF through the
 *                   roster's own published points.
 *   bluffRate       NOT measured. No tracker stat identifies a bluff, because
 *                   naming one needs the cards and the fold, and a hand that
 *                   folded to a bet never showed either. The roster's own
 *                   aggression-to-bluff relationship is used instead, so an
 *                   aggressive mirror bluffs like the aggressive archetypes do.
 *                   It is an inference from the style, not an observation of it.
 *   preferredSizing NOT measured, and not inferrable at all: sizing is not in
 *                   `PlayerStats`. Left at the half-pot reference every static
 *                   profile also defaults to.
 *
 * Below `MIN_CLASSIFY_HANDS` this returns null rather than a shaky profile, the
 * same bar the style verdict holds itself to. A mirror built from nine hands
 * would be a caricature the player would reasonably not recognise, and the
 * point of the seat is recognition.
 */

import {
  MANIAC_AF,
  MIN_CLASSIFY_HANDS,
  vectorFromStats,
} from "../coach/archetype";
import type { PlayerStats } from "../coach/stats";
import type { BotProfile } from "../table/contract";
import { MIN_HOLE_SCORE } from "./profiles";

/** The archetype id the engine sees on a mirrored seat. */
export const MIRROR_ID = "mirror";

/**
 * `entryThreshold` against the share of the 1,326 starting hands it admits.
 *
 * These are `profiles.ts`'s own figures, and they are the reason the roster's
 * blurbs can quote a percentage: the scale is a Chen-style `holeScore`, which is
 * coarse and lumpy, so the only honest way to read a threshold is through the
 * combo-weighted fraction it actually lets through.
 */
const THRESHOLD_SHARE: readonly [threshold: number, sharePercent: number][] = [
  [10, 4.4],
  [8, 10.7],
  [7, 17.8],
  [5, 43.3],
  [3, 67.1],
  [MIN_HOLE_SCORE, 96.4],
];

/** The threshold whose admitted share sits closest to the measured VPIP. */
export function thresholdForVpip(vpip: number): number {
  let best = THRESHOLD_SHARE[0];
  for (const row of THRESHOLD_SHARE) {
    if (Math.abs(row[1] - vpip) < Math.abs(best[1] - vpip)) best = row;
  }
  return best[0];
}

/**
 * Postflop AF against the aggression multiplier, through the roster's points.
 *
 * The anchors are the static profiles and the classifier's own cut points, not
 * numbers chosen to look reasonable: a seat that never raises postflop plays
 * like the station (0.55), `AGGRESSIVE_AF` is where the classifier starts
 * calling a seat aggressive and the TAG sits at 1.35, `MANIAC_AF` is where it
 * stops hedging and the LAG sits at 1.6, and the maniac's 2.2 is the ceiling
 * the roster itself does not go past.
 */
const AF_AGGRESSION: readonly [af: number, aggression: number][] = [
  [0, 0.55],
  [1.5, 1.35],
  [MANIAC_AF, 1.6],
  [4, 2.2],
];

/**
 * Piecewise-linear read of a curve given as points, clamped at both ends.
 *
 * Shared by both derivations below so neither can drift into its own
 * interpolation, and clamped rather than extrapolated: past the last anchor the
 * roster has nothing to say, and a linear guess out there is how a mirror ends
 * up bluffier than any seat that ships.
 */
function interpolate(
  points: readonly [number, number][],
  x: number
): number {
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (x <= x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

export function aggressionForAf(af: number | null): number {
  // A seat that never called postflop has no AF. That is a real state and it is
  // not zero aggression, so it takes the pure-EV baseline and no opinion.
  if (af === null) return 1;
  return interpolate(AF_AGGRESSION, af);
}

/**
 * Bluff rate along the roster's aggression axis.
 *
 * Inferred, not measured, and the header says why. The anchors are the roster's
 * own pairs: the station at (0.55, 0.01), the rock at (0.7, 0.02), the TAG at
 * (1.35, 0.14), the LAG at (1.6, 0.26) and the maniac at (2.2, 0.42).
 *
 * The professor's (1.0, 0) is deliberately NOT an anchor. Its zero is not a
 * point on the style curve, it is the switch that turns personality off so
 * `chooseAction` collapses to a plain argmax, and threading the curve through
 * it makes the function non-monotone: it would have a mirror at aggression 1.0
 * bluffing less than one at 0.8, so a player who became slightly more
 * aggressive would be mirrored as one who bluffed less. Monotone is the property
 * that has to hold here even though the roster does not satisfy it.
 */
const AGGRESSION_BLUFF: readonly [aggression: number, bluffRate: number][] = [
  [0.55, 0.01],
  [0.7, 0.02],
  [1.35, 0.14],
  [1.6, 0.26],
  [2.2, 0.42],
];

export function bluffRateForAggression(aggression: number): number {
  return Number(interpolate(AGGRESSION_BLUFF, aggression).toFixed(3));
}

/**
 * The player's measured style as a seat, or null when the sample cannot support
 * one.
 */
export function mirrorProfile(stats: PlayerStats): BotProfile | null {
  const v = vectorFromStats(stats);
  if (v.hands < MIN_CLASSIFY_HANDS) return null;

  const entryThreshold = thresholdForVpip(v.vpip);
  const aggression = Number(aggressionForAf(v.af).toFixed(3));
  const bluffRate = bluffRateForAggression(aggression);

  return {
    // Not in `BotArchetype`'s built set, which is exactly the point. The engine
    // reads `profile` as a string and resolves it through an injected lookup.
    id: MIRROR_ID as BotProfile["id"],
    name: "Mirror",
    short: "Mirror",
    monogram: "ME",
    // Quotes the two figures it actually measured, so the seat can be argued
    // with. A blurb claiming a bluff frequency would be quoting an inference.
    blurb: `Plays your measured style: ${v.vpip.toFixed(0)}% of hands, postflop aggression ${
      v.af === null ? "unmeasured" : v.af.toFixed(2)
    }.`,
    entryThreshold,
    aggression,
    bluffRate,
    preferredSizing: 0.5,
  };
}
