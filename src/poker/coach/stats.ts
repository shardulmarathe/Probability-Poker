/**
 * Standard tracker statistics over `TableHandReport[]`, sliced by position.
 *
 * Everything is stored as a numerator/denominator PAIR rather than a
 * percentage, and that is the one structural decision the rest of the design
 * follows from: a percentage cannot be merged. "38% over 40 hands" and "22% over
 * 900 hands" have no average, you need the counts back to combine them, and by
 * then the percentage has thrown them away. Pairs add. So a session merges into
 * a lifetime figure by integer addition, which is also exactly the shape the
 * `player_stats` table in db/migrations/001_persistence.sql stores
 * (`vpip_n`/`vpip_d`, `af_aggressive`/`af_passive`, ...), see `toPlayerStatsRow`.
 *
 * Each stat below states its definition in full. That is not decoration: a
 * subtly wrong VPIP is worse than no VPIP, because it looks authoritative and
 * the player will act on it. The three traps this file is built to avoid:
 *
 *  - Blinds are not voluntary. They never reach VPIP here for a structural
 *    reason rather than a filtered one: the engine posts blinds in `postBlinds`,
 *    which emits no `ActionRecord` at all, so only chosen actions are ever seen.
 *  - A walk in the big blind is not a fold. The big blind checking its option is
 *    a `check`, which is voluntary in no sense and passive in no sense; it
 *    counts toward neither VPIP nor the aggression denominators.
 *  - An all-in call is still a call. Nothing here reads the label or the size,
 *    which is what makes that true: `rules.ts` emits `{type:"call", cost:
 *    toCall}` unconditionally, only the label consults the stack, and
 *    `engine.ts` copies that straight into `ActionRecord.cost`. So the recorded
 *    cost of a short all-in call OVERSTATES the chips the seat actually put in
 *    (`commitChips` moves what the stack holds). Every counter here is a count
 *    of actions, so the overstatement cannot reach a stat; anything downstream
 *    that prices `ActionRecord.cost`. EV work in particular, is charging
 *    chips that never left the stack.
 *
 * Pure functions over reports. No state, no accumulation object, no ordering
 * requirement, `computeStats(a.concat(b))` equals `mergeStats(f(a), f(b))`.
 */

import type { ActionType } from "../../types";
import { positionOf, type PositionName } from "../table/position";
import type { ActionRecord, TableHandReport } from "../table/contract";

/**
 * A rate as the two integers it was measured from. `n / d`, undefined at d = 0 -
 * which is a real state ("never faced a 3-bet"), not a zero.
 */
export interface Counter {
  n: number;
  d: number;
}

export interface StatCounters {
  /** Hands the seat was dealt into. */
  hands: number;

  /**
   * VPIP. Voluntarily Put money In Pot.
   * n: hands with at least one preflop call, bet or raise by the seat.
   * d: hands dealt.
   * Posting a blind is forced, so it is not in the numerator; checking the big
   * blind option is not putting money in, so neither is that.
   */
  vpip: Counter;

  /**
   * PFR. PreFlop Raise.
   * n: hands with at least one preflop raise (or bet) by the seat.
   * d: hands dealt.
   * A preflop `bet` is only legal to the big blind facing limpers, which is a
   * raise in every sense but the engine's label, so it counts.
   */
  pfr: Counter;

  /**
   * 3-bet%, making the third preflop bet.
   * The big blind is the first bet and an open raise is the second, so a
   * re-raise over an open is the third; hence the name.
   * n: the seat re-raised at its first opportunity.
   * d: opportunities, the seat acted while exactly one voluntary raise stood
   *    and that raise was somebody else's. Counted at most once per hand; a
   *    limper who later faces the open still had the chance and is counted.
   */
  threeBet: Counter;

  /**
   * Fold to 3-bet%.
   * n: the seat folded.
   * d: hands where the seat made the opening raise, was 3-bet, and acted again
   *    still facing the 3-bet. A cold 4-bet landing in between removes the
   *    opportunity rather than creating a fold: the seat is answering the
   *    4-bet, and counting that here is the standard way this stat inflates.
   * The seat's response to the 3-bet only, a 4-bet that later folds to a 5-bet
   * is a non-fold here, because the question is what the 3-bet accomplished.
   */
  foldToThreeBet: Counter;

  /**
   * AF. Aggression Factor, (bets + raises) / calls, POSTFLOP.
   * n: postflop bets and raises. d: postflop calls.
   * Checks and folds appear in neither, by the standard definition. Preflop is
   * excluded because the forced blinds distort both terms, everyone "calls" a
   * blind they were priced into and nobody's style shows through it.
   * A ratio, so `d = 0` means undefined (see `rate`), not infinitely aggressive.
   */
  af: Counter;

  /**
   * AFq. Aggression Frequency, (bets + raises) / (bets + raises + calls +
   * folds), POSTFLOP. The share of postflop decisions that were aggressive.
   * Checks are excluded here too, which is what keeps AFq comparable to AF:
   * both ask what the seat did when it had chips to commit or fold.
   * Bounded 0..1, so unlike AF it stays meaningful for a seat that never calls.
   */
  afq: Counter;

  /**
   * WTSD. Went To ShowDown.
   * n: hands the seat reached showdown with cards live.
   * d: hands the seat saw a flop.
   * "Saw a flop" means a flop was dealt and the seat had not folded preflop -
   * an all-in preflop seat that gets run out saw the flop and did go to
   * showdown, which is the standard treatment.
   */
  wtsd: Counter;

  /**
   * W$SD. Won money at ShowDown.
   * n: showdowns where the seat won at least part of a pot.
   * d: showdowns reached (= `wtsd.n`).
   * Read off `PotRecord.winners` rather than `SeatResult.won`, because `won`
   * also carries an uncalled bet coming back, which is not winning a showdown.
   * A chopped pot counts as won, the tracker convention.
   */
  wsd: Counter;

  /**
   * Flop c-bet%, continuation bet.
   * n: the seat bet the flop.
   * d: hands where the seat was the preflop aggressor, saw the flop, and its
   *    first flop action faced no bet. A donk bet in front removes the
   *    opportunity rather than creating a missed one.
   */
  cbet: Counter;

  /**
   * Fold to flop c-bet%.
   * n: the seat folded to it.
   * d: hands where somebody else was the preflop aggressor, bet the flop, and
   *    the seat then had to act facing that bet, nothing raised in between.
   *    A raise of the c-bet ahead of the seat removes the opportunity: the
   *    seat's fold answers the raise, and scoring it here inflates the stat.
   */
  foldToCbet: Counter;

  /** Net chips won minus invested, summed over the hands counted. */
  net: number;
}

export interface PlayerStats {
  seat: number;
  total: StatCounters;
  /** The same counters, sliced by the seat's position in each hand. */
  byPosition: Record<PositionName, StatCounters>;
}

export const POSITIONS: readonly PositionName[] = [
  "BTN",
  "SB",
  "BB",
  "UTG",
  "HJ",
  "CO",
] as const;

/** Actions that put chips in by choice. */
const VOLUNTARY: ReadonlySet<ActionType> = new Set<ActionType>([
  "call",
  "bet",
  "raise",
]);

/** Preflop, an opening `bet` is only available to the big blind, it is a raise. */
const AGGRESSIVE: ReadonlySet<ActionType> = new Set<ActionType>(["bet", "raise"]);

// ---------------------------------------------------------------------------
// Construction and arithmetic
// ---------------------------------------------------------------------------

const counter = (): Counter => ({ n: 0, d: 0 });

export function emptyCounters(): StatCounters {
  return {
    hands: 0,
    vpip: counter(),
    pfr: counter(),
    threeBet: counter(),
    foldToThreeBet: counter(),
    af: counter(),
    afq: counter(),
    wtsd: counter(),
    wsd: counter(),
    cbet: counter(),
    foldToCbet: counter(),
    net: 0,
  };
}

function emptyStats(seat: number): PlayerStats {
  const byPosition = {} as Record<PositionName, StatCounters>;
  for (const p of POSITIONS) byPosition[p] = emptyCounters();
  return { seat, total: emptyCounters(), byPosition };
}

/** Every `Counter` field, so merging can never silently miss a new stat. */
const COUNTER_KEYS = [
  "vpip",
  "pfr",
  "threeBet",
  "foldToThreeBet",
  "af",
  "afq",
  "wtsd",
  "wsd",
  "cbet",
  "foldToCbet",
] as const;

type CounterKey = (typeof COUNTER_KEYS)[number];

function addCounter(into: Counter, from: Counter): void {
  into.n += from.n;
  into.d += from.d;
}

/** `a + b`, as a new object. Integer addition, this is why pairs are stored. */
export function mergeCounters(a: StatCounters, b: StatCounters): StatCounters {
  const out = emptyCounters();
  out.hands = a.hands + b.hands;
  out.net = a.net + b.net;
  for (const key of COUNTER_KEYS) {
    addCounter(out[key], a[key]);
    addCounter(out[key], b[key]);
  }
  return out;
}

/**
 * Merge two sessions' stats for the same seat. The whole reason the counters are
 * pairs: this is exact, order-independent, and needs nothing but addition.
 */
export function mergeStats(a: PlayerStats, b: PlayerStats): PlayerStats {
  const out = emptyStats(a.seat);
  out.total = mergeCounters(a.total, b.total);
  for (const p of POSITIONS) {
    out.byPosition[p] = mergeCounters(a.byPosition[p], b.byPosition[p]);
  }
  return out;
}

/** `n / d`, or null when nothing was observed. Null is not zero. */
export function rate(c: Counter): number | null {
  return c.d > 0 ? c.n / c.d : null;
}

/** The same as a 0..100 percentage, for display. */
export function percent(c: Counter): number | null {
  const r = rate(c);
  return r === null ? null : r * 100;
}

// ---------------------------------------------------------------------------
// Reading one hand
// ---------------------------------------------------------------------------

interface PreflopScan {
  /** Last seat to raise or bet preflop; null in a limped or walked pot. */
  aggressor: number | null;
  threeBet: Counter;
  foldToThreeBet: Counter;
}

/**
 * One ordered pass over the preflop action, which is where every stat that
 * depends on sequence rather than on totals is decided.
 *
 * `raises` counts voluntary aggression only. The big blind post is the implicit
 * first bet and is not an `ActionRecord`, so `raises === 1` is precisely "an
 * open raise stands", which is what a 3-bet is defined against.
 */
function scanPreflop(actions: ActionRecord[], seat: number): PreflopScan {
  const threeBet = counter();
  const foldToThreeBet = counter();

  let raises = 0;
  let opener: number | null = null;
  let aggressor: number | null = null;
  let threeBetScored = false;
  let awaitingFoldToThreeBet = false;

  for (const a of actions) {
    if (a.street !== "preflop") continue;

    if (a.seat === seat) {
      // A 3-bet opportunity: exactly one voluntary raise stands and it is not
      // ours. Checked before this action is folded into `raises`, so it
      // describes what the seat faced rather than what it did.
      if (!threeBetScored && raises === 1 && opener !== null && opener !== seat) {
        threeBet.d = 1;
        threeBet.n = a.action === "raise" ? 1 : 0;
        threeBetScored = true;
      }
      if (awaitingFoldToThreeBet) {
        foldToThreeBet.d = 1;
        foldToThreeBet.n = a.action === "fold" ? 1 : 0;
        awaitingFoldToThreeBet = false;
      }
    }

    if (AGGRESSIVE.has(a.action)) {
      raises++;
      if (raises === 1) opener = a.seat;
      // The second voluntary raise over our open is the 3-bet we must answer.
      else if (raises === 2 && opener === seat && a.seat !== seat) {
        awaitingFoldToThreeBet = true;
      } else if (raises > 2) {
        // A cold 4-bet reached us before we got to act. Whatever we do next
        // answers that, so the 3-bet never got its answer and this hand is
        // not an observation of the stat at all, arm nothing, count nothing.
        // (Our own 4-bet cannot land here: the block above already consumed
        // the flag on our action, before this one folds it into `raises`.)
        awaitingFoldToThreeBet = false;
      }
      aggressor = a.seat;
    }
  }

  return { aggressor, threeBet, foldToThreeBet };
}

/**
 * Counters contributed by one hand, or null when the seat was not dealt in.
 * Split out so `computeStats` can add the same object to both the total and the
 * positional slice and they cannot drift apart.
 */
export function scanHand(
  report: TableHandReport,
  seat: number
): StatCounters | null {
  const result = report.seats.find((s) => s.seat === seat);
  if (!result || result.hole.length !== 2) return null;

  const c = emptyCounters();
  c.hands = 1;
  c.net = result.net;

  const mine = report.actions.filter((a) => a.seat === seat);
  const preflopMine = mine.filter((a) => a.street === "preflop");

  // --- VPIP / PFR --------------------------------------------------------
  c.vpip.d = 1;
  c.vpip.n = preflopMine.some((a) => VOLUNTARY.has(a.action)) ? 1 : 0;
  c.pfr.d = 1;
  c.pfr.n = preflopMine.some((a) => AGGRESSIVE.has(a.action)) ? 1 : 0;

  // --- 3-bet / fold to 3-bet --------------------------------------------
  const pre = scanPreflop(report.actions, seat);
  c.threeBet = pre.threeBet;
  c.foldToThreeBet = pre.foldToThreeBet;

  // --- Aggression, postflop only ----------------------------------------
  let aggressive = 0;
  let calls = 0;
  let folds = 0;
  for (const a of mine) {
    if (a.street === "preflop" || a.street === "showdown") continue;
    if (AGGRESSIVE.has(a.action)) aggressive++;
    else if (a.action === "call") calls++;
    else if (a.action === "fold") folds++;
    // `check` is neither aggressive nor passive: no chips were at stake.
  }
  c.af.n = aggressive;
  c.af.d = calls;
  c.afq.n = aggressive;
  c.afq.d = aggressive + calls + folds;

  // --- Showdown ----------------------------------------------------------
  const foldedPreflop = preflopMine.some((a) => a.action === "fold");
  const sawFlop = report.board.length >= 3 && !foldedPreflop;
  const wentToShowdown =
    sawFlop && report.wentToShowdown && result.status !== "folded";

  c.wtsd.d = sawFlop ? 1 : 0;
  c.wtsd.n = wentToShowdown ? 1 : 0;
  c.wsd.d = c.wtsd.n;
  c.wsd.n =
    wentToShowdown && report.pots.some((p) => p.winners.includes(seat)) ? 1 : 0;

  // --- Continuation betting ---------------------------------------------
  const flop = report.actions.filter((a) => a.street === "flop");
  if (sawFlop && pre.aggressor === seat) {
    const first = flop.find((a) => a.seat === seat);
    // `toCall === 0` is the opportunity: a bet in front of us is a donk bet,
    // and answering it is not a continuation bet under any definition.
    if (first && first.toCall === 0) {
      c.cbet.d = 1;
      c.cbet.n = first.action === "bet" ? 1 : 0;
    }
  }
  if (sawFlop && pre.aggressor !== null && pre.aggressor !== seat) {
    const cbetAt = flop.findIndex(
      (a) => a.seat === pre.aggressor && a.action === "bet"
    );
    if (cbetAt >= 0) {
      // Our first action after the c-bet, but only while the c-bet is still
      // what we are facing. A raise of it in front of us replaces the question:
      // folding to a check-raise is not folding to a continuation bet, and
      // `toCall > 0` alone cannot tell the two apart.
      let answer: ActionRecord | undefined;
      for (const a of flop.slice(cbetAt + 1)) {
        if (a.seat === seat) {
          answer = a;
          break;
        }
        if (AGGRESSIVE.has(a.action)) break;
      }
      if (answer && answer.toCall > 0) {
        c.foldToCbet.d = 1;
        c.foldToCbet.n = answer.action === "fold" ? 1 : 0;
      }
    }
  }

  return c;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Every stat for one seat over a set of hands, plus the positional slices. */
export function computeStats(
  reports: TableHandReport[],
  seat: number
): PlayerStats {
  const stats = emptyStats(seat);
  for (const report of reports) {
    const hand = scanHand(report, seat);
    if (!hand) continue;
    const position = positionOf(seat, report.button, report.seatCount);
    stats.total = mergeCounters(stats.total, hand);
    stats.byPosition[position] = mergeCounters(stats.byPosition[position], hand);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The `player_stats` row shape from db/migrations/001_persistence.sql, exactly.
 *
 * The table stores a strict SUBSET of what is computed here, it has no column
 * for AFq, c-bets, fold-to-3-bet or the positional slices. That is deliberate on
 * both sides: the row is the incrementally-maintained lifetime roll-up, and the
 * rest is derived on read from the `hands`/`decisions` tables. Nothing here
 * implies a schema change; this function exists so the mapping is written down
 * once instead of being re-guessed at every call site.
 */
export interface PlayerStatsRow {
  hands: number;
  vpip_n: number;
  vpip_d: number;
  pfr_n: number;
  pfr_d: number;
  threebet_n: number;
  threebet_d: number;
  /** AF's numerator: postflop bets + raises. */
  af_aggressive: number;
  /** AF's denominator: postflop calls. */
  af_passive: number;
  wtsd_n: number;
  wtsd_d: number;
  wsd_n: number;
  wsd_d: number;
  net_bb: number;
  ev_lost_bb: number;
}

/**
 * Project the totals onto that row. Chips become big blinds here and nowhere
 * else, because `net_bb` and `ev_lost_bb` are the only two quantities in the
 * schema that are not integer counts.
 *
 * `evLostChips` comes from `evLoss.ts` (`SessionEvLoss.totalModelEvLoss`) and is
 * already <= 0, so the stored figure keeps that sign.
 */
export function toPlayerStatsRow(
  stats: PlayerStats,
  bigBlind: number,
  evLostChips = 0
): PlayerStatsRow {
  if (bigBlind <= 0) throw new Error(`toPlayerStatsRow: bad bigBlind ${bigBlind}`);
  const t = stats.total;
  return {
    hands: t.hands,
    vpip_n: t.vpip.n,
    vpip_d: t.vpip.d,
    pfr_n: t.pfr.n,
    pfr_d: t.pfr.d,
    threebet_n: t.threeBet.n,
    threebet_d: t.threeBet.d,
    af_aggressive: t.af.n,
    af_passive: t.af.d,
    wtsd_n: t.wtsd.n,
    wtsd_d: t.wtsd.d,
    wsd_n: t.wsd.n,
    wsd_d: t.wsd.d,
    net_bb: t.net / bigBlind,
    ev_lost_bb: evLostChips / bigBlind,
  };
}

/** The name of any `Counter` field on `StatCounters`, see `COUNTER_KEYS`. */
export type { CounterKey };
