/**
 * Everything the hand review reads out of a finished `TableHandReport`.
 *
 * The report is a factual record, cards, chips, actions, and the decisions the
 * bots actually priced. It is deliberately *not* a set of conclusions, so every
 * derived quantity on the review pages is computed here, in one place, from
 * that record alone. Nothing here invents an input: if a number cannot be
 * recovered from what the engine wrote down, the review says so.
 *
 * Two things are *recomputed* rather than read back, and both are recomputed
 * from the record's own contents. `streetEquities` settles each head-to-head by
 * running the two seats' real hole cards out over the real board (see
 * `headsUpEquity`), post-hand every card is face up, so the honest answer is
 * available and no estimate needs to stand in for it. And:
 *
 * `rangeView` reconstructs what the sampler drew from: a weight for each of the
 * 1326 hole-card combinations, built exactly the way `model/decider.ts`'s
 * `opponentRanges` builds the ranges it hands the estimator. A flat prior with
 * the dead cards removed, multiplied by P(action | bucket, street, position,
 * facing) for every action the seat took, renormalised after each factor.
 *
 * It deliberately does NOT project the three-tier belief onto the chart through
 * `bayesian.tierOf`. That is a *preflop* Chen score, and the sampler was
 * migrated off it precisely because on K-7-2-9-4 it calls 7-2 weak when it is
 * two pair (see `../../poker/equity/multiway.ts`, "WHAT A SEAT'S HAND IS DRAWN
 * FROM"). Drawing the superseded distribution beside the claim that it is the
 * live one is the one failure this file cannot afford, so the chart is built
 * from the same `model/buckets.ts` classification the engine used.
 */

import { ACTION_LIKELIHOODS, INITIAL_BELIEF } from "../../data/constants";
import { updateBelief } from "../../poker/bayesian";
import { hashSeed, makeRng } from "../../poker/core/rng";
import { scoreInts } from "../../poker/handEvaluator";
import {
  BUCKET_COUNT,
  BUCKET_NAMES,
  classifyAll,
  makeBoardContext,
  tierFromBucket,
  type HandBucket,
} from "../../poker/model/buckets";
import {
  createLikelihoodModel,
  likelihoodRow,
  type Facing,
  type LearnStreet,
  type LikelihoodModel,
} from "../../poker/model/likelihood";
import {
  COMBO_COUNT,
  GRID_CELLS,
  GRID_SIZE,
  comboIndex,
  gridCellOf,
  normalizeRange,
  removeCards,
  toGrid,
  uniformRange,
  type Range,
} from "../../poker/model/range";
import { positionOf, type PositionName } from "../../poker/table/position";
import type {
  ActionRecord,
  BotDecision,
  MultiwayEquity,
  SeatResult,
  TableHandReport,
} from "../../poker/table/contract";
import type { BeliefDistribution, Street } from "../../types";

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

const BETTING_STREETS: Street[] = ["preflop", "flop", "turn", "river"];

export const STREET_LABEL: Record<Street, string> = {
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

/** Community cards face-up once a street has been dealt. */
const BOARD_LEN: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
  showdown: 5,
};

function streetIndex(street: Street): number {
  return street === "showdown" ? 3 : BETTING_STREETS.indexOf(street);
}

/**
 * One column of the review's street-by-street narrative.
 *
 * `actionsUpTo` is the count of actions folded into the read, so a street's
 * entry is the table's read *entering* that street, which is what makes the
 * sequence of charts a story about narrowing rather than a set of snapshots
 * taken at arbitrary moments.
 */
export interface ReviewStreet {
  key: string;
  label: string;
  street: Street;
  boardLen: number;
  actionsUpTo: number;
}

export function reviewStreets(report: TableHandReport): ReviewStreet[] {
  const out: ReviewStreet[] = [];
  for (const street of BETTING_STREETS) {
    if (BOARD_LEN[street] > report.board.length) continue;
    out.push({
      key: street,
      label: STREET_LABEL[street],
      street,
      boardLen: BOARD_LEN[street],
      actionsUpTo: report.actions.filter(
        (a) => streetIndex(a.street) < streetIndex(street)
      ).length,
    });
  }
  out.push({
    key: "final",
    label: report.wentToShowdown ? "Showdown" : "Final",
    street: out[out.length - 1]?.street ?? "preflop",
    boardLen: report.board.length,
    actionsUpTo: report.actions.length,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The three-tier row every belief update on this table multiplies by.
 *
 * Declared once, applied below and quoted by `appliedLikelihood`, the Math tab
 * must never reach for the constant on its own, or the worked example becomes a
 * second opinion about what the engine did rather than a readout of it.
 * `decider.readsFromActions` calls `updateBelief` with no override, so this is
 * the row the live table applies too.
 */
const TIER_LIKELIHOODS = ACTION_LIKELIHOODS;

/**
 * The table's read on every seat after the first `count` actions.
 *
 * Deliberately a local re-derivation of `decider.readsFromActions` rather than
 * a call to it: the review needs the read at an arbitrary *prefix* of the hand,
 * which that function has no way to express, and the whole point of the panel
 * is to show the intermediate states.
 */
export function readsAfter(
  actions: ActionRecord[],
  count: number,
  seatCount: number
): Record<number, BeliefDistribution> {
  const reads: Record<number, BeliefDistribution> = {};
  for (let id = 0; id < seatCount; id++) reads[id] = INITIAL_BELIEF;
  for (let i = 0; i < Math.min(count, actions.length); i++) {
    const record = actions[i];
    reads[record.seat] = updateBelief(
      reads[record.seat] ?? INITIAL_BELIEF,
      record.action,
      TIER_LIKELIHOODS
    );
  }
  return reads;
}

/** Seats still contesting the pot after the first `count` actions. */
export function aliveAfter(report: TableHandReport, count: number): number[] {
  const folded = new Set<number>();
  for (let i = 0; i < Math.min(count, report.actions.length); i++) {
    if (report.actions[i].action === "fold") folded.add(report.actions[i].seat);
  }
  return report.seats
    .filter((s) => s.hole.length === 2 && !folded.has(s.seat))
    .map((s) => s.seat);
}

// ---------------------------------------------------------------------------
// Chart geometry, computed once
// ---------------------------------------------------------------------------

export const TIER_NAMES = ["weak", "medium", "strong"] as const;

/**
 * Combos in each chart cell before any card removal: 6 pairs, 4 suited,
 * 12 offsuit. 13*6 + 78*4 + 78*12 = 1326.
 */
export const CELL_TOTAL: Uint16Array = (() => {
  const out = new Uint16Array(GRID_CELLS);
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      out[row * GRID_SIZE + col] = row === col ? 6 : row < col ? 4 : 12;
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** How much of the board a decision on each street could see. */
const BOARD_CARDS_AT: Record<LearnStreet, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

const learnStreet = (street: Street): LearnStreet =>
  street === "showdown" ? "river" : street;

/** Where in the likelihood model an action was taken. */
interface NodeContext {
  street: LearnStreet;
  facing: Facing;
}

/**
 * The node every action in the hand was taken at.
 *
 * `facing` is not stored on an action, so it is reconstructed from the
 * aggression that preceded it on that street: preflop the big blind is already
 * an open, which is why the count starts at one there and at zero on every
 * later street. One walk, one rule, the range reweighting and the Math tab's
 * quoted likelihoods must agree about which node they are talking about.
 */
function nodeContexts(actions: ActionRecord[]): NodeContext[] {
  const out: NodeContext[] = [];
  let street: LearnStreet = "preflop";
  let aggressors = 1;
  for (const record of actions) {
    const recordStreet = learnStreet(record.street);
    if (recordStreet !== street) {
      street = recordStreet;
      aggressors = recordStreet === "preflop" ? 1 : 0;
    }
    out.push({
      street,
      facing:
        record.toCall <= 0
          ? "unopened"
          : aggressors >= 2
            ? "facing-raise"
            : "facing-bet",
    });
    if (record.action === "bet" || record.action === "raise") aggressors++;
  }
  return out;
}

/**
 * The model `opponentRanges` runs backwards, rebuilt rather than imported.
 *
 * `decider.ts` keeps its `OPPONENT_MODEL` private, but it is a fresh
 * `createLikelihoodModel("poker")` that is never written to, so this is the
 * same object, not an approximation of it. `derive.test.ts` pins the two
 * together by asserting this module's range equals `opponentRanges`' output.
 */
const OPPONENT_MODEL: LikelihoodModel = createLikelihoodModel("poker");

export interface RangeView {
  seat: number;
  /**
   * The weight on each of the 1326 hole-card combinations, what the sampler
   * draws from, per combo rather than per tier. Sums to 1.
   */
  range: Range;
  /** Per-cell probability the seat holds a hand in that class. Sums to 1. */
  grid: Float64Array;
  /** Combos left in each cell once the dead cards are removed. */
  cellCombos: Uint16Array;
  /** Live combos in total, out of 1326. */
  liveCombos: number;
  /**
   * The range's weight collapsed onto the three legacy tiers by
   * `tierFromBucket`, board-relative, so on K-7-2 the 7-2 combos count as
   * strong. Not a preflop judgement, and not the three-tier belief.
   */
  tierWeight: [number, number, number];
  /** Weight on each board-relative bucket, from `classifyAll`. */
  buckets: Float64Array;
  /** Largest single-cell probability, the top of the heat scale. */
  maxCell: number;
  /**
   * Smallest set of combos holding half the range's weight. The honest measure
   * of "how narrow is this read": a flat range needs half the deck, a range
   * three streets of betting have sharpened needs a fraction of it.
   */
  half: { combos: number; fraction: number };
}

/**
 * `decider.opponentRanges` for one seat, at an arbitrary prefix of the hand.
 *
 * A local re-derivation for the same reason `readsAfter` is one: the review
 * needs the range as it stood *entering* a street, and `opponentRanges` only
 * knows how to fold in a whole hand from a live `TableState`. Every step is the
 * same step, in the same order, off the same model, the flat prior with the
 * dead cards removed, one `P(action | bucket, street, position, facing)` factor
 * per action the seat took, renormalised after each.
 *
 * Buckets are measured against the board *as it stood on the action's own
 * street*: a flop bet must not be scored against a river the actor could not
 * see, which would be reading its mind rather than its bets.
 */
function opponentRangeAt(
  report: TableHandReport,
  seat: number,
  actionsUpTo: number,
  board: number[],
  dead: number[]
): Range {
  const range = normalizeRange(removeCards(uniformRange(), dead));

  const cache = new Map<LearnStreet, Uint8Array>();
  const bucketsAt = (street: LearnStreet): Uint8Array => {
    let hit = cache.get(street);
    if (hit === undefined) {
      const visible = Math.min(BOARD_CARDS_AT[street], board.length);
      hit = classifyAll(makeBoardContext(board.slice(0, visible)));
      cache.set(street, hit);
    }
    return hit;
  };

  const position = positionOf(seat, report.button, report.seatCount);
  const nodes = nodeContexts(report.actions);
  const n = Math.min(actionsUpTo, report.actions.length);
  for (let i = 0; i < n; i++) {
    const record = report.actions[i];
    if (record.seat !== seat) continue;
    const { street, facing } = nodes[i];
    const buckets = bucketsAt(street);
    const perBucket = new Float64Array(BUCKET_COUNT);
    for (let b = 0; b < BUCKET_COUNT; b++) {
      perBucket[b] = likelihoodRow(OPPONENT_MODEL, {
        bucket: b,
        street,
        position,
        facing,
      })[record.action];
    }
    for (let c = 0; c < COMBO_COUNT; c++) range[c] *= perBucket[buckets[c]];
    // Every likelihood is bounded below by the prior's uniform mixture, so no
    // product can reach zero and this can never divide by nothing.
    normalizeRange(range);
  }

  return range;
}

/**
 * The likelihoods the engine actually applied to one action, both of them.
 *
 * The table runs two models over the same action and the Math tab has to be
 * able to say which is which:
 *
 *  - `tier` is the flat three-tier row `updateBelief` multiplies the belief by.
 *    It is `TIER_LIKELIHOODS` verbatim, because `readsAfter` and
 *    `decider.readsFromActions` both call `updateBelief` with no override, the
 *    N-handed table has no learned per-player table, and the report carries
 *    none. Read from the same constant this module applies rather than fetched
 *    independently, so the worked example cannot drift from the arithmetic.
 *  - `byBucket` is `P(action | bucket)` at this node, which is what actually
 *    reweights the range the sampler draws from. It is recomputed rather than
 *    read back: `TableHandReport` records no likelihoods, but the model is a
 *    fixed prior and the node is fully determined by the record, so this is a
 *    re-derivation of a deterministic quantity and not an estimate of one.
 */
export interface AppliedLikelihood {
  action: ActionRecord["action"];
  street: LearnStreet;
  position: PositionName;
  facing: Facing;
  tier: BeliefDistribution;
  byBucket: Float64Array;
}

export function appliedLikelihood(
  report: TableHandReport,
  index: number
): AppliedLikelihood | null {
  const record = report.actions[index];
  if (!record) return null;
  const { street, facing } = nodeContexts(report.actions)[index];
  const position = positionOf(record.seat, report.button, report.seatCount);
  const byBucket = new Float64Array(BUCKET_COUNT);
  for (let b = 0; b < BUCKET_COUNT; b++) {
    byBucket[b] = likelihoodRow(OPPONENT_MODEL, {
      bucket: b,
      street,
      position,
      facing,
    })[record.action];
  }
  return {
    action: record.action,
    street,
    position,
    facing,
    tier: TIER_LIKELIHOODS[record.action],
    byBucket,
  };
}

/**
 * The distribution the sampler would draw this seat's hole cards from, as it
 * stood entering `street`.
 *
 * `heroHole` plus the visible board is every card the range cannot contain.
 * Blockers are not a special case here any more than they are in
 * `range.removeCards`: a card that is visible is simply absent from the pool
 * the combos are built out of, and the likelihood factors that follow can only
 * scale a zero.
 */
export function rangeView(
  report: TableHandReport,
  street: ReviewStreet,
  seat: number,
  heroHole: number[]
): RangeView {
  const board = report.board.slice(0, street.boardLen);
  const dead = [...heroHole, ...board].filter(
    (c) => Number.isInteger(c) && c >= 0 && c < 52
  );

  const used = new Uint8Array(52);
  for (const c of dead) used[c] = 1;
  const pool: number[] = [];
  for (let c = 0; c < 52; c++) if (!used[c]) pool.push(c);

  const cellCombos = new Uint16Array(GRID_CELLS);
  let liveCombos = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      cellCombos[gridCellOf(comboIndex(pool[i], pool[j]))]++;
      liveCombos++;
    }
  }

  const range = opponentRangeAt(report, seat, street.actionsUpTo, board, dead);

  const grid = toGrid(range);
  let maxCell = 0;
  for (let i = 0; i < GRID_CELLS; i++) if (grid[i] > maxCell) maxCell = grid[i];

  // One classification pass, read twice: the nine-rung ladder the engine works
  // in, and the three-tier collapse the meters speak. Both are the *same*
  // board-relative judgement at two resolutions, which is why they can no
  // longer disagree the way a preflop band and a postflop bucket did.
  const classes = classifyAll(makeBoardContext(Uint8Array.from(board)));
  const buckets = new Float64Array(BUCKET_COUNT);
  const tierWeight: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < COMBO_COUNT; c++) {
    const w = range[c];
    if (w <= 0) continue;
    const bucket = classes[c] as HandBucket;
    buckets[bucket] += w;
    const tier = tierFromBucket(bucket);
    tierWeight[tier === "weak" ? 0 : tier === "medium" ? 1 : 2] += w;
  }

  // Rank cells by weight *per combo*, the density the sampler actually sees -
  // and walk down until half the mass is covered.
  const order: number[] = [];
  for (let i = 0; i < GRID_CELLS; i++) if (cellCombos[i] > 0) order.push(i);
  order.sort((x, y) => {
    const dx = grid[x] / cellCombos[x];
    const dy = grid[y] / cellCombos[y];
    return dy - dx || grid[y] - grid[x];
  });
  let acc = 0;
  let combos = 0;
  for (const cell of order) {
    if (acc >= 0.5) break;
    acc += grid[cell];
    combos += cellCombos[cell];
  }

  return {
    seat,
    range,
    grid,
    cellCombos,
    liveCombos,
    tierWeight,
    buckets,
    maxCell,
    half: { combos, fraction: liveCombos > 0 ? combos / liveCombos : 0 },
  };
}

export function bucketName(index: number): string {
  return BUCKET_NAMES[index as HandBucket] ?? `Bucket ${index}`;
}

export { BUCKET_COUNT };

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

export interface BlockerView {
  /** Combos each cell loses to the given cards. */
  removedByCell: Uint16Array;
  /** Combos remaining in each cell. */
  leftByCell: Uint16Array;
  removed: number;
}

/**
 * What a set of visible cards takes out of everybody else's range.
 *
 * Removing k distinct cards kills exactly C(52,2) - C(52-k,2) combos, and the
 * cell-level detail is what turns that arithmetic into a read: holding one ace
 * halves the combinations of aces anyone else can have.
 */
export function blockerView(cards: number[]): BlockerView {
  const blocked = new Uint8Array(COMBO_COUNT);
  for (const c of cards) {
    if (!(c >= 0 && c < 52)) continue;
    for (let o = 0; o < 52; o++) {
      if (o === c) continue;
      blocked[comboIndex(c, o)] = 1;
    }
  }
  const removedByCell = new Uint16Array(GRID_CELLS);
  let removed = 0;
  for (let i = 0; i < COMBO_COUNT; i++) {
    if (blocked[i]) {
      removedByCell[gridCellOf(i)]++;
      removed++;
    }
  }
  const leftByCell = new Uint16Array(GRID_CELLS);
  for (let i = 0; i < GRID_CELLS; i++) {
    leftByCell[i] = CELL_TOTAL[i] - removedByCell[i];
  }
  return { removedByCell, leftByCell, removed };
}

// ---------------------------------------------------------------------------
// Equity, street by street
// ---------------------------------------------------------------------------

/** Last decision each seat made on each street, the most informed one. */
function lastDecisions(decisions: BotDecision[]): Map<string, BotDecision> {
  const out = new Map<string, BotDecision>();
  for (const d of decisions) out.set(`${d.street}:${d.seat}`, d);
  return out;
}

/**
 * Sample size for a runout too long to enumerate.
 *
 * A report's board is 0, 3, 4 or 5 cards, so the only runout that cannot be
 * walked in full is the preflop one: C(48,5) = 1.7M boards against C(47,2) =
 * 1081 on the flop, 44 on the turn and 1 on the river. 20k sims puts the
 * standard error at p ≈ 0.13 around 0.24 points, under the display precision,
 * and paid once per matchup per review.
 */
const H2H_SIMS = 20000;

export interface HeadToHeadEquity {
  /** The reviewing seat's share of the pot against this opponent alone. */
  equity: number;
  /** True when every runout was enumerated, so the number is not an estimate. */
  exact: boolean;
}

/**
 * Two known hands, run out over the board as it stood.
 *
 * This is the one question a hand review is uniquely able to answer honestly:
 * at the table nobody knew the opponent's cards, but the report has them, so
 * "what was my equity here" needs no read, no range and no belief, only the
 * evaluator and the cards the deck had left. Chops split, so the result is pot
 * share rather than win probability, on the same scale as `MultiwayEquity`.
 *
 * `seed` fixes the preflop sample: the same hand reviewed twice must not show
 * two different numbers.
 */
export function headsUpEquity(
  hero: number[],
  villain: number[],
  board: number[],
  seed: number
): HeadToHeadEquity | null {
  if (hero.length !== 2 || villain.length !== 2 || board.length > 5) return null;

  const used = new Uint8Array(52);
  for (const c of [...hero, ...villain, ...board]) {
    if (!(c >= 0 && c < 52) || used[c]) return null; // a card in two places
    used[c] = 1;
  }
  const pool: number[] = [];
  for (let c = 0; c < 52; c++) if (!used[c]) pool.push(c);

  const needed = 5 - board.length;
  const size = 7;
  const h = new Uint8Array(size);
  const v = new Uint8Array(size);
  h[0] = hero[0];
  h[1] = hero[1];
  v[0] = villain[0];
  v[1] = villain[1];
  for (let k = 0; k < board.length; k++) {
    h[2 + k] = board[k];
    v[2 + k] = board[k];
  }
  const at = 2 + board.length;

  let share = 0;
  let runs = 0;
  const settle = (): void => {
    const a = scoreInts(h, size);
    const b = scoreInts(v, size);
    share += a > b ? 1 : a === b ? 0.5 : 0;
    runs++;
  };

  let exact = true;
  if (needed === 0) {
    settle();
  } else if (needed === 1) {
    for (const c of pool) {
      h[at] = c;
      v[at] = c;
      settle();
    }
  } else if (needed === 2) {
    for (let i = 0; i < pool.length; i++) {
      h[at] = pool[i];
      v[at] = pool[i];
      for (let j = i + 1; j < pool.length; j++) {
        h[at + 1] = pool[j];
        v[at + 1] = pool[j];
        settle();
      }
    }
  } else {
    // Partial Fisher-Yates over a scratch copy of the pool: `needed` swaps draw
    // `needed` distinct cards, and the deck is left permuted rather than
    // rebuilt, so the loop allocates nothing.
    exact = false;
    const rng = makeRng(seed);
    const deck = Uint8Array.from(pool);
    for (let s = 0; s < H2H_SIMS; s++) {
      for (let d = 0; d < needed; d++) {
        const t = d + rng.int(deck.length - d);
        const card = deck[t];
        deck[t] = deck[d];
        deck[d] = card;
        h[at + d] = card;
        v[at + d] = card;
      }
      settle();
    }
  }

  return { equity: share / runs, exact };
}

export interface HeadToHead {
  seat: number;
  /** The reviewing seat's equity against this opponent alone. */
  equity: number;
  /**
   * Where the number came from.
   *
   *  - `actual`, both seats' real hole cards, run out over the real board by
   *    `headsUpEquity`. The true answer, available because the hand is over.
   *  - `estimate`, the reviewing seat's own recorded Monte Carlo against this
   *    opponent, used only when the opponent's cards are missing from the
   *    record. Its own cards are real; the opponent's are drawn from the read.
   *
   * There is deliberately no third case. The opponent's `perOpponent[focus]`
   * inverts to "the bot's read on you, versus the bot's hand", the reviewing
   * seat's real cards never enter it, so it returns the same number whether the
   * seat held aces or 7-2. It is not this seat's equity and is not shown as it.
   */
  source: "actual" | "estimate";
  /** False when the number was sampled rather than enumerated. */
  exact: boolean;
}

export interface StreetEquity {
  street: Street;
  label: string;
  /** The reviewing seat's equity against the whole field, when it recorded one. */
  own: MultiwayEquity | null;
  vs: HeadToHead[];
  /** The opponent holding the most equity against the reviewing seat. */
  threat: HeadToHead | null;
}

/**
 * Per-street equity from the reviewing seat's point of view.
 *
 * The decisions decide *who* appears, a matchup is on the panel iff one of the
 * two seats priced a decision naming the other, which is exactly "we were both
 * still in the pot here". They do not decide the *number*. A bot's recorded
 * `perOpponent[x]` is its own cards against a hand sampled from its read on x,
 * so it is only ever the equity of the seat that recorded it; inverting it to
 * fill in the other chair produces a figure the reviewing seat's real cards
 * never entered, identical whether that seat held aces or 7-2. Post-hand there
 * is no need for the substitution at all: both hands are face up, so the panel
 * runs them out and reports what the matchup actually was.
 */
export function streetEquities(
  report: TableHandReport,
  focus: number
): StreetEquity[] {
  const last = lastDecisions(report.decisions);
  const hole = new Map<number, number[]>();
  for (const s of report.seats) if (s.hole.length === 2) hole.set(s.seat, s.hole);
  const out: StreetEquity[] = [];

  for (const street of BETTING_STREETS) {
    if (BOARD_LEN[street] > report.board.length) continue;
    const own = last.get(`${street}:${focus}`) ?? null;
    const board = report.board.slice(0, BOARD_LEN[street]);

    // Every decision on the street is scanned rather than only the last one
    // per seat. A seat that folds early stops appearing in anybody's
    // `perOpponent` from that point on, so taking only the final decision of
    // each opponent would silently erase the whole panel for exactly the hands
    // where folding was the decision under review.
    const seats = new Set<number>();
    const estimated = new Map<number, number>();
    for (const d of report.decisions) {
      if (d.street !== street) continue;
      if (d.seat === focus) {
        for (const [key, value] of Object.entries(d.equity.perOpponent ?? {})) {
          seats.add(Number(key));
          estimated.set(Number(key), value); // later = more informed
        }
      } else if (typeof d.equity.perOpponent?.[focus] === "number") {
        seats.add(d.seat);
      }
    }
    seats.delete(focus);

    const mine = hole.get(focus);
    const vs: HeadToHead[] = [];
    for (const seat of [...seats].sort((a, b) => a - b)) {
      const theirs = hole.get(seat);
      const real =
        mine && theirs
          ? headsUpEquity(
              mine,
              theirs,
              board,
              // Fixed per (hand, street, matchup) so a review is reproducible,
              // and distinct across them so the samples are independent.
              hashSeed(report.seed, streetIndex(street), focus, seat)
            )
          : null;
      if (real) {
        vs.push({ seat, equity: real.equity, source: "actual", exact: real.exact });
      } else if (estimated.has(seat)) {
        // No cards on record for the opponent, a hand that ended before this
        // seat was ever dealt in should not happen, but the reviewing seat's
        // own estimate is at least *its* equity, so fall back rather than lie.
        vs.push({
          seat,
          equity: estimated.get(seat)!,
          source: "estimate",
          exact: false,
        });
      }
    }

    if (vs.length === 0 && own === null) continue;
    const threat = vs.reduce<HeadToHead | null>(
      (worst, h) => (worst === null || h.equity < worst.equity ? h : worst),
      null
    );
    out.push({
      street,
      label: STREET_LABEL[street],
      own: own?.equity ?? null,
      vs,
      threat,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pots
// ---------------------------------------------------------------------------

export interface PotView {
  index: number;
  amount: number;
  eligible: number[];
  winners: number[];
  /** Per-seat investment level this layer caps at. */
  cap: number;
  /** Where the layer below stopped. */
  floor: number;
  /** Seats that put chips into this layer, folded ones included. */
  contributors: number[];
}

/**
 * Side pots with their eligibility explained.
 *
 * The layout is a stack of layers cut at each distinct all-in level, so a pot's
 * cap is the smallest investment among the seats eligible for it, the shortest
 * stack in it is exactly what limits what everyone else can win from it. Every
 * seat that reached the cap paid into the layer; only the unfolded ones can
 * take it down.
 */
export function potViews(report: TableHandReport): PotView[] {
  const invested = new Map<number, number>();
  for (const s of report.seats) invested.set(s.seat, s.invested);

  let floor = 0;
  return report.pots.map((pot, index) => {
    const caps = pot.eligible.map((s) => invested.get(s) ?? 0);
    const cap = caps.length > 0 ? Math.min(...caps) : floor;
    const view: PotView = {
      index,
      amount: pot.amount,
      eligible: pot.eligible,
      winners: pot.winners,
      cap,
      floor,
      contributors: report.seats
        .filter((s) => s.invested > floor)
        .map((s) => s.seat),
    };
    floor = cap;
    return view;
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function seatResult(
  report: TableHandReport,
  seat: number
): SeatResult | undefined {
  return report.seats.find((s) => s.seat === seat);
}

/** Chips a call has to win back to break even: cost / (pot + cost). */
export function requiredEquity(pot: number, toCall: number): number {
  return toCall > 0 ? toCall / (pot + toCall) : 0;
}

export function actionsByStreet(
  actions: ActionRecord[]
): { street: Street; label: string; actions: ActionRecord[] }[] {
  const out: { street: Street; label: string; actions: ActionRecord[] }[] = [];
  for (const record of actions) {
    const tail = out[out.length - 1];
    if (tail && tail.street === record.street) tail.actions.push(record);
    else
      out.push({
        street: record.street,
        label: STREET_LABEL[record.street],
        actions: [record],
      });
  }
  return out;
}
