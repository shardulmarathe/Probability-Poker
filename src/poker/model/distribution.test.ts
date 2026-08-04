import { describe, expect, it } from "vitest";
import { makeDeck } from "../cards";
import { encodeCard } from "../core/card";
import { makeRng, type Rng } from "../core/rng";
import {
  BUCKET_COUNT,
  BUCKET_NAMES,
  HandBucket,
  classifyAll,
  makeBoardContext,
} from "./buckets";
import {
  BIN_WIDTH,
  DIST_BINS,
  EMD_MAX,
  EXACT,
  allDistributions,
  binOfEquity,
  emd,
  emdOf,
  handDistribution,
  histogramMean,
  histogramOf,
} from "./distribution";
import { COMBO_COUNT, comboCardA, comboCardB, comboIndex } from "./range";

const deck = makeDeck();

function code(id: string): number {
  const card = deck.find((c) => c.id === id);
  if (!card) throw new Error(`no such card: ${id}`);
  return encodeCard(card);
}
function codes(ids: string): number[] {
  return ids.length ? ids.split(" ").map(code) : [];
}
function cardName(c: number): string {
  return deck.find((x) => encodeCard(x) === c)!.id;
}
function comboName(i: number): string {
  return `${cardName(comboCardA(i))}${cardName(comboCardB(i))}`;
}
/** Histogram with the given mass at the given bins. */
function hist(...at: [number, number][]): Float64Array {
  const h = new Float64Array(DIST_BINS);
  for (const [bin, mass] of at) h[bin] = mass;
  return h;
}
function randomBoards(len: number, n: number, rng: Rng): number[][] {
  const all = [...Array(52).keys()];
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push(rng.shuffle(all).slice(0, len));
  return out;
}

// ---------------------------------------------------------------------------
// EMD
// ---------------------------------------------------------------------------

describe("Earth Mover's Distance", () => {
  it("matches distances worked out by hand", () => {
    // One unit of dirt carried four bins: 1 * 4 = 4.
    expect(emd(hist([0, 1]), hist([4, 1]))).toBeCloseTo(4, 12);
    // Half a unit left one bin and half right one bin: 0.5*1 + 0.5*1 = 1. Note
    // the means are equal here, so a difference of expectations would call
    // these two histograms identical and EMD does not. That is the whole point.
    expect(emd(hist([0, 0.5], [2, 0.5]), hist([1, 1]))).toBeCloseTo(1, 12);
    expect(histogramMean(hist([0, 0.5], [2, 0.5]))).toBeCloseTo(
      histogramMean(hist([1, 1])),
      12
    );
    // Both halves carried two bins: 0.5*2 + 0.5*2 = 2.
    expect(emd(hist([0, 0.5], [1, 0.5]), hist([2, 0.5], [3, 0.5]))).toBeCloseTo(2, 12);
    // The extremes: certain loss against certain win.
    expect(emd(hist([0, 1]), hist([DIST_BINS - 1, 1]))).toBeCloseTo(EMD_MAX, 12);
  });

  it("is a metric", () => {
    const rng = makeRng(11);
    const random = () => {
      const h = new Float64Array(DIST_BINS);
      let t = 0;
      for (let i = 0; i < DIST_BINS; i++) t += h[i] = rng.next();
      for (let i = 0; i < DIST_BINS; i++) h[i] /= t;
      return h;
    };
    for (let n = 0; n < 300; n++) {
      const a = random();
      const b = random();
      const c = random();
      expect(emd(a, a)).toBeCloseTo(0, 12);
      expect(emd(a, b)).toBeCloseTo(emd(b, a), 12);
      expect(emd(a, b)).toBeGreaterThan(0);
      expect(emd(a, c)).toBeLessThanOrEqual(emd(a, b) + emd(b, c) + 1e-9);
    }
  });

  it("dominates the difference of means, which is why it sees more", () => {
    // EMD >= |E[a] - E[b]| / BIN_WIDTH always, with equality only when one
    // distribution stochastically dominates the other. So EMD can never miss a
    // gap that a difference of expectations would catch, and the slack in the
    // inequality is exactly the information EHS throws away.
    const rng = makeRng(97);
    let sawSlack = false;
    for (let n = 0; n < 300; n++) {
      const a = new Float64Array(DIST_BINS);
      const b = new Float64Array(DIST_BINS);
      let ta = 0;
      let tb = 0;
      for (let i = 0; i < DIST_BINS; i++) {
        ta += a[i] = rng.next();
        tb += b[i] = rng.next();
      }
      for (let i = 0; i < DIST_BINS; i++) {
        a[i] /= ta;
        b[i] /= tb;
      }
      const gap = Math.abs(histogramMean(a) - histogramMean(b)) / BIN_WIDTH;
      expect(emd(a, b)).toBeGreaterThanOrEqual(gap - 1e-9);
      if (emd(a, b) > gap + 1) sawSlack = true;
    }
    expect(sawSlack).toBe(true);
    // The equality case: two impulses, one dominating the other.
    expect(emd(hist([10, 1]), hist([30, 1]))).toBeCloseTo(
      Math.abs(histogramMean(hist([10, 1])) - histogramMean(hist([30, 1]))) / BIN_WIDTH,
      9
    );
  });

  it("rejects histograms of the wrong length", () => {
    expect(() => emd(new Float64Array(10), new Float64Array(DIST_BINS))).toThrow(/need 50/);
    expect(() => histogramMean(new Float64Array(3))).toThrow(/need 50/);
    for (const bad of [NaN, -0.01, 1.01, undefined]) {
      expect(() => binOfEquity(bad as unknown as number)).toThrow(/outside/);
    }
    expect(binOfEquity(0)).toBe(0);
    expect(binOfEquity(1)).toBe(DIST_BINS - 1);
    expect(binOfEquity(0.5)).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// The distributions themselves
// ---------------------------------------------------------------------------

describe("hand strength distributions", () => {
  it("agrees exactly between the one-combo and all-combos paths", () => {
    // Two independent implementations of the same quantity: one enumerates the
    // 990 opponent holdings directly, the other ranks all 1081 holdings at once
    // and subtracts the ones hero blocks. On the turn both are exhaustive, so
    // agreement is exact rather than statistical, and a blocker bug in either
    // would show up here immediately.
    const board = codes("Ks 7h 2d 9c");
    const set = allDistributions(board, makeRng(2), EXACT);
    for (const hole of ["Ah Kd", "2s 2h", "Jh Th", "5c 4c"]) {
      const [a, b] = codes(hole);
      const one = handDistribution(a, b, board, makeRng(1), EXACT);
      const combo = comboIndex(a, b);
      expect(one.runouts).toBe(46);
      expect(one.exact).toBe(true);
      expect(set.samples[combo]).toBe(46);
      expect(emd(one.histogram, histogramOf(set, combo))).toBeCloseTo(0, 12);
      expect(one.mean).toBeCloseTo(set.mean[combo], 12);
    }
  });

  it("is a probability distribution whose mean is the hand's equity", () => {
    const board = codes("Ks 7h 2d");
    const set = allDistributions(board, makeRng(5), 200);
    let live = 0;
    for (let i = 0; i < COMBO_COUNT; i++) {
      const h = histogramOf(set, i);
      let total = 0;
      for (let k = 0; k < DIST_BINS; k++) total += h[k];
      if (set.samples[i] === 0) {
        // Clashes with the board: no distribution at all, and callers must skip.
        expect(total).toBe(0);
        continue;
      }
      live++;
      expect(total).toBeCloseTo(1, 12);
      // The binned mean and the unquantized one agree to within half a bin,
      // which is the quantization and nothing else.
      expect(Math.abs(histogramMean(h) - set.mean[i])).toBeLessThan(BIN_WIDTH);
      expect(set.mean[i]).toBeGreaterThanOrEqual(0);
      expect(set.mean[i]).toBeLessThanOrEqual(1);
    }
    // C(49,2): every combo that does not use one of the three board cards.
    expect(live).toBe(1176);
  });

  it("collapses to an impulse on the river, where EMD becomes |dHS|", () => {
    // "After all of the public cards are revealed in the final round, each
    // histogram would be a single impulse at the corresponding hand strength
    // value, and earth mover's distance and the difference in hand strength
    // values would be equivalent." (Johanson et al., AAMAS-13, section 4.)
    const board = codes("Ks 7h 2d 9c 4s");
    const set = allDistributions(board, makeRng(3), EXACT);
    expect(set.runouts).toBe(1);
    const rng = makeRng(8);
    for (let n = 0; n < 60; n++) {
      const i = rng.int(COMBO_COUNT);
      const j = rng.int(COMBO_COUNT);
      if (set.samples[i] === 0 || set.samples[j] === 0) continue;
      const h = histogramOf(set, i);
      let nonZero = 0;
      for (let k = 0; k < DIST_BINS; k++) if (h[k] > 0) nonZero++;
      expect(nonZero).toBe(1);
      // Equal up to the binning: both hands are rounded to a bin first.
      const binned = Math.abs(binOfEquity(set.mean[i]) - binOfEquity(set.mean[j]));
      expect(emdOf(set, i, j)).toBeCloseTo(binned, 12);
      expect(Math.abs(emdOf(set, i, j) - Math.abs(set.mean[i] - set.mean[j]) / BIN_WIDTH))
        .toBeLessThanOrEqual(1);
    }
  });

  it("puts the nuts at the top bin and a dead hand at the bottom", () => {
    // A royal flush on a complete board beats every holding: equity 1.
    const nuts = handDistribution(code("Ah"), code("Kh"), codes("Qh Jh Th 2c 3d"), makeRng(1), EXACT);
    expect(nuts.mean).toBe(1);
    expect(nuts.histogram[DIST_BINS - 1]).toBe(1);
    // Seven-high on a board that plays a straight for everyone: no hand this
    // combo beats, and a chop with most of them.
    const dead = handDistribution(code("2c"), code("3d"), codes("5h 6h 7d 8s 9c"), makeRng(1), EXACT);
    expect(dead.mean).toBeLessThan(0.5);
  });

  it("rejects impossible inputs", () => {
    const rng = makeRng(1);
    expect(() => handDistribution(0, 0, [], rng)).toThrow(/duplicate/);
    expect(() => handDistribution(0, 1, [0, 2, 3], rng)).toThrow(/duplicate/);
    expect(() => handDistribution(0, 1, [2, 2, 3], rng)).toThrow(/duplicate/);
    expect(() => handDistribution(0, 99, [], rng)).toThrow(/bad card code/);
    expect(() => handDistribution(0, 1, [2, 3, 4, 5, 6, 7], rng)).toThrow(/board of 6/);
    expect(() => handDistribution(0, 1, [], rng, -5)).toThrow(/positive integer/);
    // Exhaustive enumeration is refused where it is not affordable: preflop is
    // C(52,5) = 2,598,960 runouts, which is not a default anyone wants.
    expect(() => handDistribution(0, 1, [], rng, EXACT)).toThrow(/at most 2 cards/);
    expect(() => allDistributions([], rng, EXACT)).toThrow(/at most 2 cards/);
    expect(() => allDistributions(codes("Ks 7h 2d"), rng, EXACT)).not.toThrow();
    expect(() => histogramOf(allDistributions(codes("Ks 7h 2d 9c 4s"), rng), -1)).toThrow(
      /bad combo index/
    );
  });
});

// ---------------------------------------------------------------------------
// The published example
// ---------------------------------------------------------------------------

describe("the KcQc / 6c6d example from the literature", () => {
  it("reproduces near-identical EHS with a large EMD", () => {
    // Ganzfried & Sandholm, AAAI-14, section 1: "the hands KcQc (king and queen
    // of clubs) and 6c6d (six of clubs and six of diamonds) have expected hand
    // strengths of 0.634 and 0.633 respectively, which suggests that they have
    // very similar strength. However, looking at the full distributions of hand
    // strength, as opposed to just its expectation, paints a very different
    // picture."
    const rng = makeRng(20140101);
    const kq = handDistribution(code("Kc"), code("Qc"), [], rng, 20_000);
    const six = handDistribution(code("6c"), code("6d"), [], rng, 20_000);

    console.log(
      `KcQc EHS=${kq.mean.toFixed(4)} (paper 0.634), ` +
        `6c6d EHS=${six.mean.toFixed(4)} (paper 0.633), ` +
        `|difference|=${Math.abs(kq.mean - six.mean).toFixed(4)}, ` +
        `EMD=${emd(kq.histogram, six.histogram).toFixed(3)} bins (paper 5.286)`
    );

    // The expectations land on the published values and are indistinguishable
    // from each other, exactly as the paper says.
    expect(kq.mean).toBeCloseTo(0.634, 2);
    expect(six.mean).toBeCloseTo(0.633, 2);
    expect(Math.abs(kq.mean - six.mean)).toBeLessThan(0.005);

    // And the distributions are not remotely the same. Johanson et al. publish
    // 5.286 bins for this pair (AAMAS-13, Figure 2, where QsKs and 6s6h are the
    // same two hands up to suit); this lands within a bin of it, which is the
    // check that the EMD here is the literature's EMD and not merely something
    // with the same name.
    const distance = emd(kq.histogram, six.histogram);
    expect(distance).toBeGreaterThan(4.5);
    expect(distance).toBeLessThan(6);
    // Fifty times the gap in expectations: the distance EHS cannot see.
    expect(distance).toBeGreaterThan(
      50 * Math.abs(kq.mean - six.mean)
    );

    // The paper's own description of the shapes: "6c6d frequently has an equity
    // between 0.5 and 0.7 and rarely has an equity between 0.7 and 0.9, while
    // the reverse is true for KcQc."
    const band = (h: Float64Array, lo: number, hi: number) => {
      let s = 0;
      for (let i = binOfEquity(lo); i < binOfEquity(hi); i++) s += h[i];
      return s;
    };
    const sixMid = band(six.histogram, 0.5, 0.7);
    const sixHigh = band(six.histogram, 0.7, 0.9);
    const kqMid = band(kq.histogram, 0.5, 0.7);
    const kqHigh = band(kq.histogram, 0.7, 0.9);
    console.log(
      `   mass 0.5-0.7 / 0.7-0.9:  6c6d ${sixMid.toFixed(3)} / ${sixHigh.toFixed(3)}` +
        `   KcQc ${kqMid.toFixed(3)} / ${kqHigh.toFixed(3)}`
    );
    expect(sixMid).toBeGreaterThan(sixHigh * 2);
    expect(kqHigh).toBeGreaterThan(kqMid * 2);
  });

  it("is separated by the current taxonomy, for reasons of its own", () => {
    // The headline: this codebase does NOT commit the error the paper names.
    // Preflop the ladder does not use equity at all, it bands the Chen
    // holeScore, which rewards suited high cards and so puts KcQc four rungs
    // above 6c6d despite their identical EHS. The separation is real; the
    // reason is not distributional, and the direction is a claim EHS cannot
    // support in either direction, since by EHS these hands are equal.
    const kq = codes("Kc Qc");
    const six = codes("6c 6d");
    const pre = makeBoardContext([]);
    const kqPre = classifyAll(pre)[comboIndex(kq[0], kq[1])];
    const sixPre = classifyAll(pre)[comboIndex(six[0], six[1])];
    expect(kqPre).toBe(HandBucket.TwoPair);
    expect(sixPre).toBe(HandBucket.WeakPair);
    expect(kqPre - sixPre).toBe(4);

    // Postflop the separation is the board-relative classification doing its
    // job, and it moves both ways: the pocket pair is ahead on a low board and
    // behind on a high one, which is the strategic difference the single EHS
    // number was hiding.
    const at = (hole: number[], board: string) =>
      classifyAll(makeBoardContext(codes(board)))[comboIndex(hole[0], hole[1])];
    expect(at(kq, "Kh 4s 9d")).toBe(HandBucket.TopPair);
    expect(at(six, "Kh 4s 9d")).toBe(HandBucket.WeakPair);
    expect(at(kq, "6h 7s 2d")).toBe(HandBucket.WeakDraw);
    expect(at(six, "6h 7s 2d")).toBe(HandBucket.Monster);
    expect(at(kq, "Jh Ts 3d")).toBe(HandBucket.StrongDraw);
    expect(at(six, "Jh Ts 3d")).toBe(HandBucket.WeakPair);
  });
});

// ---------------------------------------------------------------------------
// Auditing the taxonomy
// ---------------------------------------------------------------------------

/** Bucket centroids over `n` random boards, rolled out exhaustively. */
function centroids(len: number, n: number, seed: number) {
  const rng = makeRng(seed);
  const cent = new Float64Array(BUCKET_COUNT * DIST_BINS);
  const count = new Float64Array(BUCKET_COUNT);
  for (const board of randomBoards(len, n, rng)) {
    const set = allDistributions(board, rng, EXACT);
    const buckets = classifyAll(makeBoardContext(board));
    for (let i = 0; i < COMBO_COUNT; i++) {
      if (set.samples[i] === 0) continue;
      const b = buckets[i];
      count[b]++;
      for (let k = 0; k < DIST_BINS; k++) {
        cent[b * DIST_BINS + k] += set.bins[i * DIST_BINS + k];
      }
    }
  }
  const present: number[] = [];
  for (let b = 0; b < BUCKET_COUNT; b++) {
    if (count[b] === 0) continue;
    present.push(b);
    for (let k = 0; k < DIST_BINS; k++) cent[b * DIST_BINS + k] /= count[b];
  }
  const dist = new Float64Array(BUCKET_COUNT * BUCKET_COUNT);
  for (const i of present) {
    for (const j of present) {
      dist[i * BUCKET_COUNT + j] = emd(
        cent.subarray(i * DIST_BINS, (i + 1) * DIST_BINS),
        cent.subarray(j * DIST_BINS, (j + 1) * DIST_BINS)
      );
    }
  }
  return { dist, present, count };
}

describe("is the 9-class taxonomy defensible under a distribution metric", () => {
  it("groups hands whose distributions are far closer than chance", () => {
    // The clustering question, asked directly: are two hands sharing a bucket
    // actually similar in DISTRIBUTION, not merely in mean? Exhaustive rollouts
    // throughout, so none of these numbers carry sampling noise.
    console.log("\nintra- vs inter-bucket EMD (bins, exhaustive rollouts)");
    for (const [street, len, boards] of [
      ["flop", 3, 2],
      ["turn", 4, 4],
      ["river", 5, 4],
    ] as const) {
      const rng = makeRng(4242 + len);
      let intraSum = 0;
      let intraN = 0;
      let interSum = 0;
      let interN = 0;
      const perSum = new Float64Array(BUCKET_COUNT);
      const perN = new Float64Array(BUCKET_COUNT);

      for (const board of randomBoards(len, boards, rng)) {
        const set = allDistributions(board, rng, EXACT);
        const buckets = classifyAll(makeBoardContext(board));
        const live: number[] = [];
        for (let i = 0; i < COMBO_COUNT; i++) if (set.samples[i] > 0) live.push(i);
        for (let x = 0; x < live.length; x++) {
          const i = live[x];
          const bi = buckets[i];
          for (let y = x + 1; y < live.length; y++) {
            const j = live[y];
            const d = emdOf(set, i, j);
            if (bi === buckets[j]) {
              intraSum += d;
              intraN++;
              perSum[bi] += d;
              perN[bi]++;
            } else {
              interSum += d;
              interN++;
            }
          }
        }
      }

      const intra = intraSum / intraN;
      const inter = interSum / interN;
      console.log(
        `  ${street.padEnd(6)} intra ${intra.toFixed(2)}  inter ${inter.toFixed(2)}  ` +
          `ratio ${(inter / intra).toFixed(2)}   (${intraN} / ${interN} pairs)`
      );
      for (let k = 0; k < BUCKET_COUNT; k++) {
        if (perN[k] === 0) continue;
        console.log(
          `           ${BUCKET_NAMES[k as HandBucket].padEnd(12)} intra ${(
            perSum[k] / perN[k]
          ).toFixed(2)}`
        );
      }

      // A bucket is worth having only if it is tighter than the field it is
      // drawn from. Measured ratios are 2.9 to 3.2; asserting 2.5 leaves room
      // for the board draw without letting a real collapse through.
      expect(inter / intra).toBeGreaterThan(2.5);
    }
  });

  it("orders the ladder the way the distributions do", () => {
    // A ladder whose index is claimed to be monotone in strength should have a
    // Robinson centroid matrix: distances grow as you move away from the
    // diagonal. That is testable against every alternative ordering, so this
    // does not merely check the current order, it searches all 9! = 362,880 of
    // them and asks whether any is better.
    //
    // Verified over six independent board samples (flop/turn/river x two
    // seeds): the answer is that the enum order is optimal or tied-optimal
    // every time, and the ONLY alternative that ever ties it swaps TopPair with
    // Overpair, the one adjacency buckets.ts already declines to order,
    // because the sign of the gap between them flips with the boards drawn.
    // Reaching that conclusion from EMD over distribution shapes, having
    // reached it before from mean equity, is two metrics agreeing about which
    // rung of this ladder is not really a rung.
    for (const [street, len, boards, seed] of [
      ["flop", 3, 8, 303],
      ["turn", 4, 16, 304],
      ["river", 5, 16, 305],
    ] as const) {
      const { dist, present } = centroids(len, boards, seed);
      const identity = present.slice();

      const violations = (order: number[]): number => {
        let v = 0;
        for (let a = 0; a < order.length; a++) {
          for (let b = a + 1; b < order.length; b++) {
            for (let c = b + 1; c < order.length; c++) {
              const far = dist[order[a] * BUCKET_COUNT + order[c]];
              if (far < dist[order[a] * BUCKET_COUNT + order[b]]) v++;
              if (far < dist[order[b] * BUCKET_COUNT + order[c]]) v++;
            }
          }
        }
        return v;
      };

      const permute = (items: number[]): number[][] => {
        if (items.length <= 1) return [items];
        const out: number[][] = [];
        for (let i = 0; i < items.length; i++) {
          const rest = items.slice(0, i).concat(items.slice(i + 1));
          for (const p of permute(rest)) out.push([items[i], ...p]);
        }
        return out;
      };

      const all = permute(identity);
      let best = Infinity;
      const optimal: number[][] = [];
      for (const order of all) {
        const v = violations(order);
        if (v < best) {
          best = v;
          optimal.length = 0;
        }
        if (v === best) optimal.push(order);
      }

      console.log(
        `${street}: enum order has ${violations(identity)} Robinson violations, ` +
          `best of ${all.length} orderings is ${best}`
      );

      // Reversal is always as good as the original, so the optimum comes in
      // pairs; strip the descending half before looking at what is left.
      const ascending = optimal.filter((o) => o[0] === identity[0]);
      for (const order of ascending) {
        const moved = order
          .map((b, k) => (b === identity[k] ? null : BUCKET_NAMES[b as HandBucket]))
          .filter((x): x is string => x !== null);
        console.log(`   optimal ordering differs from the enum at: {${moved.join(", ")}}`);
        // Every optimal ordering is the enum order, or the enum order with
        // TopPair and Overpair exchanged. Nothing else is ever competitive.
        expect(moved.length === 0 || moved.length === 2).toBe(true);
        for (const m of moved) {
          expect([BUCKET_NAMES[HandBucket.TopPair], BUCKET_NAMES[HandBucket.Overpair]]).toContain(m);
        }
      }
      // ...and the enum order is one of the optimal ones, or within a hair of
      // it. The gap is bounded rather than asserted to zero: which of TopPair
      // and Overpair leads is a property of the boards drawn, not of the code.
      expect(violations(identity) - best).toBeLessThanOrEqual(4);
    }
  });

  it("still has hands it cannot tell apart, and hands it wrongly splits", () => {
    // Where nine classes run out of room. These are findings, not failures to
    // tune away: the assertions below pin the defects at their measured size so
    // that a future change has to notice them.
    for (const [street, len, boards] of [
      ["flop", 3, 2],
      ["turn", 4, 3],
    ] as const) {
      const rng = makeRng(31337 + len);
      let sameFarD = 0;
      let sameFarS = "";
      let diffNearD = Infinity;
      let diffNearS = "";
      let nnSame = 0;
      let nnTotal = 0;

      for (const board of randomBoards(len, boards, rng)) {
        const set = allDistributions(board, rng, EXACT);
        const buckets = classifyAll(makeBoardContext(board));
        const live: number[] = [];
        for (let i = 0; i < COMBO_COUNT; i++) if (set.samples[i] > 0) live.push(i);
        const label = board.map(cardName).join(" ");
        const nnDist = new Float64Array(live.length).fill(Infinity);
        const nnIdx = new Int32Array(live.length).fill(-1);

        for (let x = 0; x < live.length; x++) {
          const i = live[x];
          for (let y = x + 1; y < live.length; y++) {
            const j = live[y];
            const d = emdOf(set, i, j);
            if (d < nnDist[x]) {
              nnDist[x] = d;
              nnIdx[x] = j;
            }
            if (d < nnDist[y]) {
              nnDist[y] = d;
              nnIdx[y] = i;
            }
            if (buckets[i] === buckets[j]) {
              if (d > sameFarD) {
                sameFarD = d;
                sameFarS = `${label}  ${comboName(i)} / ${comboName(j)} both ${
                  BUCKET_NAMES[buckets[i] as HandBucket]
                }`;
              }
            } else if (Math.abs(buckets[i] - buckets[j]) >= 3 && d < diffNearD) {
              diffNearD = d;
              diffNearS =
                `${label}  ${comboName(i)} (${BUCKET_NAMES[buckets[i] as HandBucket]})` +
                ` / ${comboName(j)} (${BUCKET_NAMES[buckets[j] as HandBucket]})`;
            }
          }
        }
        for (let x = 0; x < live.length; x++) {
          nnTotal++;
          if (buckets[live[x]] === buckets[nnIdx[x]]) nnSame++;
        }
      }

      const purity = (100 * nnSame) / nnTotal;
      console.log(`\n${street}: nearest-neighbour purity ${purity.toFixed(1)}%`);
      console.log(`  worst same-bucket pair:  ${sameFarS}  EMD=${sameFarD.toFixed(2)}`);
      console.log(
        `  closest 3-rungs-apart pair: ${diffNearS}  EMD=${diffNearD.toFixed(2)}`
      );

      // Nearly every combo's nearest neighbour by EMD shares its bucket. (Read
      // with care: suit-permuted near-duplicates make this measure generous.)
      expect(purity).toBeGreaterThan(95);

      // But the tails are bad, and this is the honest part. Somewhere in every
      // sample there are two hands in the SAME bucket further apart than the
      // whole distance from Air to Weak Pair (about 15 bins), and two hands
      // three rungs apart that are all but identical. Nine hand-crafted classes
      // cannot price "ace-high with a gutshot" apart from "four-high with a
      // backdoor flush", nor a straight flush apart from the straight it beats.
      expect(sameFarD).toBeGreaterThan(15);
      expect(diffNearD).toBeLessThan(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe("cost", () => {
  it("is offline apparatus, and says so in microseconds", () => {
    const board = codes("Ks 7h 2d");
    let start = performance.now();
    const exact = allDistributions(board, makeRng(1), EXACT);
    const exactMs = performance.now() - start;
    start = performance.now();
    const sampled = allDistributions(board, makeRng(2), 500);
    const sampledMs = performance.now() - start;

    let live = 0;
    for (let i = 0; i < COMBO_COUNT; i++) if (exact.samples[i] > 0) live++;
    console.log(
      `\nflop, all ${live} live combos: exhaustive (${exact.runouts} runouts) ` +
        `${exactMs.toFixed(0)}ms = ${((exactMs * 1000) / live).toFixed(0)} us/combo; ` +
        `sampled (500) ${sampledMs.toFixed(0)}ms = ${((sampledMs * 1000) / live).toFixed(0)} us/combo`
    );

    // What the sampling costs against the exhaustive truth.
    let worst = 0;
    let sum = 0;
    for (let i = 0; i < COMBO_COUNT; i++) {
      if (exact.samples[i] === 0) continue;
      const d = emd(histogramOf(exact, i), histogramOf(sampled, i));
      if (d > worst) worst = d;
      sum += d;
    }
    console.log(
      `  500 runouts vs exhaustive: mean EMD ${(sum / live).toFixed(3)} bins, worst ${worst.toFixed(2)}`
    );
    expect(sum / live).toBeLessThan(1);

    // Two to three orders of magnitude past classifyAll, which does the same
    // 1326 combos in ~190 microseconds TOTAL. Nothing inside a decision may
    // call this; the bound is here so that stays true by measurement.
    expect(sampledMs).toBeGreaterThan(1);
    expect(exactMs).toBeLessThan(20_000);
  });
});
