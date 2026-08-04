/**
 * Accumulating a `LikelihoodModel` from observed play.
 *
 * `likelihood.ts` is pure lookup; everything that writes lives here. Three jobs:
 * record decisions (including the ones where the hand is never revealed),
 * survive a round trip through a database, and merge two sessions.
 *
 * Mutation convention matches `bayesian.recordShowdownHand`: accumulation is
 * in-place on a model you already own (`observe`), while anything that combines
 * two models returns a new one (`mergeModels`). Nothing here is a class.
 */

import type { PlayerActionType } from "../../types";
import type { PositionName } from "../table/position";
import {
  ACTIONS,
  BUCKET_COUNT,
  FACINGS,
  POSITIONS,
  STREETS,
  bucketFreeKeys,
  contextKeys,
  createLikelihoodModel,
  emptyCell,
  type ActionWeights,
  type Bucket,
  type CellCounts,
  type Facing,
  type LearnStreet,
  type LikelihoodModel,
  type PriorId,
} from "./likelihood";

export { createLikelihoodModel };

// ---------------------------------------------------------------------------
// What an observation is
// ---------------------------------------------------------------------------

/** One decision at one node. */
export interface Observation {
  action: PlayerActionType;
  /**
   * The hand class the player turned out to hold, or `null` when it was never
   * revealed. See "Learning from folds" below, `null` is not a bucket, and it
   * is never replaced by a guess.
   */
  bucket: Bucket | null;
  street: LearnStreet;
  position: PositionName;
  facing: Facing;
}

/** A decision without the hand class, what a hand log gives you directly. */
export type DecisionContext = Omit<Observation, "bucket">;

export interface HandObservation {
  /** Bucket revealed at showdown, or `null` if the hand ended before one. */
  bucket: Bucket | null;
  decisions: DecisionContext[];
}

/**
 * LEARNING FROM FOLDS. WHAT IS AND IS NOT LEARNABLE
 *
 * `bayesian.recordShowdownHand` only learns at showdown, which throws away the
 * large majority of decisions: most hands end in a fold, and a player who folds
 * 80% of their big blind is telling you a great deal about themselves.
 *
 * What a fold *does* teach:
 *   - How often this player takes this action at this node. P(fold | river,
 *     facing-raise) is fully observable and is exactly the "fold to a river
 *     raise" number every tracker in the world reports.
 *   - Therefore also this player's overall action mix, which is what levels 0
 *     and 1 of the backoff hold.
 *
 * What a fold does NOT teach, and what this module refuses to invent:
 *   - P(action | bucket). The cards were mucked. Any bucket assigned to that
 *     hand would be fabricated, and it would then be laundered through the
 *     backoff into a number presented to the player as a fact about their play.
 *
 * So an unattributed observation writes to the two bucket-free levels and stops.
 * That is not a consolation prize. Those levels are the shrinkage target for the
 * bucket-conditioned ones, so unattributed data still moves every bucket's
 * estimate, it moves them all *together*, compressing the likelihood ratio
 * between buckets. Which is precisely correct: learning that a player raises
 * constantly, without ever seeing what they raise with, should make a raise mean
 * less, not make it mean "strong". That single mechanism is where the bluffer
 * discount comes from, and it works before the first showdown.
 *
 * Honest caveat, since this is shown to the player: attributed data is
 * selection-biased. Hands survive to showdown disproportionately when they were
 * strong enough to keep calling, so P(action | bucket) estimated from showdowns
 * over-represents hands that wanted to see the river. The bucket-free levels are
 * not biased that way, which is a second reason to keep them in the chain.
 */

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const ACTION_SET = new Set<string>(ACTIONS);
const STREET_SET = new Set<string>(STREETS);
const FACING_SET = new Set<string>(FACINGS);
const POSITION_SET = new Set<string>(POSITIONS);

function validate(obs: Observation): void {
  if (!ACTION_SET.has(obs.action)) throw new Error(`observe: bad action ${obs.action}`);
  if (!STREET_SET.has(obs.street)) throw new Error(`observe: bad street ${obs.street}`);
  if (!FACING_SET.has(obs.facing)) throw new Error(`observe: bad facing ${obs.facing}`);
  if (!POSITION_SET.has(obs.position)) {
    throw new Error(`observe: bad position ${obs.position}`);
  }
  if (obs.bucket !== null) {
    if (!Number.isInteger(obs.bucket) || obs.bucket < 0 || obs.bucket >= BUCKET_COUNT) {
      throw new Error(
        `observe: bucket ${obs.bucket} outside 0..${BUCKET_COUNT - 1}`
      );
    }
  }
}

function bump(model: LikelihoodModel, key: string, action: PlayerActionType): void {
  let cell = model.cells[key];
  if (!cell) {
    cell = emptyCell();
    model.cells[key] = cell;
  }
  cell.total += 1;
  cell.actions[action] += 1;
}

/**
 * Record one decision, in place.
 *
 * Writes every backoff level the observation is entitled to: all six when the
 * hand was revealed, the two bucket-free ones when it was not. Validation is
 * strict rather than forgiving because this data is persisted, a bad street
 * string would sit in the database creating a cell nothing ever reads.
 */
export function observe(model: LikelihoodModel, obs: Observation): void {
  validate(obs);
  const keys =
    obs.bucket === null
      ? bucketFreeKeys(obs)
      : contextKeys({ ...obs, bucket: obs.bucket });
  for (const key of keys) bump(model, key, obs.action);
  model.observations += 1;
  if (obs.bucket === null) model.unattributed += 1;
}

export function observeMany(model: LikelihoodModel, observations: Observation[]): void {
  for (const obs of observations) observe(model, obs);
}

/**
 * Record every decision from one hand, all sharing its revealed bucket.
 *
 * This is the engine-facing entry point and the direct replacement for
 * `recordShowdownHand`. Two deliberate differences from it:
 *
 *   - It takes `bucket: null` for hands that never reached showdown, instead of
 *     declining to learn from them at all.
 *   - It does not de-duplicate actions within a hand. `recordShowdownHand` had
 *     to, because with no context every action in a hand landed in the same
 *     cell and a three-bet-then-call would have double counted. Here each
 *     decision carries its own (street, facing), so the decisions occupy
 *     different cells and each is a genuine independent draw from that node's
 *     categorical. The unit of observation moves from "hands in which the
 *     action occurred" to "decisions taken at this node", which is the stronger
 *     statistic and the one that makes the per-node row sum to 1.
 *
 * ONE BUCKET PER HAND IS AN ASSUMPTION, and it is only true while the bucket is
 * a *preflop* hand class. `buckets.ts` classes are board-relative: the same two
 * cards are Air on the flop and TwoPair by the river, and the model conditions
 * on which. A caller recording a real hand off a board therefore has to bucket
 * each decision against the board as it stood on that street and pass the
 * results to `observeMany`, see `lib/opponentMemory.handObservations`, which is
 * the engine-facing writer in practice. This entry point stays because it is the
 * honest shape for a preflop-only or already-collapsed hand, and because it is
 * the direct like-for-like replacement for `recordShowdownHand`.
 */
export function recordHand(model: LikelihoodModel, hand: HandObservation): void {
  for (const decision of hand.decisions) {
    observe(model, { ...decision, bucket: hand.bucket });
  }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function addCells(a: CellCounts | undefined, b: CellCounts | undefined): CellCounts {
  const out = emptyCell();
  out.total = (a?.total ?? 0) + (b?.total ?? 0);
  for (const action of ACTIONS) {
    out.actions[action] = (a?.actions[action] ?? 0) + (b?.actions[action] ?? 0);
  }
  return out;
}

/**
 * Combine two models into a new one. Counts add, so this is exactly commutative
 * and associative, merging session order can never change a number.
 *
 * Keys are emitted sorted so two merges of the same data serialise to byte
 * identical JSON, which matters once these rows are diffed or checksummed in a
 * database.
 *
 * Differing priors throw. The prior is the root of the backoff, so two models
 * built on different ones are estimates of different quantities and adding their
 * counts would produce a number that means nothing.
 */
export function mergeModels(a: LikelihoodModel, b: LikelihoodModel): LikelihoodModel {
  if (a.prior !== b.prior) {
    throw new Error(`mergeModels: prior mismatch (${a.prior} vs ${b.prior})`);
  }
  const merged = createLikelihoodModel(a.prior);
  merged.observations = a.observations + b.observations;
  merged.unattributed = a.unattributed + b.unattributed;

  const keys = [...new Set([...Object.keys(a.cells), ...Object.keys(b.cells)])].sort();
  for (const key of keys) {
    merged.cells[key] = addCells(a.cells[key], b.cells[key]);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * The model is already JSON-shaped, so these are a deep copy plus validation
 * rather than a format conversion. They exist so the database boundary is a
 * single place: `modelFromJSON` is the only thing that has to be paranoid, and
 * `modelToJSON` guarantees stable key order for storage.
 */
export type LikelihoodModelJson = LikelihoodModel;

const PRIOR_IDS = new Set<string>(["poker", "flat", "legacy"]);

export function modelToJSON(model: LikelihoodModel): LikelihoodModelJson {
  const cells: Record<string, CellCounts> = {};
  for (const key of Object.keys(model.cells).sort()) {
    const cell = model.cells[key];
    const actions = {} as ActionWeights;
    for (const action of ACTIONS) actions[action] = cell.actions[action];
    cells[key] = { total: cell.total, actions };
  }
  return {
    version: 1,
    prior: model.prior,
    cells,
    observations: model.observations,
    unattributed: model.unattributed,
  };
}

function requireCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`modelFromJSON: ${what} must be a non-negative number`);
  }
  return value;
}

export function modelFromJSON(value: unknown): LikelihoodModel {
  if (typeof value !== "object" || value === null) {
    throw new Error("modelFromJSON: not an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(`modelFromJSON: unsupported version ${String(raw.version)}`);
  }
  if (typeof raw.prior !== "string" || !PRIOR_IDS.has(raw.prior)) {
    throw new Error(`modelFromJSON: unknown prior ${String(raw.prior)}`);
  }
  if (typeof raw.cells !== "object" || raw.cells === null) {
    throw new Error("modelFromJSON: cells missing");
  }

  const model = createLikelihoodModel(raw.prior as PriorId);
  model.observations = requireCount(raw.observations, "observations");
  model.unattributed = requireCount(raw.unattributed, "unattributed");

  const rawCells = raw.cells as Record<string, unknown>;
  for (const key of Object.keys(rawCells).sort()) {
    const entry = rawCells[key];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`modelFromJSON: cell ${key} is not an object`);
    }
    const cellRaw = entry as Record<string, unknown>;
    const actionsRaw = cellRaw.actions;
    if (typeof actionsRaw !== "object" || actionsRaw === null) {
      throw new Error(`modelFromJSON: cell ${key} has no actions`);
    }
    const cell = emptyCell();
    cell.total = requireCount(cellRaw.total, `cell ${key} total`);
    const bag = actionsRaw as Record<string, unknown>;
    for (const action of ACTIONS) {
      cell.actions[action] = requireCount(bag[action], `cell ${key}.${action}`);
    }
    // Unknown keys are inert rather than fatal: a cell key this build does not
    // recognise is simply never looked up, so an older row stays readable.
    model.cells[key] = cell;
  }
  return model;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface NodeMix {
  street: LearnStreet;
  facing: Facing;
  observations: number;
  /** Raw empirical frequencies, unsmoothed, for display next to the counts. */
  frequencies: ActionWeights;
}

/**
 * The player's raw action mix at one node, pooled over hand classes.
 *
 * Reads the bucket-free level, so it includes folded hands and is the one
 * statistic here that is not selection-biased toward showdowns. Unsmoothed on
 * purpose: this is reported as an observed frequency alongside its sample size,
 * not used as a likelihood.
 */
export function nodeMix(
  model: LikelihoodModel,
  street: LearnStreet,
  facing: Facing
): NodeMix {
  const cell = model.cells[`n:${street}:${facing}`];
  const frequencies = {} as ActionWeights;
  const total = cell?.total ?? 0;
  for (const action of ACTIONS) {
    frequencies[action] = total > 0 ? (cell as CellCounts).actions[action] / total : 0;
  }
  return { street, facing, observations: total, frequencies };
}

export interface ModelStats {
  observations: number;
  /** Decisions from hands that reached showdown, so bucket-conditioned. */
  attributed: number;
  /** Decisions from hands that were never revealed. */
  unattributed: number;
  /** Non-empty cells across all six levels, how much of the space is covered. */
  cells: number;
}

export function modelStats(model: LikelihoodModel): ModelStats {
  return {
    observations: model.observations,
    attributed: model.observations - model.unattributed,
    unattributed: model.unattributed,
    cells: Object.keys(model.cells).length,
  };
}
