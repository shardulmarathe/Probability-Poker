import type { LegalAction, MonteCarloResult } from "../types";
import { makeRng, type Rng } from "./core/rng";
import { scoreInts } from "./handEvaluator";
import {
  COMBO_COUNT,
  comboCardA,
  comboCardB,
  drawCombo,
  makeComboSampler,
  type ComboSampler,
  type Range,
} from "./model/range";

/**
 * Forward-looking (pot-odds) expected value of an action, measured from the
 * decision point. Sunk chips already in the pot are ignored, only the chips
 * risked *now* and the pot that can be won matter. This is what makes folding
 * correct: the bot folds whenever calling is a losing proposition.
 *
 *   - Fold:  EV = 0                      (baseline, risk nothing, win nothing)
 *   - Check: EV = pWin · pot             (no chips risked)
 *   - Call:  EV = pWin · pot − pLoss · cost
 *   - Bet/Raise: opponent is assumed to match the extra, so the pot you can win
 *     grows by that extra:
 *            EV = pWin · (pot + extra) − pLoss · cost,  extra = cost − toCall
 *
 * Ties are treated as chip-neutral (their contribution is ~0).
 *
 * NOTE the assumption in the last line: the bet is *always* called. That makes
 * this function blind to fold equity, so a bet can only ever be worth what it
 * wins at showdown and a hand with no showdown value can never profitably bet.
 * `foldEquityEv` below is the version that does not assume a call; this one is
 * kept unchanged because calls, checks and folds have no fold-equity term and
 * several callers price only those.
 *
 * NOTE a second assumption, in the `pot` argument: the pot is taken to be final.
 * That is exact for a call that CLOSES the action and wrong for one that does
 * not, see `callEv` below, which is the version that does not assume the call
 * is the last word. This one remains correct, and remains the price used, for
 * every closing call.
 */
export function actionEv(
  action: LegalAction,
  mc: MonteCarloResult,
  pot: number,
  toCall: number
): number {
  if (action.type === "fold") return 0;
  const extra = Math.max(0, action.cost - toCall);
  return mc.pWin * (pot + extra) - mc.pLoss * action.cost;
}

// ---------------------------------------------------------------------------
// Fold equity
// ---------------------------------------------------------------------------
//
// A bet wins two different ways and `actionEv` only counts one of them:
//
//     EV(bet s) = P(fold | s) · Pot
//               + (1 − P(fold | s)) · [ E_continue · (Pot + 2s) − s ]
//
// The load-bearing term is E_continue. It is the hero's equity against the part
// of the opponent's range that *continues* against a bet of s, which is not the
// same as equity against the whole range and is always worse when folding is
// strength-correlated: the hands that fold are the weak ones, so what is left
// facing the bet is the strong tail. Pricing a bluff against equity-vs-range
// instead of equity-vs-callers systematically overvalues betting, which is a
// worse failure than never bluffing at all, it turns every missed draw into a
// "profitable" bet against a range that has already folded its air.
//
// The continuing range is derived here by weighting each combo by
// 1 − P(fold | bucket(combo)) and renormalising, which is exactly the posterior
// over the opponent's holding conditioned on "did not fold".
//
// The bracket above is the same arithmetic `actionEv` does, with E_continue
// substituted for pWin: E·(Pot + s) − (1 − E)·s = E·(Pot + 2s) − s. That
// identity is why this is an extension of the old formula rather than a rival
// to it.
//
// It does NOT generalise to k callers as E·(Pot + k·s) − (1 − E)·cost. That
// form factorises an expectation of a product. Heads-up it is exact because k
// is the constant 1; multiway both the hero's share and the field size are
// random, and they are *negatively correlated*, the hero takes a smaller
// fraction of the pot in exactly the simulations where more opponents stayed
// to contest it. By that correlation
//
//     E[share] · (Pot + E[k]·s)  >  E[share · (Pot + k·s)]
//
// strictly, whenever k varies at all, and the gap runs entirely in the
// "betting looks better" direction: on a 100-chip pot it reached +12 chips
// against five opponents, enough to flip bets that are really checks. The
// call term is therefore accumulated one simulation at a time, with that
// simulation's own share and its own field, and never reassembled out of the
// two marginal means. `eContinue` and `callers` survive only as reporting.
//
// ALPHA. Setting E_continue = 0, a pure bluff, no equity at all, collapses
// the formula to
//
//     EV = P(fold)·Pot − (1 − P(fold))·s
//
// which is zero exactly at
//
//     alpha = s / (Pot + s)
//
// the standard break-even bluffing frequency, and its complement
// MDF = 1 − alpha = Pot / (Pot + s) is the minimum defence frequency: the
// fraction of range an opponent must continue with to stop a pure bluff being
// automatically profitable. The published values fall straight out -
// half pot 33.3% / 66.7%, three-quarter pot 42.9% / 57.1%, pot 50% / 50%,
// twice pot 66.7% / 33.3%, and `ev.test.ts` pins all four against this
// implementation to floating-point tolerance. That identity is the external
// check on the whole module: it is a closed-form result from the literature
// rather than a property of this code, so if the two disagree, this code is
// wrong. Everything else here is a behavioural claim; this one is arithmetic.

/** One opponent's model at a single bet size. */
export interface FoldingOpponent {
  /**
   * Prior weight per combo, indexed by `comboIndex`. Unnormalised, and the
   * caller has already zeroed every combo containing a card it can see.
   */
  range: Range;
  /**
   * P(fold | combo) at the size being priced, same indexing as `range`. An
   * opponent that cannot fold, already all-in, is modelled with zeros.
   */
  foldByCombo: Float64Array;
  /**
   * Chips *this* opponent must add to keep playing, which is not the same for
   * every seat once the hero is raising rather than betting.
   *
   *   - facing an opening bet (`toCall = 0`): everybody owes `cost`, and
   *     `extra = cost`, so the distinction is empty;
   *   - facing a raise: a seat already at the current bet level, the player
   *     whose bet the hero is raising, owes only the increment `extra`, while
   *     a seat that has not yet matched `toCall` owes the whole `cost`.
   *
   * Charging `extra` to a seat that owes `cost` under-counts the pot the hero
   * plays for by `toCall` per such seat.
   *
   * Defaults to `extra = max(0, cost − toCall)` when omitted, which is exact
   * heads-up and exact for any opening bet, and understates the pot (so it
   * understates the EV of a raise, the safe direction) for a multiway raise
   * whose callers have not yet matched.
   */
  owes?: number;
}

export interface FoldEquityInput {
  /** Hero's two card codes (0..51). */
  heroHole: readonly number[];
  /** Visible board card codes; 0, 3, 4 or 5 of them. */
  board: readonly number[];
  opponents: readonly FoldingOpponent[];
  /** Chips already in the middle, before this action. */
  pot: number;
  /** Chips the hero owes before acting; 0 for an opening bet. */
  toCall: number;
  /** Chips the hero adds now, call included, `TableAction.cost`. */
  cost: number;
  simulations: number;
  seed: number;
}

/**
 * Why a bet scored what it scored. Every field is either an input or a mean
 * over the run, and `ev` is reconstructible from them, so the analysis page can
 * show the whole derivation rather than a single number.
 */
export interface FoldEquityBreakdown {
  /** P(every opponent folds), see the independence note on `foldEquityEv`. */
  pFold: number;
  /** P(fold) per opponent, in input order. */
  pFoldEach: number[];
  /**
   * Hero's pot share against the opponents that continue, given at least one
   * does. Compare against equity-vs-range (`rangeEquity`): the gap between them
   * is the whole reason this module exists.
   *
   * REPORTING ONLY. `callEv` is not built from this mean, see `callEv`.
   */
  eContinue: number;
  /**
   * Mean number of opponents that continue, given at least one does.
   *
   * REPORTING ONLY, for the same reason as `eContinue`.
   */
  callers: number;
  /**
   * Mean pot the hero is playing for when called: `pot` plus what the
   * opponents who stayed in add, averaged over the run. With one `owes` for
   * every seat this is `pot + callers · owes`; with a raise's mixed `owes` it
   * is the mean of the per-simulation sums. REPORTING ONLY.
   */
  potIfCalled: number;
  /** `pFold · pot`, the chips the bet wins uncontested. */
  foldEv: number;
  /**
   * `(1 − pFold) · E[ share · (pot + Σ_continuing owes) − (1 − share) · cost ]`,
   * the expectation taken over the simulated fields.
   *
   * The mean is of the whole per-simulation payoff, NOT a payoff rebuilt from
   * `eContinue` and `potIfCalled`: share and field size are negatively
   * correlated, so `eContinue · potIfCalled` overstates the product's mean and
   * always in the direction that makes betting look better.
   */
  callEv: number;
  ev: number;
  /** Sims that produced `eContinue`; 0 when nobody can continue. */
  simulations: number;
}

/**
 * Price a bet or raise with its fold equity.
 *
 * MULTIWAY INDEPENDENCE ASSUMPTION. With N opponents the bet only wins
 * uncontested if *every* one of them folds, and that probability is taken here
 * to be Π P(fold_i), the product of the per-opponent marginals. That is not
 * strictly true: the opponents' ranges are coupled by card removal (a card in
 * one hand is not in another), so their folding decisions are weakly dependent,
 * and the same coupling is ignored again when the continuing field is drawn.
 * The error runs one way, the product overstates how often the whole field
 * folds, so the bot is slightly over-optimistic about bluffing into a field.
 *
 * The decay itself is not an artifact of that assumption, and it is the real
 * lesson: a 55% fold rate is 55% heads-up, 30% against two, 9% against four.
 * Fold equity dies exponentially in the field size, which is why bluffing
 * multiway is bad long before any second-order dependence matters.
 *
 * This function used to carry a second multiway error next to that one, the
 * call term was assembled as `E[share] · (pot + E[k] · extra)`, and the note
 * excusing it claimed the Π decay dominated. It did not. The factorisation
 * error *grows* with the field exactly as the decay does, because it is driven
 * by the variance of k, and it pointed the same way as the independence error:
 * both made bluffing into a field look better than it is, which is the precise
 * failure this module exists to prevent. The call term is now accumulated
 * inside the simulation, so only the independence assumption above remains.
 */
export function foldEquityEv(input: FoldEquityInput): FoldEquityBreakdown {
  const { pot, toCall, cost, opponents } = input;
  const extra = Math.max(0, cost - toCall);

  // What each seat has to put in to keep playing. Uniformly `extra` for a bet;
  // for a raise the seats that have not matched `toCall` owe the full `cost`.
  // See `FoldingOpponent.owes`.
  const owes = opponents.map((o) =>
    o.owes === undefined ? extra : Math.max(0, o.owes)
  );

  const pFoldEach: number[] = [];
  const pContinue: number[] = [];
  const samplers: (ComboSampler | null)[] = [];
  let pFold = 1;

  for (const opponent of opponents) {
    // The continuing range: each combo kept in proportion to how often this
    // opponent does NOT fold it. Renormalisation happens inside the sampler,
    // which divides by the total weight it is handed.
    const continuing = new Float64Array(COMBO_COUNT);
    let total = 0;
    let folded = 0;
    for (let c = 0; c < COMBO_COUNT; c++) {
      const w = opponent.range[c];
      if (w <= 0) continue;
      const f = opponent.foldByCombo[c];
      total += w;
      folded += w * f;
      continuing[c] = w * (1 - f);
    }

    const p = total > 0 ? Math.min(1, Math.max(0, folded / total)) : 1;
    pFoldEach.push(p);
    pContinue.push(1 - p);
    pFold *= p;
    samplers.push(total - folded > 0 ? makeComboSampler(continuing) : null);
  }

  let eContinue = 0;
  let callers = 0;
  let simulations = 0;
  // The mean per-simulation payoff of the called branch. Undefined until a
  // simulation actually runs; see the fallback below.
  let meanPayoff: number | null = null;
  let potIfCalled = pot;
  if (pFold < 1) {
    const run = runField(
      input.heroHole,
      input.board,
      samplers,
      pContinue,
      { pot, cost, owes },
      input.simulations,
      makeRng(input.seed)
    );
    if (run.sims > 0) {
      eContinue = run.shareSum / run.sims;
      callers = run.contestedSum / run.sims;
      potIfCalled = run.potSum / run.sims;
      meanPayoff = run.evSum / run.sims;
      simulations = run.sims;
    }
  }

  // The call term is the mean of `share · (pot + Σ owes) − (1 − share) · cost`
  // over the simulated fields, accumulated one field at a time in `runField`.
  // Reassembling it here out of `eContinue` and `potIfCalled` would factorise
  // an expectation of a product and overstate every multiway bet.
  //
  // With no usable simulation there is no share to speak of, and the branch
  // collapses to the losing leg alone: the hero puts in `cost` and takes
  // nothing, which is what the old share-of-zero arithmetic also gave.
  const foldEv = pFold * pot;
  const callEv = (1 - pFold) * (meanPayoff ?? -cost);

  return {
    pFold,
    pFoldEach,
    eContinue,
    callers,
    potIfCalled,
    foldEv,
    callEv,
    ev: foldEv + callEv,
    simulations,
  };
}

// ---------------------------------------------------------------------------
// Calls that do not close the action
// ---------------------------------------------------------------------------
//
// `actionEv` prices a call against the pot AS IT STANDS. That is exact when the
// call closes the action, heads-up, or last to act with everybody else already
// matched, because every chip that will ever enter the pot is already in it.
// For any other call it is wrong, and wrong on both legs of one expression.
//
// The equity a call is priced with is the hero's share against the WHOLE field
// still contesting, seats behind included (`decider.equityRequest` asks about
// every contesting seat). So the losing leg already pays for those seats
// sticking around. The winning leg does not collect for it: the pot it wins is
// the pot from before any of them called. Six-handed preflop that pairs a share
// of ~1/6 with a pot of one and a half blinds:
//
//     call   = share x pot             - (1 - share) x toCall  ~  -4 chips
//     raise  = share x (pot + Σ owed)  - (1 - share) x cost    ~ +12 chips
//
// for the same holding. The raise is on the right basis; the call is on a basis
// that assumes a six-way showdown for a heads-up pot. The two are therefore not
// comparable at all, and the bias is not small: over 220 six-handed hands the
// call came out negative while the best aggressive line came out positive in
// 37.5% of spots. `profiles.tiltEv` is a multiplier and multipliers preserve
// sign, so no `aggression` value can reorder any of them.
//
// The fix is to price a non-closing call against the pot it will plausibly
// REACH, with the same field simulation a raise is priced with: each seat that
// still owes chips continues at its own P(continue), and the hero's share is
// taken against the field that actually shows up, one simulation at a time.
// That is a common basis, not parity, the two prices are still free to differ,
// and now the difference means something.
//
// WHAT MUST NOT COME WITH IT IS FOLD EQUITY. Nobody folds to a call. The seat
// whose bet is being called has already committed and has no decision left, so
// the "everybody folds and the hero takes the pot" branch `foldEquityEv` prices
// is unreachable. That is why this is a *specialisation* of `foldEquityEv`
// rather than another call of it with different numbers: zeroing the fold model
// of every already-matched seat drives `pFold` to 0 by construction and the
// formula collapses onto its call term alone. A raise therefore still beats a
// call whenever the folds it buys are genuinely worth something, which is the
// asymmetry the whole roster rests on.

export interface CallEvInput {
  heroHole: readonly number[];
  board: readonly number[];
  /**
   * EVERY opponent still contesting, the already-matched ones included, they
   * are in the showdown whatever the seats behind do, so leaving them out would
   * price the hero's share against the wrong field.
   *
   * `owes` is what separates the two kinds. A seat with `owes > 0` is still to
   * act and continues at `1 - foldByCombo`; a seat with `owes` zero or absent
   * has no decision left, and its fold model is overwritten with zeros here
   * whatever the caller passed.
   */
  opponents: readonly FoldingOpponent[];
  /** Chips already in the middle, before the hero calls. */
  pot: number;
  /** Chips the hero must add to call. Also the hero's whole cost. */
  toCall: number;
  simulations: number;
  seed: number;
}

/** A seat with no decision left to make: it never folds. Read-only, so shared. */
const NEVER_FOLDS = new Float64Array(COMBO_COUNT);

/**
 * Price a call against the pot the seats behind will build.
 *
 * Delegates to `foldEquityEv` with `cost = toCall`, which is what puts the two
 * prices on one basis by construction rather than by agreement: one field
 * simulation, one pricing formula, and one place a multiway error could live.
 * Returns the same breakdown, whose `foldEv` is 0 and whose `callEv` is
 * therefore the whole of `ev`.
 *
 * PRECONDITION: at least one opponent owes nothing, the seat whose bet is
 * being called. It always holds for a real call, because a seat cannot bet and
 * then not be at its own bet, and it is what makes `pFold === 0` structural
 * rather than incidental. `ev.test.ts` pins it. Handed a field where every seat
 * could still fold, this returns `foldEquityEv`'s answer, which awards the pot
 * on the all-fold branch, correct arithmetic for a state that cannot arise.
 */
export function callEv(input: CallEvInput): FoldEquityBreakdown {
  const opponents = input.opponents.map((o) => {
    const owes = Math.max(0, o.owes ?? 0);
    return owes > 0
      ? { ...o, owes }
      : { ...o, owes: 0, foldByCombo: NEVER_FOLDS };
  });
  return foldEquityEv({ ...input, opponents, cost: input.toCall });
}

export interface RangeEquityInput {
  heroHole: readonly number[];
  board: readonly number[];
  /** One prior range per opponent; every one of them sees the river. */
  ranges: readonly Range[];
  simulations: number;
  seed: number;
}

/**
 * Hero's pot share against the opponents' *whole* ranges, the number
 * `eContinue` has to be compared against.
 *
 * Same sampler and same scoring as the continuing-range run, so the two are
 * measured on one scale and their difference is the selection effect alone.
 */
export function rangeEquity(input: RangeEquityInput): number {
  if (input.ranges.length === 0) return 1;
  const samplers = input.ranges.map(makeComboSampler);
  const run = runField(
    input.heroHole,
    input.board,
    samplers,
    null,
    null,
    input.simulations,
    makeRng(input.seed)
  );
  return run.sims > 0 ? run.shareSum / run.sims : 0;
}

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------
//
// `equity/multiway.ts` samples a seat's hand from a `Range`, an arbitrary
// weight per combo, which is exactly what a continuing range is, so that part
// is not the reason this module has its own kernel. (It once was: multiway
// sampled the three-tier `BeliefDistribution` and could not express a per-combo
// weight. `beliefRange` is now only an adapter for callers that still hold a
// belief rather than a range.)
//
// The reason is the coin. Fold equity needs each seat to *sit the hand out*
// with its own probability before the field is dealt, so the number of live
// opponents is itself random. `runMultiway` deals a fixed field. Everything
// else here, the `ComboSampler`, the whole-tuple redraw, is shared in spirit
// with that module and duplicated only because the fold coin sits inside the
// same inner loop.

/** Whole-tuple redraws before the field is dealt short. See `multiway.ts`. */
const MAX_TUPLE_ATTEMPTS = 64;
/** Redraws of the continue/fold coins before the fallback pick below. */
const MAX_SUBSET_ATTEMPTS = 64;

/**
 * What a simulated field is worth to the hero, priced per simulation.
 *
 * Kept here rather than applied by the caller because the two random pieces -
 * the hero's share and which seats stayed in, have to meet inside the same
 * simulation. Multiplying their averages afterwards is the bug this exists to
 * make impossible.
 */
interface FieldPayoff {
  /** Chips in the middle before the hero acts. */
  pot: number;
  /** Chips the hero puts in now. */
  cost: number;
  /** Chips each opponent adds to continue, in `samplers` order. */
  owes: readonly number[];
}

interface FieldRun {
  /** Σ of the hero's pot share over the sims that produced one. */
  shareSum: number;
  /** Σ of the number of opponents contesting. */
  contestedSum: number;
  /** Σ of `pot + Σ_contesting owes`. Zero without a payoff. */
  potSum: number;
  /** Σ of the hero's payoff, `share · potIfCalled − (1 − share) · cost`. */
  evSum: number;
  sims: number;
}

const EMPTY_RUN: FieldRun = {
  shareSum: 0,
  contestedSum: 0,
  potSum: 0,
  evSum: 0,
  sims: 0,
};

function runField(
  heroHole: readonly number[],
  board: readonly number[],
  samplers: readonly (ComboSampler | null)[],
  pContinue: readonly number[] | null,
  payoff: FieldPayoff | null,
  sims: number,
  rng: Rng
): FieldRun {
  const n = samplers.length;
  const bl = board.length;
  const needed = 5 - bl;
  if (n === 0 || sims <= 0) return EMPTY_RUN;
  if (bl > 5) throw new Error(`runField: board of ${bl} cards`);
  if (heroHole.length < 2) throw new Error("runField: hero holds no cards");

  const HAND = 7;
  const heroHand = new Uint8Array(HAND);
  heroHand[0] = heroHole[0];
  heroHand[1] = heroHole[1];
  const oppHands: Uint8Array[] = [];
  for (let i = 0; i < n; i++) oppHands.push(new Uint8Array(HAND));
  for (let k = 0; k < bl; k++) {
    heroHand[2 + k] = board[k];
    for (let i = 0; i < n; i++) oppHands[i][2 + k] = board[k];
  }

  // Cards the hero can see. Fixed for the whole run, so it is not restamped.
  const blocked = new Uint8Array(52);
  blocked[heroHole[0]] = 1;
  blocked[heroHole[1]] = 1;
  for (let k = 0; k < bl; k++) blocked[board[k]] = 1;

  // A complete board fixes the hero's hand: score it once rather than per sim.
  const fixedHero = needed === 0 ? scoreInts(heroHand, HAND) : -1;

  // Stamped rather than cleared, so a rejected tuple's marks go stale for free.
  const seen = new Int32Array(52);
  let stamp = 0;
  const inField = new Uint8Array(n);
  const scores = new Int32Array(n);
  const live = new Uint8Array(52);

  let shareSum = 0;
  let contestedSum = 0;
  let potSum = 0;
  let evSum = 0;
  let ran = 0;

  for (let s = 0; s < sims; s++) {
    // 1. Who is still in. With no fold model everybody is; with one, each seat
    //    flips its own coin and the all-fold outcome is rejected, that is what
    //    makes this the distribution *conditioned on the bet being called*,
    //    which is the only branch the continue term prices.
    let k = 0;
    if (pContinue === null) {
      for (let i = 0; i < n; i++) inField[i] = samplers[i] ? 1 : 0;
      k = n;
    } else {
      for (let a = 0; a < MAX_SUBSET_ATTEMPTS && k === 0; a++) {
        for (let i = 0; i < n; i++) {
          const on = samplers[i] !== null && rng.next() < pContinue[i];
          inField[i] = on ? 1 : 0;
          if (on) k++;
        }
      }
      if (k === 0) {
        // Everyone is folding almost always, so the conditional collapses onto
        // "exactly one seat continues", whose weight is ∝ p_i / (1 − p_i).
        // Picking from that keeps the fallback asymptotically exact rather than
        // merely terminating.
        let totalOdds = 0;
        for (let i = 0; i < n; i++) {
          inField[i] = 0;
          const p = pContinue[i];
          if (samplers[i] !== null && p > 0 && p < 1) totalOdds += p / (1 - p);
        }
        if (totalOdds <= 0) continue;
        let r = rng.next() * totalOdds;
        for (let i = 0; i < n; i++) {
          const p = pContinue[i];
          if (samplers[i] === null || !(p > 0) || p >= 1) continue;
          r -= p / (1 - p);
          if (r < 0 || i === n - 1) {
            inField[i] = 1;
            k = 1;
            break;
          }
        }
        if (k === 0) continue;
      }
    }

    // 2. Deal the field. Ranges already exclude the hero's cards and the board,
    //    so the only possible clash is seat against seat; the whole tuple is
    //    redrawn on one, which is what keeps the sampler exchangeable.
    let dealt = false;
    for (let a = 0; a < MAX_TUPLE_ATTEMPTS && !dealt; a++) {
      stamp++;
      dealt = true;
      for (let i = 0; i < n; i++) {
        if (!inField[i]) continue;
        const combo = drawCombo(samplers[i]!, rng);
        const x = comboCardA(combo);
        const y = comboCardB(combo);
        if (seen[x] === stamp || seen[y] === stamp) {
          dealt = false;
          break;
        }
        seen[x] = stamp;
        seen[y] = stamp;
        oppHands[i][0] = x;
        oppHands[i][1] = y;
      }
    }
    if (!dealt) {
      // Only reachable when several seats are pinned on nearly the same few
      // combos. Seat the ones that fit and drop the rest for this sim rather
      // than dealing a card twice.
      stamp++;
      k = 0;
      for (let i = 0; i < n; i++) {
        if (!inField[i]) continue;
        const combo = drawCombo(samplers[i]!, rng);
        const x = comboCardA(combo);
        const y = comboCardB(combo);
        if (seen[x] === stamp || seen[y] === stamp) {
          inField[i] = 0;
          continue;
        }
        seen[x] = stamp;
        seen[y] = stamp;
        oppHands[i][0] = x;
        oppHands[i][1] = y;
        k++;
      }
      if (k === 0) continue;
    }

    // 3. Run the board out of what nobody holds.
    let L = 0;
    for (let c = 0; c < 52; c++) {
      if (blocked[c] === 0 && seen[c] !== stamp) live[L++] = c;
    }
    for (let d = 0; d < needed; d++) {
      const j = d + rng.int(L - d);
      const card = live[j];
      live[j] = live[d];
      live[d] = card;
      heroHand[2 + bl + d] = card;
      for (let i = 0; i < n; i++) {
        if (inField[i]) oppHands[i][2 + bl + d] = card;
      }
    }

    // 4. Score. A k-way chop is worth 1/k, same convention as `multiway.ts`.
    const heroScore = fixedHero >= 0 ? fixedHero : scoreInts(heroHand, HAND);
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (!inField[i]) continue;
      const sc = scoreInts(oppHands[i], HAND);
      scores[i] = sc;
      if (sc > best) best = sc;
    }

    let share = 0;
    if (heroScore > best) share = 1;
    else if (heroScore === best) {
      let tied = 1;
      for (let i = 0; i < n; i++) {
        if (inField[i] && scores[i] === heroScore) tied++;
      }
      share = 1 / tied;
    }
    shareSum += share;

    // 5. Price this field, with this field's share. `inField` is read after
    //    the dealing step so a seat dropped by the clash fallback is neither
    //    counted nor charged.
    if (payoff !== null) {
      let potIfCalled = payoff.pot;
      for (let i = 0; i < n; i++) {
        if (inField[i]) potIfCalled += payoff.owes[i];
      }
      potSum += potIfCalled;
      evSum += share * potIfCalled - (1 - share) * payoff.cost;
    }

    contestedSum += k;
    ran++;
  }

  return { shareSum, contestedSum, potSum, evSum, sims: ran };
}
