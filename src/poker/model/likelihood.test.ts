import { describe, expect, it } from "vitest";

import {
  ACTION_LIKELIHOODS,
  INITIAL_BELIEF,
  LEARNING_PRIOR_ALPHA,
  LEARNING_PRIOR_DENOM,
} from "../../data/constants";
import { updateBelief } from "../bayesian";
import { makeRng } from "../core/rng";
import { classifyAll, makeBoardContext } from "./buckets";
import { COMBO_COUNT } from "./range";
import { observe } from "./learn";
import {
  ACTIONS,
  BUCKETS_BY_TIER,
  BUCKET_COUNT,
  FACINGS,
  FLAT_PRIOR_MEAN,
  LEVEL_NAMES,
  POOLED_STRENGTH,
  POSITIONS,
  PRIOR_STRENGTH,
  STREETS,
  betaMean,
  collapseToTiers,
  collapsedLikelihoods,
  contextKeys,
  createLikelihoodModel,
  explainLikelihood,
  likelihoodOf,
  likelihoodRow,
  priorRow,
  tierFromBucket,
} from "./likelihood";
import type { Bucket, Facing, LearnStreet } from "./likelihood";
import type { HandBucket } from "./buckets";
import type { PositionName } from "../table/position";

const sumRow = (row: Record<string, number>): number =>
  ACTIONS.reduce((acc, a) => acc + row[a], 0);

describe("axes", () => {
  it("enumerates every value of every conditioning axis", () => {
    expect(STREETS).toEqual(["preflop", "flop", "turn", "river"]);
    expect(FACINGS).toEqual(["unopened", "facing-bet", "facing-raise"]);
    expect(ACTIONS.slice().sort()).toEqual(["bet", "call", "check", "fold", "raise"]);
    expect(POSITIONS).toHaveLength(6);
    expect(LEVEL_NAMES).toHaveLength(6);
  });

  it("partitions buckets into the three legacy tiers", () => {
    const all = [
      ...BUCKETS_BY_TIER.weak,
      ...BUCKETS_BY_TIER.medium,
      ...BUCKETS_BY_TIER.strong,
    ];
    expect(all).toHaveLength(BUCKET_COUNT);
    expect(new Set(all).size).toBe(BUCKET_COUNT);
    expect(tierFromBucket(0)).toBe("weak");
    expect(tierFromBucket((BUCKET_COUNT - 1) as HandBucket)).toBe("strong");
    // The split is buckets.ts's, not a second opinion about it: Overpair and up
    // is value, WeakPair..TopPair is marginal, Air..StrongDraw has no showdown
    // value yet. Nine classes, imported, this module never re-declares them,
    // because a persisted cell key built from a bucket id only means anything
    // if there is exactly one taxonomy in the codebase.
    expect(BUCKET_COUNT).toBe(9);
    expect(BUCKETS_BY_TIER).toEqual({
      weak: [0, 1, 2],
      medium: [3, 4, 5],
      strong: [6, 7, 8],
    });
  });
});

describe("default prior", () => {
  it("is a proper distribution over actions in every cell", () => {
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      for (const street of STREETS) {
        for (const facing of FACINGS) {
          const row = priorRow("poker", b, street, facing);
          expect(sumRow(row)).toBeCloseTo(1, 12);
          // No action is ever impossible: one observation can never carry an
          // unbounded Bayes factor.
          for (const a of ACTIONS) expect(row[a]).toBeGreaterThan(0.015);
        }
      }
    }
  });

  it("makes raising monotonically more likely from stronger buckets", () => {
    for (const street of STREETS) {
      for (let b = 1; b < BUCKET_COUNT; b += 1) {
        expect(priorRow("poker", b, street, "facing-bet").raise).toBeGreaterThan(
          priorRow("poker", b - 1, street, "facing-bet").raise
        );
      }
    }
  });

  it("makes checking monotonically more likely from weaker buckets", () => {
    for (const street of STREETS) {
      for (let b = 1; b < BUCKET_COUNT; b += 1) {
        expect(priorRow("poker", b, street, "unopened").check).toBeLessThan(
          priorRow("poker", b - 1, street, "unopened").check
        );
      }
    }
  });

  it("sharpens the tell from preflop to the river", () => {
    const ratio = (street: LearnStreet): number =>
      priorRow("poker", BUCKET_COUNT - 1, street, "facing-bet").raise /
      priorRow("poker", 0, street, "facing-bet").raise;

    // Preflop is range-vs-range and half-mechanical; by the river the hand is
    // complete and behaviour is at its most strength-correlated.
    expect(ratio("preflop")).toBeCloseTo(3.65, 1);
    expect(ratio("river")).toBeCloseTo(15.53, 1);
    expect(ratio("preflop")).toBeLessThan(ratio("flop"));
    expect(ratio("flop")).toBeLessThan(ratio("turn"));
    expect(ratio("turn")).toBeLessThan(ratio("river"));
  });

  it("distinguishes the betting context", () => {
    // A raise facing a raise is a three-bet: folding is likelier at that node
    // from every bucket.
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      expect(priorRow("poker", b, "river", "facing-raise").fold).toBeGreaterThan(
        priorRow("poker", b, "river", "facing-bet").fold
      );
    }
    expect(priorRow("poker", BUCKET_COUNT - 1, "river", "unopened").bet).toBeGreaterThan(
      0.5
    );
  });

  it("pins the river rows with concrete numbers", () => {
    // Bucket 0 and bucket BUCKET_COUNT-1 sit at tilt -1 and +1 whatever the
    // ladder's length, so the ends of the river row are the same numbers a
    // shorter ladder produced. Bucket 7 is an interior rung now (tilt 0.75
    // rather than 1.0) and is pinned separately, because it is exactly the
    // sort of value that would drift unnoticed if it were not.
    expect(priorRow("poker", 0, "river", "facing-bet").raise).toBeCloseTo(0.0346, 4);
    expect(priorRow("poker", 7, "river", "facing-bet").raise).toBeCloseTo(0.39136, 4);
    expect(priorRow("poker", 8, "river", "facing-bet").raise).toBeCloseTo(0.5376, 4);
    expect(priorRow("poker", 0, "river", "unopened").check).toBeCloseTo(0.8645, 4);
    expect(priorRow("poker", 7, "river", "unopened").check).toBeCloseTo(0.1658, 4);
    expect(priorRow("poker", 8, "river", "unopened").check).toBeCloseTo(0.1031, 4);
  });

  // -------------------------------------------------------------------------
  // Minimum defence frequency
  // -------------------------------------------------------------------------
  //
  // The bound the prior's fold LEVEL is set by, asserted directly rather than
  // pinned as a decimal, so it goes on holding if the shape constants move.
  //
  // Against a bet of `s` into a pot of `P`, a bluff risking `s` to win `P` is
  // free money if it gets through more than `alpha = s / (P + s)` of the time,
  // so no unexploitable opponent folds more than alpha: half pot 1/3, three
  // quarters 3/7, pot 1/2. The shipped prior used to fold 46.4% of a range to a
  // half-pot bet, 13 points past the bound, and every bet in the game is
  // priced against it, which is why the bots bet nearly everything.

  /** Renormalised over the moves that are legal facing a bet, as decider does. */
  const foldGivenLegal = (b: Bucket, street: LearnStreet, facing: Facing): number => {
    const row = priorRow("poker", b, street, facing);
    return row.fold / (row.fold + row.call + row.raise);
  };

  /**
   * The fold rate against a real range, not a flat average over the nine
   * buckets. A random range is air-heavy and air is what folds, so the two
   * differ by 6-12 points and it is this one that prices a bet.
   */
  function rangeFoldRate(
    street: LearnStreet,
    facing: Facing,
    fraction: number
  ): number {
    // Mirrors decider.foldAtSize, whose log-odds shift is what makes one anchor
    // hold every size: odds(s) = odds(REFERENCE) x s / REFERENCE.
    const REFERENCE = 0.5;
    const sized = Array.from({ length: BUCKET_COUNT }, (_, b) => {
      const p = foldGivenLegal(b, street, facing);
      const odds = (p / (1 - p)) * (Math.min(fraction, 1) / REFERENCE);
      return odds / (1 + odds);
    });

    const boards = BOARD_CARDS_AT[street];
    const rng = makeRng(0x1d5);
    let acc = 0;
    const TRIALS = 40;
    for (let t = 0; t < TRIALS; t += 1) {
      const deck = rng.shuffle(Array.from({ length: 52 }, (_, i) => i));
      const buckets = classifyAll(makeBoardContext(deck.slice(0, boards)));
      let sum = 0;
      for (let c = 0; c < COMBO_COUNT; c += 1) sum += sized[buckets[c]];
      acc += sum / COMBO_COUNT;
    }
    return acc / TRIALS;
  }

  const BOARD_CARDS_AT: Record<LearnStreet, number> = {
    preflop: 0,
    flop: 3,
    turn: 4,
    river: 5,
  };

  /** The identity the whole cap rests on. */
  const alpha = (fraction: number): number => fraction / (1 + fraction);

  it("never folds more than alpha, at any size, street or node", () => {
    expect(alpha(0.5)).toBeCloseTo(1 / 3, 12);
    expect(alpha(0.75)).toBeCloseTo(3 / 7, 12);
    expect(alpha(1)).toBe(0.5);

    for (const street of STREETS) {
      for (const facing of ["facing-bet", "facing-raise"] as Facing[]) {
        for (const fraction of [0.5, 0.75, 1]) {
          const folded = rangeFoldRate(street, facing, fraction);
          expect(
            folded,
            `${street}/${facing} at ${fraction} pot: folds ${(100 * folded).toFixed(
              1
            )}% vs alpha ${(100 * alpha(fraction)).toFixed(1)}%`
          ).toBeLessThanOrEqual(alpha(fraction));
        }
      }
    }
  });

  it("stays close to the bound rather than collapsing under it", () => {
    // A prior that folded nothing would satisfy MDF trivially and be useless:
    // it would price every bluff at zero fold equity. The binding cell, the
    // flop facing a raise, whose bucket mix is the most air-heavy, sits within
    // a point of alpha, which is what makes this a cap rather than a rewrite.
    const binding = rangeFoldRate("flop", "facing-raise", 0.5);
    expect(binding).toBeGreaterThan(0.3);
    expect(binding).toBeLessThanOrEqual(1 / 3);
  });

  it("leaves everything except the fold/call split exactly where it was", () => {
    // The cap moves weight from fold to call after the row is normalised, so
    // the aggressive and give-up weights it does not touch are bit-identical to
    // the uncapped prior. That is the property that makes it the minimum edit -
    // and it is why the raise pins above did not move when the level did.
    for (const street of STREETS) {
      for (const facing of FACINGS) {
        for (let b = 0; b < BUCKET_COUNT; b += 1) {
          const row = priorRow("poker", b, street, facing);
          // Row still sums to one: the surplus went somewhere legal.
          expect(sumRow(row)).toBeCloseTo(1, 12);
          // Folding never became more likely than calling's own floor allows.
          expect(row.fold).toBeGreaterThan(0.015);
        }
      }
    }
    // The uncapped node is untouched: nothing has been bet, so nothing to defend.
    expect(priorRow("poker", 0, "river", "unopened").fold).toBeCloseTo(0.03143, 4);
  });

  it("still folds more facing a raise than facing a bet, from every bucket", () => {
    // Both nodes are scaled by the same factor precisely so the cap cannot
    // reorder them; two separately-solved factors inverted this at the air
    // bucket, which is why there is one constant and not two.
    for (const street of STREETS) {
      for (let b = 0; b < BUCKET_COUNT; b += 1) {
        expect(
          foldGivenLegal(b, street, "facing-raise"),
          `${street} bucket ${b}`
        ).toBeGreaterThan(foldGivenLegal(b, street, "facing-bet"));
      }
    }
  });

  it("has a flat variant equal to the writeup's alpha/delta", () => {
    expect(FLAT_PRIOR_MEAN).toBe(LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM);
    for (const a of ACTIONS) {
      expect(priorRow("flat", 3, "turn", "facing-bet")[a]).toBe(0.2);
    }
    // Five actions at 0.20 is a symmetric Dirichlet whose pseudo-counts sum to
    // LEARNING_PRIOR_DENOM exactly, the shipped constants already are one.
    expect(sumRow(priorRow("flat", 3, "turn", "facing-bet"))).toBe(1);
  });

  it("has a legacy variant that reproduces ACTION_LIKELIHOODS by tier", () => {
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      const tier = tierFromBucket(b as HandBucket);
      for (const a of ACTIONS) {
        expect(priorRow("legacy", b, "flop", "facing-bet")[a]).toBe(
          ACTION_LIKELIHOODS[a][tier]
        );
      }
    }
  });
});

describe("Beta smoothing (TECHNICAL_WRITEUP.md 7)", () => {
  it("is literally learnedLikelihood when the prior mean is alpha/delta", () => {
    for (const [k, n] of [
      [0, 0],
      [1, 1],
      [3, 7],
      [15, 15],
      [40, 250],
    ]) {
      expect(betaMean(k, n, FLAT_PRIOR_MEAN)).toBe(
        (k + LEARNING_PRIOR_ALPHA) / (n + LEARNING_PRIOR_DENOM)
      );
    }
  });

  it("returns exactly the prior mean with no data", () => {
    expect(betaMean(0, 0, FLAT_PRIOR_MEAN)).toBe(0.2);
    expect(betaMean(0, 0, 0.7312)).toBe(0.7312);
    expect(betaMean(0, 0, 0.7312, POOLED_STRENGTH)).toBe(0.7312);
  });

  it("converges to the empirical frequency as n grows", () => {
    const gaps = [10, 100, 1_000, 10_000, 100_000].map((n) =>
      Math.abs(betaMean(0.75 * n, n, FLAT_PRIOR_MEAN) - 0.75)
    );
    // (k + 2)/(n + 10) - 0.75 = -5.5/(n + 10): the prior's pull decays like 1/n.
    expect(gaps[0]).toBeCloseTo(5.5 / 20, 12);
    expect(gaps[1]).toBeCloseTo(5.5 / 110, 12);
    expect(gaps[4]).toBeLessThan(1e-4);
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]).toBeLessThan(gaps[i - 1]);
    }
    expect(betaMean(0.75e9, 1e9, FLAT_PRIOR_MEAN)).toBeCloseTo(0.75, 7);
  });

  it("gives a fresh flat-prior model exactly alpha/delta everywhere", () => {
    const model = createLikelihoodModel("flat");
    for (const a of ACTIONS) {
      expect(likelihoodOf(model, a, 4, "turn", "CO", "facing-bet")).toBe(0.2);
    }
  });
});

describe("collapsing to three tiers (TECHNICAL_WRITEUP.md 6)", () => {
  it("reproduces ACTION_LIKELIHOODS when the conditioning is collapsed", () => {
    const model = createLikelihoodModel("legacy");
    for (const a of ACTIONS) {
      const row = collapseToTiers(model, a, "flop", "BTN", "facing-bet");
      expect(row.weak).toBeCloseTo(ACTION_LIKELIHOODS[a].weak, 12);
      expect(row.medium).toBeCloseTo(ACTION_LIKELIHOODS[a].medium, 12);
      expect(row.strong).toBeCloseTo(ACTION_LIKELIHOODS[a].strong, 12);
    }
  });

  it("reproduces the worked numerical example exactly", () => {
    const model = createLikelihoodModel("legacy");
    const table = collapsedLikelihoods(model, "flop", "BTN", "facing-bet");

    expect(table.raise.weak).toBeCloseTo(0.05, 12);
    expect(table.raise.medium).toBeCloseTo(0.25, 12);
    expect(table.raise.strong).toBeCloseTo(0.7, 12);

    // Prior (0.40, 0.35, 0.25), action "raise", evidence 0.2825.
    const posterior = updateBelief(INITIAL_BELIEF, "raise", table);
    expect(posterior.weak).toBeCloseTo(0.0708, 4);
    expect(posterior.medium).toBeCloseTo(0.3097, 4);
    expect(posterior.strong).toBeCloseTo(0.6195, 4);

    // ...and is indistinguishable from running the old fixed table directly,
    // which is the sense in which this generalises rather than replaces it.
    const legacy = updateBelief(INITIAL_BELIEF, "raise", ACTION_LIKELIHOODS);
    expect(posterior.weak).toBeCloseTo(legacy.weak, 12);
    expect(posterior.medium).toBeCloseTo(legacy.medium, 12);
    expect(posterior.strong).toBeCloseTo(legacy.strong, 12);
  });

  it("is shaped as a drop-in for learnedActionLikelihoods", () => {
    const table = collapsedLikelihoods(
      createLikelihoodModel(),
      "river",
      "BTN",
      "facing-bet"
    );
    expect(Object.keys(table).sort()).toEqual(ACTIONS.slice().sort());
    for (const a of ACTIONS) {
      expect(table[a].weak).toBeGreaterThan(0);
      expect(table[a].strong).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------

const at = (
  bucket: Bucket,
  street: LearnStreet = "turn",
  position: PositionName = "SB",
  facing: Facing = "facing-bet"
) => ({ bucket, street, position, facing });

function raiseNTimes(n: number) {
  const model = createLikelihoodModel();
  for (let i = 0; i < n; i += 1) observe(model, { action: "raise", ...at(5) });
  return model;
}

const raiseAt = (n: number) =>
  likelihoodOf(raiseNTimes(n), "raise", 5, "turn", "SB", "facing-bet");

describe("backoff", () => {
  it("counts every observation exactly once across the six levels", () => {
    const model = createLikelihoodModel();
    observe(model, { action: "raise", ...at(5, "turn", "SB", "facing-bet") });
    observe(model, { action: "fold", ...at(5, "turn", "CO", "facing-bet") });
    observe(model, { action: "call", ...at(5, "river", "SB", "facing-bet") });
    observe(model, { action: "bet", ...at(1, "turn", "SB", "unopened") });
    observe(model, { action: "check", ...at(7, "turn", "SB", "facing-bet") });
    observe(model, {
      action: "fold",
      bucket: null,
      street: "turn",
      position: "SB",
      facing: "facing-bet",
    });

    // The inclusion-exclusion columns sum to (1,0,0,0,0,0), so the exclusive
    // totals partition the global total whichever context is queried.
    for (const query of [at(5), at(7), at(0, "preflop", "BB", "unopened")]) {
      const steps = explainLikelihood(model, "raise", query).steps;
      expect(steps.reduce((acc, s) => acc + s.observations, 0)).toBe(model.observations);
      for (const step of steps) expect(step.observations).toBeGreaterThanOrEqual(0);
    }
  });

  it("writes one cell per level for an attributed observation", () => {
    const model = createLikelihoodModel();
    const where = at(5, "turn", "SB", "facing-bet");
    observe(model, { action: "raise", ...where });
    expect(Object.keys(model.cells).sort()).toEqual(contextKeys(where).slice().sort());
    expect(contextKeys(where)).toEqual([
      "*",
      "n:turn:facing-bet",
      "b:5",
      "bs:5:turn",
      "bsf:5:turn:facing-bet",
      "bsfp:5:turn:facing-bet:SB",
    ]);
  });

  it("makes an empty cell inherit its parent, not the prior", () => {
    // All 40 observations sit at (bucket 5, turn, facing-bet, SB). The CO cell
    // has never been touched.
    const model = raiseNTimes(40);
    const prior = priorRow("poker", 5, "turn", "facing-bet").raise;
    const unseen = likelihoodOf(model, "raise", 5, "turn", "CO", "facing-bet");

    expect(prior).toBeCloseTo(0.17, 4);
    expect(unseen).toBeCloseTo(0.834, 4);
    // Exactly the parent (bucket+street+facing) estimate: (40 + delta*prior)/50.
    expect(unseen).toBeCloseTo(
      (40 + PRIOR_STRENGTH * prior) / (40 + PRIOR_STRENGTH),
      12
    );
    // Emphatically not the flat prior, and not the poker prior either.
    expect(Math.abs(unseen - FLAT_PRIOR_MEAN)).toBeGreaterThan(0.6);
    expect(Math.abs(unseen - prior)).toBeGreaterThan(0.6);

    const steps = explainLikelihood(model, "raise", at(5, "turn", "CO")).steps;
    const full = steps[steps.length - 1];
    const parent = steps[steps.length - 2];
    expect(full.observations).toBe(0);
    expect(parent.observations).toBe(40);
    expect(full.estimate).toBe(parent.estimate); // exact identity, not a fallback
  });

  it("lets a cell with its own data override its parent", () => {
    // Same node, opposite behaviour from two positions.
    const model = createLikelihoodModel();
    for (let i = 0; i < 40; i += 1) {
      observe(model, { action: "raise", ...at(5, "turn", "SB", "facing-bet") });
      observe(model, { action: "fold", ...at(5, "turn", "CO", "facing-bet") });
    }
    const sb = likelihoodOf(model, "raise", 5, "turn", "SB", "facing-bet");
    const co = likelihoodOf(model, "raise", 5, "turn", "CO", "facing-bet");
    const unseen = likelihoodOf(model, "raise", 5, "turn", "BTN", "facing-bet");

    expect(sb).toBeCloseTo(0.8068, 4);
    expect(co).toBeCloseTo(0.1668, 4);
    // A position never seen sits at the pooled parent, between the two.
    expect(unseen).toBeGreaterThan(co);
    expect(unseen).toBeLessThan(sb);
  });

  it("tracks the single-cell posterior mean exactly at every data volume", () => {
    const prior = priorRow("poker", 5, "turn", "facing-bet").raise;
    for (const n of [0, 1, 2, 5, 10, 30, 100, 500]) {
      // With every observation at one context only one level holds exclusive
      // evidence, so the six-level chain collapses to a single Beta update.
      // This is the assertion that the hierarchy never double counts.
      expect(raiseAt(n)).toBeCloseTo(
        (n + PRIOR_STRENGTH * prior) / (n + PRIOR_STRENGTH),
        12
      );
    }

    expect(raiseAt(0)).toBeCloseTo(0.17, 4);
    expect(raiseAt(1)).toBeCloseTo(0.2455, 4);
    expect(raiseAt(10)).toBeCloseTo(0.585, 4);
    expect(raiseAt(100)).toBeCloseTo(0.92455, 4);
    // 500 observations: the parent is worth 2% of the answer.
    expect(raiseAt(500)).toBeGreaterThan(0.98);
  });

  it("weights pooled evidence at 1/BUCKET_COUNT of attributed evidence", () => {
    expect(POOLED_STRENGTH).toBe(PRIOR_STRENGTH * BUCKET_COUNT);

    const pooled = createLikelihoodModel();
    for (let i = 0; i < 40; i += 1) {
      observe(pooled, {
        action: "raise",
        bucket: null,
        street: "turn",
        position: "SB",
        facing: "facing-bet",
      });
    }
    const prior = priorRow("poker", 5, "turn", "facing-bet").raise;
    const pooledP = likelihoodOf(pooled, "raise", 5, "turn", "SB", "facing-bet");

    expect(pooledP).toBeCloseTo(
      (40 + POOLED_STRENGTH * prior) / (40 + POOLED_STRENGTH),
      12
    );
    // Both move off the prior; the pooled evidence moves it much less.
    expect(pooledP).toBeGreaterThan(prior);
    expect(pooledP).toBeLessThan(raiseAt(40));
    // 40 pooled decisions move it to 0.425; 40 attributed ones reach 0.834.
    expect(pooledP).toBeCloseTo(0.4254, 4);
    expect(raiseAt(40)).toBeCloseTo(0.834, 4);
  });

  it("keeps every row a distribution after learning", () => {
    const model = createLikelihoodModel();
    for (let i = 0; i < 60; i += 1) {
      observe(model, { action: i % 2 ? "raise" : "fold", ...at(i % BUCKET_COUNT) });
      observe(model, {
        action: "call",
        bucket: null,
        street: "river",
        position: "BB",
        facing: "facing-raise",
      });
    }
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      for (const street of STREETS) {
        for (const facing of FACINGS) {
          const row = likelihoodRow(model, { bucket: b, street, position: "BB", facing });
          expect(sumRow(row)).toBeCloseTo(1, 10);
          for (const a of ACTIONS) {
            expect(row[a]).toBeGreaterThan(0);
            expect(row[a]).toBeLessThan(1);
          }
        }
      }
    }
  });

  it("clamps a corrupt bucket instead of producing a broken probability", () => {
    const model = raiseNTimes(10);
    for (const bogus of [-5, 99, Number.NaN]) {
      const p = likelihoodOf(model, "raise", bogus, "turn", "SB", "facing-bet");
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe("explainLikelihood", () => {
  it("agrees with likelihoodOf and shows where the number came from", () => {
    const model = createLikelihoodModel();
    for (let i = 0; i < 25; i += 1) {
      observe(model, { action: "raise", ...at(6, "river", "BTN", "facing-bet") });
      observe(model, { action: "fold", ...at(1, "river", "BTN", "facing-bet") });
    }
    const explained = explainLikelihood(model, "raise", at(6, "river", "BTN", "facing-bet"));

    expect(explained.value).toBe(
      likelihoodOf(model, "raise", 6, "river", "BTN", "facing-bet")
    );
    expect(explained.prior).toBe(priorRow("poker", 6, "river", "facing-bet").raise);
    expect(explained.steps.map((s) => s.level)).toEqual([...LEVEL_NAMES]);
    // 25 of the 50 decisions at this node came from another bucket, so they are
    // charged to the node level rather than counted again further down.
    expect(explained.steps[1].observations).toBe(25);
    expect(explained.steps[5].observations).toBe(25);
    expect(explained.steps[5].matching).toBe(25);
  });
});
