/**
 * Conditioned action likelihoods. P(action | bucket, street, position, facing).
 *
 * `data/constants.ts` ships a flat 3x5 table: one P(action | tier) row that is
 * the same preflop and on the river, in the big blind and on the button,
 * unopened and facing a three-bet. That is not a tell, it is an average. The
 * identical raise means completely different things in those spots, and a model
 * that cannot say so cannot tell a player anything they did not already know.
 *
 * This module conditions on all four axes and then solves the problem that
 * conditioning creates. 9 buckets x 4 streets x 6 positions x 3 facings = 648
 * cells; a 200-hand session produces a few hundred decisions. Most cells are
 * empty forever, so the backoff scheme below is the whole design, see
 * "The backoff" further down.
 *
 * Nothing here mutates. `learn.ts` owns accumulation, serialisation and merging;
 * this file owns the prior, the smoothing and the lookup.
 */

import {
  ACTION_LIKELIHOODS,
  LEARNING_PRIOR_ALPHA,
  LEARNING_PRIOR_DENOM,
} from "../../data/constants";
import type {
  BeliefDistribution,
  PlayerActionType,
  StrengthTier,
  Street,
} from "../../types";
import type { PositionName } from "../table/position";
import { BUCKET_COUNT, tierFromBucket, type HandBucket } from "./buckets";

// ---------------------------------------------------------------------------
// The conditioning axes
// ---------------------------------------------------------------------------

/**
 * The hand-class taxonomy, re-exported from its single owner.
 *
 * `model/buckets.ts` is the authority: it defines `HandBucket`
 * (Air 0 · WeakDraw 1 · StrongDraw 2 · WeakPair 3 · MidPair 4 · TopPair 5 ·
 * Overpair 6 · TwoPair 7 · Monster 8), the classifier that produces those ids,
 * and the collapse onto the three legacy tiers. This module conditions on them
 * and must never re-declare them.
 *
 * That is not tidiness. Cell keys are built from bucket ids (`contextKeys`) and
 * the model is serialised to a database. A model written under one taxonomy and
 * read back under another would not error, every stored cell would simply be
 * reinterpreted as a different set of hand classes, silently and permanently.
 * One definition, imported, is the only version of this that is safe.
 *
 * Everything numeric here is parameterised on `BUCKET_COUNT`: the prior
 * generator's strength tilt, the tier split, and `POOLED_STRENGTH`.
 */
export { BUCKET_COUNT, tierFromBucket };

/** A board-relative hand class id in `0..BUCKET_COUNT-1`, 0 = weakest. */
export type Bucket = number;

/** Betting rounds a decision can happen on. "showdown" is not a decision point. */
export type LearnStreet = Exclude<Street, "showdown">;

/**
 * What the actor is looking at when they decide.
 *
 * This is the axis the flat table is most obviously missing. "Raise" unopened is
 * a bet; "raise" facing a bet is a raise; "raise" facing a raise is a three-bet,
 * and the three carry wildly different strength implications. Folding is only
 * even legal in the last two, so pooling them corrupts the fold rate as well.
 */
export type Facing = "unopened" | "facing-bet" | "facing-raise";

/**
 * Value lists for every axis.
 *
 * Built from an exhaustive `Record<Union, true>` rather than written as a bare
 * array so the compiler fails if a union ever gains a member, a silently short
 * list here would produce a model that ignores a whole street.
 */
const STREET_KEYS: Record<LearnStreet, true> = {
  preflop: true,
  flop: true,
  turn: true,
  river: true,
};
export const STREETS = Object.keys(STREET_KEYS) as LearnStreet[];

const FACING_KEYS: Record<Facing, true> = {
  unopened: true,
  "facing-bet": true,
  "facing-raise": true,
};
export const FACINGS = Object.keys(FACING_KEYS) as Facing[];

const ACTION_KEYS: Record<PlayerActionType, true> = {
  check: true,
  bet: true,
  call: true,
  raise: true,
  fold: true,
};
export const ACTIONS = Object.keys(ACTION_KEYS) as PlayerActionType[];

/**
 * `poker/table/position` exports `PositionName` as a type only, so the value
 * list is mirrored here (exhaustively, same trick as above).
 */
const POSITION_KEYS: Record<PositionName, true> = {
  BTN: true,
  SB: true,
  BB: true,
  UTG: true,
  HJ: true,
  CO: true,
};
export const POSITIONS = Object.keys(POSITION_KEYS) as PositionName[];

/** One number per action. Used for both probability rows and tallies. */
export type ActionWeights = Record<PlayerActionType, number>;

export interface LikelihoodContext {
  bucket: Bucket;
  street: LearnStreet;
  position: PositionName;
  facing: Facing;
}

/** Context with the hand class removed, what a fold leaves you with. */
export type UnattributedContext = Omit<LikelihoodContext, "bucket">;

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** Tallies for one cell: decisions seen, and how they split across actions. */
export interface CellCounts {
  total: number;
  actions: ActionWeights;
}

/**
 * Which data-free table sits at the root of the backoff.
 *
 * - `poker`, the generated prior below. The default for a real player.
 * - `flat`, every action at exactly `LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM`
 *              = 0.20. This is the writeup's "no data" value made explicit, and
 *              it is what makes the Beta claim in TECHNICAL_WRITEUP.md §7 still
 *              literally true of this module.
 * - `legacy`, the flat 3x5 `ACTION_LIKELIHOODS` broadcast over buckets. Kept so
 *              the old model is demonstrably a special case of this one rather
 *              than something that was thrown away.
 */
export type PriorId = "poker" | "flat" | "legacy";

/**
 * A plain, JSON-shaped bag of counts. Deliberately not a class: it goes to a
 * database, comes back, and gets merged across sessions (see `learn.ts`).
 *
 * `cells` is sparse and keyed by the level keys built below, so an untouched
 * cell costs nothing. Every observation writes to several keys at once (one per
 * backoff level), which is what makes lookup O(levels) instead of a scan.
 */
export interface LikelihoodModel {
  version: 1;
  prior: PriorId;
  cells: Record<string, CellCounts>;
  /** Decisions recorded in total, attributed or not. */
  observations: number;
  /** Of those, decisions whose hand was never revealed (folds). */
  unattributed: number;
}

export function emptyCell(): CellCounts {
  return {
    total: 0,
    actions: { check: 0, bet: 0, call: 0, raise: 0, fold: 0 },
  };
}

const EMPTY_CELL: CellCounts = emptyCell();

export function createLikelihoodModel(prior: PriorId = "poker"): LikelihoodModel {
  return { version: 1, prior, cells: {}, observations: 0, unattributed: 0 };
}

// ---------------------------------------------------------------------------
// Beta / Dirichlet smoothing, unchanged from `bayesian.learnedLikelihood`
// ---------------------------------------------------------------------------

/**
 * Prior strength delta: how many pseudo-decisions the parent estimate is worth.
 *
 * This is `LEARNING_PRIOR_DENOM` and it stays that way. With
 * `LEARNING_PRIOR_ALPHA = 2` for each of the 5 actions, the pseudo-counts sum to
 * 5 x 2 = 10 = delta exactly, so the constants the writeup already ships are a
 * symmetric Dirichlet(2,2,2,2,2), the multi-action generalisation of its
 * Beta(2,8), with no re-derivation needed.
 */
export const PRIOR_STRENGTH = LEARNING_PRIOR_DENOM;

/**
 * Prior strength for the two bucket-free levels, which pool over hand classes.
 *
 * A decision recorded without a hand class could have come from any of the
 * `BUCKET_COUNT` buckets, so as evidence about one specific bucket it is worth
 * roughly `1 / BUCKET_COUNT` of a decision that was attributed, the value of a
 * uniform soft assignment. Weighting it that way is the same as making its
 * prior strength `BUCKET_COUNT` times larger, which is all this constant is.
 *
 * Without it the pooled levels win on volume and flatten the prior's bucket
 * structure: after 10 hands the model would have replaced "strong hands raise
 * more" with "this player raises 20% of the time", which is a worse estimate
 * than the one it started with. Nine pooled observations now move a bucket's
 * estimate about as far as one attributed observation does.
 */
export const POOLED_STRENGTH = PRIOR_STRENGTH * BUCKET_COUNT;

/** The writeup's no-data value, alpha/delta = 0.20. */
export const FLAT_PRIOR_MEAN = LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM;

/**
 * Posterior mean of a Dirichlet component whose prior mean is `priorMean`:
 *
 *     (count + delta * priorMean) / (total + delta)
 *
 * Substituting `priorMean = LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM` and the
 * default strength gives `(count + LEARNING_PRIOR_ALPHA) / (total +
 * LEARNING_PRIOR_DENOM)`, exactly `bayesian.learnedLikelihood`, digit for digit
 * (10 * 0.2 is exactly 2.0 in IEEE-754, so this is not an approximation). The
 * only generalisation is that the prior mean is now supplied by a coarser
 * estimate instead of being pinned at 0.20, which is what turns one Beta update
 * into a backoff hierarchy.
 *
 * Both limits are the ones §7 documents: no data returns `priorMean`, and
 * `total -> infinity` returns the empirical frequency `count / total`.
 */
export function betaMean(
  count: number,
  total: number,
  priorMean: number,
  strength: number = PRIOR_STRENGTH
): number {
  return (count + strength * priorMean) / (total + strength);
}

// ---------------------------------------------------------------------------
// The default prior, sane poker, generated rather than typed out
// ---------------------------------------------------------------------------

/**
 * 9 x 4 x 3 = 108 rows of 5 numbers is too many to hand-author honestly (nobody
 * can keep 540 hand-typed probabilities self-consistent). They are generated
 * from six constants instead, each of which means something:
 *
 *   weight(action) = base(action, facing) * exp(role_exponent)
 *
 * where `role` is what the action does at that node, and the exponent scales
 * with hand strength and with how far the hand has developed.
 */

/**
 * The three things an action can be. Note this is facing-relative: `check` is
 * the give-up option unopened, `call` is the middle option facing a bet, and
 * `bet` and `raise` are the same act at different nodes.
 */
const ROLE: Record<PlayerActionType, "aggro" | "mid" | "give"> = {
  bet: "aggro",
  raise: "aggro",
  call: "mid",
  check: "give",
  fold: "give",
};

/**
 * What an average player does at each node before strength is considered.
 *
 * Actions that are not legal at a node (calling when nobody has bet) get 0.01
 * rather than 0: they should be vanishingly unlikely, but a hard zero would make
 * one mislabelled observation an infinitely strong Bayes factor.
 *
 * These are the shape of the prior. Its fold LEVEL is set separately, one line
 * down, because the level is bounded by something these numbers know nothing
 * about, see `MDF_FOLD_SCALE`.
 */
const BASE_MIX: Record<Facing, ActionWeights> = {
  unopened: { check: 0.55, bet: 0.42, call: 0.01, raise: 0.01, fold: 0.01 },
  "facing-bet": { fold: 0.42, call: 0.44, raise: 0.12, check: 0.01, bet: 0.01 },
  "facing-raise": { fold: 0.52, call: 0.38, raise: 0.08, check: 0.01, bet: 0.01 },
};

/**
 * MINIMUM DEFENCE FREQUENCY, the ceiling on how much this prior may fold.
 *
 * Against a bet of `s` into a pot of `P`, a bluff risking `s` to win `P` breaks
 * even when it gets through with probability
 *
 *     alpha = s / (P + s)
 *
 * so an opponent folding more than `alpha` can be beaten by betting *any two
 * cards*, and an unexploitable one folds at most `alpha`, equivalently it
 * defends the MDF `1 - alpha`. Half pot alpha = 1/3, three quarters 3/7, pot 1/2.
 *
 * The uncapped rows above folded 46.4% of a range to a half-pot bet: 13 points
 * looser than any unexploitable opponent. Every bet and raise in the game is
 * priced against this table (`decider.foldByBucket` -> `ev.foldEquityEv`), so
 * those 13 points were a standing subsidy on aggression, and an EV maximiser
 * correctly collected it by betting close to everything. This constant removes
 * the subsidy.
 *
 * WHAT IS ANCHORED. The bound is on the range-weighted fold frequency, the
 * share of the hands an opponent actually holds that go in the muck, which is
 * what `foldEquityEv` integrates. Not the flat mean over the nine buckets: a
 * random range is air-heavy and air is what folds, so the range-weighted rate
 * runs 6-12 points above the per-bucket mean, and pinning the smaller number
 * would leave the one that prices a bet still over the line.
 *
 * WHY ONE SIZE IS ENOUGH. `decider.foldAtSize` shifts the log-odds of a fold by
 * `log(s / REFERENCE_FRACTION)` at unit sensitivity, i.e. odds(s) = odds(0.5) x
 * 2s. Alpha in odds form is exactly `s / P = s`. So odds(0.5) = 1/2, that is,
 * p = 1/3, gives odds(s) = s at every size: the MDF frontier is a fixed point
 * of the sizing law, and anchoring the reference size holds the whole curve.
 * Measured at 0.50 / 0.75 / 1.00 pot the rows below come out at 32.4 / 41.3 /
 * 47.9% facing a bet and 32.6 / 41.7 / 48.5% facing a raise, against alphas of
 * 33.3 / 42.9 / 50.0%.
 *
 * WHY A SCALAR. MDF constrains the total share of a range that folds, not how
 * that share is spread over hand classes. The prior's spread was never the
 * problem; its level was. So the fold weight is scaled by a constant and the
 * surplus handed to `call`, after normalisation, so the row still sums to one
 * and `bet`, `raise` and `check` keep the values they had before this constant
 * existed. Strength ordering, street sharpening and the raise weights are all
 * untouched, which is why this is the smallest edit that makes the claim true.
 *
 * WHY ONE SCALAR AND NOT TWO. Both defended nodes face the same bound at the
 * same reference size, so they get the same factor: it is the largest scale at
 * which no (street, facing, size) cell exceeds its alpha. Facing a raise binds
 * because it starts higher, and the flop binds among streets because its bucket
 * mix is the most air-heavy; facing a bet then lands comfortably under. Scaling
 * both by the same number is also what keeps the facing comparison exactly as it
 * was, a three-bet still folds out more than a bet does from every single
 * bucket, because a shared positive factor cannot reorder anything. Two
 * separately-solved factors did invert that at the air bucket.
 */
const MDF_FOLD_SCALE = 0.47;

/** Nodes where a bet has to be answered, and MDF therefore binds. */
const DEFENDED: Record<Facing, boolean> = {
  // Nothing has been bet, so there is no bound and nothing is scaled.
  unopened: false,
  "facing-bet": true,
  "facing-raise": true,
};

/**
 * How strongly strength drives behaviour on each street.
 *
 * Preflop everybody is playing a range against a range and much of the action is
 * mechanical (the big blind defends 72o because it is already half paid in), so
 * the tell is weak. By the river the hand is complete, there are no more cards
 * to change it, and the correlation between what you hold and what you do is at
 * its maximum. Preflop 0.55 vs river 1.25 is that spread.
 */
const STREET_SHARPNESS: Record<LearnStreet, number> = {
  preflop: 0.55,
  flop: 0.8,
  turn: 1.0,
  river: 1.25,
};

/** How much a strong hand lifts betting and raising. */
const AGGRO_LIFT = 1.0;
/** How much a strong hand suppresses checking and folding. */
const GIVEUP_DROP = 1.0;
/**
 * Calling is the middle action, not a weak one, it peaks at medium strength
 * and falls off at both ends (nothing to call with, or too good to just call).
 * A quadratic in the strength tilt is the cheapest shape with that property.
 */
const CALL_PEAK = 0.8;

/**
 * Fraction of the prior row replaced by a uniform mix.
 *
 * Caps the Bayes factor a single action can carry at roughly 1 : 30. Without it
 * the river rows get polarised enough that one check would zero out the "strong"
 * hypothesis, and a model whose output is shown to the player must never claim
 * to be certain from one action.
 */
const PRIOR_MIX = 0.08;

function normalizeWeights(w: ActionWeights): ActionWeights {
  let sum = 0;
  for (const a of ACTIONS) sum += w[a];
  if (sum <= 0) {
    const flat = {} as ActionWeights;
    for (const a of ACTIONS) flat[a] = 1 / ACTIONS.length;
    return flat;
  }
  const out = {} as ActionWeights;
  for (const a of ACTIONS) out[a] = w[a] / sum;
  return out;
}

function pokerPriorRow(
  bucket: Bucket,
  street: LearnStreet,
  facing: Facing
): ActionWeights {
  // -1 at the weakest bucket, +1 at the strongest.
  const tilt = BUCKET_COUNT > 1 ? (2 * bucket) / (BUCKET_COUNT - 1) - 1 : 0;
  const gamma = STREET_SHARPNESS[street];
  const base = BASE_MIX[facing];

  const raw = {} as ActionWeights;
  for (const a of ACTIONS) {
    const role = ROLE[a];
    const exponent =
      role === "aggro"
        ? AGGRO_LIFT * gamma * tilt
        : role === "give"
          ? -GIVEUP_DROP * gamma * tilt
          : -CALL_PEAK * gamma * tilt * tilt;
    raw[a] = base[a] * Math.exp(exponent);
  }

  const normalized = normalizeWeights(raw);

  // The MDF cap. Between fold and call only, so the row still sums to one and
  // every other action keeps the value it had before this line existed.
  if (DEFENDED[facing]) {
    const kept = normalized.fold * MDF_FOLD_SCALE;
    normalized.call += normalized.fold - kept;
    normalized.fold = kept;
  }

  const out = {} as ActionWeights;
  for (const a of ACTIONS) {
    out[a] = (1 - PRIOR_MIX) * normalized[a] + PRIOR_MIX / ACTIONS.length;
  }
  return out;
}

/**
 * The three legacy tiers, expanded into the buckets each contains.
 *
 * Derived from `tierFromBucket` rather than restated, so the partition can only
 * ever be the one `buckets.ts` defines: Overpair and up (6-8) are genuine value
 * hands, WeakPair through TopPair (3-5) are marginal made hands, and Air through
 * StrongDraw (0-2) have no showdown value yet. This is the bridge that lets the
 * 9-bucket model talk to the 3-tier `BeliefDistribution` the rest of the
 * codebase already speaks.
 */
export const BUCKETS_BY_TIER: Record<StrengthTier, Bucket[]> = {
  weak: [],
  medium: [],
  strong: [],
};
for (let b = 0; b < BUCKET_COUNT; b += 1) {
  BUCKETS_BY_TIER[tierFromBucket(b as HandBucket)].push(b);
}

/**
 * Prior rows, built on first use and cached. 108 rows x 3 prior ids is small
 * enough to keep forever and expensive enough (an `exp` per cell) to not want to
 * recompute on every belief update.
 */
const PRIOR_CACHE = new Map<string, ActionWeights>();

export function priorRow(
  prior: PriorId,
  bucket: Bucket,
  street: LearnStreet,
  facing: Facing
): ActionWeights {
  const b = clampBucket(bucket);
  const key = `${prior}|${b}|${street}|${facing}`;
  const hit = PRIOR_CACHE.get(key);
  if (hit) return hit;

  let row: ActionWeights;
  if (prior === "flat") {
    row = {} as ActionWeights;
    for (const a of ACTIONS) row[a] = FLAT_PRIOR_MEAN;
  } else if (prior === "legacy") {
    // Deliberately unnormalised: the legacy table is five independent
    // per-hand Bernoullis, not a categorical, and its rows sum to ~1.75. That
    // is harmless here because Bayes normalises over hypotheses, not over
    // actions, scaling a likelihood column leaves the posterior untouched.
    const tier = tierFromBucket(b as HandBucket);
    row = {} as ActionWeights;
    for (const a of ACTIONS) row[a] = ACTION_LIKELIHOODS[a][tier];
  } else {
    row = pokerPriorRow(b, street, facing);
  }

  PRIOR_CACHE.set(key, row);
  return row;
}

function clampBucket(bucket: Bucket): Bucket {
  // Defensive: a corrupt row out of the database must not crash the analysis
  // page, and clamping to the nearest real class is the least-wrong answer.
  if (!Number.isFinite(bucket)) return 0;
  return Math.min(BUCKET_COUNT - 1, Math.max(0, Math.trunc(bucket)));
}

// ---------------------------------------------------------------------------
// The backoff
// ---------------------------------------------------------------------------

/**
 * THE SPARSITY PROBLEM, AND WHAT IS DONE ABOUT IT
 *
 * Six nested estimates are maintained per player, ordered by how fast each
 * fills with data. Every observation writes to all of them at once:
 *
 *   0. global   ()                                   every decision ever
 *   1. node     (street, facing)                     12 cells
 *   2. bucket   (bucket)                             9 cells
 *   3. bs       (bucket, street)                     36 cells
 *   4. bsf      (bucket, street, facing)             108 cells
 *   5. full     (bucket, street, facing, position)   648 cells
 *
 * A lookup starts at the data-free prior row and walks the list coarse to fine,
 * applying `betaMean` at each level with the previous level's answer as the
 * prior mean. Because `betaMean(0, 0, m) === m` exactly, a level with no
 * evidence is the identity: an empty cell inherits its parent's estimate rather
 * than snapping back to the prior. That is the property that decides whether the
 * model is useful after 50 hands or only after 5,000.
 *
 * ORDERING. Position is dropped first because it is the weakest signal per unit
 * of sparsity (6 values, and most of what position does is already visible
 * through `facing`). Bucket is introduced late but never dropped from levels
 * 2-5, because it is the axis being estimated. Levels 0 and 1 carry no bucket at
 * all, which is exactly what makes them writable from folds, see `learn.ts`.
 *
 * NO DOUBLE COUNTING. The naive version of this chain feeds the same
 * observation into all six levels, so 30 hands at one context move the estimate
 * as if there had been 180. Instead each level uses its exclusive evidence -
 * the observations it saw that the finer levels did not, via inclusion and
 * exclusion over the six cells (`LEVEL_COEFFS`). The coefficient columns sum to
 * (1,0,0,0,0,0), so summing the exclusive totals across levels returns exactly
 * the global total: every observation is counted once, at the most specific
 * level that saw it. `likelihood.test.ts` asserts that partition directly.
 *
 * The intersection identities that make this valid, for a fixed query context:
 * node ∩ bucket = bsf, full ⊂ bsf ⊂ bs ⊂ bucket, and bsf ⊂ node. All exclusive
 * counts are therefore non-negative by construction.
 *
 * WEIGHTING. Levels 0 and 1 pool over hand classes, so their evidence is worth
 * `1 / BUCKET_COUNT` of an attributed decision when the question is about one
 * bucket. They use `POOLED_STRENGTH` instead of `PRIOR_STRENGTH` for exactly
 * that reason; see the constant. This is what stops volume at the coarse levels
 * from erasing the bucket structure the model exists to estimate.
 */
export const LEVEL_NAMES = [
  "global",
  "node",
  "bucket",
  "bucket+street",
  "bucket+street+facing",
  "full",
] as const;

export type LevelName = (typeof LEVEL_NAMES)[number];

/** Number of leading levels that carry no bucket, the ones folds can write. */
export const BUCKET_FREE_LEVELS = 2;

/** Prior strength used at each level; the pooled ones are trusted more slowly. */
function levelStrength(level: number): number {
  return level < BUCKET_FREE_LEVELS ? POOLED_STRENGTH : PRIOR_STRENGTH;
}

/**
 * Inclusion-exclusion coefficients: `LEVEL_COEFFS[level][cell]`, over the six
 * cells returned by `contextKeys` in the same order. Column sums are
 * (1,0,0,0,0,0), i.e. an exact partition of the global total.
 */
const LEVEL_COEFFS: readonly (readonly number[])[] = [
  //  global node bucket  bs  bsf full
  [1, -1, -1, 0, 1, 0], // global   = all - node - bucket + (node ∩ bucket)
  [0, 1, 0, 0, -1, 0], // node     = node - bsf
  [0, 0, 1, -1, 0, 0], // bucket   = bucket - bs
  [0, 0, 0, 1, -1, 0], // bs       = bs - bsf
  [0, 0, 0, 0, 1, -1], // bsf      = bsf - full
  [0, 0, 0, 0, 0, 1], // full     = full
];

/** The six cell keys a full context writes to / reads from, coarse to fine. */
export function contextKeys(ctx: LikelihoodContext): string[] {
  const b = clampBucket(ctx.bucket);
  return [
    "*",
    `n:${ctx.street}:${ctx.facing}`,
    `b:${b}`,
    `bs:${b}:${ctx.street}`,
    `bsf:${b}:${ctx.street}:${ctx.facing}`,
    `bsfp:${b}:${ctx.street}:${ctx.facing}:${ctx.position}`,
  ];
}

/**
 * The keys an observation with an unknown hand class may write to: the two
 * bucket-free levels, and only those.
 */
export function bucketFreeKeys(ctx: UnattributedContext): string[] {
  return ["*", `n:${ctx.street}:${ctx.facing}`];
}

interface LevelEvidence {
  index: number;
  level: LevelName;
  key: string;
  total: number;
  actions: ActionWeights;
}

function exclusiveEvidence(
  model: LikelihoodModel,
  ctx: LikelihoodContext
): LevelEvidence[] {
  const keys = contextKeys(ctx);
  const cells = keys.map((k) => model.cells[k] ?? EMPTY_CELL);

  return LEVEL_COEFFS.map((coeffs, level) => {
    let total = 0;
    for (let i = 0; i < coeffs.length; i += 1) total += coeffs[i] * cells[i].total;
    total = Math.max(0, total);

    const actions = {} as ActionWeights;
    for (const a of ACTIONS) {
      let k = 0;
      for (let i = 0; i < coeffs.length; i += 1) k += coeffs[i] * cells[i].actions[a];
      // Non-negative and <= total by construction; clamped anyway so a corrupted
      // persisted model degrades instead of producing a probability outside 0..1.
      actions[a] = Math.min(Math.max(0, k), total);
    }

    return { index: level, level: LEVEL_NAMES[level], key: keys[level], total, actions };
  });
}

/**
 * The full smoothed row P(action | context) for every action at once.
 *
 * Prefer this over five `likelihoodOf` calls: it walks the backoff once, and
 * because every action shares the same per-level totals the row sums to 1
 * whenever the prior row does (each level maps a distribution to a distribution).
 */
export function likelihoodRow(
  model: LikelihoodModel,
  ctx: LikelihoodContext
): ActionWeights {
  const out = { ...priorRow(model.prior, ctx.bucket, ctx.street, ctx.facing) };
  for (const level of exclusiveEvidence(model, ctx)) {
    if (level.total <= 0) continue; // exact identity; skipped only for speed
    const strength = levelStrength(level.index);
    for (const a of ACTIONS) {
      out[a] = betaMean(level.actions[a], level.total, out[a], strength);
    }
  }
  return out;
}

/** P(action | bucket, street, position, facing). */
export function likelihoodOf(
  model: LikelihoodModel,
  action: PlayerActionType,
  bucket: Bucket,
  street: LearnStreet,
  position: PositionName,
  facing: Facing
): number {
  return likelihoodRow(model, { bucket, street, position, facing })[action];
}

// ---------------------------------------------------------------------------
// Explaining a lookup (the analysis page reads this)
// ---------------------------------------------------------------------------

export interface BackoffStep {
  level: LevelName;
  key: string;
  /** Exclusive decisions this level contributed, see the backoff note. */
  observations: number;
  /** Of those, ones that took the queried action. */
  matching: number;
  /** Running estimate after this level. */
  estimate: number;
}

export interface LikelihoodExplanation {
  action: PlayerActionType;
  context: LikelihoodContext;
  prior: number;
  steps: BackoffStep[];
  value: number;
}

/**
 * The same walk `likelihoodOf` performs, with the intermediate estimates kept.
 *
 * This module's output is shown to the player as a claim about themselves, so
 * the claim has to be auditable: "you raise 71% of the time here" should be
 * traceable to how many of those observations were actually at here versus
 * borrowed from a coarser slice.
 */
export function explainLikelihood(
  model: LikelihoodModel,
  action: PlayerActionType,
  ctx: LikelihoodContext
): LikelihoodExplanation {
  const prior = priorRow(model.prior, ctx.bucket, ctx.street, ctx.facing)[action];
  let estimate = prior;
  const steps: BackoffStep[] = [];

  for (const level of exclusiveEvidence(model, ctx)) {
    if (level.total > 0) {
      estimate = betaMean(
        level.actions[action],
        level.total,
        estimate,
        levelStrength(level.index)
      );
    }
    steps.push({
      level: level.level,
      key: level.key,
      observations: level.total,
      matching: level.actions[action],
      estimate,
    });
  }

  return { action, context: ctx, prior, steps, value: estimate };
}

// ---------------------------------------------------------------------------
// Collapsing back to the three-tier world
// ---------------------------------------------------------------------------

/**
 * P(action | tier) for the three legacy tiers, by averaging the buckets in each.
 *
 * Uniform within a tier. A weighted average over P(bucket | tier) would be
 * strictly better, but that needs a range distribution this module deliberately
 * does not depend on, and uniform is the honest default rather than a guess
 * dressed up as one.
 */
export function collapseToTiers(
  model: LikelihoodModel,
  action: PlayerActionType,
  street: LearnStreet,
  position: PositionName,
  facing: Facing
): BeliefDistribution {
  const mean = (tier: StrengthTier): number => {
    const buckets = BUCKETS_BY_TIER[tier];
    let sum = 0;
    for (const bucket of buckets) {
      sum += likelihoodOf(model, action, bucket, street, position, facing);
    }
    return sum / buckets.length;
  };
  return { weak: mean("weak"), medium: mean("medium"), strong: mean("strong") };
}

/**
 * The whole 5x3 table for one context, a drop-in replacement for
 * `bayesian.learnedActionLikelihoods`, so `updateBelief` can consume this model
 * with no change at the call site. Passing a fresh `legacy`-prior model through
 * here reproduces `ACTION_LIKELIHOODS` exactly, which is the concrete sense in
 * which the old model was generalised rather than replaced.
 */
export function collapsedLikelihoods(
  model: LikelihoodModel,
  street: LearnStreet,
  position: PositionName,
  facing: Facing
): Record<PlayerActionType, BeliefDistribution> {
  const table = {} as Record<PlayerActionType, BeliefDistribution>;
  for (const a of ACTIONS) {
    table[a] = collapseToTiers(model, a, street, position, facing);
  }
  return table;
}
