import { describe, expect, it } from "vitest";

import {
  MIRROR_ID,
  aggressionForAf,
  bluffRateForAggression,
  mirrorProfile,
  thresholdForVpip,
} from "./mirror";
import { MANIAC_AF, MIN_CLASSIFY_HANDS } from "../coach/archetype";
import type { PlayerStats } from "../coach/stats";
import { BOT_ARCHETYPES, BOT_PROFILES } from "./profiles";

/** Stats with only the counters `vectorFromStats` reads. */
function stats(over: {
  hands?: number;
  vpip?: [number, number];
  pfr?: [number, number];
  af?: [number, number];
}): PlayerStats {
  const c = ([n, d]: [number, number]) => ({ n, d });
  return {
    seat: 0,
    total: {
      hands: over.hands ?? 100,
      vpip: c(over.vpip ?? [20, 100]),
      pfr: c(over.pfr ?? [10, 100]),
      af: c(over.af ?? [10, 10]),
    },
  } as unknown as PlayerStats;
}

describe("thresholdForVpip", () => {
  it("maps a measured VPIP to the threshold admitting the closest share", () => {
    // The shares are profiles.ts's own combo-weighted figures.
    expect(thresholdForVpip(4)).toBe(10);
    expect(thresholdForVpip(11)).toBe(8);
    expect(thresholdForVpip(18)).toBe(7);
    expect(thresholdForVpip(43)).toBe(5);
    expect(thresholdForVpip(67)).toBe(3);
    expect(thresholdForVpip(96)).toBe(-1);
  });

  it("is monotone: a looser player never gets a tighter gate", () => {
    let previous = Infinity;
    for (let vpip = 0; vpip <= 100; vpip += 2) {
      const t = thresholdForVpip(vpip);
      expect(t).toBeLessThanOrEqual(previous);
      previous = t;
    }
  });

  it("lands every static profile's own VPIP back on its own threshold", () => {
    // The roster quotes a share per threshold; feeding that share back must
    // return the threshold it came from, or the inversion is not one.
    for (const [share, threshold] of [
      [4.4, 10], [10.7, 8], [17.8, 7], [43.3, 5], [67.1, 3], [96.4, -1],
    ] as const) {
      expect(thresholdForVpip(share)).toBe(threshold);
    }
  });
});

describe("aggressionForAf", () => {
  it("gives no opinion when the seat never called postflop", () => {
    // Null AF is a real state and must not read as zero aggression.
    expect(aggressionForAf(null)).toBe(1);
  });

  it("anchors on the roster's own points", () => {
    expect(aggressionForAf(0)).toBeCloseTo(0.55, 5);
    expect(aggressionForAf(1.5)).toBeCloseTo(1.35, 5);
    expect(aggressionForAf(MANIAC_AF)).toBeCloseTo(1.6, 5);
    expect(aggressionForAf(4)).toBeCloseTo(2.2, 5);
  });

  it("is monotone and never leaves the roster's range", () => {
    const lo = Math.min(...BOT_ARCHETYPES.map((id) => BOT_PROFILES[id].aggression));
    const hi = Math.max(...BOT_ARCHETYPES.map((id) => BOT_PROFILES[id].aggression));
    let previous = -Infinity;
    for (let af = 0; af <= 12; af += 0.25) {
      const a = aggressionForAf(af);
      expect(a).toBeGreaterThanOrEqual(previous);
      expect(a).toBeGreaterThanOrEqual(lo);
      expect(a).toBeLessThanOrEqual(hi);
      previous = a;
    }
  });
});

describe("bluffRateForAggression", () => {
  it("stays inside the roster's range", () => {
    const hi = Math.max(...BOT_ARCHETYPES.map((id) => BOT_PROFILES[id].bluffRate));
    for (let a = 0.5; a <= 2.5; a += 0.05) {
      const b = bluffRateForAggression(a);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(hi);
    }
  });

  it("rises with aggression", () => {
    let previous = -Infinity;
    for (let a = 0.55; a <= 2.2; a += 0.05) {
      const b = bluffRateForAggression(a);
      expect(b).toBeGreaterThanOrEqual(previous);
      previous = b;
    }
  });
});

describe("mirrorProfile", () => {
  it("refuses a profile below the bar the style verdict uses", () => {
    expect(mirrorProfile(stats({ hands: MIN_CLASSIFY_HANDS - 1 }))).toBeNull();
    expect(mirrorProfile(stats({ hands: MIN_CLASSIFY_HANDS }))).not.toBeNull();
  });

  it("reproduces a tight passive player as a tight passive seat", () => {
    const p = mirrorProfile(stats({ vpip: [11, 100], af: [3, 10] }))!;
    expect(p.entryThreshold).toBe(8);
    expect(p.aggression).toBeLessThan(1);
    expect(p.bluffRate).toBeLessThan(0.05);
  });

  it("reproduces a loose aggressive player as a loose aggressive seat", () => {
    const p = mirrorProfile(stats({ vpip: [43, 100], af: [30, 10] }))!;
    expect(p.entryThreshold).toBe(5);
    expect(p.aggression).toBeGreaterThan(1.5);
    expect(p.bluffRate).toBeGreaterThan(0.2);
  });

  it("carries the id the engine resolves through its lookup", () => {
    expect(mirrorProfile(stats({}))!.id).toBe(MIRROR_ID);
    // And that id is deliberately not a row in the static roster.
    expect(Object.keys(BOT_PROFILES)).not.toContain(MIRROR_ID);
  });

  it("quotes only what it measured in the blurb", () => {
    const p = mirrorProfile(stats({ vpip: [24, 100], af: [18, 10] }))!;
    expect(p.blurb).toContain("24%");
    expect(p.blurb).toContain("1.80");
    // A bluff frequency in the blurb would be quoting an inference as a reading.
    expect(p.blurb).not.toMatch(/bluff/i);
  });

  it("says so rather than inventing a number when AF is unmeasured", () => {
    const p = mirrorProfile(stats({ af: [0, 0] }))!;
    expect(p.blurb).toContain("unmeasured");
    expect(p.aggression).toBe(1);
  });

  it("fills every field a static profile has", () => {
    const p = mirrorProfile(stats({}))!;
    for (const key of Object.keys(BOT_PROFILES.tag)) {
      expect(p[key as keyof typeof p]).toBeDefined();
    }
  });
});
