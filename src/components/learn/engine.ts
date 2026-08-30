/**
 * Engine adapters for the two explanatory surfaces.
 *
 * The review's Math tab and the concepts page both need to run the engine
 * rather than quote it, a break-even frequency worked at this hand's pot, the
 * category distribution of a real holding, the model a session's own decisions
 * would build, an equilibrium for the river that was actually dealt. Every one
 * of those is a call into `poker/*`, and none of them belongs in a component.
 *
 * The rule the whole file exists to keep: nothing here invents a number. Each
 * function either returns what the engine computed or returns null with a
 * reason, and the reasons are specific enough to print. Where the engine needs
 * an input the hand record does not carry, stack depth on the river is the one
 * real case, the assumption is a named field on the result so the UI is forced
 * to disclose it rather than able to quietly absorb it.
 */

import { decodeCard } from "../../poker/core/card";
import { makeRng } from "../../poker/core/rng";
import { runFullKnowledgeMonteCarlo } from "../../poker/monteCarlo";
import {
  BUCKET_COUNT,
  classifyAll,
  classifyHole,
  makeBoardContext,
  type HandBucket,
} from "../../poker/model/buckets";
import { createLikelihoodModel, modelStats, observe } from "../../poker/model/learn";
import {
  FACINGS,
  POSITIONS,
  STREETS,
  type LearnStreet,
  type LikelihoodModel,
} from "../../poker/model/likelihood";
import {
  cloneRange,
  comboIndex,
  emptyRange,
  normalizeRange,
  COMBO_COUNT,
  type Range,
} from "../../poker/model/range";
import {
  buildRiverGame,
  createSolver,
  TERMINAL_DECISION,
  type PublicTree,
} from "../../poker/solver/cfr";
import { exploitability } from "../../poker/solver/exploitability";
import type {
  ActionRecord,
  TableHandReport,
} from "../../poker/table/contract";
import {
  HandCategory,
  HAND_CATEGORY_NAMES,
  type Card,
  type MonteCarloResult,
  type PlayerActionType,
  type Street,
} from "../../types";
import { appliedLikelihood } from "../report/derive";

// ---------------------------------------------------------------------------
// Fold equity: alpha and MDF
// ---------------------------------------------------------------------------

/**
 * Bet sizes as a fraction of the pot, the four the literature quotes.
 *
 * They are here as inputs to the formula below, not as answers: the published
 * 33.3 / 42.9 / 50 / 66.7 table is produced by evaluating `alphaOf` at these
 * fractions, and `poker/ev.test.ts` pins the same four numbers against the
 * implementation in `poker/ev.ts`. Nothing in this module stores a break-even
 * frequency.
 */
export const QUOTED_FRACTIONS: readonly number[] = [0.5, 0.75, 1, 2];

/**
 * The break-even bluffing frequency, `alpha = s / (P + s)`.
 *
 * Straight out of `poker/ev.ts`'s ALPHA note: with no equity at all the fold
 * branch of `EV(bet s) = P(fold)·Pot + (1 − P(fold))·[E·(Pot + 2s) − s]`
 * collapses to `P(fold)·Pot − (1 − P(fold))·s`, which is zero exactly here.
 */
export function alphaOf(pot: number, size: number): number {
  return pot + size > 0 ? size / (pot + size) : 0;
}

/** Minimum defence frequency, `1 − alpha = P / (P + s)`. Same note. */
export function mdfOf(pot: number, size: number): number {
  return pot + size > 0 ? pot / (pot + size) : 0;
}

export interface PriceRung {
  /** Bet size as a fraction of the pot. */
  fraction: number;
  /** The size in chips, at the pot this rung was evaluated against. */
  size: number;
  alpha: number;
  mdf: number;
}

/** The published table, evaluated at a real pot rather than looked up. */
export function priceLadder(pot: number): PriceRung[] {
  return QUOTED_FRACTIONS.map((fraction) => {
    const size = pot * fraction;
    return { fraction, size, alpha: alphaOf(pot, size), mdf: mdfOf(pot, size) };
  });
}

// ---------------------------------------------------------------------------
// Hand-category distribution
// ---------------------------------------------------------------------------

/** Categories in ladder order, weakest first, the axis of the shape chart. */
export const CATEGORY_ORDER: readonly HandCategory[] = [
  HandCategory.HighCard,
  HandCategory.Pair,
  HandCategory.TwoPair,
  HandCategory.ThreeOfAKind,
  HandCategory.Straight,
  HandCategory.Flush,
  HandCategory.FullHouse,
  HandCategory.FourOfAKind,
  HandCategory.StraightFlush,
];

export interface CategoryShare {
  category: HandCategory;
  name: string;
  /** P(final hand is this category) for the hero. */
  p: number;
  /** Trials that produced it, `p × simulations`, rounded. */
  hits: number;
}

export interface CategoryRun {
  result: MonteCarloResult;
  shares: CategoryShare[];
  /** Board cards still to come when the run was made. */
  unknown: number;
  /** True when the board was already complete, so nothing was sampled. */
  settled: boolean;
  /** Runouts the deck still allowed, `C(pool, unknown)`. */
  runouts: number;
}

function poolFor(used: number[]): Card[] {
  const seen = new Uint8Array(52);
  for (const c of used) if (c >= 0 && c < 52) seen[c] = 1;
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) if (!seen[c]) out.push(decodeCard(c));
  return out;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}

/**
 * The hero's final made-hand category distribution, both hole hands known.
 *
 * `runFullKnowledgeMonteCarlo` is the engine's own post-hand estimator, the one
 * the legacy analysis page used for its distribution chart, so the shape here
 * is the shape the engine reports, at the trial count asked for. With the board
 * complete it does not sample at all: the category is settled and the
 * distribution is a point mass, which is the information ladder's last rung
 * showing up in a second place.
 */
export function categoryRun(
  hero: number[],
  villain: number[],
  board: number[],
  sims: number,
  seed: number
): CategoryRun | null {
  if (hero.length !== 2 || villain.length !== 2 || board.length > 5) return null;
  const seen = new Set([...hero, ...villain, ...board]);
  if (seen.size !== hero.length + villain.length + board.length) return null;

  const pool = poolFor([...hero, ...villain, ...board]);
  const unknown = 5 - board.length;
  const result = runFullKnowledgeMonteCarlo(
    hero.map(decodeCard),
    villain.map(decodeCard),
    board.map(decodeCard),
    pool,
    sims,
    makeRng(seed)
  );

  const shares = CATEGORY_ORDER.map((category) => ({
    category,
    name: HAND_CATEGORY_NAMES[category],
    p: result.categoryFrequencies[category] ?? 0,
    hits: Math.round((result.categoryFrequencies[category] ?? 0) * sims),
  }));

  return {
    result,
    shares,
    unknown,
    settled: unknown === 0,
    runouts: choose(pool.length, unknown),
  };
}

// ---------------------------------------------------------------------------
// What a session's own decisions teach the model
// ---------------------------------------------------------------------------

/** Community cards a decision on each street could see. */
const BOARD_AT: Record<LearnStreet, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

export interface SessionModel {
  /** The model the session's decisions build, prior included. */
  model: LikelihoodModel;
  /** The same prior with nothing observed, the before to the model's after. */
  fresh: LikelihoodModel;
  hands: number;
  observations: number;
  /** Decisions from hands that were actually revealed at showdown. */
  attributed: number;
  /** Decisions from hands that were mucked, bucket-free levels only. */
  unattributed: number;
  /** Distinct cells the observations touched, across all six levels. */
  cells: number;
  /** Cells the finest level has: buckets × streets × positions × facings. */
  cellSpace: number;
  /** Attributed decisions per board-relative bucket. */
  byBucket: number[];
  byAction: Record<PlayerActionType, number>;
}

/**
 * Build a per-player likelihood model out of finished hands.
 *
 * Every number this produces is an observation from the record, and the split
 * between attributed and unattributed is the one `model/learn.ts` insists on: a
 * hand that reached showdown was seen, so its decisions carry the board-relative
 * class the seat actually held; a hand that was mucked writes only to the two
 * bucket-free levels, because assigning it a class would be inventing the one
 * fact the fold withheld.
 *
 * The class is measured against the board *as it stood on each decision's own
 * street*, not against the final board, a seat that check-called the flop with
 * a gutshot and rivered a straight took the flop decision with a draw, and the
 * taxonomy is board-relative precisely so it can say so.
 *
 * IMPORTANT, and stated wherever this is displayed: the live table does not
 * learn. `model/decider.ts` prices every hand against a fresh
 * `createLikelihoodModel("poker")` that is never written to, and nothing in the
 * app calls `learn.observe`. This is the model the session's own play would
 * produce, computed from the archive after the fact.
 */
export function learnSeat(
  reports: readonly TableHandReport[],
  seat: number
): SessionModel {
  const model = createLikelihoodModel("poker");
  const byBucket = new Array<number>(BUCKET_COUNT).fill(0);
  const byAction: Record<PlayerActionType, number> = {
    check: 0,
    bet: 0,
    call: 0,
    raise: 0,
    fold: 0,
  };
  let hands = 0;

  for (const report of reports) {
    const result = report.seats.find((s) => s.seat === seat);
    if (!result || result.hole.length !== 2) continue;
    const revealed = result.final !== null;
    let acted = false;

    report.actions.forEach((record, index) => {
      if (record.seat !== seat) return;
      const node = appliedLikelihood(report, index);
      if (!node) return;
      acted = true;

      let bucket: HandBucket | null = null;
      if (revealed) {
        const visible = Math.min(BOARD_AT[node.street], report.board.length);
        bucket = classifyHole(
          result.hole[0],
          result.hole[1],
          makeBoardContext(report.board.slice(0, visible))
        );
        byBucket[bucket] += 1;
      }

      observe(model, {
        action: record.action,
        bucket,
        street: node.street,
        position: node.position,
        facing: node.facing,
      });
      byAction[record.action] += 1;
    });

    if (acted) hands += 1;
  }

  const stats = modelStats(model);
  return {
    model,
    fresh: createLikelihoodModel("poker"),
    hands,
    observations: stats.observations,
    attributed: stats.attributed,
    unattributed: stats.unattributed,
    cells: stats.cells,
    cellSpace: BUCKET_COUNT * STREETS.length * POSITIONS.length * FACINGS.length,
    byBucket,
    byAction,
  };
}

// ---------------------------------------------------------------------------
// The river, solved
// ---------------------------------------------------------------------------

/**
 * Combos kept per side before solving.
 *
 * A reweighted range is dense, every likelihood is bounded below by the prior's
 * uniform mixture, so no combo is ever exactly zero, and the full 1081 x 1081
 * river measures ~2ms per iteration (`cfr.test.ts`, "holds its throughput on the
 * widest ranges"), which is a solve a browser tab cannot afford between two
 * paints. Keeping the heaviest 220 combos a side measures 60-90ms for the whole
 * solve including its exploitability check, against ~30ms at 110 and a budget of
 * a couple of hundred: worth paying, because the weight retained roughly doubles.
 * That weight is reported as `coverage` and shown, so the abstraction is visible
 * rather than assumed.
 */
const SOLVE_HANDS = 220;

/** Iterations. 400 gets a realistic spot under 1% in `cfr.test.ts`; this is a
 * review panel, so it trades a little accuracy for a paint. `exploitability`
 * is measured and shown, which makes the trade auditable. */
const SOLVE_ITERATIONS = 240;

export interface SolvedMove {
  label: string;
  probability: number;
  /** True for the tree action matched to what the seat actually did. */
  taken: boolean;
}

export interface RiverSolve {
  /** Seat that is out of position, player 0, and the root's actor. */
  oop: number;
  ip: number;
  /** The seat the comparison is written for. */
  hero: number;
  heroIsOop: boolean;
  pot: number;
  /**
   * Effective stack the subgame was solved at.
   *
   * NOT from the record. `TableHandReport` carries no stack sizes and no blind
   * level, so this is the deepest commitment the river actually saw, floored at
   * one pot. Every panel showing this solve has to say so.
   */
  stack: number;
  stackAssumed: boolean;
  iterations: number;
  /** Milliseconds inside `solver.step`, what `solveRiver` reports as its own. */
  solveMs: number;
  /** Milliseconds for everything: ranges, tree, solve, exploitability. */
  totalMs: number;
  nodes: number;
  decisionNodes: number;
  handCounts: [number, number];
  /** Range weight surviving the prune, per player. */
  coverage: [number, number];
  /** Exploitability of the solved profile, in chips per hand. */
  exploitChips: number;
  /** The same as a share of the river pot, the record carries no big blind. */
  exploitPotShare: number;
  /** The equilibrium mix for the hero's actual holding at its first decision. */
  mix: SolvedMove[];
  /** What the hero actually did there. */
  actual: ActionRecord;
  /** Tree action the real move was matched to, and whether the size was exact. */
  matched: string | null;
  /** True when an opponent bet had to be snapped to the tree's nearest rung. */
  approximated: boolean;
  /** Rank of the hero's hand inside its own river range, 1 = weakest. */
  handRank: number;
  handTotal: number;
}

export type RiverSolveResult =
  | { ok: true; solve: RiverSolve }
  | { ok: false; reason: string };

/** Keep the `keep` heaviest combos, plus any that must survive, renormalised. */
function pruneRange(range: Range, keep: number, must: number[]): {
  range: Range;
  coverage: number;
} {
  let total = 0;
  for (let c = 0; c < COMBO_COUNT; c++) total += range[c];
  if (!(total > 0)) return { range: cloneRange(range), coverage: 0 };

  const order: number[] = [];
  for (let c = 0; c < COMBO_COUNT; c++) if (range[c] > 0) order.push(c);
  order.sort((a, b) => range[b] - range[a]);

  const chosen = new Set<number>(order.slice(0, keep));
  for (const c of must) if (range[c] > 0) chosen.add(c);

  const out = emptyRange();
  let kept = 0;
  for (const c of chosen) {
    out[c] = range[c];
    kept += range[c];
  }
  normalizeRange(out);
  return { range: out, coverage: kept / total };
}

/** The chip fraction a tree label stands for: `b67` is two thirds of the pot. */
function labelFraction(label: string): number | null {
  const m = /^[br](\d+)$/.exec(label);
  if (m) return Number(m[1]) / 100;
  if (label === "allin") return Number.POSITIVE_INFINITY;
  return null;
}

function actionsAt(tree: PublicTree, node: number): { label: string; child: number }[] {
  const off = tree.childOffset[node];
  return Array.from({ length: tree.actionCount[node] }, (_, k) => ({
    label: tree.actionLabels[off + k],
    child: tree.children[off + k],
  }));
}

/**
 * The tree action that best stands for a real move.
 *
 * Exact for check, call and fold. A bet or raise is snapped to the nearest rung
 * of the size abstraction, the tree offers a third, two thirds, pot and all-in
 *, and the caller is told that a snap happened, because a solved strategy at
 * two-thirds pot is not a claim about a bet of 0.7 pot without that caveat.
 */
function matchMove(
  tree: PublicTree,
  node: number,
  record: ActionRecord
): { label: string; child: number; approximated: boolean } | null {
  const options = actionsAt(tree, node);
  if (record.action === "check" || record.action === "fold" || record.action === "call") {
    const exact = options.find((o) => o.label === record.action);
    return exact ? { ...exact, approximated: false } : null;
  }
  const pot = record.potBefore;
  if (!(pot > 0)) return null;
  const want = record.cost / pot;
  let best: { label: string; child: number } | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const fraction = labelFraction(option.label);
    if (fraction === null) continue;
    const gap = Math.abs(
      (fraction === Number.POSITIVE_INFINITY ? 4 : fraction) - want
    );
    if (gap < bestGap) {
      bestGap = gap;
      best = option;
    }
  }
  return best ? { ...best, approximated: bestGap > 1e-9 } : null;
}

const RIVER: Street = "river";

/**
 * Solve the river the hand actually reached, and read off what equilibrium does
 * with the hero's exact holding at its first river decision.
 *
 * Every precondition it declines on is a real limit of the subgame solver, not
 * an implementation shortcut: it is a two-player solver (`HandInteraction` has
 * two hand vectors), it needs a five-card board, and it needs the hero to have
 * had a river decision to compare against.
 */
export function solveReviewRiver(
  report: TableHandReport,
  hero: number,
  rangeFor: (seat: number) => Range
): RiverSolveResult {
  if (report.board.length !== 5) {
    return { ok: false, reason: "the hand never reached a five-card board" };
  }

  const riverIndex = report.actions.findIndex((a) => a.street === RIVER);
  if (riverIndex < 0) {
    return { ok: false, reason: "there was no betting on the river" };
  }
  const river = report.actions.filter((a) => a.street === RIVER);

  const live = new Set(river.map((a) => a.seat));
  // A seat that folded earlier never acts on the river, so the actors are the
  // field, unless somebody was already all-in, in which case there is no river
  // decision for them to have and the two-player tree still describes what is
  // left.
  if (live.size !== 2) {
    return {
      ok: false,
      reason:
        live.size < 2
          ? "only one seat acted on the river, so there was no subgame to solve"
          : `${live.size} seats acted on the river and the solver is two-player`,
    };
  }
  if (!live.has(hero)) {
    return { ok: false, reason: "this seat had no river decision" };
  }

  const oop = river[0].seat;
  const ip = [...live].find((s) => s !== oop)!;
  const holes = new Map(report.seats.map((s) => [s.seat, s.hole]));
  if (holes.get(oop)?.length !== 2 || holes.get(ip)?.length !== 2) {
    return { ok: false, reason: "a seat's cards are missing from the record" };
  }

  const pot = river[0].potBefore;
  if (!(pot > 0)) return { ok: false, reason: "the river pot was empty" };
  const deepest = river.reduce((most, a) => Math.max(most, a.cost), 0);
  const stack = Math.max(pot, deepest);

  const started = performance.now();

  const heroCombo = comboIndex(holes.get(hero)![0], holes.get(hero)![1]);
  const oopCombo = comboIndex(holes.get(oop)![0], holes.get(oop)![1]);
  const ipCombo = comboIndex(holes.get(ip)![0], holes.get(ip)![1]);
  const oopPruned = pruneRange(rangeFor(oop), SOLVE_HANDS, [oopCombo]);
  const ipPruned = pruneRange(rangeFor(ip), SOLVE_HANDS, [ipCombo]);
  if (oopPruned.coverage <= 0 || ipPruned.coverage <= 0) {
    return { ok: false, reason: "a seat's range came back empty" };
  }

  let game;
  try {
    game = buildRiverGame(
      { pot, stack },
      report.board,
      oopPruned.range,
      ipPruned.range
    );
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const solver = createSolver(game.tree, game.interaction, game.priors);
  const solveStart = performance.now();
  solver.step(SOLVE_ITERATIONS);
  const strategy = solver.averageStrategy();
  const solveMs = performance.now() - solveStart;

  // Walk to the hero's first river decision. Only the moves before it are
  // replayed, and only two of them can exist before the hero acts (the hero is
  // either first to act or answering one move).
  const heroIsOop = hero === oop;
  let node = game.tree.root;
  let approximated = false;
  const before = river.slice(0, river.findIndex((a) => a.seat === hero));
  if (before.length > 1) {
    return {
      ok: false,
      reason:
        "this seat's first river move came after more betting than the tree replays",
    };
  }
  for (const record of before) {
    const match = matchMove(game.tree, node, record);
    if (!match) {
      return { ok: false, reason: `no tree action stands for a ${record.action} here` };
    }
    approximated = approximated || match.approximated;
    node = match.child;
  }
  if (game.tree.kind[node] !== TERMINAL_DECISION) {
    return { ok: false, reason: "the replayed line ends the hand before this seat acts" };
  }

  const player = game.tree.player[node] as 0 | 1;
  if ((player === 0) !== heroIsOop) {
    return { ok: false, reason: "the tree has the other seat acting at this node" };
  }

  const hands = game.hands[player];
  let handIndex = -1;
  for (let i = 0; i < hands.count; i++) {
    if (hands.combo[i] === heroCombo) {
      handIndex = i;
      break;
    }
  }
  if (handIndex < 0) {
    return { ok: false, reason: "this seat's holding is not in the range it was solved with" };
  }

  const actual = river.find((a) => a.seat === hero)!;
  const matched = matchMove(game.tree, node, actual);
  const s = strategy[node];
  const mix: SolvedMove[] = actionsAt(game.tree, node).map((option, k) => ({
    label: option.label,
    probability: s[k * hands.count + handIndex],
    taken: matched !== null && option.label === matched.label,
  }));

  const chips = exploitability(game.tree, game.interaction, game.priors, strategy);
  const totalMs = performance.now() - started;

  let decisionNodes = 0;
  for (let n = 0; n < game.tree.nodeCount; n++) {
    if (game.tree.kind[n] === TERMINAL_DECISION) decisionNodes++;
  }

  return {
    ok: true,
    solve: {
      oop,
      ip,
      hero,
      heroIsOop,
      pot,
      stack,
      stackAssumed: true,
      iterations: SOLVE_ITERATIONS,
      solveMs,
      totalMs,
      nodes: game.tree.nodeCount,
      decisionNodes,
      handCounts: [game.hands[0].count, game.hands[1].count],
      coverage: [oopPruned.coverage, ipPruned.coverage],
      exploitChips: chips,
      exploitPotShare: pot > 0 ? chips / pot : 0,
      mix,
      actual,
      matched: matched?.label ?? null,
      approximated: approximated || (matched?.approximated ?? false),
      handRank: handIndex + 1,
      handTotal: hands.count,
    },
  };
}

// ---------------------------------------------------------------------------
// Notation, for the concepts page's worked examples
// ---------------------------------------------------------------------------

const RANK_TEXT = "23456789TJQKA";
const SUIT_TEXT = "shdc";

/**
 * "As" -> the integer code the engine works in.
 *
 * A parser, not a table: the concepts page names its example cards the way a
 * poker book does, and every number it then shows is computed from the codes
 * this returns. Throws on nonsense so a typo in an example is a crash in
 * development rather than a silently different hand in production.
 */
export function cardCode(text: string): number {
  const rank = RANK_TEXT.indexOf(text[0]?.toUpperCase() ?? "");
  const suit = SUIT_TEXT.indexOf(text[1]?.toLowerCase() ?? "");
  if (rank < 0 || suit < 0) throw new Error(`cardCode: not a card: ${text}`);
  return (rank << 2) | suit;
}

/** `cardCode` over a whitespace-separated list: "Ah Kd" or "Kc 7h 2s". */
export function cardCodes(text: string): number[] {
  return text.trim().length === 0 ? [] : text.trim().split(/\s+/).map(cardCode);
}

// ---------------------------------------------------------------------------
// How an estimate converges
// ---------------------------------------------------------------------------

export interface ConvergencePoint {
  simulations: number;
  pWin: number;
  equity: number;
  /** Wald standard error on pWin. */
  se: number;
  ci: { lo: number; hi: number };
  /** Wall-clock milliseconds for this run. */
  ms: number;
}

/**
 * The same matchup estimated at increasing sample sizes.
 *
 * The point it makes is the one every Monte Carlo rests on and no static figure
 * can: the interval narrows as 1/√n, so four times the trials buys half the
 * error, and the estimate itself wanders inside the interval rather than walking
 * steadily toward the answer. Each row is an independent run, a different seed
 *, because rows that shared one would be nested samples and would look far
 * better behaved than sampling actually is.
 */
export function convergence(
  hero: number[],
  villain: number[],
  board: number[],
  sizes: readonly number[],
  seed: number
): ConvergencePoint[] {
  const pool = poolFor([...hero, ...villain, ...board]);
  return sizes.map((simulations, i) => {
    const started = performance.now();
    const result = runFullKnowledgeMonteCarlo(
      hero.map(decodeCard),
      villain.map(decodeCard),
      board.map(decodeCard),
      pool,
      simulations,
      makeRng(seed + i * 7919)
    );
    return {
      simulations,
      pWin: result.pWin,
      equity: result.pWin + result.pTie / 2,
      se: result.se,
      ci: result.ciWin,
      ms: performance.now() - started,
    };
  });
}

// ---------------------------------------------------------------------------
// What a board does to the deck
// ---------------------------------------------------------------------------

export interface BoardClasses {
  /** Combos in each class, out of the 1326 the deck holds. */
  counts: number[];
  /** The same as shares of the live combos. */
  shares: number[];
  live: number;
}

/**
 * Every hole-card combination classified against one board.
 *
 * This is `classifyAll`, the same call a decision makes, and the reason a range
 * chart means anything, counted rather than weighted, so it answers "what does
 * this board do to the deck" independently of what anyone is believed to hold.
 */
export function boardClasses(board: number[]): BoardClasses {
  const classes = classifyAll(makeBoardContext(board));
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;

  const counts = new Array<number>(BUCKET_COUNT).fill(0);
  let live = 0;
  for (let a = 0; a < 52; a++) {
    if (dead[a]) continue;
    for (let b = a + 1; b < 52; b++) {
      if (dead[b]) continue;
      counts[classes[comboIndex(a, b)]] += 1;
      live += 1;
    }
  }
  return {
    counts,
    shares: counts.map((n) => (live > 0 ? n / live : 0)),
    live,
  };
}

// ---------------------------------------------------------------------------
// A solve you can watch converge
// ---------------------------------------------------------------------------

export interface SolveDemoPoint {
  iterations: number;
  /** Exploitability in thousandths of a big blind per hand. */
  mbb: number;
  ms: number;
}

export interface SolveDemo {
  points: SolveDemoPoint[];
  hands: [number, number];
  nodes: number;
  decisionNodes: number;
  totalMs: number;
  pot: number;
  stack: number;
  bigBlind: number;
}

/**
 * Solve a river spot from scratch, measuring exploitability as it goes.
 *
 * Unlike the review's solve this one owns its whole specification, pot, stacks,
 * blind level, both ranges, so exploitability can be quoted in the standard
 * unit (mbb/h, thousandths of a big blind per hand) rather than in chips. The
 * shape of the returned curve is the deliverable: a solver that is doing
 * anything at all drives it down, and one that is not produces a flat or
 * wandering line no matter how plausible its strategies look.
 */
export function solveDemo(
  board: number[],
  oop: Range,
  ip: Range,
  checkpoints: readonly number[],
  spec: { pot: number; stack: number; bigBlind: number }
): SolveDemo {
  const started = performance.now();
  const game = buildRiverGame(
    { pot: spec.pot, stack: spec.stack },
    board,
    oop,
    ip
  );
  const solver = createSolver(game.tree, game.interaction, game.priors);

  const points: SolveDemoPoint[] = [];
  for (const target of checkpoints) {
    const at = performance.now();
    solver.step(target - solver.iterations);
    points.push({
      iterations: solver.iterations,
      mbb:
        (exploitability(
          game.tree,
          game.interaction,
          game.priors,
          solver.averageStrategy()
        ) /
          spec.bigBlind) *
        1000,
      ms: performance.now() - at,
    });
  }

  let decisionNodes = 0;
  for (let n = 0; n < game.tree.nodeCount; n++) {
    if (game.tree.kind[n] === TERMINAL_DECISION) decisionNodes++;
  }

  return {
    points,
    hands: [game.hands[0].count, game.hands[1].count],
    nodes: game.tree.nodeCount,
    decisionNodes,
    totalMs: performance.now() - started,
    pot: spec.pot,
    stack: spec.stack,
    bigBlind: spec.bigBlind,
  };
}

