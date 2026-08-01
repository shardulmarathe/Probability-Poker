import { describe, expect, it } from "vitest";
import {
  createOpponentModel,
  learnedLikelihood,
  normalize,
  recordShowdownHand,
  updateBelief,
} from "./bayesian";

describe("updateBelief", () => {
  // TECHNICAL_WRITEUP.md §6, "Complete numerical example (default likelihoods)".
  it("reproduces the documented worked example for a raise", () => {
    const posterior = updateBelief(
      { weak: 0.4, medium: 0.35, strong: 0.25 },
      "raise"
    );

    // Numerators 0.0200 / 0.0875 / 0.1750, evidence 0.2825.
    expect(posterior.weak).toBeCloseTo(0.0708, 4);
    expect(posterior.medium).toBeCloseTo(0.3097, 4);
    expect(posterior.strong).toBeCloseTo(0.6195, 4);
    expect(posterior.weak).toBeCloseTo(0.02 / 0.2825, 12);
    expect(posterior.medium).toBeCloseTo(0.0875 / 0.2825, 12);
    expect(posterior.strong).toBeCloseTo(0.175 / 0.2825, 12);
    expect(posterior.weak + posterior.medium + posterior.strong).toBeCloseTo(1, 12);
  });

  it("leaves the prior unchanged when the likelihood row is flat", () => {
    const prior = { weak: 0.4, medium: 0.35, strong: 0.25 };
    const flat = { weak: 0.5, medium: 0.5, strong: 0.5 };
    const posterior = updateBelief(prior, "raise", {
      check: flat, call: flat, bet: flat, raise: flat, fold: flat,
    });

    expect(posterior.weak).toBeCloseTo(0.4, 12);
    expect(posterior.medium).toBeCloseTo(0.35, 12);
    expect(posterior.strong).toBeCloseTo(0.25, 12);
  });

  it("does not mutate the prior it is given", () => {
    const prior = { weak: 0.4, medium: 0.35, strong: 0.25 };
    updateBelief(prior, "raise");
    expect(prior).toEqual({ weak: 0.4, medium: 0.35, strong: 0.25 });
  });
});

describe("normalize", () => {
  it("scales a distribution to sum to 1", () => {
    const n = normalize({ weak: 2, medium: 3, strong: 5 });
    expect(n).toEqual({ weak: 0.2, medium: 0.3, strong: 0.5 });
  });

  it("falls back to uniform when everything is zero", () => {
    expect(normalize({ weak: 0, medium: 0, strong: 0 })).toEqual({
      weak: 1 / 3,
      medium: 1 / 3,
      strong: 1 / 3,
    });
  });
});

describe("learnedLikelihood", () => {
  it("returns the 2/10 = 0.20 Beta prior with no observations", () => {
    const model = createOpponentModel();
    for (const tier of ["weak", "medium", "strong"] as const) {
      for (const action of ["check", "call", "bet", "raise", "fold"] as const) {
        expect(learnedLikelihood(model[tier], action)).toBe(0.2);
      }
    }
  });

  it("moves toward the observed frequency as showdowns accumulate", () => {
    const model = createOpponentModel();
    // One strong hand in which the player raised (and raised twice — actions are
    // de-duplicated to a per-hand indicator).
    recordShowdownHand(model, "strong", ["raise", "raise", "call"]);

    expect(model.strong.total).toBe(1);
    expect(model.strong.raises).toBe(1);
    expect(learnedLikelihood(model.strong, "raise")).toBeCloseTo(3 / 11, 12);
    expect(learnedLikelihood(model.strong, "call")).toBeCloseTo(3 / 11, 12);
    expect(learnedLikelihood(model.strong, "fold")).toBeCloseTo(2 / 11, 12);
    // Untouched tiers keep the flat prior.
    expect(learnedLikelihood(model.weak, "raise")).toBe(0.2);
  });
});
