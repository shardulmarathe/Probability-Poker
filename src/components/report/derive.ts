/**
 * Everything the hand review reads out of a finished `TableHandReport`.
 *
 * The report is a factual record — cards, chips, actions, and the decisions the
 * bots actually priced. It is deliberately *not* a set of conclusions, so every
 * derived quantity on the review pages is computed here, in one place, from
 * that record alone. Nothing here invents an input: if a number cannot be
 * recovered from what the engine wrote down, the review says so.
 *
 * Two things are *recomputed* rather than read back, and both are recomputed
 * from the record's own contents. `streetEquities` settles each head-to-head by
 * running the two seats' real hole cards out over the real board (see
 * `headsUpEquity`) — post-hand every card is face up, so the honest answer is
 * available and no estimate needs to stand in for it. And:
 *
 * `rangeView` reconstructs what the sampler drew from. The table's read on a
 * seat is a three-tier belief (weak / medium / strong), and the multiway
 * sampler turns that into hole cards by bucketing every available two-card
 * combo with `tierOf` and drawing uniformly inside the chosen tier. That is
 * reproduced here exactly, so the 13x13 chart the review draws is the same
 * distribution the equity estimate was sampled from — not a prettier stand-in
 * for it. See `../../poker/equity/multiway.ts`, `runMultiwayCountsFromCodes`.
 */

import { INITIAL_BELIEF } from "../../data/constants";
import { normalize, tierOf, updateBelief } from "../../poker/bayesian";
import { decodeCard } from "../../poker/core/card";
import { hashSeed, makeRng } from "../../poker/core/rng";
import { scoreInts } from "../../poker/handEvaluator";
import {
  BUCKET_COUNT,
  BUCKET_NAMES,
  classifyAll,
  makeBoardContext,
  type HandBucket,
} from "../../poker/model/buckets";
import {
  COMBO_COUNT,
  GRID_CELLS,
  GRID_SIZE,
  comboIndex,
  gridCellOf,
  toGrid,
} from "../../poker/model/range";
import type {
  ActionRecord,
  BotDecision,
  MultiwayEquity,
  SeatResult,
  TableHandReport,
} from "../../poker/table/contract";
import type { BeliefDistribution, Street, StrengthTier } from "../../types";

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
 * entry is the table's read *entering* that street — which is what makes the
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
    reads[record.seat] = updateBelief(reads[record.seat] ?? INITIAL_BELIEF, record.action);
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

const TIER_INDEX: Record<StrengthTier, number> = { weak: 0, medium: 1, strong: 2 };

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

/**
 * The strength tier each chart cell falls in.
 *
 * `tierOf` reads only ranks and suitedness, so it is constant across a cell —
 * which is exactly why the belief can be projected onto the chart at all. One
 * representative combo per cell settles all 169.
 */
const CELL_TIER: Uint8Array = (() => {
  const out = new Uint8Array(GRID_CELLS);
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const hi = 14 - Math.min(row, col);
      const lo = 14 - Math.max(row, col);
      const suited = row < col;
      const a = (hi - 2) * 4;
      const b = (lo - 2) * 4 + (suited ? 0 : 1);
      out[row * GRID_SIZE + col] =
        TIER_INDEX[tierOf(decodeCard(a), decodeCard(b))];
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export interface RangeView {
  seat: number;
  belief: BeliefDistribution;
  /** Per-cell probability the seat holds a hand in that class. Sums to 1. */
  grid: Float64Array;
  /** Combos left in each cell once the dead cards are removed. */
  cellCombos: Uint16Array;
  /** Live combos in total, out of 1326. */
  liveCombos: number;
  /** Belief mass on each tier after removal, renormalised. */
  tierWeight: [number, number, number];
  /** Weight on each board-relative bucket, from `classifyAll`. */
  buckets: Float64Array;
  /** Largest single-cell probability — the top of the heat scale. */
  maxCell: number;
  /**
   * Smallest set of combos holding half the range's weight. The honest measure
   * of "how narrow is this read": a flat read needs half the deck, a read
   * pinned on one tier needs a fraction of it.
   */
  half: { combos: number; fraction: number };
}

/**
 * The distribution the sampler would draw this seat's hole cards from.
 *
 * `dead` is every card the range cannot contain — the reviewing seat's own
 * hole cards plus the board. Blockers are not a special case here any more than
 * they are in `range.removeCards`: a card that is visible is simply absent from
 * the pool the combos are built out of.
 */
export function rangeView(
  seat: number,
  belief: BeliefDistribution,
  dead: number[],
  board: number[]
): RangeView {
  const used = new Uint8Array(52);
  for (const c of dead) if (c >= 0 && c < 52) used[c] = 1;
  const pool: number[] = [];
  for (let c = 0; c < 52; c++) if (!used[c]) pool.push(c);

  const cellCombos = new Uint16Array(GRID_CELLS);
  const tierCount: [number, number, number] = [0, 0, 0];
  const live: number[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const combo = comboIndex(pool[i], pool[j]);
      const cell = gridCellOf(combo);
      cellCombos[cell]++;
      tierCount[CELL_TIER[cell]]++;
      live.push(combo);
    }
  }

  // A tier with no live combos cannot be held, so its mass is redistributed
  // rather than silently lost — the same choice `beliefsFor` makes when it
  // normalises a read before sampling from it.
  const b = normalize(belief);
  const raw: [number, number, number] = [b.weak, b.medium, b.strong];
  let total = 0;
  for (let t = 0; t < 3; t++) if (tierCount[t] > 0) total += raw[t];
  const tierWeight: [number, number, number] = [0, 0, 0];
  for (let t = 0; t < 3; t++) {
    tierWeight[t] = total > 0 && tierCount[t] > 0 ? raw[t] / total : 0;
  }

  const range = new Float64Array(COMBO_COUNT);
  for (const combo of live) {
    const t = CELL_TIER[gridCellOf(combo)];
    range[combo] = tierCount[t] > 0 ? tierWeight[t] / tierCount[t] : 0;
  }

  const grid = toGrid(range);
  let maxCell = 0;
  for (let i = 0; i < GRID_CELLS; i++) if (grid[i] > maxCell) maxCell = grid[i];

  const ctx = makeBoardContext(Uint8Array.from(board));
  const classes = classifyAll(ctx);
  const buckets = new Float64Array(BUCKET_COUNT);
  for (const combo of live) buckets[classes[combo]] += range[combo];

  // Rank cells by weight *per combo* — the density the sampler actually sees —
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
    belief: b,
    grid,
    cellCombos,
    liveCombos: live.length,
    tierWeight,
    buckets,
    maxCell,
    half: { combos, fraction: live.length > 0 ? combos / live.length : 0 },
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

/** Last decision each seat made on each street — the most informed one. */
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
 * standard error at p ≈ 0.13 around 0.24 points — under the display precision,
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
 * "what was my equity here" needs no read, no range and no belief — only the
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
   *  - `actual` — both seats' real hole cards, run out over the real board by
   *    `headsUpEquity`. The true answer, available because the hand is over.
   *  - `estimate` — the reviewing seat's own recorded Monte Carlo against this
   *    opponent, used only when the opponent's cards are missing from the
   *    record. Its own cards are real; the opponent's are drawn from the read.
   *
   * There is deliberately no third case. The opponent's `perOpponent[focus]`
   * inverts to "the bot's read on you, versus the bot's hand" — the reviewing
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
 * The decisions decide *who* appears — a matchup is on the panel iff one of the
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
        // No cards on record for the opponent — a hand that ended before this
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
 * cap is the smallest investment among the seats eligible for it — the shortest
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
