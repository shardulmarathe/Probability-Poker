/**
 * Discounted CFR over a two-player public game tree, plus a river subgame solver.
 *
 * Algorithm: Discounted CFR (Brown & Sandholm, "Solving Imperfect-Information
 * Games via Discounted Regret Minimization", AAAI 2019, arXiv:1809.04040).
 * Every CFR variant carries the same worst-case O(T^-1/2) bound, so the choice
 * between them is entirely empirical, and the paper's measurement is that
 * DCFR(3/2, 0, 2) "matches or outperforms CFR+ across the board... usually a
 * factor of 2 or 3". Vanilla CFR is a full order of magnitude behind both. In a
 * browser that is the difference between a solve and a hang, so DCFR is the
 * default here and vanilla CFR exists only as a convergence-rate control.
 *
 * The paper's definition, verbatim: "a family of algorithms called Discounted
 * CFR with parameters alpha, beta, and gamma (DCFR_{a,b,g}), defined by
 * multiplying accumulated positive regrets by t^a/(t^a+1), negative regrets by
 * t^b/(t^b+1), and contributions to the average strategy by (t/(t+1))^g on each
 * iteration t."
 *
 * Representation: a public tree, the betting sequence, carried in typed
 * arrays, with every node holding a whole vector of private hands at once. That
 * is what makes the river tractable: the public tree has a few dozen nodes, and
 * a node's work is a handful of passes over a Float64Array of hands rather than
 * a walk over |hands|^2 histories. The only place the two players' hands ever
 * meet is at a terminal, which is exactly what `HandInteraction` abstracts.
 */

import { scoreInts } from "../handEvaluator";
import {
  cloneRange,
  comboCardA,
  comboCardB,
  COMBO_COUNT,
  removeCards,
  type Range,
} from "../model/range";

// ---------------------------------------------------------------------------
// Discount schedule
// ---------------------------------------------------------------------------

export interface DcfrParams {
  /** Positive-regret discount exponent. Infinity = no discount. */
  readonly alpha: number;
  /** Negative-regret discount exponent. -Infinity = floor at zero (RM+). */
  readonly beta: number;
  /** Average-strategy weight exponent: iteration t ends up weighted ~t^gamma. */
  readonly gamma: number;
}

/**
 * The paper's recommendation: "we found that setting alpha=3/2, beta=0, and
 * gamma=2 led to performance that was consistently stronger than CFR+ ... when
 * we refer to DCFR with no parameters listed, we assume this set of parameters
 * are used." beta = 0 gives t^0/(t^0+1) = 1/2, i.e. negative regret is halved
 * every iteration, the paper contrasts this with DCFR(3/2,-1,2), which zeroes
 * it, and recommends this one because zeroing "can produce a spike in
 * exploitability that takes many iterations to recover from".
 */
export const DCFR: DcfrParams = { alpha: 1.5, beta: 0, gamma: 2 };

/** "CFR+ ... is equivalent to DCFR_{inf,-inf,2}". RM+ with quadratic averaging. */
export const CFR_PLUS: DcfrParams = {
  alpha: Number.POSITIVE_INFINITY,
  beta: Number.NEGATIVE_INFINITY,
  gamma: 2,
};

/** "LCFR is equivalent to DCFR_{1,1,1}". */
export const LINEAR_CFR: DcfrParams = { alpha: 1, beta: 1, gamma: 1 };

/** No discounting, uniform averaging, the Zinkevich 2007 original. */
export const VANILLA_CFR: DcfrParams = {
  alpha: Number.POSITIVE_INFINITY,
  beta: Number.POSITIVE_INFINITY,
  gamma: 0,
};

/**
 * t^e/(t^e+1), with the two limits the presets need. Applied to the accumulated
 * value after iteration t's contribution is added, which is what makes the
 * paper's own equivalence hold: multiplying by t'/(t'+1) for every t' in [t, T]
 * leaves iteration t weighted t/(T+1), i.e. linear.
 */
function discount(t: number, exponent: number): number {
  if (exponent === Number.POSITIVE_INFINITY) return 1;
  if (exponent === Number.NEGATIVE_INFINITY) return 0;
  const p = Math.pow(t, exponent);
  return p / (p + 1);
}

// ---------------------------------------------------------------------------
// Public tree
// ---------------------------------------------------------------------------

export const TERMINAL_DECISION = -1;
export const TERMINAL_FOLD = 0;
export const TERMINAL_SHOWDOWN = 1;

export interface PublicTree {
  readonly nodeCount: number;
  /** 0 or 1 at a decision node, -1 at a terminal. */
  readonly player: Int8Array;
  /** TERMINAL_DECISION / TERMINAL_FOLD / TERMINAL_SHOWDOWN. */
  readonly kind: Int8Array;
  /** Index into `children` of node n's first child. */
  readonly childOffset: Int32Array;
  readonly actionCount: Int32Array;
  readonly children: Int32Array;
  /**
   * Terminal payoff, in chips, expressed for player 0. A fold terminal pays
   * this constant to player 0 (and its negation to player 1). A showdown
   * terminal pays this much to whoever wins, so both players scale by +this.
   */
  readonly value: Float64Array;
  /** Parallel to `children`. Diagnostics only; nothing hot reads it. */
  readonly actionLabels: readonly string[];
  readonly root: number;
}

export interface TreeAction {
  readonly label: string;
  readonly next: TreeSpec;
}

export type TreeSpec =
  | { readonly kind: "decision"; readonly player: 0 | 1; readonly actions: readonly TreeAction[] }
  | { readonly kind: "fold"; readonly value: number }
  | { readonly kind: "showdown"; readonly value: number };

/** Flatten a recursive spec into the typed-array form the solver walks. */
export function flattenTree(root: TreeSpec): PublicTree {
  const specs: TreeSpec[] = [];
  const kids: number[][] = [];

  function visit(spec: TreeSpec): number {
    const id = specs.length;
    specs.push(spec);
    kids.push([]);
    if (spec.kind === "decision") {
      if (spec.actions.length === 0) throw new Error("flattenTree: decision node with no actions");
      // Assign ids depth-first; `kids[id]` was reserved above so the recursive
      // pushes can't shift it.
      kids[id] = spec.actions.map((a) => visit(a.next));
    }
    return id;
  }
  visit(root);

  const n = specs.length;
  const player = new Int8Array(n);
  const kind = new Int8Array(n);
  const childOffset = new Int32Array(n);
  const actionCount = new Int32Array(n);
  const value = new Float64Array(n);
  const children: number[] = [];
  const actionLabels: string[] = [];

  for (let i = 0; i < n; i++) {
    const spec = specs[i];
    childOffset[i] = children.length;
    if (spec.kind === "decision") {
      player[i] = spec.player;
      kind[i] = TERMINAL_DECISION;
      actionCount[i] = spec.actions.length;
      for (let a = 0; a < spec.actions.length; a++) {
        children.push(kids[i][a]);
        actionLabels.push(spec.actions[a].label);
      }
    } else {
      player[i] = -1;
      kind[i] = spec.kind === "fold" ? TERMINAL_FOLD : TERMINAL_SHOWDOWN;
      value[i] = spec.value;
    }
  }

  return {
    nodeCount: n,
    player,
    kind,
    childOffset,
    actionCount,
    children: Int32Array.from(children),
    value,
    actionLabels,
    root: 0,
  };
}

// ---------------------------------------------------------------------------
// Where the two players' private hands meet
// ---------------------------------------------------------------------------

/**
 * The only game-specific piece. Everything above is betting structure; this is
 * "what happens when the hands are shown", collapsed to two vector operations
 * so a terminal costs O(hands) rather than O(hands^2).
 *
 * Both methods overwrite `out` and are indexed from the hero's point of view:
 * `out[i]` is a sum over the villain's hands j that are compatible with hero
 * hand i (no shared cards, card removal is the interaction's job, not the
 * caller's).
 */
export interface HandInteraction {
  /** Hand-vector length for each player. */
  readonly handCount: readonly [number, number];
  /** out[i] = sum over compatible j of oppReach[j]. */
  reachMass(hero: 0 | 1, oppReach: Float64Array, out: Float64Array): void;
  /** out[i] = sum over compatible j of oppReach[j] * s, s = +1 win / -1 lose / 0 chop. */
  showdown(hero: 0 | 1, oppReach: Float64Array, out: Float64Array): void;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

export interface SolverOptions {
  readonly params?: DcfrParams;
}

export interface Solver {
  readonly tree: PublicTree;
  readonly interaction: HandInteraction;
  /** Normalized priors, one Float64Array per player. */
  readonly priors: readonly [Float64Array, Float64Array];
  /** Iterations run so far. */
  readonly iterations: number;
  /** Run `count` more iterations (each does one traversal per player). */
  step(count?: number): void;
  /**
   * Normalized average strategy per node: `s[node][action * handCount + hand]`.
   * This, not the current regret-matching strategy, is the thing that
   * converges to equilibrium (Eq. 5).
   */
  averageStrategy(): Float64Array[];
  /** The regret-matching strategy of the latest iteration, same layout. */
  currentStrategy(): Float64Array[];
}

export function createSolver(
  tree: PublicTree,
  interaction: HandInteraction,
  priors: readonly [Float64Array, Float64Array],
  options: SolverOptions = {}
): Solver {
  const params = options.params ?? DCFR;
  const counts = interaction.handCount;
  if (priors[0].length !== counts[0] || priors[1].length !== counts[1]) {
    throw new Error("createSolver: prior length does not match interaction.handCount");
  }
  const maxHands = Math.max(counts[0], counts[1]);

  const prior: [Float64Array, Float64Array] = [normalized(priors[0]), normalized(priors[1])];

  const n = tree.nodeCount;
  // Per-node scratch. Each node is visited once per traversal, so a single
  // buffer per node is enough. The `*View` arrays are subarrays cut once here
  // rather than per visit: the traversal runs a few hundred thousand times and
  // a fresh view per child per iteration is pure garbage.
  const regret: Float64Array[] = new Array(n);
  const stratSum: Float64Array[] = new Array(n);
  const strategy: Float64Array[] = new Array(n);
  const childReach: Float64Array[] = new Array(n);
  const reachView: Float64Array[][] = new Array(n);
  const valueView: Float64Array[][] = new Array(n);
  const denom = new Float64Array(maxHands);
  const rootValue = new Float64Array(maxHands);

  for (let i = 0; i < n; i++) {
    if (tree.kind[i] !== TERMINAL_DECISION) continue;
    const a = tree.actionCount[i];
    const h = counts[tree.player[i] as 0 | 1];
    regret[i] = new Float64Array(a * h);
    stratSum[i] = new Float64Array(a * h);
    strategy[i] = new Float64Array(a * h);
    childReach[i] = new Float64Array(a * h);
    // The updating player alternates, so the per-action value buffer has to
    // fit whichever player's hand vector is longer.
    const values = new Float64Array(a * maxHands);
    reachView[i] = [];
    valueView[i] = [];
    for (let k = 0; k < a; k++) {
      reachView[i].push(childReach[i].subarray(k * h, (k + 1) * h));
      valueView[i].push(values.subarray(k * maxHands, (k + 1) * maxHands));
    }
  }

  let iterations = 0;

  /**
   * Regret matching, Eq. (3): probabilities proportional to positive regret,
   * uniform where every action's regret is non-positive. Also folds the acting
   * player's reach into `childReach` in the same pass, because the product is
   * needed both to descend and as Eq. (5)'s strategy-sum increment.
   */
  function regretMatch(node: number, reach: Float64Array | null): Float64Array {
    const a = tree.actionCount[node];
    const h = counts[tree.player[node] as 0 | 1];
    const r = regret[node];
    const s = strategy[node];
    const cr = childReach[node];
    denom.fill(0, 0, h);
    for (let k = 0; k < a; k++) {
      const off = k * h;
      for (let i = 0; i < h; i++) {
        const v = r[off + i];
        if (v > 0) denom[i] += v;
      }
    }
    const uniform = 1 / a;
    for (let k = 0; k < a; k++) {
      const off = k * h;
      for (let i = 0; i < h; i++) {
        const j = off + i;
        const d = denom[i];
        const v = r[j];
        const p = d > 0 ? (v > 0 ? v / d : 0) : uniform;
        s[j] = p;
        if (reach !== null) cr[j] = reach[i] * p;
      }
    }
    return s;
  }

  /**
   * Counterfactual values for `hero` at `node`, written into `dest`.
   *
   * `reachHero` is only needed for the average-strategy weight in Eq. (5);
   * `reachOpp` is what makes the value counterfactual. Writing through `dest`
   * rather than returning a buffer lets children fill the parent's per-action
   * array directly, which removes a full copy of the value vector per action.
   */
  function walk(
    node: number,
    hero: 0 | 1,
    reachHero: Float64Array,
    reachOpp: Float64Array,
    dest: Float64Array,
    posMul: number,
    negMul: number,
    stratMul: number
  ): void {
    const kind = tree.kind[node];
    const hh = counts[hero];

    if (kind !== TERMINAL_DECISION) {
      if (kind === TERMINAL_SHOWDOWN) {
        // A showdown pays the same amount to whoever wins, and `showdown`
        // already signs from the hero's side, so both players scale by +value.
        interaction.showdown(hero, reachOpp, dest);
        const w = tree.value[node];
        for (let i = 0; i < hh; i++) dest[i] *= w;
      } else {
        interaction.reachMass(hero, reachOpp, dest);
        const w = hero === 0 ? tree.value[node] : -tree.value[node];
        for (let i = 0; i < hh; i++) dest[i] *= w;
      }
      return;
    }

    const q = tree.player[node] as 0 | 1;
    const a = tree.actionCount[node];
    const off = tree.childOffset[node];
    const isHero = q === hero;
    const s = regretMatch(node, isHero ? reachHero : reachOpp);
    const rv = reachView[node];
    const vv = valueView[node];

    for (let k = 0; k < a; k++) {
      const child = tree.children[off + k];
      if (isHero) walk(child, hero, rv[k], reachOpp, vv[k], posMul, negMul, stratMul);
      else walk(child, hero, reachHero, rv[k], vv[k], posMul, negMul, stratMul);
    }

    if (!isHero) {
      // The villain's action probabilities are already inside their reach, so
      // the hero's counterfactual value is a plain sum over their actions.
      const first = vv[0];
      for (let i = 0; i < hh; i++) dest[i] = first[i];
      for (let k = 1; k < a; k++) {
        const cv = vv[k];
        for (let i = 0; i < hh; i++) dest[i] += cv[i];
      }
      return;
    }

    const h = hh;
    {
      const first = vv[0];
      for (let i = 0; i < h; i++) dest[i] = s[i] * first[i];
      for (let k = 1; k < a; k++) {
        const cv = vv[k];
        const base = k * h;
        for (let i = 0; i < h; i++) dest[i] += s[base + i] * cv[i];
      }
    }
    // Eq. (1) with the DCFR discount, and Eq. (5)'s numerator with the gamma
    // weight. Both multiply after the add, see `discount` for why that is
    // what makes the paper's own equivalences hold.
    const r = regret[node];
    const acc = stratSum[node];
    const cr = childReach[node];
    for (let k = 0; k < a; k++) {
      const base = k * h;
      const cv = vv[k];
      for (let i = 0; i < h; i++) {
        const j = base + i;
        const v = r[j] + cv[i] - dest[i];
        r[j] = v > 0 ? v * posMul : v * negMul;
        acc[j] = (acc[j] + cr[j]) * stratMul;
      }
    }
  }

  function step(count = 1): void {
    for (let c = 0; c < count; c++) {
      const t = ++iterations;
      const posMul = discount(t, params.alpha);
      const negMul = discount(t, params.beta);
      const stratMul = Math.pow(t / (t + 1), params.gamma);
      // Alternating updates: the paper notes "in practice far better
      // performance is achieved by alternating which player updates their
      // regrets on each iteration", and player 1's traversal below already
      // sees player 0's freshly updated regrets.
      walk(tree.root, 0, prior[0], prior[1], rootValue, posMul, negMul, stratMul);
      walk(tree.root, 1, prior[1], prior[0], rootValue, posMul, negMul, stratMul);
    }
  }

  function snapshot(source: Float64Array[]): Float64Array[] {
    const out: Float64Array[] = new Array(n);
    for (let i = 0; i < n; i++) {
      if (tree.kind[i] !== TERMINAL_DECISION) {
        out[i] = new Float64Array(0);
        continue;
      }
      const a = tree.actionCount[i];
      const h = counts[tree.player[i] as 0 | 1];
      const src = source[i];
      const dst = new Float64Array(a * h);
      for (let x = 0; x < h; x++) {
        let sum = 0;
        for (let k = 0; k < a; k++) sum += src[k * h + x];
        if (sum > 0) {
          for (let k = 0; k < a; k++) dst[k * h + x] = src[k * h + x] / sum;
        } else {
          for (let k = 0; k < a; k++) dst[k * h + x] = 1 / a;
        }
      }
      out[i] = dst;
    }
    return out;
  }

  return {
    tree,
    interaction,
    priors: prior,
    get iterations() {
      return iterations;
    },
    step,
    averageStrategy: () => snapshot(stratSum),
    currentStrategy: () => {
      // Regret matching already normalizes, but a node never visited would hold
      // stale zeros; snapshot() renormalizes and fills uniform, so reuse it.
      for (let i = 0; i < n; i++) if (tree.kind[i] === TERMINAL_DECISION) regretMatch(i, null);
      return snapshot(strategy);
    },
  };
}

function normalized(v: Float64Array): Float64Array {
  let total = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < 0) throw new Error("createSolver: negative prior weight");
    total += v[i];
  }
  if (!(total > 0)) throw new Error("createSolver: prior has no weight");
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / total;
  return out;
}

// ---------------------------------------------------------------------------
// River subgame: hands
// ---------------------------------------------------------------------------

/**
 * One player's river hand vector, sorted by showdown strength ascending.
 *
 * Sorting is the whole trick behind the O(hands) showdown below: once both
 * players' hands are in strength order, "how much villain reach do I beat" is a
 * prefix sum, not a pairwise scan.
 */
export interface RiverHands {
  readonly count: number;
  /** Combo index into the 1326-combo space of `model/range`. */
  readonly combo: Uint16Array;
  readonly cardA: Uint8Array;
  readonly cardB: Uint8Array;
  /** 7-card evaluator score, ascending. */
  readonly strength: Float64Array;
  /** Normalized weights, summing to 1. */
  readonly prior: Float64Array;
}

/** Collect the positive-weight combos of `range` that survive `board`. */
export function riverHands(range: Range, board: ArrayLike<number>): RiverHands {
  if (board.length !== 5) throw new Error("riverHands: a river board is 5 cards");
  if (range.length !== COMBO_COUNT) throw new Error("riverHands: not a 1326-combo range");

  const live = removeCards(cloneRange(range), board);
  const buf = new Uint8Array(7);
  for (let i = 0; i < 5; i++) buf[i] = board[i];

  const idx: number[] = [];
  for (let i = 0; i < COMBO_COUNT; i++) if (live[i] > 0) idx.push(i);
  if (idx.length === 0) throw new Error("riverHands: range has no combos left after the board");

  const strength = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    buf[5] = comboCardA(idx[k]);
    buf[6] = comboCardB(idx[k]);
    strength[k] = scoreInts(buf, 7);
  }
  const order = idx.map((_, k) => k).sort((x, y) => strength[x] - strength[y]);

  const n = idx.length;
  const combo = new Uint16Array(n);
  const cardA = new Uint8Array(n);
  const cardB = new Uint8Array(n);
  const sorted = new Float64Array(n);
  const prior = new Float64Array(n);
  let total = 0;
  for (let k = 0; k < n; k++) {
    const c = idx[order[k]];
    combo[k] = c;
    cardA[k] = comboCardA(c);
    cardB[k] = comboCardB(c);
    sorted[k] = strength[order[k]];
    prior[k] = live[c];
    total += live[c];
  }
  for (let k = 0; k < n; k++) prior[k] /= total;

  return { count: n, combo, cardA, cardB, strength: sorted, prior };
}

// ---------------------------------------------------------------------------
// River subgame: the showdown interaction
// ---------------------------------------------------------------------------

/**
 * Showdown and card removal for two sorted river hand vectors.
 *
 * `showdown` is two linear sweeps. Walking hero hands in strength order, the
 * villain reach that hero beats only ever grows, so it is a running sum; the
 * blocked part of it is the running sum restricted to villain hands holding one
 * of hero's two cards, which is 52 more accumulators. A villain hand holding
 * both of hero's cards is hero's own combo, which ties rather than losing, so
 * it is never in either running sum and the two card corrections can't
 * double-count. That single observation is why this is O(n) and not O(n^2).
 */
export function riverInteraction(hands: readonly [RiverHands, RiverHands]): HandInteraction {
  const cardSum = new Float64Array(52);
  // Index of the identical combo in the other player's vector, or -1. Needed
  // only by reachMass: subtracting both card totals removes hero's own combo
  // twice, and unlike at a showdown it does not contribute zero.
  const mirror: [Int32Array, Int32Array] = [
    new Int32Array(hands[0].count).fill(-1),
    new Int32Array(hands[1].count).fill(-1),
  ];
  {
    const where = new Int32Array(COMBO_COUNT).fill(-1);
    for (let j = 0; j < hands[1].count; j++) where[hands[1].combo[j]] = j;
    for (let i = 0; i < hands[0].count; i++) {
      const j = where[hands[0].combo[i]];
      mirror[0][i] = j;
      if (j >= 0) mirror[1][j] = i;
    }
  }

  return {
    handCount: [hands[0].count, hands[1].count],

    reachMass(hero, oppReach, out) {
      const me = hands[hero];
      const opp = hands[1 - hero];
      cardSum.fill(0);
      let total = 0;
      for (let j = 0; j < opp.count; j++) {
        const r = oppReach[j];
        if (r === 0) continue;
        total += r;
        cardSum[opp.cardA[j]] += r;
        cardSum[opp.cardB[j]] += r;
      }
      const mir = mirror[hero];
      for (let i = 0; i < me.count; i++) {
        const j = mir[i];
        // Inclusion-exclusion: hero's own combo is the only villain hand
        // counted by both card totals.
        out[i] = total - cardSum[me.cardA[i]] - cardSum[me.cardB[i]] + (j >= 0 ? oppReach[j] : 0);
      }
    },

    showdown(hero, oppReach, out) {
      const me = hands[hero];
      const opp = hands[1 - hero];
      const nH = me.count;
      const nV = opp.count;

      cardSum.fill(0);
      let sum = 0;
      let j = 0;
      let i = 0;
      while (i < nH) {
        const s = me.strength[i];
        while (j < nV && opp.strength[j] < s) {
          const r = oppReach[j];
          if (r !== 0) {
            sum += r;
            cardSum[opp.cardA[j]] += r;
            cardSum[opp.cardB[j]] += r;
          }
          j++;
        }
        do {
          out[i] = sum - cardSum[me.cardA[i]] - cardSum[me.cardB[i]];
          i++;
        } while (i < nH && me.strength[i] === s);
      }

      cardSum.fill(0);
      sum = 0;
      j = nV - 1;
      i = nH - 1;
      while (i >= 0) {
        const s = me.strength[i];
        while (j >= 0 && opp.strength[j] > s) {
          const r = oppReach[j];
          if (r !== 0) {
            sum += r;
            cardSum[opp.cardA[j]] += r;
            cardSum[opp.cardB[j]] += r;
          }
          j--;
        }
        do {
          out[i] -= sum - cardSum[me.cardA[i]] - cardSum[me.cardB[i]];
          i--;
        } while (i >= 0 && me.strength[i] === s);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// River subgame: the betting tree
// ---------------------------------------------------------------------------

export interface RiverSpec {
  /** Chips already in the middle when the river betting starts. */
  readonly pot: number;
  /** Chips behind, per player. Equal stacks are assumed at the start. */
  readonly stack: number;
  /**
   * Bet sizes as a fraction of the current pot. Default 1/3, 2/3, pot: small
   * enough to keep the tree at a few dozen nodes, spread enough to cover the
   * thin-value / polar split that the river actually has. All-in is always
   * offered on top, because on the river it is a genuinely distinct action
   * (there is no future street to protect a stack for).
   */
  readonly betFractions?: readonly number[];
  /** Raise sizes as a fraction of (pot after the call). Default: pot. */
  readonly raiseFractions?: readonly number[];
  /** Maximum aggressive actions in the round (bets + raises). Default 3. */
  readonly maxBets?: number;
  /** Smallest legal bet. Default 1 chip. */
  readonly minBet?: number;
}

const DEFAULT_BET_FRACTIONS = [1 / 3, 2 / 3, 1] as const;
const DEFAULT_RAISE_FRACTIONS = [1] as const;

/**
 * The river betting tree, out-of-position player first (player 0 = OOP).
 *
 * Payoffs are net chips shifted so the game is zero-sum: the pot that both
 * players brought into the river is dead money split evenly in the baseline, so
 * winning it is worth pot/2 rather than pot. Nothing about the strategies
 * changes, it is a constant shift, but exploitability is only meaningful as a
 * sum of two best-response values when those values sum to zero at equilibrium.
 */
export function buildRiverTree(spec: RiverSpec): PublicTree {
  const betFractions = spec.betFractions ?? DEFAULT_BET_FRACTIONS;
  const raiseFractions = spec.raiseFractions ?? DEFAULT_RAISE_FRACTIONS;
  const maxBets = spec.maxBets ?? 3;
  const minBet = spec.minBet ?? 1;
  const { pot, stack } = spec;
  if (!(pot > 0)) throw new Error("buildRiverTree: pot must be positive");
  if (!(stack > 0)) throw new Error("buildRiverTree: stack must be positive");

  const half = pot / 2;

  function showdown(c0: number, c1: number): TreeSpec {
    // A call for less returns the excess, so only the matched part is at risk.
    return { kind: "showdown", value: half + Math.min(c0, c1) };
  }
  function folded(who: 0 | 1, c0: number, c1: number): TreeSpec {
    const stake = half + (who === 0 ? c0 : c1);
    return { kind: "fold", value: who === 0 ? -stake : stake };
  }

  function node(
    toAct: 0 | 1,
    c0: number,
    c1: number,
    bets: number,
    minRaise: number,
    checked: boolean
  ): TreeSpec {
    const mine = toAct === 0 ? c0 : c1;
    const theirs = toAct === 0 ? c1 : c0;
    const toCall = theirs - mine;
    const myRemaining = stack - mine;
    const theirRemaining = stack - theirs;
    const potNow = pot + c0 + c1;
    const actions: TreeAction[] = [];

    const withCommit = (add: number): TreeSpec => {
      const n0 = toAct === 0 ? c0 + add : c0;
      const n1 = toAct === 1 ? c1 + add : c1;
      return node(
        (1 - toAct) as 0 | 1,
        n0,
        n1,
        bets + 1,
        add - toCall,
        false
      );
    };

    if (toCall <= 0) {
      actions.push({
        label: "check",
        next: checked ? showdown(c0, c1) : node((1 - toAct) as 0 | 1, c0, c1, bets, minRaise, true),
      });
    } else {
      actions.push({ label: "fold", next: folded(toAct, c0, c1) });
      const call = Math.min(toCall, myRemaining);
      const n0 = toAct === 0 ? c0 + call : c0;
      const n1 = toAct === 1 ? c1 + call : c1;
      actions.push({ label: "call", next: showdown(n0, n1) });
    }

    // No aggression once someone is all-in, or once the cap is reached.
    if (bets < maxBets && myRemaining > toCall && theirRemaining > 0) {
      const fractions = toCall <= 0 ? betFractions : raiseFractions;
      const base = potNow + toCall;
      const seen = new Set<number>();
      const sizes: { label: string; add: number }[] = [];
      for (const f of fractions) {
        // A raise is "call plus f x the pot after the call"; a bet is just f x
        // the current pot, which is the same formula with toCall = 0.
        let add = toCall + Math.max(f * base, toCall <= 0 ? minBet : Math.max(minRaise, minBet));
        if (add >= myRemaining) continue; // folded into the all-in below
        add = Math.round(add * 1e6) / 1e6;
        if (seen.has(add)) continue;
        seen.add(add);
        sizes.push({ label: `${toCall <= 0 ? "b" : "r"}${Math.round(f * 100)}`, add });
      }
      if (!seen.has(myRemaining)) sizes.push({ label: "allin", add: myRemaining });
      for (const s of sizes) actions.push({ label: s.label, next: withCommit(s.add) });
    }

    return { kind: "decision", player: toAct, actions };
  }

  return flattenTree(node(0, 0, 0, 0, minBet, false));
}

// ---------------------------------------------------------------------------
// River subgame: assembly
// ---------------------------------------------------------------------------

export interface RiverGame {
  readonly tree: PublicTree;
  readonly interaction: HandInteraction;
  readonly hands: readonly [RiverHands, RiverHands];
  readonly priors: readonly [Float64Array, Float64Array];
}

/** Board + two ranges + a betting spec, ready for `createSolver`. */
export function buildRiverGame(
  spec: RiverSpec,
  board: ArrayLike<number>,
  oopRange: Range,
  ipRange: Range
): RiverGame {
  const hands: [RiverHands, RiverHands] = [
    riverHands(oopRange, board),
    riverHands(ipRange, board),
  ];
  return {
    tree: buildRiverTree(spec),
    interaction: riverInteraction(hands),
    hands,
    priors: [hands[0].prior, hands[1].prior],
  };
}

export interface RiverSolveOptions extends SolverOptions {
  /** Default 500, enough for sub-1% exploitability on realistic ranges. */
  readonly iterations?: number;
}

export interface RiverSolution extends RiverGame {
  readonly solver: Solver;
  readonly strategy: Float64Array[];
  readonly iterations: number;
  readonly elapsedMs: number;
}

export function solveRiver(
  spec: RiverSpec,
  board: ArrayLike<number>,
  oopRange: Range,
  ipRange: Range,
  options: RiverSolveOptions = {}
): RiverSolution {
  const game = buildRiverGame(spec, board, oopRange, ipRange);
  const iterations = options.iterations ?? 500;
  const solver = createSolver(game.tree, game.interaction, game.priors, options);
  const started = performance.now();
  solver.step(iterations);
  const strategy = solver.averageStrategy();
  return {
    ...game,
    solver,
    strategy,
    iterations,
    elapsedMs: performance.now() - started,
  };
}
