import { describe, expect, it } from "vitest";
import type { LegalAction, MonteCarloResult } from "../types";
import { makeCard } from "./cards";
import { encodeCard } from "./core/card";
import {
  actionEv,
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

  it("reports the numbers", () => {
    const sharp = foldBelow(BOARD, HandBucket.WeakPair);
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
      // eslint-disable-next-line no-console
      console.log(
        `${name.padEnd(15)} E_range=${eRange([...hole], 1).toFixed(4)} ` +
          `E_continue=${priced.eContinue.toFixed(4)} ` +
          `pFold=${priced.pFold.toFixed(4)}`
      );
    }
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
