/**
 * Heads-up preflop push/fold: the correctness anchor for the CFR core.
 *
 * The small blind may only shove or fold; the big blind may only call or fold.
 * That is a tiny game, but it is the one poker game in here whose equilibrium
 * has been published and independently recomputed by many people, see the
 * HoldemResources HUNE tables, which `pushfold.test.ts` checks against hand by
 * hand. The river solver has no published answer to compare with, so if this
 * one disagrees with the charts, nothing else in the solver can be trusted
 * either.
 *
 * Two modelling choices, both forced:
 *
 *  - The game is solved over the 169 chart classes, not the 1326 combos.
 *    Preflop the whole game is invariant under permuting suits, so equilibrium
 *    frequencies are constant within a class; solving at the combo level would
 *    multiply the work by 60 and produce the same numbers. Card removal is not
 *    dropped along with the combos, `classCompatibility` keeps the exact count
 *    of disjoint combo pairs per class pair, so "AA blocks your aces" survives.
 *
 *  - Preflop all-in equity is estimated, not enumerated. An exact 169x169
 *    matrix means C(48,5) = 1.7M runouts for each of ~14k class matchups; that
 *    is off by many orders of magnitude from anything that can run in a test.
 *    Instead every matchup is scored on the same sampled boards (common
 *    random numbers), which is what makes the differences between neighbouring
 *    hands, the only thing a push/fold threshold depends on, far more
 *    accurate than the absolute equities. `equityStandardError` reports the
 *    residual, and the tests re-solve on a second seed to show what it moves.
 */

import { scoreInts } from "../handEvaluator";
import { makeRng } from "../core/rng";
import {
  comboCardA,
  comboCardB,
  COMBO_COUNT,
  GRID_CELLS,
  GRID_LABELS,
  gridCellOf,
} from "../model/range";
import {
  createSolver,
  DCFR,
  flattenTree,
  type HandInteraction,
  type PublicTree,
  type Solver,
  type SolverOptions,
} from "./cfr";
import { exploitabilityMbb } from "./exploitability";

export const CLASS_COUNT = GRID_CELLS;
export const CLASS_LABELS = GRID_LABELS;

// ---------------------------------------------------------------------------
// Class tables
// ---------------------------------------------------------------------------

/** Combo indices of each chart cell: 6 for a pair, 4 suited, 12 offsuit. */
const CLASS_COMBOS: Uint16Array[] = (() => {
  const buckets: number[][] = Array.from({ length: CLASS_COUNT }, () => []);
  for (let i = 0; i < COMBO_COUNT; i++) buckets[gridCellOf(i)].push(i);
  return buckets.map((b) => Uint16Array.from(b));
})();

/** How many combos of class X hold card c. */
const CLASS_CARD_COUNT = (() => {
  const t = new Int32Array(CLASS_COUNT * 52);
  for (let i = 0; i < COMBO_COUNT; i++) {
    const row = gridCellOf(i) * 52;
    t[row + comboCardA(i)]++;
    t[row + comboCardB(i)]++;
  }
  return t;
})();

export function classSize(cls: number): number {
  return CLASS_COMBOS[cls].length;
}

/**
 * `out[X * 169 + Y]` = the fraction of (combo of X, combo of Y) pairs that hold
 * no card in common, the exact card-removal weight between two chart cells.
 *
 * Counted in closed form rather than by a 1326x1326 scan: the only combo of Y
 * holding both of a given combo's cards is that combo itself, so inclusion-
 * exclusion over the two per-card counts is exact.
 */
export const classCompatibility: Float64Array = (() => {
  const out = new Float64Array(CLASS_COUNT * CLASS_COUNT);
  for (let x = 0; x < CLASS_COUNT; x++) {
    const cx = CLASS_COMBOS[x];
    for (let y = 0; y < CLASS_COUNT; y++) {
      const cy = CLASS_COMBOS[y];
      const row = y * 52;
      let conflicts = 0;
      for (let k = 0; k < cx.length; k++) {
        conflicts += CLASS_CARD_COUNT[row + comboCardA(cx[k])];
        conflicts += CLASS_CARD_COUNT[row + comboCardB(cx[k])];
      }
      // Each combo of X was double-counted against itself exactly when it is
      // also a combo of Y, i.e. when X === Y.
      const pairs = cx.length * cy.length - conflicts + (x === y ? cx.length : 0);
      out[x * CLASS_COUNT + y] = pairs / (cx.length * cy.length);
    }
  }
  return out;
})();

/** Prior over classes for a uniformly dealt hand: 6/1326, 4/1326 or 12/1326. */
export const CLASS_PRIOR: Float64Array = (() => {
  const p = new Float64Array(CLASS_COUNT);
  for (let x = 0; x < CLASS_COUNT; x++) p[x] = CLASS_COMBOS[x].length / COMBO_COUNT;
  return p;
})();

// ---------------------------------------------------------------------------
// Preflop all-in equity
// ---------------------------------------------------------------------------

export interface EquityOptions {
  /**
   * Sampled runouts. Every matchup is scored on all of them.
   *
   * 24000 costs ~3.8s once per (boards, seed) and lands 1005 of the 1014
   * published chart cells at 10/15/20bb. 100000 costs ~17s and lands 1012;
   * the remaining handful never resolve because they are hands the published
   * table itself puts within 0.1bb of the stack depth being tested.
   */
  readonly boards?: number;
  readonly seed?: number;
}

export interface EquityMatrix {
  /** `equity[X * 169 + Y]` = share of the pot class X wins against class Y. */
  readonly equity: Float64Array;
  /** Samples behind each entry, for the standard-error estimate. */
  readonly samples: Float64Array;
  readonly boards: number;
  readonly seed: number;
}

const DEFAULT_EQUITY: Required<EquityOptions> = { boards: 24_000, seed: 0x5eed };
const equityCache = new Map<string, EquityMatrix>();

/**
 * Monte Carlo estimate of the 169x169 all-in equity matrix.
 *
 * One representative combo per class is drawn per board, uniformly among the
 * class's combos that the board leaves alive, and then every pair of
 * representatives is scored.
 *
 * Dealing the board first and the hands second is not the same experiment as
 * dealing the hands first, and the difference is not small. A board with a king
 * on it leaves KK only three combos instead of six, so under uniform board
 * sampling every surviving KK combo stands in for half as many real deals as it
 * should, king-high boards get double weight, and AA vs KK comes out at 74.5%
 * instead of 82%. Each sample is therefore weighted by n_X * n_Y, the number of
 * live combos the board left the two classes, which is exactly the factor that
 * restores a uniform distribution over (hand, hand, board) triples.
 *
 * All 14k matchups share the board, which is deliberate: absolute equities move
 * together under a lucky board, so their differences, which is what decides
 * whether A5o shoves at 15bb, carry far less error than the per-matchup
 * standard error suggests.
 */
export function preflopEquityMatrix(options: EquityOptions = {}): EquityMatrix {
  const boards = options.boards ?? DEFAULT_EQUITY.boards;
  const seed = options.seed ?? DEFAULT_EQUITY.seed;
  const key = `${boards}:${seed}`;
  const hit = equityCache.get(key);
  if (hit) return hit;

  const rng = makeRng(seed);
  // Interleaved [weight, weight^2, wins] per matchup. The pair loop below is
  // the whole cost of this function and it touches all three accumulators for
  // every pair; keeping them adjacent turns three cache lines into one.
  const ACC = 3;
  const acc = new Float64Array(CLASS_COUNT * CLASS_COUNT * ACC);
  const samples = new Float64Array(CLASS_COUNT * CLASS_COUNT);

  const deck = new Uint8Array(52);
  for (let i = 0; i < 52; i++) deck[i] = i;
  const used = new Uint8Array(52);
  const buf = new Uint8Array(7);
  // The representative hand of each class, as a 52-bit card mask split across
  // two 32-bit halves: one AND per half replaces four card comparisons, and a
  // class the board left with no combos gets an all-ones mask so the same test
  // also skips it.
  const maskLo = new Int32Array(CLASS_COUNT);
  const maskHi = new Int32Array(CLASS_COUNT);
  const score = new Float64Array(CLASS_COUNT);
  /** Live combos of each class on this board, the importance weight. */
  const liveCount = new Float64Array(CLASS_COUNT);
  const live = new Uint16Array(12);

  for (let b = 0; b < boards; b++) {
    used.fill(0);
    for (let i = 0; i < 5; i++) {
      const j = i + rng.int(52 - i);
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
      buf[i] = deck[i];
      used[deck[i]] = 1;
    }

    for (let x = 0; x < CLASS_COUNT; x++) {
      const combos = CLASS_COMBOS[x];
      let n = 0;
      for (let k = 0; k < combos.length; k++) {
        const c = combos[k];
        if (used[comboCardA(c)] === 0 && used[comboCardB(c)] === 0) live[n++] = c;
      }
      liveCount[x] = n;
      if (n === 0) {
        maskLo[x] = -1;
        maskHi[x] = -1;
        continue;
      }
      const pick = live[rng.int(n)];
      const ca = comboCardA(pick);
      const cb = comboCardB(pick);
      maskLo[x] = (ca < 32 ? 1 << ca : 0) | (cb < 32 ? 1 << cb : 0);
      maskHi[x] = (ca >= 32 ? 1 << (ca - 32) : 0) | (cb >= 32 ? 1 << (cb - 32) : 0);
      buf[5] = ca;
      buf[6] = cb;
      score[x] = scoreInts(buf, 7);
    }

    // Upper triangle only; the mirror entry is 1 - equity by definition.
    for (let x = 0; x < CLASS_COUNT; x++) {
      const lo = maskLo[x];
      const hi = maskHi[x];
      if (lo === -1) continue;
      const sx = score[x];
      const nx = liveCount[x];
      let at = (x * CLASS_COUNT + x + 1) * ACC;
      for (let y = x + 1; y < CLASS_COUNT; y++, at += ACC) {
        if ((lo & maskLo[y]) !== 0 || (hi & maskHi[y]) !== 0) continue;
        const w = nx * liveCount[y];
        const sy = score[y];
        acc[at] += w;
        acc[at + 1] += w * w;
        if (sx > sy) acc[at + 2] += w;
        else if (sx === sy) acc[at + 2] += w * 0.5;
      }
    }
  }

  const equity = new Float64Array(CLASS_COUNT * CLASS_COUNT);
  for (let x = 0; x < CLASS_COUNT; x++) {
    // A class against itself is exactly a coin flip by symmetry, no sampling
    // needed, and pretending otherwise would inject noise onto the diagonal.
    equity[x * CLASS_COUNT + x] = 0.5;
    for (let y = x + 1; y < CLASS_COUNT; y++) {
      const i = x * CLASS_COUNT + y;
      const at = i * ACC;
      if (acc[at] === 0) throw new Error(`preflopEquityMatrix: no sample for ${x} vs ${y}`);
      const e = acc[at + 2] / acc[at];
      equity[i] = e;
      equity[y * CLASS_COUNT + x] = 1 - e;
      // Kish effective sample size: importance weights cost some precision, and
      // reporting the raw board count would overstate it.
      const eff = (acc[at] * acc[at]) / acc[at + 1];
      samples[i] = eff;
      samples[y * CLASS_COUNT + x] = eff;
    }
  }

  const built: EquityMatrix = { equity, samples, boards, seed };
  equityCache.set(key, built);
  return built;
}

/**
 * Root-mean-square standard error of the off-diagonal entries, treating each
 * board as one independent draw. Boards are shared across matchups, so this is
 * the per-matchup error and understates nothing except the correlation between
 * matchups, which helps rather than hurts the thresholds.
 */
export function equityStandardError(m: EquityMatrix): number {
  let acc = 0;
  let count = 0;
  for (let x = 0; x < CLASS_COUNT; x++) {
    for (let y = x + 1; y < CLASS_COUNT; y++) {
      const e = m.equity[x * CLASS_COUNT + y];
      const n = m.samples[x * CLASS_COUNT + y];
      acc += (e * (1 - e)) / n;
      count++;
    }
  }
  return Math.sqrt(acc / count);
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export interface PushFoldSpec {
  /** Effective stack in big blinds, counted before the blinds are posted. */
  readonly stack: number;
  readonly smallBlind?: number;
  readonly bigBlind?: number;
}

export interface PushFoldGame {
  readonly tree: PublicTree;
  readonly interaction: HandInteraction;
  readonly priors: readonly [Float64Array, Float64Array];
  readonly bigBlind: number;
}

/** Node ids of the two-decision tree. */
export const SB_NODE = 0;
export const BB_NODE = 2;
/** Action index of "push" at SB_NODE and "call" at BB_NODE. */
export const AGGRESSIVE = 1;

function pushFoldInteraction(equity: Float64Array): HandInteraction {
  // sign[X][Y] = compatibility x expected showdown sign, so both terminals are
  // one 169x169 mat-vec. Antisymmetric by construction (equity[Y][X] = 1 -
  // equity[X][Y]), which is why the same array serves both heroes.
  const sign = new Float64Array(CLASS_COUNT * CLASS_COUNT);
  for (let i = 0; i < sign.length; i++) {
    sign[i] = classCompatibility[i] * (2 * equity[i] - 1);
  }
  const matvec = (m: Float64Array, reach: Float64Array, out: Float64Array) => {
    for (let x = 0; x < CLASS_COUNT; x++) {
      const row = x * CLASS_COUNT;
      let acc = 0;
      for (let y = 0; y < CLASS_COUNT; y++) acc += m[row + y] * reach[y];
      out[x] = acc;
    }
  };
  return {
    handCount: [CLASS_COUNT, CLASS_COUNT],
    reachMass: (_hero, oppReach, out) => matvec(classCompatibility, oppReach, out),
    showdown: (_hero, oppReach, out) => matvec(sign, oppReach, out),
  };
}

/**
 * SB shoves or folds; BB calls or folds. Payoffs are net chips, already
 * zero-sum: there is no dead pot to shift out because both blinds are live.
 */
export function buildPushFoldGame(spec: PushFoldSpec, equity: Float64Array): PushFoldGame {
  const sb = spec.smallBlind ?? 0.5;
  const bb = spec.bigBlind ?? 1;
  const stack = spec.stack;
  if (!(stack > bb)) throw new Error("buildPushFoldGame: stack must exceed the big blind");

  const tree = flattenTree({
    kind: "decision",
    player: 0,
    actions: [
      // Folding the button costs exactly the small blind.
      { label: "fold", next: { kind: "fold", value: -sb } },
      {
        label: "push",
        next: {
          kind: "decision",
          player: 1,
          actions: [
            { label: "fold", next: { kind: "fold", value: bb } },
            // Both players are in for their whole stack, so the winner's net
            // gain is exactly one stack.
            { label: "call", next: { kind: "showdown", value: stack } },
          ],
        },
      },
    ],
  });

  return {
    tree,
    interaction: pushFoldInteraction(equity),
    priors: [CLASS_PRIOR, CLASS_PRIOR],
    bigBlind: bb,
  };
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

export interface PushFoldOptions extends SolverOptions, EquityOptions {
  /** Default 1500; the game has two decision nodes, so this is cheap. */
  readonly iterations?: number;
}

export interface PushFoldSolution {
  readonly spec: PushFoldSpec;
  /** Shove frequency per chart class, indexed like `GRID_LABELS`. */
  readonly push: Float64Array;
  /** Call frequency per chart class facing the shove. */
  readonly call: Float64Array;
  /** Combo-weighted share of all hands shoved / called. */
  readonly pushShare: number;
  readonly callShare: number;
  readonly exploitabilityMbb: number;
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly solver: Solver;
  readonly game: PushFoldGame;
}

export function solvePushFold(
  spec: PushFoldSpec,
  options: PushFoldOptions = {}
): PushFoldSolution {
  const { equity } = preflopEquityMatrix(options);
  const game = buildPushFoldGame(spec, equity);
  const iterations = options.iterations ?? 1500;
  const solver = createSolver(game.tree, game.interaction, game.priors, {
    params: options.params ?? DCFR,
  });
  const started = performance.now();
  solver.step(iterations);
  const strategy = solver.averageStrategy();
  const elapsedMs = performance.now() - started;

  const push = strategy[SB_NODE].slice(AGGRESSIVE * CLASS_COUNT, (AGGRESSIVE + 1) * CLASS_COUNT);
  const call = strategy[BB_NODE].slice(AGGRESSIVE * CLASS_COUNT, (AGGRESSIVE + 1) * CLASS_COUNT);

  let pushShare = 0;
  let callShare = 0;
  for (let x = 0; x < CLASS_COUNT; x++) {
    pushShare += CLASS_PRIOR[x] * push[x];
    callShare += CLASS_PRIOR[x] * call[x];
  }

  return {
    spec,
    push,
    call,
    pushShare,
    callShare,
    exploitabilityMbb: exploitabilityMbb(
      game.tree,
      game.interaction,
      game.priors,
      strategy,
      game.bigBlind
    ),
    iterations,
    elapsedMs,
    solver,
    game,
  };
}

/** Chart-cell index of a label like "AKs". Throws on anything unknown. */
export function classIndex(label: string): number {
  const i = CLASS_LABELS.indexOf(label);
  if (i < 0) throw new Error(`classIndex: unknown hand class ${label}`);
  return i;
}
