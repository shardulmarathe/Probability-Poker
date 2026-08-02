import { describe, expect, it } from "vitest";

import { INITIAL_BELIEF } from "../../data/constants";
import { updateBelief } from "../bayesian";
import {
  createLikelihoodModel,
  mergeModels,
  modelFromJSON,
  modelStats,
  modelToJSON,
  nodeMix,
  observe,
  observeMany,
  recordHand,
} from "./learn";
import type { Observation } from "./learn";
import {
  BUCKETS_BY_TIER,
  BUCKET_COUNT,
  collapsedLikelihoods,
  likelihoodOf,
  priorRow,
} from "./likelihood";
import type { Bucket } from "./likelihood";

// ---------------------------------------------------------------------------
// Fixtures: a river spot where a raise is the most informative action there is.
// ---------------------------------------------------------------------------

const NODE = { street: "river", position: "BTN", facing: "facing-bet" } as const;

const raiseWith = (bucket: Bucket | null): Observation => ({
  action: "raise",
  bucket,
  ...NODE,
});

const foldWith = (bucket: Bucket | null): Observation => ({
  action: "fold",
  bucket,
  ...NODE,
});

/** P(raise | tier) at NODE, collapsed to the three tiers the engine speaks. */
const raiseByTier = (model: Parameters<typeof collapsedLikelihoods>[0]) =>
  collapsedLikelihoods(model, NODE.street, NODE.position, NODE.facing).raise;

/** Posterior over tiers after one observed raise, from the standard prior. */
const posteriorAfterRaise = (model: Parameters<typeof collapsedLikelihoods>[0]) =>
  updateBelief(
    INITIAL_BELIEF,
    "raise",
    collapsedLikelihoods(model, NODE.street, NODE.position, NODE.facing)
  );

describe("recording", () => {
  it("writes all six levels for a revealed hand", () => {
    const model = createLikelihoodModel();
    observe(model, raiseWith(5));
    expect(Object.keys(model.cells).sort()).toEqual([
      "*",
      "b:5",
      "bs:5:river",
      "bsf:5:river:facing-bet",
      "bsfp:5:river:facing-bet:BTN",
      "n:river:facing-bet",
    ]);
    expect(model.cells["*"].total).toBe(1);
    expect(model.cells["*"].actions.raise).toBe(1);
    expect(modelStats(model)).toEqual({
      observations: 1,
      attributed: 1,
      unattributed: 0,
      cells: 6,
    });
  });

  it("records a whole hand's decisions against one revealed bucket", () => {
    const model = createLikelihoodModel();
    recordHand(model, {
      bucket: 7,
      decisions: [
        { action: "call", street: "preflop", position: "BB", facing: "facing-bet" },
        { action: "check", street: "flop", position: "BB", facing: "unopened" },
        { action: "raise", street: "river", position: "BB", facing: "facing-bet" },
      ],
    });
    expect(model.observations).toBe(3);
    expect(model.unattributed).toBe(0);
    // Each decision lands in its own node cell — the whole point of conditioning.
    expect(model.cells["n:preflop:facing-bet"].actions.call).toBe(1);
    expect(model.cells["n:flop:unopened"].actions.check).toBe(1);
    expect(model.cells["n:river:facing-bet"].actions.raise).toBe(1);
    // ...and, unlike recordShowdownHand, repeated actions are not de-duplicated
    // away, because each is a genuine separate draw at a different node.
    expect(model.cells["*"].total).toBe(3);
  });

  it("rejects malformed observations rather than persisting them", () => {
    const model = createLikelihoodModel();
    expect(() => observe(model, { ...raiseWith(0), action: "shove" as never })).toThrow(
      /bad action/
    );
    expect(() => observe(model, { ...raiseWith(0), street: "showdown" as never })).toThrow(
      /bad street/
    );
    expect(() => observe(model, { ...raiseWith(0), facing: "limped" as never })).toThrow(
      /bad facing/
    );
    expect(() => observe(model, { ...raiseWith(0), position: "MP" as never })).toThrow(
      /bad position/
    );
    expect(() => observe(model, raiseWith(BUCKET_COUNT))).toThrow(/outside 0\.\./);
    expect(() => observe(model, raiseWith(-1))).toThrow(/outside 0\.\./);
    expect(() => observe(model, raiseWith(2.5))).toThrow(/outside 0\.\./);
    expect(model.observations).toBe(0);
  });
});

describe("learning from folds", () => {
  it("never invents a bucket for a hand it did not see", () => {
    const model = createLikelihoodModel();
    for (let i = 0; i < 25; i += 1) observe(model, foldWith(null));

    // Only the two bucket-free levels exist. Nothing bucket-conditioned was
    // touched, because the cards were mucked and there is nothing to condition on.
    expect(Object.keys(model.cells).sort()).toEqual(["*", "n:river:facing-bet"]);
    expect(modelStats(model)).toEqual({
      observations: 25,
      attributed: 0,
      unattributed: 25,
      cells: 2,
    });
  });

  it("still learns the fold rate at that node", () => {
    const model = createLikelihoodModel();
    for (let i = 0; i < 16; i += 1) observe(model, foldWith(null));
    for (let i = 0; i < 4; i += 1) observe(model, raiseWith(null));

    const mix = nodeMix(model, "river", "facing-bet");
    expect(mix.observations).toBe(20);
    expect(mix.frequencies.fold).toBe(0.8);
    expect(mix.frequencies.raise).toBe(0.2);
    // Untouched nodes report zero observations rather than a fabricated mix.
    expect(nodeMix(model, "flop", "unopened").observations).toBe(0);
    expect(nodeMix(model, "flop", "unopened").frequencies.fold).toBe(0);
  });

  it("moves every bucket together, compressing the likelihood ratio", () => {
    // 40 raises at this node, no showdown ever. The model cannot say *what* they
    // raise with, only that they raise constantly — so the raise must lose
    // information, not gain it.
    const model = createLikelihoodModel();
    for (let i = 0; i < 40; i += 1) observe(model, raiseWith(null));

    const before = raiseByTier(createLikelihoodModel());
    const after = raiseByTier(model);

    expect(before.weak).toBeCloseTo(0.0487, 4);
    expect(before.strong).toBeCloseTo(0.39926, 4);
    expect(after.weak).toBeCloseTo(0.3414, 4);
    expect(after.strong).toBeCloseTo(0.5841, 4);

    // Every tier's raise rate rose, and the strong/weak ratio collapsed from
    // 8.2 to 1.7 — a raise is now far weaker evidence than it was.
    expect(after.weak).toBeGreaterThan(before.weak);
    expect(after.medium).toBeGreaterThan(before.medium);
    expect(after.strong).toBeGreaterThan(before.strong);
    expect(before.strong / before.weak).toBeCloseTo(8.2, 1);
    expect(after.strong / after.weak).toBeCloseTo(1.71, 1);

    const posterior = posteriorAfterRaise(model);
    expect(posterior.strong).toBeLessThan(posteriorAfterRaise(createLikelihoodModel()).strong);
    expect(posterior.strong).toBeCloseTo(0.34564, 4);
  });
});

describe("learning is directional", () => {
  it("sharpens a raise when the player only ever raises strong hands", () => {
    // 30 hands: raises with buckets 6-7, folds with 0-2.
    const model = createLikelihoodModel();
    for (let i = 0; i < 30; i += 1) {
      observe(model, raiseWith(6 + (i % 2)));
      observe(model, foldWith(i % 3));
    }

    const before = raiseByTier(createLikelihoodModel());
    const after = raiseByTier(model);

    // P(raise | strong) rises, P(raise | weak) stays low.
    expect(after.strong).toBeGreaterThan(before.strong);
    expect(after.strong).toBeCloseTo(0.6625, 4);
    expect(after.weak).toBeCloseTo(0.1228, 4);
    expect(after.strong / after.weak).toBeGreaterThan(5);

    // The posterior after an observed raise shifts hard toward strong.
    const posterior = posteriorAfterRaise(model);
    expect(posterior.strong).toBeGreaterThan(INITIAL_BELIEF.strong);
    expect(posterior.weak).toBeLessThan(INITIAL_BELIEF.weak);
    expect(posterior.strong).toBeCloseTo(0.5297, 3);
    expect(posterior.weak).toBeCloseTo(0.1571, 4);
  });

  it("discounts a raise from a habitual bluffer", () => {
    // The same 30 raises, but the showdowns reveal buckets 0-2 every time.
    const model = createLikelihoodModel();
    for (let i = 0; i < 30; i += 1) observe(model, raiseWith(i % 3));

    const before = raiseByTier(createLikelihoodModel());
    const after = raiseByTier(model);

    // P(raise | weak) goes from 4.9% to 61% — a twelvefold rise — and now sits
    // level with P(raise | strong). The action has stopped meaning anything.
    expect(after.weak).toBeCloseTo(0.6108, 4);
    expect(after.strong).toBeCloseTo(0.54944, 4);
    expect(after.weak / before.weak).toBeGreaterThan(10);
    // The ratio is pinned rather than bounded, because where it lands is the
    // result: 8.20 before, 0.8995 after. It has not merely collapsed to 1, it
    // has crossed it — this player raises weak hands *more* often than strong
    // ones, which is what "habitual bluffer" means and is strictly stronger
    // evidence than indistinguishability. Two decades of the prior's
    // discrimination, undone by 30 showdowns.
    expect(after.strong / after.weak).toBeCloseTo(0.8995, 4);
    expect(before.strong / before.weak).toBeCloseTo(8.2, 1);
    expect(after.strong / after.weak).toBeLessThan((before.strong / before.weak) / 8);

    // Headline: a raise used to push "strong" from 25% to 59%. It now pushes it
    // *down*, and makes "weak" the most likely tier instead.
    const fresh = posteriorAfterRaise(createLikelihoodModel());
    const posterior = posteriorAfterRaise(model);
    expect(fresh.strong).toBeCloseTo(0.602, 4);
    expect(posterior.strong).toBeCloseTo(0.2725, 4);
    expect(posterior.weak).toBeCloseTo(0.4847, 4);
    expect(posterior.strong).toBeLessThan(INITIAL_BELIEF.strong + 0.05);
    expect(posterior.weak).toBeGreaterThan(posterior.strong);
  });

  it("keeps the two players distinguishable at the bucket level", () => {
    const honest = createLikelihoodModel();
    const bluffer = createLikelihoodModel();
    for (let i = 0; i < 30; i += 1) {
      observe(honest, raiseWith(BUCKETS_BY_TIER.strong[i % BUCKETS_BY_TIER.strong.length]));
      observe(bluffer, raiseWith(BUCKETS_BY_TIER.weak[i % BUCKETS_BY_TIER.weak.length]));
    }
    const weakRaise = (m: typeof honest) =>
      likelihoodOf(m, "raise", 0, NODE.street, NODE.position, NODE.facing);

    expect(weakRaise(bluffer)).toBeGreaterThan(0.6);
    expect(weakRaise(honest)).toBeLessThan(0.35);
    expect(weakRaise(bluffer)).toBeGreaterThan(weakRaise(honest) * 2);
  });

  it("needs data to depart from the prior, and departs monotonically", () => {
    const prior = priorRow("poker", 7, NODE.street, NODE.facing).raise;
    const model = createLikelihoodModel();
    const seen: number[] = [];
    for (let n = 1; n <= 50; n += 1) {
      observe(model, raiseWith(7));
      if ([1, 5, 10, 25, 50].includes(n)) {
        seen.push(likelihoodOf(model, "raise", 7, NODE.street, NODE.position, NODE.facing));
      }
    }
    expect(prior).toBeCloseTo(0.39136, 4);
    expect(seen[0]).toBeCloseTo(0.4467, 4); // 1 hand:  +0.06
    expect(seen[1]).toBeCloseTo(0.59424, 4); // 5 hands: +0.20
    expect(seen[2]).toBeCloseTo(0.6957, 4); // 10:      +0.30
    expect(seen[3]).toBeCloseTo(0.8261, 4); // 25:      +0.43
    expect(seen[4]).toBeCloseTo(0.89856, 4); // 50:      +0.51
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });
});

describe("serialisation", () => {
  const populated = () => {
    const model = createLikelihoodModel();
    observeMany(model, [
      raiseWith(7),
      foldWith(0),
      raiseWith(null),
      { action: "check", bucket: 3, street: "flop", position: "SB", facing: "unopened" },
    ]);
    return model;
  };

  it("round-trips through JSON exactly", () => {
    const model = populated();
    const text = JSON.stringify(modelToJSON(model));
    const restored = modelFromJSON(JSON.parse(text));

    expect(restored).toEqual(model);
    expect(JSON.stringify(modelToJSON(restored))).toBe(text);
    // And the round trip changes no answer the model gives.
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      expect(likelihoodOf(restored, "raise", b, "river", "BTN", "facing-bet")).toBe(
        likelihoodOf(model, "raise", b, "river", "BTN", "facing-bet")
      );
    }
  });

  it("emits stable key order so stored rows are diffable", () => {
    const a = createLikelihoodModel();
    const b = createLikelihoodModel();
    observe(a, raiseWith(7));
    observe(a, foldWith(0));
    observe(b, foldWith(0));
    observe(b, raiseWith(7));
    expect(JSON.stringify(modelToJSON(a))).toBe(JSON.stringify(modelToJSON(b)));
  });

  it("preserves the prior id, which selects the root of the backoff", () => {
    for (const prior of ["poker", "flat", "legacy"] as const) {
      const restored = modelFromJSON(modelToJSON(createLikelihoodModel(prior)));
      expect(restored.prior).toBe(prior);
    }
  });

  it("rejects corrupt payloads instead of silently degrading", () => {
    expect(() => modelFromJSON(null)).toThrow(/not an object/);
    expect(() => modelFromJSON({ version: 2 })).toThrow(/unsupported version/);
    expect(() => modelFromJSON({ version: 1, prior: "vibes" })).toThrow(/unknown prior/);
    expect(() => modelFromJSON({ version: 1, prior: "poker" })).toThrow(/cells missing/);
    expect(() =>
      modelFromJSON({
        version: 1,
        prior: "poker",
        cells: { "*": { total: -1, actions: {} } },
        observations: 0,
        unattributed: 0,
      })
    ).toThrow(/non-negative/);
    expect(() =>
      modelFromJSON({
        version: 1,
        prior: "poker",
        cells: { "*": { total: 1 } },
        observations: 1,
        unattributed: 0,
      })
    ).toThrow(/no actions/);
  });
});

describe("mergeModels", () => {
  const withData = (bucket: Bucket | null, n: number) => {
    const model = createLikelihoodModel();
    for (let i = 0; i < n; i += 1) observe(model, raiseWith(bucket));
    return model;
  };

  it("adds counts", () => {
    const merged = mergeModels(withData(7, 3), withData(7, 4));
    expect(merged.cells["*"].total).toBe(7);
    expect(merged.cells["*"].actions.raise).toBe(7);
    expect(modelStats(merged)).toEqual({
      observations: 7,
      attributed: 7,
      unattributed: 0,
      cells: 6,
    });
    // Merging two sessions is the same as having played them as one.
    const single = withData(7, 7);
    expect(modelToJSON(merged)).toEqual(modelToJSON(single));
  });

  it("is commutative and associative on counts", () => {
    const a = withData(7, 3);
    const b = withData(2, 5);
    const c = withData(null, 4);

    expect(JSON.stringify(modelToJSON(mergeModels(a, b)))).toBe(
      JSON.stringify(modelToJSON(mergeModels(b, a)))
    );
    expect(JSON.stringify(modelToJSON(mergeModels(mergeModels(a, b), c)))).toBe(
      JSON.stringify(modelToJSON(mergeModels(a, mergeModels(b, c))))
    );
  });

  it("leaves the inputs untouched and keeps the empty model an identity", () => {
    const a = withData(7, 3);
    const snapshot = JSON.stringify(modelToJSON(a));
    const merged = mergeModels(a, createLikelihoodModel());

    expect(JSON.stringify(modelToJSON(a))).toBe(snapshot);
    expect(modelToJSON(merged)).toEqual(modelToJSON(a));
    merged.cells["*"].total = 999;
    expect(a.cells["*"].total).toBe(3);
  });

  it("refuses to add counts across different priors", () => {
    expect(() =>
      mergeModels(createLikelihoodModel("poker"), createLikelihoodModel("flat"))
    ).toThrow(/prior mismatch/);
  });

  it("tracks unattributed decisions separately through a merge", () => {
    const merged = mergeModels(withData(7, 3), withData(null, 4));
    expect(modelStats(merged)).toEqual({
      observations: 7,
      attributed: 3,
      unattributed: 4,
      cells: 6,
    });
  });
});
