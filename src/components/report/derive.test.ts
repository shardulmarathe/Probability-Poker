/**
 * Tests for the hand review's derived quantities.
 *
 * The module has one job that can fail silently: it turns a factual record into
 * the numbers a player will read as facts. A wrong equity here does not throw,
 * does not look wrong, and is exactly as authoritative on the page as a right
 * one, so the assertions below are mostly about *identity*: that a number is
 * the quantity its label claims, and not some other number that happens to sit
 * in the same range.
 *
 * The head-to-head block in particular pins down the property that no
 * range-based estimate can have: change the reviewing seat's hole cards and the
 * number must move.
 */

import { describe, expect, it } from "vitest";
import { tierOf } from "../../poker/bayesian";
import { decodeCard } from "../../poker/core/card";
import { opponentRanges } from "../../poker/model/decider";
import {
  COMBO_COUNT,
  GRID_CELLS,
  comboCardA,
  comboCardB,
  comboIndex,
  gridCellOf,
} from "../../poker/model/range";
import type { TableState } from "../../poker/table/state";
import type {
  ActionRecord,
  BotDecision,
  MultiwayEquity,
  PotRecord,
  SeatResult,
  TableHandReport,
} from "../../poker/table/contract";
import type { BeliefDistribution, Street } from "../../types";
import {
  CELL_TOTAL,
  headsUpEquity,
  rangeView,
  readsAfter,
  requiredEquity,
  reviewStreets,
  streetEquities,
} from "./derive";

// ---------------------------------------------------------------------------
// Cards. Code = (rank - 2) * 4 + suit, suits ordered s h d c (core/card.ts).
// ---------------------------------------------------------------------------

const card = (rank: number, suit: number) => (rank - 2) * 4 + suit;
const [S, H, D, C] = [0, 1, 2, 3];

const SEVEN_H = card(7, H);
const TWO_C = card(2, C);
const KING_S = card(13, S);
const KING_D = card(13, D);
const ACE_S = card(14, S);
const ACE_D = card(14, D);

/** 7-2 offsuit: the worst starting hand in hold'em. */
const SEVEN_TWO = [SEVEN_H, TWO_C];
/** Pocket kings. */
const KINGS = [KING_S, KING_D];
/** Pocket aces: the best. */
const ACES = [ACE_S, ACE_D];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function equity(perOpponent: Record<number, number>): MultiwayEquity {
  return {
    simulations: 2000,
    wins: 0,
    ties: 0,
    losses: 0,
    pWin: 0,
    pTie: 0,
    pLoss: 0,
    equity: 0,
    se: 0,
    ciWin: { lo: 0, hi: 0 },
    perOpponent,
  };
}

function decision(
  seat: number,
  street: Street,
  perOpponent: Record<number, number>
): BotDecision {
  return {
    seat,
    street,
    action: { type: "raise", amount: 60, cost: 60, label: "Raise" },
    potBefore: 90,
    toCall: 30,
    equity: equity(perOpponent),
    evByAction: {},
    beliefs: {},
    profile: "tag",
  };
}

interface ReportSpec {
  holes: Record<number, number[]>;
  board?: number[];
  decisions?: BotDecision[];
  actions?: ActionRecord[];
  pots?: PotRecord[];
  seed?: number;
}

function report(spec: ReportSpec): TableHandReport {
  const ids = Object.keys(spec.holes).map(Number).sort((a, b) => a - b);
  const seats: SeatResult[] = ids.map((seat) => ({
    seat,
    hole: spec.holes[seat],
    final: null,
    invested: 100,
    won: 0,
    net: -100,
    status: "active",
  }));
  return {
    handNumber: 1,
    seed: spec.seed ?? 12345,
    button: 0,
    seatCount: ids.length,
    board: spec.board ?? [],
    seats,
    pots: spec.pots ?? [{ amount: 200, eligible: ids, winners: [ids[0]] }],
    decisions: spec.decisions ?? [],
    actions: spec.actions ?? [],
    endStreet: (spec.board?.length ?? 0) >= 5 ? "river" : "preflop",
    wentToShowdown: true,
  };
}

/**
 * The same hand as a live `TableState`, so `decider.opponentRanges`, the thing
 * that actually feeds the sampler, can be run against the review's rebuild of
 * it. Only the fields `opponentRanges` reads are meaningful; the rest is
 * scaffolding the type demands.
 */
function tableState(spec: {
  holes: Record<number, number[]>;
  board: number[];
  actions: ActionRecord[];
  button?: number;
}): TableState {
  const ids = Object.keys(spec.holes).map(Number).sort((a, b) => a - b);
  return {
    seed: 1,
    handNumber: 1,
    seats: ids.map((id) => ({
      id,
      name: `seat ${id}`,
      kind: "bot" as const,
      stack: 1000,
      hole: spec.holes[id].map(decodeCard),
      status: "active" as const,
      streetCommit: 0,
      invested: 0,
      hasActed: true,
      mayRaise: true,
    })),
    button: spec.button ?? 0,
    street: "river",
    deck: [],
    board: spec.board.map(decodeCard),
    currentBet: 0,
    lastRaiseSize: 0,
    lastAggressor: null,
    toAct: null,
    pot: 0,
    log: [],
    status: "playing",
    // `handActions` reads this off the state defensively; the engine's `Table`
    // carries it and a bare `TableState` does not.
    actions: spec.actions,
  } as unknown as TableState;
}

/**
 * The reviewed case: seat 0 is a human holding 7-2 offsuit that has raised
 * twice, so seat 1's read on it is strong; seat 1 holds kings and records its
 * own equity against that read. A human records no decision of its own, so this
 * bot's entry is the *only* thing in the record naming the matchup.
 */
function humanVsKings(heroHole: number[], botEquityVsHero: number) {
  return report({
    holes: { 0: heroHole, 1: KINGS },
    decisions: [decision(1, "preflop", { 0: botEquityVsHero })],
  });
}

// ---------------------------------------------------------------------------
// Head-to-head equity
// ---------------------------------------------------------------------------

describe("streetEquities: head-to-head", () => {
  it("reports the reviewing seat's OWN equity, which moves with its cards", () => {
    // The assertion the old inverted arithmetic could never satisfy. The bot's
    // recorded estimate is identical in both reports; only the human's hole
    // cards differ, and they are the worst and best hands in poker.
    const worst = streetEquities(humanVsKings(SEVEN_TWO, 0.727), 0);
    const best = streetEquities(humanVsKings(ACES, 0.727), 0);

    const withSevenTwo = worst[0].vs[0].equity;
    const withAces = best[0].vs[0].equity;

    expect(withAces - withSevenTwo).toBeGreaterThan(0.5);
  });

  it("gets 7-2 offsuit against kings right", () => {
    const [preflop] = streetEquities(humanVsKings(SEVEN_TWO, 0.727), 0);
    expect(preflop.vs).toHaveLength(1);
    expect(preflop.vs[0].seat).toBe(1);
    expect(preflop.vs[0].equity).toBeCloseTo(0.129, 2);
    expect(preflop.vs[0].source).toBe("actual");
  });

  it("does not invert the opponent's estimate", () => {
    // 1 - 0.727 = 0.273, which is 14 points too generous and, the real tell -
    // does not depend on the human's cards at all.
    const [preflop] = streetEquities(humanVsKings(SEVEN_TWO, 0.727), 0);
    expect(preflop.vs[0].equity).not.toBeCloseTo(1 - 0.727, 2);
  });

  it("is symmetric: the two seats' equities sum to one", () => {
    const hand = humanVsKings(SEVEN_TWO, 0.727);
    // Seat 1 records a decision naming seat 0, so both reviews list the pair.
    const hero = streetEquities(hand, 0)[0].vs[0].equity;
    const villain = streetEquities(hand, 1)[0].vs[0].equity;
    expect(hero + villain).toBeCloseTo(1, 2);
  });

  it("is exact from the flop on, and says so", () => {
    // Kd Ks on a 7-high board: the human's sevens are drawing to two outs.
    const flop = report({
      holes: { 0: SEVEN_TWO, 1: KINGS },
      board: [card(7, S), card(9, D), card(3, C)],
      decisions: [
        decision(1, "preflop", { 0: 0.87 }),
        decision(1, "flop", { 0: 0.9 }),
      ],
    });
    const streets = streetEquities(flop, 0);
    const onFlop = streets.find((s) => s.street === "flop")!;
    expect(onFlop.vs[0].exact).toBe(true);
    expect(onFlop.vs[0].equity).toBeGreaterThan(0);
    expect(onFlop.vs[0].equity).toBeLessThan(0.3);

    // Preflop is sampled over 1.7M runouts and is marked as such.
    const preflop = streets.find((s) => s.street === "preflop")!;
    expect(preflop.vs[0].exact).toBe(false);
  });

  it("is reproducible: the same report reviewed twice reads the same", () => {
    const hand = humanVsKings(SEVEN_TWO, 0.727);
    expect(streetEquities(hand, 0)[0].vs[0].equity).toBe(
      streetEquities(hand, 0)[0].vs[0].equity
    );
  });

  it("names the seat with the most equity against the reviewer as the threat", () => {
    // Board 7s 9d 3c Jh Qd. Seat 0 holds 7-2 for a pair of sevens; seat 1
    // kings, which outkicks it; seat 2 threes, which it outkicks.
    const hand = report({
      holes: { 0: SEVEN_TWO, 1: KINGS, 2: [card(3, S), card(4, S)] },
      board: [card(7, S), card(9, D), card(3, C), card(11, H), card(12, D)],
      decisions: [
        decision(1, "river", { 0: 0.9, 2: 0.9 }),
        decision(2, "river", { 0: 0.1, 1: 0.1 }),
      ],
    });
    const river = streetEquities(hand, 0).find((s) => s.street === "river")!;
    expect(river.threat!.seat).toBe(1);
    expect(river.vs.find((h) => h.seat === 1)!.equity).toBe(0);
    expect(river.vs.find((h) => h.seat === 2)!.equity).toBe(1);
  });

  it("lists a matchup the reviewing seat itself priced", () => {
    // A bot review: seat 0 records its own perOpponent, so the panel is built
    // from that side, and the equity still comes from the real cards.
    const hand = humanVsKings(SEVEN_TWO, 0.727);
    hand.decisions.push(decision(0, "preflop", { 1: 0.4 }));
    const [preflop] = streetEquities(hand, 0);
    expect(preflop.vs).toHaveLength(1);
    expect(preflop.vs[0].source).toBe("actual");
    expect(preflop.vs[0].equity).toBeCloseTo(0.129, 2);
  });

  it("falls back to the seat's own estimate when the opponent has no cards", () => {
    const hand = report({
      holes: { 0: SEVEN_TWO, 1: [] },
      decisions: [decision(0, "preflop", { 1: 0.42 })],
    });
    const [preflop] = streetEquities(hand, 0);
    expect(preflop.vs[0].source).toBe("estimate");
    expect(preflop.vs[0].equity).toBe(0.42);
  });

  it("skips a matchup neither side can supply a number for", () => {
    const hand = report({
      holes: { 0: SEVEN_TWO, 1: [] },
      decisions: [decision(1, "preflop", { 0: 0.9 })],
    });
    expect(streetEquities(hand, 0)).toHaveLength(0);
  });
});

describe("headsUpEquity", () => {
  it("settles a complete board with no sampling at all", () => {
    // Aces beat kings on a board that helps neither.
    const board = [card(2, S), card(5, H), card(9, D), card(11, C), card(3, S)];
    expect(headsUpEquity(ACES, KINGS, board, 1)).toEqual({
      equity: 1,
      exact: true,
    });
    expect(headsUpEquity(KINGS, ACES, board, 1)).toEqual({
      equity: 0,
      exact: true,
    });
  });

  it("scores a chopped board as half, not as a win", () => {
    // Both play the board: a wheel neither hole card improves.
    const board = [card(14, C), card(2, H), card(3, D), card(4, S), card(5, C)];
    const a = [card(7, S), card(8, H)];
    const b = [card(7, D), card(8, C)];
    expect(headsUpEquity(a, b, board, 1)).toEqual({ equity: 0.5, exact: true });
  });

  it("enumerates the turn: 44 runouts, so the answer is a 44th", () => {
    // Aces against kings with one card to come; the count must be integral.
    const board = [card(2, S), card(5, H), card(9, D), card(11, C)];
    const result = headsUpEquity(ACES, KINGS, board, 1)!;
    expect(result.exact).toBe(true);
    expect(Math.round(result.equity * 44)).toBeCloseTo(result.equity * 44, 9);
    expect(result.equity).toBeGreaterThan(0.9);
  });

  it("enumerates the flop exactly rather than sampling it", () => {
    const board = [card(2, S), card(5, H), card(9, D)];
    const a = headsUpEquity(ACES, KINGS, board, 1)!;
    const b = headsUpEquity(ACES, KINGS, board, 999)!;
    expect(a.exact).toBe(true);
    // Enumeration ignores the seed entirely; a sampler would not.
    expect(a.equity).toBe(b.equity);
  });

  it("samples preflop deterministically from the seed", () => {
    const a = headsUpEquity(ACES, SEVEN_TWO, [], 7)!;
    const b = headsUpEquity(ACES, SEVEN_TWO, [], 7)!;
    expect(a.exact).toBe(false);
    expect(a.equity).toBe(b.equity);
    // Aces are roughly an 87-13 favourite over 7-2 offsuit.
    expect(a.equity).toBeGreaterThan(0.85);
    expect(a.equity).toBeLessThan(0.90);
  });

  it("refuses an impossible matchup rather than returning a number", () => {
    // The same card in two hands, and a card on the board and in a hand.
    expect(headsUpEquity(ACES, [ACE_S, card(13, C)], [], 1)).toBeNull();
    expect(headsUpEquity(ACES, KINGS, [ACE_D, 1, 2], 1)).toBeNull();
    expect(headsUpEquity([ACE_S], KINGS, [], 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pot odds
// ---------------------------------------------------------------------------

describe("requiredEquity", () => {
  it("prices the call against the pot it would create, not the pot it faces", () => {
    // The classic error is toCall / pot. Facing 50 into 100 that says 50%; the
    // call actually needs 50 / 150, because the chips called are in the pot the
    // hand is playing for.
    expect(requiredEquity(100, 50)).toBeCloseTo(1 / 3, 12);
    expect(requiredEquity(100, 50)).not.toBeCloseTo(0.5, 6);
  });

  it("never exceeds one half, however large the bet", () => {
    // toCall / pot is unbounded; toCall / (pot + toCall) approaches 1.
    expect(requiredEquity(10, 1000)).toBeLessThan(1);
    expect(requiredEquity(0, 50)).toBe(1);
    expect(requiredEquity(50, 50)).toBe(0.5);
  });

  it("is zero when there is nothing to call", () => {
    expect(requiredEquity(100, 0)).toBe(0);
    expect(requiredEquity(0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * K-7-2-9-4, the board `equity/multiway.ts` names in its own header as the
 * case the preflop classifier gets wrong. 7-2 has flopped two pair here and
 * `bayesian.tierOf` still calls it the worst hand in poker.
 */
const K72_BOARD = [card(13, S), card(7, D), card(2, C), card(9, H), card(4, S)];

/** A seat that called pre-flop and then bet every street. */
const BETTOR_ACTIONS: ActionRecord[] = [
  { seat: 1, street: "preflop", action: "call", cost: 20, potBefore: 30, toCall: 20 },
  { seat: 0, street: "preflop", action: "check", cost: 0, potBefore: 50, toCall: 0 },
  { seat: 1, street: "flop", action: "bet", cost: 40, potBefore: 50, toCall: 0 },
  { seat: 0, street: "flop", action: "call", cost: 40, potBefore: 90, toCall: 40 },
  { seat: 1, street: "turn", action: "bet", cost: 90, potBefore: 130, toCall: 0 },
  { seat: 0, street: "turn", action: "call", cost: 90, potBefore: 220, toCall: 90 },
  { seat: 1, street: "river", action: "bet", cost: 200, potBefore: 310, toCall: 0 },
];

/** The `ReviewStreet` for the end of the hand, the whole record folded in. */
function finalStreet(hand: TableHandReport) {
  const streets = reviewStreets(hand);
  return streets[streets.length - 1];
}

/**
 * The distribution the chart used to draw, reconstructed here rather than kept
 * in the source: bucket every live combo by `bayesian.tierOf`, split each
 * tier's belief mass evenly inside it. This is what `rangeView` did before it
 * was rebuilt on `model/buckets.ts`, and it is the yardstick the assertions
 * below measure the fix against.
 */
function tierOfGrid(dead: number[], belief: BeliefDistribution): Float64Array {
  const used = new Uint8Array(52);
  for (const c of dead) used[c] = 1;
  const tierIndex = (combo: number): number => {
    const t = tierOf(decodeCard(comboCardA(combo)), decodeCard(comboCardB(combo)));
    return t === "weak" ? 0 : t === "medium" ? 1 : 2;
  };
  const live: number[] = [];
  const count = [0, 0, 0];
  for (let c = 0; c < COMBO_COUNT; c++) {
    if (used[comboCardA(c)] || used[comboCardB(c)]) continue;
    live.push(c);
    count[tierIndex(c)]++;
  }
  const mass = [belief.weak, belief.medium, belief.strong];
  const grid = new Float64Array(GRID_CELLS);
  for (const c of live) {
    const t = tierIndex(c);
    grid[gridCellOf(c)] += count[t] > 0 ? mass[t] / count[t] : 0;
  }
  return grid;
}

describe("rangeView", () => {
  it("draws the distribution the sampler draws, combo for combo", () => {
    // The assertion the whole tab rests on. `opponentRanges` is what the engine
    // hands the multiway estimator; if the chart is "the model" rather than an
    // illustration of it, these two arrays are the same array.
    const holes = { 0: ACES, 1: [card(7, S), card(2, H)] };
    const hand = report({ holes, board: K72_BOARD, actions: BETTOR_ACTIONS });
    const engine = opponentRanges(
      tableState({ holes, board: K72_BOARD, actions: BETTOR_ACTIONS }),
      0
    )[1];
    const view = rangeView(hand, finalStreet(hand), 1, ACES);

    let worst = 0;
    for (let c = 0; c < COMBO_COUNT; c++) {
      worst = Math.max(worst, Math.abs(view.range[c] - engine[c]));
    }
    expect(worst).toBeLessThan(1e-15);
    // …and not vacuously: the range is a real distribution with structure in it.
    expect(view.range.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Math.max(...view.range)).toBeGreaterThan(2 / view.liveCombos);
  });

  it("does not call 7-2 trash on a board where it is two pair", () => {
    // The defect this rebuild exists to remove. `tierOf` scores hole cards with
    // a preflop Chen formula on every street, so on K-7-2-9-4 it files 7-2
    // under "weak", the bin a seat that has bet three streets is least likely
    // to be in, while the board says two pair.
    const holes = { 0: ACES, 1: [card(7, S), card(2, H)] };
    const hand = report({ holes, board: K72_BOARD, actions: BETTOR_ACTIONS });
    const dead = [...ACES, ...K72_BOARD];
    const view = rangeView(hand, finalStreet(hand), 1, ACES);

    const cell = gridCellOf(comboIndex(card(7, S), card(2, H))); // 72o
    expect(tierOf(decodeCard(card(7, S)), decodeCard(card(2, H)))).toBe("weak");

    const belief = readsAfter(hand.actions, hand.actions.length, hand.seatCount)[1];
    const before = tierOfGrid(dead, belief)[cell];
    const after = view.grid[cell];

    // Materially more, not marginally: the old chart put this cell in the bin
    // its own bets argue against.
    expect(after).toBeGreaterThan(before * 3);
    // And it is not just "some weight", per combo it beats the flat share the
    // deck would give it, which is what "this seat can credibly hold it" means.
    expect(after / view.cellCombos[cell]).toBeGreaterThan(1 / view.liveCombos);
  });

  it("reads the same range through nine buckets and three tiers", () => {
    const holes = { 0: ACES, 1: [card(7, S), card(2, H)] };
    const hand = report({ holes, board: K72_BOARD, actions: BETTOR_ACTIONS });
    const view = rangeView(hand, finalStreet(hand), 1, ACES);

    const tiers = view.tierWeight[0] + view.tierWeight[1] + view.tierWeight[2];
    expect(tiers).toBeCloseTo(1, 12);
    let buckets = 0;
    for (let b = 0; b < view.buckets.length; b++) buckets += view.buckets[b];
    expect(buckets).toBeCloseTo(1, 12);

    // The collapse is `tierFromBucket`: Overpair and up is strong, WeakPair
    // through TopPair medium, everything below weak. Same numbers, two
    // resolutions, so the meters can never contradict the bars beside them.
    const strong = view.buckets[6] + view.buckets[7] + view.buckets[8];
    const medium = view.buckets[3] + view.buckets[4] + view.buckets[5];
    expect(view.tierWeight[2]).toBeCloseTo(strong, 12);
    expect(view.tierWeight[1]).toBeCloseTo(medium, 12);
  });

  it("is a probability distribution over the live combos", () => {
    const hand = report({
      holes: { 0: ACES, 1: KINGS },
      actions: [
        { seat: 1, street: "preflop", action: "raise", cost: 60, potBefore: 30, toCall: 20 },
      ],
    });
    const view = rangeView(hand, finalStreet(hand), 1, ACES);
    let total = 0;
    for (let i = 0; i < view.grid.length; i++) total += view.grid[i];
    expect(total).toBeCloseTo(1, 9);
    expect(view.maxCell).toBeGreaterThan(0);
    expect(view.maxCell).toBeLessThanOrEqual(1);
  });

  it("removes the dead cards from the combos it counts", () => {
    // Two aces gone: C(52,2) - C(50,2) = 1326 - 1225 = 101 combos die, and the
    // AA cell keeps exactly the one pair the other two aces still make.
    const hand = report({ holes: { 0: ACES, 1: KINGS } });
    const view = rangeView(hand, finalStreet(hand), 1, ACES);
    expect(view.liveCombos).toBe(1225);
    const aces = gridCellOf(comboIndex(card(14, H), card(14, C)));
    expect(view.cellCombos[aces]).toBe(1);
    expect(CELL_TOTAL[aces]).toBe(6);

    // A dead combo carries no weight, however the seat bet: `removeCards` runs
    // before the likelihood factors and nothing downstream can scale a zero.
    for (let c = 0; c < COMBO_COUNT; c++) {
      if (comboCardA(c) === ACE_S || comboCardB(c) === ACE_S) {
        expect(view.range[c]).toBe(0);
      }
    }
  });

  it("measures narrowness as the combos holding half the weight", () => {
    const flat = rangeView(
      report({ holes: { 0: ACES, 1: KINGS } }),
      finalStreet(report({ holes: { 0: ACES, 1: KINGS } })),
      1,
      ACES
    );
    const bet = report({
      holes: { 0: ACES, 1: KINGS },
      board: K72_BOARD,
      actions: BETTOR_ACTIONS,
    });
    const narrowed = rangeView(bet, finalStreet(bet), 1, ACES);

    // No actions is no information: half a flat range's weight takes half the
    // deck. Three streets of betting has to buy something.
    expect(flat.half.fraction).toBeCloseTo(0.5, 2);
    expect(narrowed.half.fraction).toBeLessThan(flat.half.fraction);
    expect(narrowed.half.combos).toBeGreaterThan(0);
    expect(flat.half.fraction).toBeLessThanOrEqual(1);
  });
});
