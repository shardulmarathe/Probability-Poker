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
 * decision point. Sunk chips already in the pot are ignored — only the chips
 * risked *now* and the pot that can be won matter. This is what makes folding
 * correct: the bot folds whenever calling is a losing proposition.
 *
 *   - Fold:  EV = 0                      (baseline — risk nothing, win nothing)
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
// worse failure than never bluffing at all — it turns every missed draw into a
// "profitable" bet against a range that has already folded its air.
//
// The continuing range is derived here by weighting each combo by
// 1 − P(fold | bucket(combo)) and renormalising, which is exactly the posterior
// over the opponent's holding conditioned on "did not fold".
//
// The bracket above is the same arithmetic `actionEv` does, with E_continue
// substituted for pWin: E·(Pot + s) − (1 − E)·s = E·(Pot + 2s) − s. That
// identity is why this is an extension of the old formula rather than a rival
// to it, and it generalises to k callers as E·(Pot + k·s) − (1 − E)·cost.
//
// ALPHA. Setting E_continue = 0 — a pure bluff, no equity at all — collapses
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
// automatically profitable. The published values fall straight out —
// half pot 33.3% / 66.7%, three-quarter pot 42.9% / 57.1%, pot 50% / 50%,
// twice pot 66.7% / 33.3% — and `ev.test.ts` pins all four against this
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
   * opponent that cannot fold — already all-in — is modelled with zeros.
   */
  foldByCombo: Float64Array;
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
  /** Chips the hero adds now, call included — `TableAction.cost`. */
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
  /** P(every opponent folds) — see the independence note on `foldEquityEv`. */
  pFold: number;
  /** P(fold) per opponent, in input order. */
  pFoldEach: number[];
  /**
   * Hero's pot share against the opponents that continue, given at least one
   * does. Compare against equity-vs-range (`rangeEquity`): the gap between them
   * is the whole reason this module exists.
   */
  eContinue: number;
  /** Mean number of opponents that continue, given at least one does. */
  callers: number;
  /** Pot the hero is playing for when called: `pot + callers · extra`. */
  potIfCalled: number;
  /** `pFold · pot` — the chips the bet wins uncontested. */
  foldEv: number;
  /** `(1 − pFold) · [eContinue · potIfCalled − (1 − eContinue) · cost]`. */
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
 * to be Π P(fold_i) — the product of the per-opponent marginals. That is not
 * strictly true: the opponents' ranges are coupled by card removal (a card in
 * one hand is not in another), so their folding decisions are weakly dependent,
 * and the same coupling is ignored again when the continuing field is drawn.
 * The error runs one way — the product overstates how often the whole field
 * folds — so the bot is slightly over-optimistic about bluffing into a field.
 *
 * The decay itself is not an artifact of that assumption, and it is the real
 * lesson: a 55% fold rate is 55% heads-up, 30% against two, 9% against four.
 * Fold equity dies exponentially in the field size, which is why bluffing
 * multiway is bad long before any second-order dependence matters.
 */
export function foldEquityEv(input: FoldEquityInput): FoldEquityBreakdown {
  const { pot, toCall, cost, opponents } = input;
  const extra = Math.max(0, cost - toCall);

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
  if (pFold < 1) {
    const run = runField(
      input.heroHole,
      input.board,
      samplers,
      pContinue,
      input.simulations,
      makeRng(input.seed)
    );
    if (run.sims > 0) {
      eContinue = run.shareSum / run.sims;
      callers = run.contestedSum / run.sims;
      simulations = run.sims;
    }
  }

  // `callers · extra` rather than `2s`: heads-up `callers` is 1 and this is the
  // formula in the header comment exactly. Multiway it factorises an
  // expectation of a product — pot share and field size are negatively
  // correlated, so this reads slightly high — but the Π decay above dominates
  // by orders of magnitude in every spot where the difference could matter.
  const potIfCalled = pot + callers * extra;
  const foldEv = pFold * pot;
  const callEv =
    (1 - pFold) * (eContinue * potIfCalled - (1 - eContinue) * cost);

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

export interface RangeEquityInput {
  heroHole: readonly number[];
  board: readonly number[];
  /** One prior range per opponent; every one of them sees the river. */
  ranges: readonly Range[];
  simulations: number;
  seed: number;
}

/**
 * Hero's pot share against the opponents' *whole* ranges — the number
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
    input.simulations,
    makeRng(input.seed)
  );
  return run.sims > 0 ? run.shareSum / run.sims : 0;
}

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------
//
// `equity/multiway.ts` samples opponents from a three-tier `BeliefDistribution`
// and cannot express an arbitrary weight per combo. A continuing range *is* an
// arbitrary weight per combo — that is the entire point of deriving it — so
// this module needs its own sampler. It differs in exactly two ways: hands come
// off a `ComboSampler` instead of a tier bucket, and a seat may sit the hand out
// according to its own fold probability.

/** Whole-tuple redraws before the field is dealt short. See `multiway.ts`. */
const MAX_TUPLE_ATTEMPTS = 64;
/** Redraws of the continue/fold coins before the fallback pick below. */
const MAX_SUBSET_ATTEMPTS = 64;

interface FieldRun {
  /** Σ of the hero's pot share over the sims that produced one. */
  shareSum: number;
  /** Σ of the number of opponents contesting. */
  contestedSum: number;
  sims: number;
}

function runField(
  heroHole: readonly number[],
  board: readonly number[],
  samplers: readonly (ComboSampler | null)[],
  pContinue: readonly number[] | null,
  sims: number,
  rng: Rng
): FieldRun {
  const n = samplers.length;
  const bl = board.length;
  const needed = 5 - bl;
  if (n === 0 || sims <= 0) return { shareSum: 0, contestedSum: 0, sims: 0 };
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
  let ran = 0;

  for (let s = 0; s < sims; s++) {
    // 1. Who is still in. With no fold model everybody is; with one, each seat
    //    flips its own coin and the all-fold outcome is rejected — that is what
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

    if (heroScore > best) shareSum += 1;
    else if (heroScore === best) {
      let tied = 1;
      for (let i = 0; i < n; i++) {
        if (inField[i] && scores[i] === heroScore) tied++;
      }
      shareSum += 1 / tied;
    }

    contestedSum += k;
    ran++;
  }

  return { shareSum, contestedSum, sims: ran };
}
