import { describe, expect, it } from "vitest";
import { makeRng } from "../core/rng";
import { decodeCard, encodeCard } from "../core/card";
import { makeDeck } from "../cards";
import {
  COMBO_COUNT,
  GRID_CELLS,
  GRID_LABELS,
  GRID_SIZE,
  cloneRange,
  comboCardA,
  comboCardB,
  comboCards,
  comboIndex,
  drawCombo,
  emptyRange,
  gridCellOf,
  makeComboSampler,
  normalizeRange,
  removeCards,
  sampleCombo,
  toGrid,
  totalWeight,
  uniformRange,
  weightOf,
} from "./range";

const deck = makeDeck();

/** Card code from an id like "Ah". */
function code(id: string): number {
  const card = deck.find((c) => c.id === id);
  if (!card) throw new Error(`no such card: ${id}`);
  return encodeCard(card);
}

/** C(n, 2). */
function choose2(n: number): number {
  return (n * (n - 1)) / 2;
}

describe("combo indexing", () => {
  it("is a bijection between the 1326 combos and 0..1325", () => {
    const seen = new Uint8Array(COMBO_COUNT);
    let count = 0;
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) {
        const i = comboIndex(a, b);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(COMBO_COUNT);
        expect(seen[i]).toBe(0);
        seen[i] = 1;
        count++;
      }
    }
    expect(count).toBe(COMBO_COUNT);
    expect(choose2(52)).toBe(COMBO_COUNT);
    for (let i = 0; i < COMBO_COUNT; i++) expect(seen[i]).toBe(1);
  });

  it("comboCards inverts comboIndex, both ways round", () => {
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) {
        const [x, y] = comboCards(comboIndex(a, b));
        expect(x).toBe(a);
        expect(y).toBe(b);
      }
    }
    for (let i = 0; i < COMBO_COUNT; i++) {
      const [a, b] = comboCards(i);
      expect(comboIndex(a, b)).toBe(i);
      expect(comboCardA(i)).toBe(a);
      expect(comboCardB(i)).toBe(b);
      expect(a).toBeLessThan(b);
    }
  });

  it("ignores the order of the two cards", () => {
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) {
        expect(comboIndex(b, a)).toBe(comboIndex(a, b));
      }
    }
  });

  it("rejects a card paired with itself, and out-of-range codes", () => {
    expect(() => comboIndex(7, 7)).toThrow(/not a two-card combo/);
    expect(() => comboIndex(-1, 3)).toThrow(/not a two-card combo/);
    expect(() => comboIndex(3, 52)).toThrow(/not a two-card combo/);
    expect(() => comboCards(-1)).toThrow(/bad index/);
    expect(() => comboCards(COMBO_COUNT)).toThrow(/bad index/);
  });
});

describe("range construction", () => {
  it("uniformRange weights every combo 1", () => {
    const r = uniformRange();
    expect(r.length).toBe(COMBO_COUNT);
    expect(totalWeight(r)).toBe(COMBO_COUNT);
    for (let i = 0; i < COMBO_COUNT; i++) expect(r[i]).toBe(1);
  });

  it("emptyRange is all zero and cloneRange is independent", () => {
    const e = emptyRange();
    expect(totalWeight(e)).toBe(0);

    const r = uniformRange();
    const copy = cloneRange(r);
    copy[0] = 99;
    expect(r[0]).toBe(1);
    expect(copy[1]).toBe(1);
  });

  it("normalizeRange sums to 1 and refuses an empty range", () => {
    const r = uniformRange();
    r[10] = 5;
    normalizeRange(r);
    expect(totalWeight(r)).toBeCloseTo(1, 12);
    // Relative weights survive: combo 10 still carries five times its peers.
    expect(r[10] / r[11]).toBeCloseTo(5, 10);

    expect(() => normalizeRange(emptyRange())).toThrow(/no weight/);
  });

  it("weightOf reads a combo and bounds-checks", () => {
    const r = uniformRange();
    r[42] = 3;
    expect(weightOf(r, 42)).toBe(3);
    expect(() => weightOf(r, COMBO_COUNT)).toThrow(/bad combo index/);
    expect(() => weightOf(r, -1)).toThrow(/bad combo index/);
  });
});

describe("removeCards (card removal, and blockers for free)", () => {
  it("zeroes exactly C(52,2) - C(52-k,2) combos for k known cards", () => {
    const rng = makeRng(0xb10c);
    for (let k = 1; k <= 7; k++) {
      const cards = rng.shuffle([...Array(52).keys()]).slice(0, k);
      const r = uniformRange();
      removeCards(r, cards);

      let zeroed = 0;
      for (let i = 0; i < COMBO_COUNT; i++) if (r[i] === 0) zeroed++;
      expect(zeroed).toBe(choose2(52) - choose2(52 - k));
      // The surviving weight is exactly the combos dealable from what is left.
      expect(totalWeight(r)).toBe(choose2(52 - k));
    }
  });

  it("zeroes a combo iff it contains a removed card", () => {
    const removed = [code("Ah"), code("Kd"), code("7c")];
    const r = uniformRange();
    removeCards(r, removed);

    for (let i = 0; i < COMBO_COUNT; i++) {
      const [a, b] = comboCards(i);
      const clashes = removed.includes(a) || removed.includes(b);
      expect(r[i]).toBe(clashes ? 0 : 1);
    }
  });

  it("makes the nut flush impossible when we hold the ace of that suit", () => {
    // Holding the A of hearts, no opponent combo can contain it, so every
    // nut-heart-flush holding is gone without a blocker rule being written.
    const r = uniformRange();
    removeCards(r, [code("Ah")]);
    for (const other of deck) {
      if (other.id === "Ah") continue;
      expect(r[comboIndex(code("Ah"), encodeCard(other))]).toBe(0);
    }
    // 51 combos contained it; 1275 remain.
    expect(totalWeight(r)).toBe(choose2(51));
  });

  it("is idempotent and rejects a bad card code", () => {
    const r = uniformRange();
    removeCards(r, [code("Ah")]);
    const after = cloneRange(r);
    removeCards(r, [code("Ah")]);
    expect([...r]).toEqual([...after]);
    expect(() => removeCards(uniformRange(), [52])).toThrow(/bad card code/);
    expect(() => removeCards(uniformRange(), [-1])).toThrow(/bad card code/);
  });

  it("rejects a card code that is not an integer 0..51", () => {
    // `c < 0 || c > 51` is false for every one of these, so each used to slip
    // through and do something quietly wrong instead of throwing:
    //   NaN       -> INDEX_OF[NaN] is undefined, a silent no-op
    //   null      -> coerces to 0 and removes the ace of spades
    //   3.5       -> row 182 zeroes 51 combos that are the tail of card 3 and
    //                the head of card 4, i.e. the wrong ones
    // A range that has quietly lost the wrong combos still looks like a range.
    for (const bad of [NaN, undefined, null, 3.5, -0.5, Infinity, "7"]) {
      expect(() =>
        removeCards(uniformRange(), [bad as unknown as number])
      ).toThrow(/bad card code/);
    }

    // Nothing is removed when the call throws, and in particular the ace of
    // spades survives a `null`, which is the case that used to look like a
    // working blocker.
    const r = uniformRange();
    expect(() => removeCards(r, [null as unknown as number])).toThrow();
    expect(totalWeight(r)).toBe(COMBO_COUNT);
    expect(r[comboIndex(code("As"), code("Kd"))]).toBe(1);

    // A bad code partway through a list still throws, having stopped there.
    const r2 = uniformRange();
    expect(() =>
      removeCards(r2, [code("Ah"), NaN as unknown as number, code("Ks")])
    ).toThrow(/bad card code/);
    expect(totalWeight(r2)).toBe(choose2(51));
  });
});

describe("13x13 grid projection", () => {
  it("labels the chart in the standard orientation", () => {
    expect(GRID_LABELS.length).toBe(GRID_CELLS);
    expect(GRID_LABELS[0]).toBe("AA");
    expect(GRID_LABELS[1]).toBe("AKs"); // suited above the diagonal
    expect(GRID_LABELS[GRID_SIZE]).toBe("AKo"); // offsuit below it
    expect(GRID_LABELS[GRID_CELLS - 1]).toBe("22");
    expect(GRID_LABELS[12]).toBe("A2s");
    expect(GRID_LABELS[12 * GRID_SIZE]).toBe("A2o");
    expect(GRID_LABELS[GRID_SIZE + 1]).toBe("KK");
  });

  it("puts each combo in the cell its label names", () => {
    for (let i = 0; i < COMBO_COUNT; i++) {
      const a = decodeCard(comboCardA(i));
      const b = decodeCard(comboCardB(i));
      const hi = a.rank >= b.rank ? a : b;
      const lo = a.rank >= b.rank ? b : a;
      const rank = (r: number) =>
        r === 14 ? "A" : r === 13 ? "K" : r === 12 ? "Q" : r === 11 ? "J" : r === 10 ? "T" : String(r);
      const expected =
        hi.rank === lo.rank
          ? `${rank(hi.rank)}${rank(hi.rank)}`
          : `${rank(hi.rank)}${rank(lo.rank)}${a.suit === b.suit ? "s" : "o"}`;
      expect(GRID_LABELS[gridCellOf(i)]).toBe(expected);
    }
  });

  it("conserves weight", () => {
    const rng = makeRng(7);
    const r = uniformRange();
    for (let i = 0; i < COMBO_COUNT; i++) r[i] = rng.next() * 10;
    const grid = toGrid(r);
    let sum = 0;
    for (let i = 0; i < GRID_CELLS; i++) sum += grid[i];
    expect(sum).toBeCloseTo(totalWeight(r), 9);
  });

  it("gives the textbook 6 / 4 / 12 combo counts on a uniform range", () => {
    const grid = toGrid(uniformRange());
    let pairs = 0;
    let suited = 0;
    let offsuit = 0;
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const v = grid[row * GRID_SIZE + col];
        if (row === col) {
          expect(v).toBe(6);
          pairs++;
        } else if (col > row) {
          expect(v).toBe(4);
          suited++;
        } else {
          expect(v).toBe(12);
          offsuit++;
        }
      }
    }
    expect([pairs, suited, offsuit]).toEqual([13, 78, 78]);
    expect(13 * 6 + 78 * 4 + 78 * 12).toBe(COMBO_COUNT);
  });

  it("tracks card removal — blocking one ace drops AA from 6 combos to 3", () => {
    const r = uniformRange();
    removeCards(r, [code("As")]);
    const grid = toGrid(r);
    expect(grid[0]).toBe(3); // AA: only the three combos among Ah/Ad/Ac
    expect(grid[1]).toBe(3); // AKs: the spade one is gone
    expect(grid[GRID_SIZE]).toBe(9); // AKo: 12 - 3 that used the As
  });

  it("reuses a caller-provided output buffer", () => {
    const out = new Float64Array(GRID_CELLS).fill(99);
    const grid = toGrid(uniformRange(), out);
    expect(grid).toBe(out);
    expect(out[0]).toBe(6);
  });

  it("rejects an output buffer too small to hold the grid", () => {
    // Float64Array drops out-of-range stores, so a short buffer silently loses
    // whole cells, and `toGrid` would stop conserving weight without saying so.
    expect(() => toGrid(uniformRange(), new Float64Array(10))).toThrow(
      /out buffer/
    );
    expect(() => toGrid(uniformRange(), new Float64Array(GRID_CELLS - 1))).toThrow(
      /out buffer/
    );
    expect(() =>
      toGrid(uniformRange(), new Float64Array(GRID_CELLS))
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Pearson chi-square of observed counts against the range's own weights. */
function chiSquare(counts: Int32Array, range: Float64Array, draws: number): number {
  const total = totalWeight(range);
  let chi2 = 0;
  for (let i = 0; i < COMBO_COUNT; i++) {
    if (range[i] <= 0) continue;
    const expected = (range[i] / total) * draws;
    const d = counts[i] - expected;
    chi2 += (d * d) / expected;
  }
  return chi2;
}

function support(range: Float64Array): number {
  let n = 0;
  for (let i = 0; i < COMBO_COUNT; i++) if (range[i] > 0) n++;
  return n;
}

describe("sampleCombo", () => {
  it("draws proportionally to weight (chi-square, uniform range)", () => {
    const range = uniformRange();
    const rng = makeRng(2024);
    const draws = 200_000;
    const counts = new Int32Array(COMBO_COUNT);
    for (let i = 0; i < draws; i++) counts[sampleCombo(range, rng)]++;

    const df = support(range) - 1;
    const chi2 = chiSquare(counts, range, draws);
    // For large df, chi2 is ~N(df, 2df). Five sigma is a wide net that still
    // catches any real bias; the seed is fixed, so this cannot flake.
    expect(Math.abs(chi2 - df)).toBeLessThan(5 * Math.sqrt(2 * df));
  });

  it("draws proportionally on a sparse, unequally weighted range", () => {
    const range = emptyRange();
    const picks = [5, 100, 700, 1325];
    const weights = [1, 2, 7, 10];
    picks.forEach((p, k) => (range[p] = weights[k]));

    const rng = makeRng(99);
    const draws = 120_000;
    const counts = new Int32Array(COMBO_COUNT);
    for (let i = 0; i < draws; i++) counts[sampleCombo(range, rng)]++;

    // chi-square on 3 degrees of freedom; 21 is p < 1e-4.
    expect(chiSquare(counts, range, draws)).toBeLessThan(21);
    picks.forEach((p, k) => {
      expect(counts[p] / draws).toBeCloseTo(weights[k] / 20, 2);
    });
  });

  it("never returns a combo with zero weight", () => {
    // The realistic case: a range with three cards removed.
    const range = uniformRange();
    removeCards(range, [code("Ah"), code("Ks"), code("2d")]);
    const rng = makeRng(1);
    for (let i = 0; i < 50_000; i++) {
      const combo = sampleCombo(range, rng);
      expect(range[combo]).toBeGreaterThan(0);
    }
  });

  it("refuses a range with no weight", () => {
    expect(() => sampleCombo(emptyRange(), makeRng(0))).toThrow(/no weight/);
  });
});

/**
 * The exact probability the alias table assigns each combo.
 *
 * A Vose draw picks a bucket uniformly and then keeps it with probability
 * `prob[i]` or follows `alias[i]`, so the marginal is a closed form. Checking it
 * needs no sampling, no chi-square and no tolerance for luck, every entry of
 * both arrays is read, and an error of 1e-12 is a failure rather than noise.
 */
function aliasMarginals(sampler: {
  prob: Float64Array;
  alias: Uint16Array;
}): Float64Array {
  const m = new Float64Array(COMBO_COUNT);
  for (let i = 0; i < COMBO_COUNT; i++) {
    m[i] += sampler.prob[i] / COMBO_COUNT;
    m[sampler.alias[i]] += (1 - sampler.prob[i]) / COMBO_COUNT;
  }
  return m;
}

/** Ranges chosen to exercise the alias build, not just to be valid. */
function shapedRanges(): [string, Float64Array][] {
  const rng = makeRng(90210);
  const fill = (f: (i: number) => number): Float64Array => {
    const r = emptyRange();
    for (let i = 0; i < COMBO_COUNT; i++) r[i] = f(i);
    return r;
  };
  const sparse = emptyRange();
  sparse[5] = 1;
  sparse[100] = 2;
  sparse[700] = 7;
  sparse[1325] = 10;
  const single = emptyRange();
  single[42] = 3;
  const spikes = emptyRange();
  spikes[3] = 1;
  spikes[1000] = 0.0001;

  return [
    ["uniform", uniformRange()],
    ["random", fill(() => rng.next())],
    ["random again", fill(() => rng.next())],
    ["heavy-tailed", fill(() => Math.pow(rng.next(), 8))],
    ["linear mod 17", fill((i) => i % 17)],
    ["one dominant combo", fill((i) => (i === 0 ? 1e6 : 1))],
    ["1 : 1e-9", fill((i) => (i === 7 ? 1 : 1e-9))],
    ["sparse", sparse],
    ["single combo", single],
    ["two spikes", spikes],
  ];
}

describe("alias sampler", () => {
  it("assigns every combo exactly its share of the weight", () => {
    // The old test here drew 200k samples from a UNIFORM range and ran a
    // chi-square. On a uniform range every scaled value is exactly 1, so every
    // bucket goes to `large`, the small/large pairing loop never executes and
    // `prob` is all ones, the test exercised none of the alias construction.
    // (Mutating `prob[s] = scaled[s] * 0.97` left its error at exactly 0.)
    // This checks the table's own arithmetic instead, on ranges that do drive
    // the pairing loop.
    for (const [name, range] of shapedRanges()) {
      const sampler = makeComboSampler(range);
      const total = totalWeight(range);
      const m = aliasMarginals(sampler);
      expect(sampler.total).toBeCloseTo(total, 9);

      let worst = 0;
      for (let i = 0; i < COMBO_COUNT; i++) {
        worst = Math.max(worst, Math.abs(m[i] - range[i] / total));
        expect(m[i]).toBeCloseTo(range[i] / total, 12);
      }
      // Carries the shape's name into the failure message, and records that the
      // bound is float dust rather than slack: the worst shape here measures
      // 1.2e-13 against the 5e-13 that 12 digits allows.
      expect({ name, exact: worst < 5e-13 }).toEqual({ name, exact: true });
    }
  });

  it("gives a zero-weight combo exactly zero probability", () => {
    // The marginal is the whole story for blockers too: a removed card must not
    // merely be unlikely, it must be unreachable.
    const range = uniformRange();
    const blocked = [code("Ah"), code("Ks"), code("2d"), code("9c")];
    removeCards(range, blocked);
    const m = aliasMarginals(makeComboSampler(range));
    for (let i = 0; i < COMBO_COUNT; i++) {
      if (range[i] === 0) expect(m[i]).toBe(0);
      else expect(m[i]).toBeGreaterThan(0);
    }
  });

  it("draws from a uniform range in proportion (chi-square)", () => {
    // Kept as an end-to-end check that `drawCombo` reads the table the way
    // `makeComboSampler` writes it; the marginal test above is what pins the
    // construction itself.
    const range = uniformRange();
    const sampler = makeComboSampler(range);
    expect(sampler.total).toBe(COMBO_COUNT);

    const rng = makeRng(31337);
    const draws = 200_000;
    const counts = new Int32Array(COMBO_COUNT);
    for (let i = 0; i < draws; i++) counts[drawCombo(sampler, rng)]++;

    const df = COMBO_COUNT - 1;
    const chi2 = chiSquare(counts, range, draws);
    expect(Math.abs(chi2 - df)).toBeLessThan(5 * Math.sqrt(2 * df));
  });

  it("matches a skewed range", () => {
    // Weight rising linearly across the combos: nothing about the alias build
    // should care where the mass sits.
    const range = emptyRange();
    for (let i = 0; i < COMBO_COUNT; i++) range[i] = i % 17;
    const sampler = makeComboSampler(range);

    const rng = makeRng(4242);
    const draws = 300_000;
    const counts = new Int32Array(COMBO_COUNT);
    for (let i = 0; i < draws; i++) counts[drawCombo(sampler, rng)]++;

    const df = support(range) - 1;
    const chi2 = chiSquare(counts, range, draws);
    expect(Math.abs(chi2 - df)).toBeLessThan(5 * Math.sqrt(2 * df));
  });

  it("never returns a combo with zero weight, even on a tiny support", () => {
    const range = emptyRange();
    range[3] = 1;
    range[1000] = 0.0001;
    const sampler = makeComboSampler(range);
    const rng = makeRng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 100_000; i++) {
      const combo = drawCombo(sampler, rng);
      expect(range[combo]).toBeGreaterThan(0);
      seen.add(combo);
    }
    expect(seen.has(3)).toBe(true);
  });

  it("respects card removal", () => {
    const range = uniformRange();
    const blocked = [code("Ah"), code("Ks"), code("2d"), code("9c")];
    removeCards(range, blocked);
    const sampler = makeComboSampler(range);
    const rng = makeRng(5);
    for (let i = 0; i < 50_000; i++) {
      const [a, b] = comboCards(drawCombo(sampler, rng));
      expect(blocked).not.toContain(a);
      expect(blocked).not.toContain(b);
    }
  });

  it("refuses a range with no weight", () => {
    expect(() => makeComboSampler(emptyRange())).toThrow(/no weight/);
  });
});

describe("determinism", () => {
  it("replays the same draws from the same seed", () => {
    // The Monte Carlo is reproducible only if this is: a decision replayed from
    // the same seed must sample the same opponent hands in the same order.
    const range = uniformRange();
    removeCards(range, [code("Ah"), code("Ks")]);
    const sampler = makeComboSampler(range);

    const draw = (seed: number): number[] => {
      const rng = makeRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 5_000; i++) out.push(drawCombo(sampler, rng));
      return out;
    };
    const a = draw(777);
    const b = draw(777);
    expect(a).toEqual(b);
    // ...and a different seed must not replay it, or the seed does nothing.
    expect(draw(778)).not.toEqual(a);

    // sampleCombo walks the range instead of a table, and must agree with
    // itself the same way.
    const walk = (seed: number): number[] => {
      const rng = makeRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 2_000; i++) out.push(sampleCombo(range, rng));
      return out;
    };
    expect(walk(31)).toEqual(walk(31));
    expect(walk(32)).not.toEqual(walk(31));
  });

  it("builds the same table from the same range", () => {
    // Two samplers over equal ranges must be interchangeable, or a cached
    // sampler and a freshly built one would drift apart mid-run.
    const range = emptyRange();
    const rng = makeRng(2024);
    for (let i = 0; i < COMBO_COUNT; i++) range[i] = rng.next();
    const a = makeComboSampler(range);
    const b = makeComboSampler(cloneRange(range));
    expect([...a.prob]).toEqual([...b.prob]);
    expect([...a.alias]).toEqual([...b.alias]);
    expect(a.total).toBe(b.total);
  });
});
