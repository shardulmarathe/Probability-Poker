import { describe, expect, it } from "vitest";
import type { LegalAction, MonteCarloResult } from "../types";
import { makeCard } from "./cards";
import { encodeCard } from "./core/card";
import {
  actionEv,
  callEv,
  foldEquityEv,
  rangeEquity,
  type FoldingOpponent,
} from "./ev";
import { scoreInts } from "./handEvaluator";
import {
  classifyAll,
  makeBoardContext,
  HandBucket,
} from "./model/buckets";
import {
  COMBO_COUNT,
  comboCardA,
  comboCardB,
  removeCards,
  uniformRange,
  type Range,
} from "./model/range";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const card = (rank: number, suit: "s" | "h" | "d" | "c") =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encodeCard(makeCard(rank as any, suit));

/** Cards nobody else can hold. */
const dead = (hole: number[], board: number[]) => [...hole, ...board];

/** Every combo the hero cannot see, weighted equally. */
function priorRange(hole: number[], board: number[]): Range {
  return removeCards(uniformRange(), dead(hole, board));
}

/**
 * A fold model that folds everything below `keep` and never folds at or above
 * it — the sharpest possible strength correlation, which makes the selection
 * effect on `eContinue` unmistakable rather than merely detectable.
 */
function foldBelow(board: number[], keep: HandBucket): Float64Array {
  const buckets = classifyAll(makeBoardContext(board));
  const out = new Float64Array(COMBO_COUNT);
  for (let c = 0; c < COMBO_COUNT; c++) out[c] = buckets[c] >= keep ? 0 : 1;
  return out;
}

/** A fold model that folds at a flat rate regardless of what it holds. */
function foldFlat(rate: number): Float64Array {
  return new Float64Array(COMBO_COUNT).fill(rate);
}

const SIMS = 6000;

// A dry, disconnected board. The hero holds the worst two cards that touch
// nothing on it, which is what makes it a pure bluffing candidate.
const BOARD = [card(13, "s"), card(9, "h"), card(4, "d")];
const AIR = [card(7, "c"), card(2, "d")];
/** Top pair with a good kicker on the same board. */
const VALUE = [card(13, "c"), card(12, "d")];

function opponent(
  hole: number[],
  board: number[],
  foldByCombo: Float64Array
): FoldingOpponent {
  return { range: priorRange(hole, board), foldByCombo };
}

function priceBet(options: {
  hole: number[];
  board?: number[];
  opponents: number;
  fold: Float64Array;
  pot: number;
  bet: number;
  seed?: number;
}) {
  const board = options.board ?? BOARD;
  return foldEquityEv({
    heroHole: options.hole,
    board,
    opponents: Array.from({ length: options.opponents }, () =>
      opponent(options.hole, board, options.fold)
    ),
    pot: options.pot,
    toCall: 0,
    cost: options.bet,
    simulations: SIMS,
    seed: options.seed ?? 0x51ee,
  });
}

/** EV of checking: no chips risked, so the pot share is the whole story. */
const checkEv = (share: number, pot: number) => share * pot;

// ---------------------------------------------------------------------------
// The old formula, unchanged
// ---------------------------------------------------------------------------

describe("actionEv", () => {
  const mc = (pWin: number): MonteCarloResult => ({
    simulations: 1000,
    wins: 0,
    losses: 0,
    ties: 0,
    pWin,
    pLoss: 1 - pWin,
    pTie: 0,
    se: 0,
    ciWin: { lo: 0, hi: 1 },
    categoryFrequencies: {
      0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0,
    },
  });

  const act = (type: LegalAction["type"], cost: number): LegalAction => ({
    type,
    amount: cost,
    cost,
    label: type,
  });

  it("still scores a fold at zero", () => {
    expect(actionEv(act("fold", 0), mc(0.9), 100, 20)).toBe(0);
  });

  it("still assumes a bet is called", () => {
    // The defect this module was extended to fix, kept as a live regression:
    // priced this way a 30% hand can never profitably bet.
    expect(actionEv(act("bet", 50), mc(0.3), 100, 0)).toBeCloseTo(
      0.3 * 150 - 0.7 * 50,
      10
    );
  });
});

// ---------------------------------------------------------------------------
// The formula
// ---------------------------------------------------------------------------

describe("foldEquityEv", () => {
  it("collapses onto actionEv when nobody ever folds", () => {
    // P(fold) = 0 removes the first branch entirely, and the second branch is
    // exactly the old formula with equity-vs-callers in the pWin slot. This is
    // the identity that makes the new price an extension of the old one.
    const r = priceBet({
      hole: AIR,
      opponents: 1,
      fold: foldFlat(0),
      pot: 100,
      bet: 50,
    });
    expect(r.pFold).toBe(0);
    expect(r.callers).toBe(1);
    expect(r.ev).toBeCloseTo(
      r.eContinue * (100 + 50) - (1 - r.eContinue) * 50,
      10
    );
    // ...and the spec's arrangement of the same arithmetic: E·(Pot + 2s) − s.
    expect(r.ev).toBeCloseTo(r.eContinue * (100 + 2 * 50) - 50, 10);
  });

  it("is worth exactly the pot when everybody always folds", () => {
    const r = priceBet({
      hole: AIR,
      opponents: 3,
      fold: foldFlat(1),
      pot: 100,
      bet: 50,
    });
    expect(r.pFold).toBe(1);
    expect(r.ev).toBe(100);
    expect(r.simulations).toBe(0); // nothing left to simulate
  });

  it("splits the EV into a fold term and a call term that sum to it", () => {
    const r = priceBet({
      hole: AIR,
      opponents: 1,
      fold: foldBelow(BOARD, HandBucket.WeakPair),
      pot: 100,
      bet: 50,
    });
    expect(r.foldEv).toBeCloseTo(r.pFold * 100, 10);
    expect(r.callEv).toBeCloseTo(
      (1 - r.pFold) *
        (r.eContinue * r.potIfCalled - (1 - r.eContinue) * 50),
      10
    );
    expect(r.ev).toBeCloseTo(r.foldEv + r.callEv, 10);
  });

  it("takes P(all fold) to be the product of the marginals", () => {
    const r = priceBet({
      hole: AIR,
      opponents: 3,
      fold: foldFlat(0.6),
      pot: 100,
      bet: 50,
    });
    for (const p of r.pFoldEach) expect(p).toBeCloseTo(0.6, 10);
    expect(r.pFold).toBeCloseTo(0.6 ** 3, 10);
  });

  it("is deterministic — the same seed gives the same numbers", () => {
    const args = {
      hole: AIR,
      opponents: 2,
      fold: foldBelow(BOARD, HandBucket.WeakPair),
      pot: 100,
      bet: 50,
      seed: 12345,
    } as const;
    expect(priceBet({ ...args })).toEqual(priceBet({ ...args }));
  });

  it("gives different answers from different seeds", () => {
    const args = {
      hole: AIR,
      opponents: 2,
      fold: foldBelow(BOARD, HandBucket.WeakPair),
      pot: 100,
      bet: 50,
    } as const;
    expect(priceBet({ ...args, seed: 1 }).eContinue).not.toBe(
      priceBet({ ...args, seed: 2 }).eContinue
    );
  });
});

// ---------------------------------------------------------------------------
// E_continue vs E_range — the term that stops the bot over-bluffing
// ---------------------------------------------------------------------------

describe("the continuing range", () => {
  const eRange = (hole: number[], opponents: number) =>
    rangeEquity({
      heroHole: hole,
      board: BOARD,
      ranges: Array.from({ length: opponents }, () => priorRange(hole, BOARD)),
      simulations: SIMS,
      seed: 0x9a17,
    });

  it("is strictly worse than the whole range when folding tracks strength", () => {
    const priced = priceBet({
      hole: AIR,
      opponents: 1,
      fold: foldBelow(BOARD, HandBucket.WeakPair),
      pot: 100,
      bet: 50,
    });
    const whole = eRange(AIR, 1);

    // Heads-up the two are measured against the same one opponent, so the gap
    // is the selection effect alone and nothing else.
    expect(priced.callers).toBe(1);
    expect(priced.eContinue).toBeLessThan(whole);
    // Real numbers, not just an ordering. 7-2 has 0.184 against everything a
    // random hand can be on K-9-4; against only the hands that call a half-pot
    // bet it has 0.047 — a quarter as much. Pricing the bet off 0.184 is what
    // would make the bot bluff hands it should be checking.
    expect(whole).toBeGreaterThan(0.17);
    expect(whole).toBeLessThan(0.2);
    expect(priced.eContinue).toBeLessThan(0.06);
  });

  it("equals the whole range when folding ignores strength", () => {
    // The control. A flat fold rate selects nothing, so the continuing range is
    // the prior range and the two estimates agree to sampling error.
    const priced = priceBet({
      hole: AIR,
      opponents: 1,
      fold: foldFlat(0.5),
      pot: 100,
      bet: 50,
    });
    expect(priced.eContinue).toBeCloseTo(eRange(AIR, 1), 1);
  });

  it("costs a value hand less than it costs air", () => {
    // Top pair is still ahead of the hands that call; air is not. The gap
    // between the two is why the bot can value bet thin and only bluff when the
    // folds are worth more than the gap.
    const sharp = foldBelow(BOARD, HandBucket.WeakPair);
    const airLoss =
      eRange(AIR, 1) -
      priceBet({ hole: AIR, opponents: 1, fold: sharp, pot: 100, bet: 50 })
        .eContinue;
    const valueLoss =
      eRange(VALUE, 1) -
      priceBet({ hole: VALUE, opponents: 1, fold: sharp, pot: 100, bet: 50 })
        .eContinue;
    expect(valueLoss).toBeLessThan(airLoss);
  });

  it("selects against both hands, and by the published amounts", () => {
    // This used to be a bare console.log with no `expect` in it — a test that
    // could not fail. The numbers it printed are worth keeping, so they are
    // pinned instead: the selection effect costs air three-quarters of its
    // equity and top pair about a ninth of its own, and the fold rate barely
    // moves between the two because the model folds on the OPPONENT's hand.
    const sharp = foldBelow(BOARD, HandBucket.WeakPair);
    const rows: string[] = [];
    const seen: Record<string, [number, number, number]> = {};
    for (const [name, hole] of [
      ["7-2 (air)", AIR],
      ["KQ (top pair)", VALUE],
    ] as const) {
      const priced = priceBet({
        hole: [...hole],
        opponents: 1,
        fold: sharp,
        pot: 100,
        bet: 50,
      });
      const whole = eRange([...hole], 1);
      seen[name] = [whole, priced.eContinue, priced.pFold];
      expect(priced.eContinue).toBeLessThan(whole);
      expect(priced.pFold).toBeGreaterThan(0.55);
      expect(priced.pFold).toBeLessThan(0.7);
      rows.push(
        `${name.padEnd(15)} E_range=${whole.toFixed(4)} ` +
          `E_continue=${priced.eContinue.toFixed(4)} ` +
          `pFold=${priced.pFold.toFixed(4)}`
      );
    }

    const [airRange, airContinue] = seen["7-2 (air)"];
    expect(airRange).toBeCloseTo(0.1845, 2);
    expect(airContinue).toBeCloseTo(0.0473, 2);
    // Air keeps under a third of its equity once the folders are removed.
    expect(airContinue / airRange).toBeLessThan(0.33);

    const [valueRange, valueContinue] = seen["KQ (top pair)"];
    expect(valueRange).toBeCloseTo(0.8668, 2);
    expect(valueContinue).toBeCloseTo(0.7549, 2);
    // Top pair keeps almost all of it: it beats the callers too.
    expect(valueContinue / valueRange).toBeGreaterThan(0.85);

    // eslint-disable-next-line no-console
    console.log(rows.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// The asymmetry: the bot bluffs, and only where bluffing works
// ---------------------------------------------------------------------------

describe("bluffing", () => {
  /** A fold-prone opponent: gives up everything short of a pair. */
  const foldProne = () => foldBelow(BOARD, HandBucket.WeakPair);
  /** A calling station: essentially never folds, whatever it holds. */
  const station = () => foldFlat(0.02);

  it("beats checking with the worst hand against a folding opponent", () => {
    const share = rangeEquity({
      heroHole: AIR,
      board: BOARD,
      ranges: [priorRange(AIR, BOARD)],
      simulations: SIMS,
      seed: 0x9a17,
    });
    const bet = priceBet({
      hole: AIR,
      opponents: 1,
      fold: foldProne(),
      pot: 100,
      bet: 50,
    });
    expect(bet.ev).toBeGreaterThan(checkEv(share, 100));
    // eslint-disable-next-line no-console
    console.log(
      `bluff vs fold-prone: check=${checkEv(share, 100).toFixed(2)} ` +
        `bet=${bet.ev.toFixed(2)} pFold=${bet.pFold.toFixed(3)}`
    );
  });

  it("loses to checking with the worst hand against a calling station", () => {
    // The asymmetry that proves the fold term is doing work rather than adding
    // a constant: the same hand, the same pot, the same bet — only the model of
    // what the opponent does with it has changed.
    const share = rangeEquity({
      heroHole: AIR,
      board: BOARD,
      ranges: [priorRange(AIR, BOARD)],
      simulations: SIMS,
      seed: 0x9a17,
    });
    const bet = priceBet({
      hole: AIR,
      opponents: 1,
      fold: station(),
      pot: 100,
      bet: 50,
    });
    expect(bet.ev).toBeLessThan(checkEv(share, 100));
    // eslint-disable-next-line no-console
    console.log(
      `bluff vs station:    check=${checkEv(share, 100).toFixed(2)} ` +
        `bet=${bet.ev.toFixed(2)} pFold=${bet.pFold.toFixed(3)}`
    );
  });

  it("still bets top pair into a calling station", () => {
    // Value betting does not need fold equity, so removing it must not remove
    // the bet — a station is who you want to bet your good hands into.
    const share = rangeEquity({
      heroHole: VALUE,
      board: BOARD,
      ranges: [priorRange(VALUE, BOARD)],
      simulations: SIMS,
      seed: 0x9a17,
    });
    const bet = priceBet({
      hole: VALUE,
      opponents: 1,
      fold: station(),
      pot: 100,
      bet: 50,
    });
    expect(bet.ev).toBeGreaterThan(checkEv(share, 100));
  });

  it("decays with the field size", () => {
    const rows: string[] = [];
    let previous = Infinity;
    for (const n of [1, 2, 3, 5]) {
      const bet = priceBet({
        hole: AIR,
        opponents: n,
        fold: foldProne(),
        pot: 100,
        bet: 50,
      });
      rows.push(
        `${n} opp: pFold=${bet.pFold.toFixed(4)} ` +
          `eCont=${bet.eContinue.toFixed(3)} ev=${bet.ev.toFixed(2)}`
      );
      // Π P(fold_i) falls geometrically, and with it the whole reason to bet.
      expect(bet.pFold).toBeLessThan(previous);
      previous = bet.pFold;
    }
    // eslint-disable-next-line no-console
    console.log("bluff by field size:\n  " + rows.join("\n  "));

    const heads = priceBet({
      hole: AIR,
      opponents: 1,
      fold: foldProne(),
      pot: 100,
      bet: 50,
    });
    const five = priceBet({
      hole: AIR,
      opponents: 5,
      fold: foldProne(),
      pot: 100,
      bet: 50,
    });
    expect(five.ev).toBeLessThan(heads.ev);
  });
});

// ---------------------------------------------------------------------------
// alpha and MDF — the closed-form check
// ---------------------------------------------------------------------------
//
// Everything above is a behavioural claim: the bot bluffs here, not there,
// less into a field. Those would all pass for a formula that was merely
// directionally right. This section is the absolute one. A pure bluff into a
// pot of P at a size of s breaks even exactly when the opponent folds
//
//     alpha = s / (P + s)
//
// and must continue with MDF = 1 - alpha = P / (P + s). That is a published
// result, not a property of this code, so a disagreement convicts the code.

/** The river board the zero-equity fixtures below are built on. */
const RIVER = [
  makeCard(2, "s"),
  makeCard(7, "h"),
  makeCard(9, "d"),
  makeCard(11, "c"),
  makeCard(4, "s"),
].map(encodeCard);
/** Jack-high: beaten by any pair, and there is no draw left to change that. */
const WORST = [makeCard(3, "c"), makeCard(5, "d")].map(encodeCard);

/**
 * Every combo that STRICTLY beats the hero on a complete board.
 *
 * An opponent drawn from this range wins outright every time, so a bet into it
 * has exactly zero equity — not approximately zero, and not zero on average.
 * The board is already five cards, so there is no runout to add variance
 * either: `eContinue` comes back as the integer 0 and the identity can be
 * checked to floating-point tolerance rather than to a confidence interval.
 */
function beatingRange(hole: number[], board: number[]): Range {
  const range = removeCards(uniformRange(), [...hole, ...board]);
  const hand = new Uint8Array(7);
  hand[0] = hole[0];
  hand[1] = hole[1];
  for (let k = 0; k < 5; k++) hand[2 + k] = board[k];
  const heroScore = scoreInts(hand, 7);

  for (let c = 0; c < COMBO_COUNT; c++) {
    if (range[c] <= 0) continue;
    hand[0] = comboCardA(c);
    hand[1] = comboCardB(c);
    if (scoreInts(hand, 7) <= heroScore) range[c] = 0;
  }
  return range;
}

/** A pure bluff of `bet` into `pot`, against an opponent folding at `pFold`. */
function pureBluff(pot: number, bet: number, pFold: number) {
  return foldEquityEv({
    heroHole: WORST,
    board: RIVER,
    opponents: [
      { range: beatingRange(WORST, RIVER), foldByCombo: foldFlat(pFold) },
    ],
    pot,
    toCall: 0,
    cost: bet,
    simulations: 400,
    seed: 0xa1fa,
  });
}

describe("alpha", () => {
  /** Pot, bet, published alpha, published MDF. */
  const TABLE: [number, number, number, number][] = [
    [100, 50, 1 / 3, 2 / 3], //   half pot: 33.3% / 66.7%
    [100, 75, 3 / 7, 4 / 7], //  three-quarter: 42.9% / 57.1%
    [100, 100, 1 / 2, 1 / 2], //  pot: 50.0% / 50.0%
    [100, 200, 2 / 3, 1 / 3], //  twice pot: 66.7% / 33.3%
    [37, 11, 11 / 48, 37 / 48], // an ugly pair, to catch a fitted constant
  ];

  it("gives a pure bluff exactly zero equity, by construction", () => {
    const r = pureBluff(100, 50, 0.5);
    expect(r.eContinue).toBe(0);
    expect(r.callers).toBe(1);
  });

  it("breaks even exactly at alpha = s / (P + s)", () => {
    const rows: string[] = [];
    for (const [pot, bet, alpha, mdf] of TABLE) {
      const r = pureBluff(pot, bet, alpha);
      expect(r.pFold).toBeCloseTo(alpha, 10);
      expect(r.ev).toBeCloseTo(0, 8);
      // Nothing here is a sampling estimate: `eContinue` is the integer 0 and
      // every simulation pays exactly -s, so the residual is floating-point
      // rounding on `alpha·P - (1-alpha)·s` and nothing else. Pinned four orders
      // tighter than the tolerance above, which is what makes this an arithmetic
      // check on `foldEquityEv` rather than a statistical one.
      expect(Math.abs(r.ev)).toBeLessThan(1e-12);
      rows.push(
        `P=${pot} s=${bet}: alpha=${(100 * alpha).toFixed(1)}% ` +
          `MDF=${(100 * mdf).toFixed(1)}% EV(alpha)=${r.ev.toExponential(2)}`
      );
    }
    // eslint-disable-next-line no-console
    console.log("alpha / MDF crossings:\n  " + rows.join("\n  "));
  });

  it("is a genuine crossing — losing below alpha, winning above", () => {
    for (const [pot, bet, alpha] of TABLE) {
      expect(pureBluff(pot, bet, alpha - 0.02).ev).toBeLessThan(0);
      expect(pureBluff(pot, bet, alpha + 0.02).ev).toBeGreaterThan(0);
    }
  });

  it("demands more folds from a bigger bet", () => {
    // alpha is increasing in s, which is why a big bluff needs a fold-prone
    // opponent and a small one does not.
    let previous = -Infinity;
    for (const bet of [25, 50, 75, 100, 200, 400]) {
      const alpha = bet / (100 + bet);
      expect(alpha).toBeGreaterThan(previous);
      previous = alpha;
      // A fold rate that broke even at half pot loses money at every size above
      // it, which is the whole content of "alpha is increasing".
      if (bet > 50) expect(pureBluff(100, bet, 1 / 3).ev).toBeLessThan(0);
    }
  });

  it("leaves the bot indifferent at alpha rather than enthusiastic", () => {
    // If a pure bluff were strongly +EV at exactly the break-even frequency,
    // something would be counted twice — most likely the pot appearing in both
    // branches. The bet must be worth neither more nor less than checking a
    // hand that cannot win, which is worth nothing.
    for (const [pot, bet, alpha] of TABLE) {
      expect(Math.abs(pureBluff(pot, bet, alpha).ev)).toBeLessThan(1e-8);
    }
  });

  it("pays a bluff with equity more than a pure one at the same alpha", () => {
    // The sanity check in the other direction: alpha is the floor for a hand
    // with nothing, and any real equity has to be worth strictly more.
    const pot = 100;
    const bet = 50;
    const alpha = bet / (pot + bet);
    const withEquity = foldEquityEv({
      heroHole: WORST,
      board: RIVER,
      opponents: [
        {
          range: removeCards(uniformRange(), [...WORST, ...RIVER]),
          foldByCombo: foldFlat(alpha),
        },
      ],
      pot,
      toCall: 0,
      cost: bet,
      simulations: SIMS,
      seed: 0xa1fa,
    });
    expect(withEquity.eContinue).toBeGreaterThan(0);
    expect(withEquity.ev).toBeGreaterThan(pureBluff(pot, bet, alpha).ev);
  });
});


// ---------------------------------------------------------------------------
// The multiway call term — an expectation of a product, not a product of means
// ---------------------------------------------------------------------------
//
// The call branch is worth E[ share · (Pot + Σ owes) − (1 − share) · cost ].
// The module used to compute E[share] · (Pot + E[k] · extra) instead. Heads-up
// those agree, because k is the constant 1 and there is nothing to correlate.
// Multiway they do not: the hero takes a smaller fraction of the pot in exactly
// the simulations where more opponents stayed in, so share and k are negatively
// correlated and the product of the means is strictly the larger of the two —
// always in the direction that makes betting look better than it is.
//
// The fixtures below pin that difference against closed-form arithmetic rather
// than against the implementation, so they convict the code the way `alpha`
// does rather than merely describing it.

const choose = (n: number, k: number) => {
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return out;
};

/**
 * P(exactly k of n opponents continue | at least one does), for n independent
 * seats folding at a flat `pFold`. This is the distribution `runField` samples
 * when it rejects the all-fold outcome, so it is the right yardstick for the
 * field size the call term is averaged over.
 */
function fieldSizes(n: number, pFold: number): number[] {
  const q = 1 - pFold;
  const denom = 1 - pFold ** n;
  const out = [0];
  for (let k = 1; k <= n; k++) {
    out.push((choose(n, k) * q ** k * pFold ** (n - k)) / denom);
  }
  return out;
}

/**
 * An opponent that beats the hero with probability exactly `beat`, whatever the
 * board runs out — because there is no runout left.
 *
 * Every combo that ties the hero is given zero weight, so the hero's share of
 * any pot is 0 or 1 and never a fraction. Against k such opponents the hero
 * wins iff all k of them drew from the losing side, i.e. with probability
 * (1 − beat)^k: share falls as the field grows, by construction and by a known
 * amount. That is the negative correlation the call term has to survive.
 */
function mixedRange(hole: number[], board: number[], beat: number): Range {
  const range = removeCards(uniformRange(), [...hole, ...board]);
  const hand = new Uint8Array(7);
  hand[0] = hole[0];
  hand[1] = hole[1];
  for (let k = 0; k < 5; k++) hand[2 + k] = board[k];
  const heroScore = scoreInts(hand, 7);

  const better: number[] = [];
  const worse: number[] = [];
  for (let c = 0; c < COMBO_COUNT; c++) {
    if (range[c] <= 0) continue;
    hand[0] = comboCardA(c);
    hand[1] = comboCardB(c);
    const sc = scoreInts(hand, 7);
    range[c] = 0;
    if (sc > heroScore) better.push(c);
    else if (sc < heroScore) worse.push(c);
  }
  // `WORST` has essentially nothing below it — that is what makes it a pure
  // bluff — so a mixture built on it would be a beating range wearing a
  // disguise. Fail loudly rather than silently pricing `beat = 1`.
  if (better.length === 0 || worse.length === 0) {
    throw new Error(
      `mixedRange: ${better.length} better / ${worse.length} worse combos`
    );
  }
  for (const c of better) range[c] = beat / better.length;
  for (const c of worse) range[c] = (1 - beat) / worse.length;
  return range;
}

/**
 * A hand in the middle of the river board: a pair of nines with a jack kicker.
 * Plenty of hands beat it and plenty lose to it, which is what `mixedRange`
 * needs and what `WORST` cannot provide.
 */
const MIDDLE = [card(9, "s"), card(5, "c")];

interface MixedSpot {
  n: number;
  pFold: number;
  beat: number;
  pot: number;
  bet: number;
  sims?: number;
  seed?: number;
}

/** What the module says the spot is worth. */
function priceMixed(spot: MixedSpot) {
  const range = mixedRange(MIDDLE, RIVER, spot.beat);
  return foldEquityEv({
    heroHole: MIDDLE,
    board: RIVER,
    opponents: Array.from({ length: spot.n }, () => ({
      range,
      foldByCombo: foldFlat(spot.pFold),
    })),
    pot: spot.pot,
    toCall: 0,
    cost: spot.bet,
    simulations: spot.sims ?? 40000,
    seed: spot.seed ?? 0x51ee,
  });
}

/** What the spot is actually worth, and what factorising would have said. */
function mixedTruth(spot: MixedSpot) {
  const P = fieldSizes(spot.n, spot.pFold);
  let eShare = 0;
  let eK = 0;
  let ePayoff = 0;
  for (let k = 1; k <= spot.n; k++) {
    const share = (1 - spot.beat) ** k;
    eShare += P[k] * share;
    eK += P[k] * k;
    ePayoff +=
      P[k] * (share * (spot.pot + k * spot.bet) - (1 - share) * spot.bet);
  }
  const allFold = spot.pFold ** spot.n;
  return {
    eShare,
    eK,
    exact: allFold * spot.pot + (1 - allFold) * ePayoff,
    factorised:
      allFold * spot.pot +
      (1 - allFold) *
        (eShare * (spot.pot + eK * spot.bet) - (1 - eShare) * spot.bet),
  };
}

/**
 * The price the module WOULD report if it rebuilt the call term out of its two
 * reported means. Everything here comes off the breakdown, so it is measured on
 * the very same sample stream as `r.ev` and the gap between them is the
 * factorisation and nothing else — not seeds, not sampling noise.
 */
function factorisedEv(
  r: ReturnType<typeof foldEquityEv>,
  pot: number,
  cost: number,
  toCall = 0
) {
  const extra = Math.max(0, cost - toCall);
  return (
    r.pFold * pot +
    (1 - r.pFold) *
      (r.eContinue * (pot + r.callers * extra) - (1 - r.eContinue) * cost)
  );
}

describe("the multiway call term", () => {
  it("is unchanged heads-up, where the factorisation is exact", () => {
    // k ≡ 1 with one opponent, so there is no product to factorise and the two
    // arrangements must agree to the last bit that double precision allows.
    for (const [pot, bet] of [
      [100, 50],
      [100, 100],
      [100, 200],
      [37, 11],
    ] as const) {
      for (const fold of [foldFlat(0.3), foldBelow(BOARD, HandBucket.WeakPair)]) {
        const r = priceBet({ hole: AIR, opponents: 1, fold, pot, bet });
        expect(r.callers).toBe(1);
        expect(r.potIfCalled).toBe(pot + bet);
        expect(Math.abs(r.ev - factorisedEv(r, pot, bet))).toBeLessThan(1e-9);
      }
    }
  });

  it("is strictly below the factorised price multiway, and by more as the field grows", () => {
    const gaps: number[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const r = priceBet({
        hole: AIR,
        opponents: n,
        fold: foldFlat(0.6),
        pot: 100,
        bet: 100,
      });
      const gap = factorisedEv(r, 100, 100) - r.ev;
      if (n === 1) expect(Math.abs(gap)).toBeLessThan(1e-9);
      else expect(gap).toBeGreaterThan(0);
      gaps.push(gap);
    }
    // The comment this replaced claimed the Π-fold decay dominated the
    // factorisation error. It does not: the error is driven by the variance of
    // the field size, so it GROWS with the field exactly as the decay does.
    expect(gaps[4]).toBeGreaterThan(gaps[1]);
    expect(gaps[4]).toBeGreaterThan(2);
  });

  it("matches the closed form, and the factorised price matches its own", () => {
    // The absolute check. `mixedRange` makes every opponent beat the hero with
    // a known probability, so both prices can be written down without running
    // anything, and the module has to land on the right one of the two.
    const spot: MixedSpot = { n: 4, pFold: 0.4, beat: 0.45, pot: 100, bet: 200 };
    const truth = mixedTruth(spot);
    const r = priceMixed(spot);

    const measured = factorisedEv(r, spot.pot, spot.bet);

    // The closed form treats the four seats as independent draws; the sampler
    // deals them from one deck, so the hero's share comes in a whisker low.
    // That bias is on the share, not on the arithmetic under test.
    expect(Math.abs(r.eContinue - truth.eShare)).toBeLessThan(0.01);
    expect(Math.abs(r.callers - truth.eK)).toBeLessThan(0.02);

    // The module lands on the honest price and nowhere near the other one.
    expect(Math.abs(r.ev - truth.exact)).toBeLessThan(6);
    expect(Math.abs(r.ev - truth.factorised)).toBeGreaterThan(18);
    expect(Math.abs(measured - truth.factorised)).toBeLessThan(6);

    // The gap between the two arrangements is what the correlation is worth,
    // and the share bias cancels out of it — so this is the tight assertion.
    expect(truth.factorised - truth.exact).toBeCloseTo(24.5815, 3);
    expect(Math.abs(measured - r.ev - (truth.factorised - truth.exact)))
      .toBeLessThan(1);
  });

  it("flips a decision the factorised price got wrong", () => {
    // Same spot, read as a decision. Betting risks 200 into 100 with a hand
    // that wins 27% of the pots it contests: the factorised price calls that a
    // +12 chip bet, the honest one a −12 chip bet. Checking is worth 0 to a
    // hand that has to fold to any action, so the sign IS the decision.
    const spot: MixedSpot = { n: 4, pFold: 0.4, beat: 0.45, pot: 100, bet: 200 };
    const r = priceMixed(spot);
    const wrong = factorisedEv(r, spot.pot, spot.bet);

    expect(wrong).toBeGreaterThan(5); // "bet"
    expect(r.ev).toBeLessThan(-5); //    "check"
    expect(wrong - r.ev).toBeGreaterThan(15);
  });

  it("counts every opponent that stayed in, not just one of them", () => {
    // The pot the hero plays for is pot + Σ owes over the seats that continue,
    // so with one `owes` for everybody it has to track the mean field size.
    // Charging a single opponent regardless of how many called would leave
    // `potIfCalled` stuck at pot + extra.
    const spot = { n: 4, pFold: 0.4, pot: 100, bet: 200 };
    const r = priceMixed({ ...spot, beat: 0.45 });
    const eK = mixedTruth({ ...spot, beat: 0.45 }).eK;

    expect(eK).toBeCloseTo(2.4631, 4);
    expect(r.callers).toBeCloseTo(eK, 1);
    expect(r.potIfCalled).toBeCloseTo(spot.pot + r.callers * spot.bet, 6);
    expect(Math.abs(r.potIfCalled - (spot.pot + eK * spot.bet))).toBeLessThan(5);
    // ...which is a long way from what one caller alone would put in.
    expect(r.potIfCalled).toBeGreaterThan(spot.pot + 1.4 * spot.bet);
  });
});

// ---------------------------------------------------------------------------
// Raises — where `extra` and `cost` stop being the same number
// ---------------------------------------------------------------------------
//
// Every test above this line prices an opening bet, `toCall = 0`, and there
// `extra = cost − toCall = cost`: the two are interchangeable and nothing can
// tell them apart. A raise separates them, and they play different roles.
//
//   - the hero risks `cost` — the call and the raise on top of it;
//   - a seat already at the current bet level owes only the increment `extra`;
//   - a seat that has not matched `toCall` owes the whole `cost`.

/** A pure bluff-raise: no equity at all, so only the chips matter. */
function pureRaise(opts: {
  pot: number;
  toCall: number;
  cost: number;
  pFold: number;
  opponents?: number;
}) {
  const range = beatingRange(WORST, RIVER);
  return foldEquityEv({
    heroHole: WORST,
    board: RIVER,
    opponents: Array.from({ length: opts.opponents ?? 1 }, () => ({
      range,
      foldByCombo: foldFlat(opts.pFold),
    })),
    pot: opts.pot,
    toCall: opts.toCall,
    cost: opts.cost,
    simulations: 400,
    seed: 0xa1fa,
  });
}

/**
 * A hero who cannot lose: opponents draw only from hands he beats, so his share
 * is the integer 1 in every simulation and the EV is pure chip arithmetic.
 * That makes the pot — who owes what — the only thing left to get wrong.
 */
function pricedRaise(opts: {
  pot: number;
  toCall: number;
  cost: number;
  pFold: number;
  owes?: (number | undefined)[];
  opponents?: number;
}) {
  const n = opts.opponents ?? 2;
  const range = mixedRange(MIDDLE, RIVER, 0);
  return foldEquityEv({
    heroHole: MIDDLE,
    board: RIVER,
    opponents: Array.from({ length: n }, (_, i) => ({
      range,
      foldByCombo: foldFlat(opts.pFold),
      owes: opts.owes?.[i],
    })),
    pot: opts.pot,
    toCall: opts.toCall,
    cost: opts.cost,
    simulations: 40000,
    seed: 0x51ee,
  });
}

describe("raises", () => {
  const POT = 125;
  const TO_CALL = 25;
  const COST = 75;
  const EXTRA = COST - TO_CALL; // 50

  it("risks the whole cost, not just the raise increment", () => {
    // A bluff-raise that gets called loses the call as well as the raise. The
    // hero is 75 chips lighter, not 50, and alpha moves accordingly.
    for (const pFold of [0.2, 0.375, 0.5, 0.8]) {
      const r = pureRaise({ pot: POT, toCall: TO_CALL, cost: COST, pFold });
      expect(r.eContinue).toBe(0);
      expect(r.ev).toBeCloseTo(pFold * POT - (1 - pFold) * COST, 10);
    }
  });

  it("breaks even at cost / (pot + cost), not extra / (pot + extra)", () => {
    // The raise's alpha. Charging the increment instead of the cost would move
    // the crossing from 37.5% down to 28.6%, and a bluff-raise that needs 37.5%
    // folds would be priced as break-even on 28.6% — a licence to bluff-raise
    // roughly a third more often than the arithmetic allows.
    const alpha = COST / (POT + COST);
    const wrong = EXTRA / (POT + EXTRA);
    expect(alpha).toBeCloseTo(0.375, 10);
    expect(wrong).toBeCloseTo(2 / 7, 10);

    expect(pureRaise({ pot: POT, toCall: TO_CALL, cost: COST, pFold: alpha }).ev)
      .toBeCloseTo(0, 8);
    expect(
      pureRaise({ pot: POT, toCall: TO_CALL, cost: COST, pFold: wrong }).ev
    ).toBeLessThan(-15);
    expect(
      pureRaise({ pot: POT, toCall: TO_CALL, cost: COST, pFold: alpha - 0.02 })
        .ev
    ).toBeLessThan(0);
    expect(
      pureRaise({ pot: POT, toCall: TO_CALL, cost: COST, pFold: alpha + 0.02 })
        .ev
    ).toBeGreaterThan(0);
  });

  it("charges a seat that has not matched toCall the full cost", () => {
    // Two opponents. A is the player whose bet the hero is raising and is
    // already in for `toCall`, so calling costs it the increment. B has not put
    // anything in this street and owes the call AND the raise. Pricing B at the
    // increment loses `toCall` chips of pot every time B calls.
    const pFold = 0.4;
    const q = 1 - pFold;
    const called = 1 - pFold ** 2;
    // P(a given seat is in | somebody is), for two independent flat coins.
    const inGivenCalled = q / called;

    const matched = pricedRaise({
      pot: POT,
      toCall: TO_CALL,
      cost: COST,
      pFold,
      owes: [EXTRA, COST],
    });
    // The hero never loses in this fixture, so the pot is the whole story.
    expect(matched.eContinue).toBe(1);
    const truePot = POT + (EXTRA + COST) * inGivenCalled;
    expect(truePot).toBeCloseTo(214.2857, 4);
    expect(matched.potIfCalled).toBeCloseTo(truePot, 0);
    expect(matched.ev).toBeCloseTo(pFold ** 2 * POT + called * truePot, 0);
    expect(matched.ev).toBeCloseTo(200, 0);

    // The default — charge everybody the increment — is what the module does
    // when the caller does not say who has matched. It is the conservative
    // direction: it understates the pot, and so understates the raise.
    const assumed = pricedRaise({ pot: POT, toCall: TO_CALL, cost: COST, pFold });
    const shortPot = POT + 2 * EXTRA * inGivenCalled;
    expect(shortPot).toBeCloseTo(196.4286, 4);
    expect(assumed.potIfCalled).toBeCloseTo(shortPot, 0);
    expect(assumed.ev).toBeCloseTo(185, 0);
    expect(assumed.ev).toBeLessThan(matched.ev);
    // Exactly `toCall` per unmatched seat that calls, and nothing else.
    expect(matched.potIfCalled - assumed.potIfCalled).toBeCloseTo(
      TO_CALL * inGivenCalled,
      1
    );
  });

  it("leaves an opening bet alone, where every seat owes the same", () => {
    // toCall = 0 makes extra = cost, so `owes` cannot change anything and the
    // default has to be exactly the old behaviour for every bet ever priced.
    const spelled = pricedRaise({
      pot: 100,
      toCall: 0,
      cost: 60,
      pFold: 0.4,
      owes: [60, 60],
    });
    const defaulted = pricedRaise({
      pot: 100,
      toCall: 0,
      cost: 60,
      pFold: 0.4,
    });
    expect(spelled).toEqual(defaulted);
  });

  it("still separates the two multiway errors", () => {
    // Bug 1 (factorising) reads high, bug 2 (under-charging the field) reads
    // low, and in the raise path they partially cancelled. With both fixed the
    // honest price is below the factorised one at the same, correct, pot.
    const r = pricedRaise({
      pot: POT,
      toCall: TO_CALL,
      cost: COST,
      pFold: 0.4,
      owes: [EXTRA, COST],
      opponents: 2,
    });
    // A hero who always wins has no share/field correlation to lose, so here
    // the two arrangements agree — the pot fix is visible on its own.
    expect(r.eContinue).toBe(1);
    expect(r.ev).toBeGreaterThan(
      pricedRaise({ pot: POT, toCall: TO_CALL, cost: COST, pFold: 0.4 }).ev
    );
  });
});

// ---------------------------------------------------------------------------
// callEv — a call that does not close the action
// ---------------------------------------------------------------------------
//
// The two things this has to get right are opposites, so both are pinned. It
// must price the call against the pot the seats behind will build (or it stays
// on a different basis from the raise it is compared against, which is the bug),
// and it must not award a single chip of fold equity (or a call becomes a raise
// that costs less, which would be a worse bug than the one it replaces).

describe("callEv", () => {
  /** A hero calling `toCall` into `pot`, with `behind` seats yet to act. */
  function priceCall(options: {
    hole?: number[];
    /** Seats already at the current bet: no decision left, and add nothing. */
    matched: number;
    /** Seats still to act, each owing this much, each folding at this rate. */
    behind?: { owes: number; fold: number }[];
    pot: number;
    toCall: number;
  }) {
    const hole = options.hole ?? AIR;
    const opponents: FoldingOpponent[] = [];
    for (let i = 0; i < options.matched; i++) {
      // Deliberately handed a fold model that folds everything: `callEv` has to
      // overwrite it, and a test that passed zeros in could not tell.
      opponents.push({ ...opponent(hole, BOARD, foldFlat(1)), owes: 0 });
    }
    for (const b of options.behind ?? []) {
      opponents.push({ ...opponent(hole, BOARD, foldFlat(b.fold)), owes: b.owes });
    }
    return callEv({
      heroHole: hole,
      board: BOARD,
      opponents,
      pot: options.pot,
      toCall: options.toCall,
      simulations: SIMS,
      seed: 0xca11,
    });
  }

  it("gives a call no fold equity at all, however the caller models the field", () => {
    // The seat whose bet is being called cannot fold to the call, so the
    // all-fold branch is unreachable and `pFold` is 0 by construction — not
    // small, not usually, exactly 0.
    const r = priceCall({
      matched: 1,
      behind: [{ owes: 20, fold: 0.9 }],
      pot: 100,
      toCall: 20,
    });
    expect(r.pFoldEach[0]).toBe(0);
    expect(r.pFold).toBe(0);
    expect(r.foldEv).toBe(0);
    expect(r.ev).toBe(r.callEv);
  });

  it("collapses onto actionEv's basis when nobody behind owes anything", () => {
    // Every opponent already matched: the pot cannot grow, so the priced pot is
    // the pot as it stands and the payoff is `share·pot - (1-share)·toCall` —
    // exactly the arithmetic `actionEv` does. This is why `decider.priceCall`
    // can decline to re-price a closing call and leave the old number standing.
    const POT = 100;
    const TO_CALL = 20;
    const r = priceCall({ matched: 3, pot: POT, toCall: TO_CALL });
    expect(r.potIfCalled).toBe(POT);
    expect(r.callers).toBe(3);
    const share = r.eContinue;
    expect(r.ev).toBeCloseTo(share * POT - (1 - share) * TO_CALL, 6);
  });

  it("prices the call against the pot the seats behind build", () => {
    // The correction, isolated. Same hero, same field, same price: the only
    // difference is whether the two seats yet to act are treated as already in
    // (`actionEv`'s assumption) or as seats that must pay 20 each to continue.
    const behind = [
      { owes: 20, fold: 0.5 },
      { owes: 20, fold: 0.5 },
    ];
    const priced = priceCall({ matched: 1, behind, pot: 100, toCall: 20 });
    const assumed = priceCall({ matched: 3, pot: 100, toCall: 20 });

    // Two mechanisms, both pointing the same way: the seats that continue add
    // chips, and the ones that fold stop contesting the hero's share.
    expect(priced.potIfCalled).toBeGreaterThan(assumed.potIfCalled);
    expect(priced.eContinue).toBeGreaterThan(assumed.eContinue);
    expect(priced.ev).toBeGreaterThan(assumed.ev);
    // eslint-disable-next-line no-console
    console.log(
      `call priced on the reached pot: ${priced.ev.toFixed(2)} ` +
        `(pot ${priced.potIfCalled.toFixed(1)}) vs on the standing pot: ` +
        `${assumed.ev.toFixed(2)} (pot ${assumed.potIfCalled.toFixed(1)})`
    );
  });

  it("still lets a raise beat a call when the folds it buys are worth something", () => {
    // The asymmetry the roster rests on. Same air, same board, same field: the
    // raise gets a fold branch, the call does not, so the raise wins on hands
    // that cannot win a showdown. If this ever fails, `callEv` has grown fold
    // equity and every passive profile has quietly become an aggressive one.
    const POT = 100;
    const called = priceCall({
      matched: 1,
      behind: [{ owes: 20, fold: 0.7 }],
      pot: POT,
      toCall: 20,
    });
    const raised = foldEquityEv({
      heroHole: AIR,
      board: BOARD,
      opponents: [
        { ...opponent(AIR, BOARD, foldFlat(0.7)), owes: 60 },
        { ...opponent(AIR, BOARD, foldFlat(0.7)), owes: 80 },
      ],
      pot: POT,
      toCall: 20,
      cost: 80,
      simulations: SIMS,
      seed: 0xca11,
    });
    expect(raised.pFold).toBeGreaterThan(0);
    expect(called.pFold).toBe(0);
    expect(raised.ev).toBeGreaterThan(called.ev);
  });

  it("charges each seat behind only what that seat owes", () => {
    // The small blind owes less than a seat that has put in nothing, and the pot
    // has to reflect that. One shared `owes` would over-count the cheap seat.
    const cheap = priceCall({
      matched: 1,
      behind: [{ owes: 5, fold: 0 }],
      pot: 100,
      toCall: 20,
    });
    const full = priceCall({
      matched: 1,
      behind: [{ owes: 20, fold: 0 }],
      pot: 100,
      toCall: 20,
    });
    // Nobody folds in either, so the fields are identical and the whole gap is
    // the 15 chips the second seat has to add.
    expect(cheap.callers).toBe(2);
    expect(full.callers).toBe(2);
    expect(full.potIfCalled - cheap.potIfCalled).toBeCloseTo(15, 6);
  });

  it("treats a missing owes as nothing owed", () => {
    // `FoldingOpponent.owes` is optional because a bet charges every seat the
    // same. A call is the other case: an omitted `owes` is a seat with no
    // decision left, which is what `decider.priceCall` never has to spell out.
    const implicit = callEv({
      heroHole: AIR,
      board: BOARD,
      opponents: [opponent(AIR, BOARD, foldFlat(0.9))],
      pot: 100,
      toCall: 20,
      simulations: SIMS,
      seed: 0xca11,
    });
    const explicit = priceCall({ matched: 1, pot: 100, toCall: 20 });
    expect(implicit).toEqual(explicit);
  });
});
