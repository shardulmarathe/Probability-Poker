/**
 * Everything the hand review reads out of a finished `TableHandReport`.
 *
 * The report is a factual record — cards, chips, actions, and the decisions the
 * bots actually priced. It is deliberately *not* a set of conclusions, so every
 * derived quantity on the review pages is computed here, in one place, from
 * that record alone. Nothing in this module simulates anything: if a number
 * cannot be recovered from what the engine wrote down, the review says so
 * rather than inventing it.
 *
 * The one piece of real reconstruction is `rangeView`. The table's read on a
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

export const BETTING_STREETS: Street[] = ["preflop", "flop", "turn", "river"];

export const STREET_LABEL: Record<Street, string> = {
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

/** Community cards face-up once a street has been dealt. */
export const BOARD_LEN: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
  showdown: 5,
};

export function streetIndex(street: Street): number {
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
export const CELL_TIER: Uint8Array = (() => {
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
export function lastDecisions(
  decisions: BotDecision[]
): Map<string, BotDecision> {
  const out = new Map<string, BotDecision>();
  for (const d of decisions) out.set(`${d.street}:${d.seat}`, d);
  return out;
}

export interface HeadToHead {
  seat: number;
  /** The reviewing seat's equity against this opponent alone. */
  equity: number;
  /**
   * Whether the number was recorded by the reviewing seat's own estimate, or
   * recovered by inverting the opponent's estimate of the same matchup. A
   * human seat never runs a Monte Carlo, so every number for it is inverted.
   */
  source: "own" | "inverted";
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
 * `perOpponent` is symmetric information recorded asymmetrically: a bot stores
 * its equity against every seat it is facing, so when the reviewing seat is a
 * human — which never runs a simulation and therefore records nothing — the
 * same matchup can still be read off the opponent's own decision and inverted.
 * That is the only way a human's hand review shows real numbers at all, and it
 * is labelled as inverted wherever it appears.
 */
export function streetEquities(
  report: TableHandReport,
  focus: number
): StreetEquity[] {
  const last = lastDecisions(report.decisions);
  const out: StreetEquity[] = [];

  for (const street of BETTING_STREETS) {
    if (BOARD_LEN[street] > report.board.length) continue;
    const own = last.get(`${street}:${focus}`) ?? null;

    // Every decision on the street is scanned rather than only the last one
    // per seat. A seat that folds early stops appearing in anybody's
    // `perOpponent` from that point on, so taking only the final decision of
    // each opponent would silently erase the whole panel for exactly the hands
    // where folding was the decision under review. Later entries overwrite
    // earlier ones, so what survives is the most informed estimate that still
    // had the reviewing seat in the pot.
    const mine = new Map<number, number>();
    const theirs = new Map<number, number>();
    for (const d of report.decisions) {
      if (d.street !== street) continue;
      if (d.seat === focus) {
        for (const [key, value] of Object.entries(d.equity.perOpponent ?? {})) {
          mine.set(Number(key), value);
        }
      } else {
        const value = d.equity.perOpponent?.[focus];
        if (typeof value === "number") theirs.set(d.seat, 1 - value);
      }
    }

    const seats = [...new Set([...mine.keys(), ...theirs.keys()])].sort(
      (a, b) => a - b
    );
    const vs: HeadToHead[] = seats.map((seat) =>
      mine.has(seat)
        ? { seat, equity: mine.get(seat)!, source: "own" as const }
        : { seat, equity: theirs.get(seat)!, source: "inverted" as const }
    );

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
