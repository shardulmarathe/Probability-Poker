/**
 * The N-handed table's store.
 *
 * It drives `poker/table/engine` one `applyAction` at a time and wraps each move
 * in the choreography the heads-up store established, a chip flight, a spoken
 * action, a staggered board deal, generalised from two fixed seats to however
 * many are sitting. The engine itself is untouched by any of it: this file
 * decides when a move is shown, never what the move is.
 *
 * Two invariants are worth stating because breaking either is invisible until
 * it is catastrophic:
 *
 *   1. One animated sequence at a time, released in a `finally`. A rejected
 *      decision or a wedged worker must not leave the table locked forever.
 *   2. Modes gate rendering only. Nothing here consults `mode` before deciding
 *      anything, the bots' information set is identical in Fair, Drill, Coach
 *      and Study, so a hand studied is the same hand as a hand played. `mode`
 *      is read in exactly two places, and both are display: whether the human's
 *      coach equity is worth running at all, and how much of a bot's narration
 *      is filled in (see "the information boundary" in `performBot`). Neither
 *      reaches the engine. Drill's verdict deliberately reads no mode at all,
 *      it is priced on every hero action in all four and `CoachPanel` decides
 *      whether it is printed.
 *
 * The provider outlives the felt: `/review`, `/profile` and `/replay` are
 * mounted inside it too, because the hand history lives here and a separately
 * mounted review would find an empty archive. That is deliberate, and it has
 * one consequence this file has to own, see "Pausing" below.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
  loadSetup,
  saveSetup,
  startingStack,
  DRILL_THRESHOLD_BB,
  type TableMode,
  type TableSetup as TableOptions,
} from "../lib/tableOptions";
import {
  asyncTableDecider,
  closesAction,
  decisionSeed,
  equityRequest,
  evByAction,
  handActions,
  priceCall,
  priceSizes,
  readsFromActions,
  sizedCandidates,
  FOLD_EQUITY_SIMS,
  type PricedSizes,
} from "../poker/model/decider";
import type { FoldEquityBreakdown } from "../poker/ev";
import {
  clearMemory,
  loadMemory,
  memoryStats,
  recordReport,
  scheduleSave,
  seatModelsFor,
  type MemoryStats,
  type OpponentMemory,
} from "../lib/opponentMemory";
import { BOT_PROFILES } from "../poker/model/profiles";
import { COMBO_COUNT, type Range } from "../poker/model/range";
import { planShards, runMultiwayEquity } from "../poker/equity/pool";
import type {
  BotDecision,
  EquityRequest,
  MultiwayEquity,
  TableHandReport,
} from "../poker/table/contract";
import {
  applyAction,
  createTable,
  startHand,
  type SeatSetup,
  type Table,
} from "../poker/table/engine";
import { blindSeats } from "../poker/table/position";
import {
  legalActions,
  sizingLadder,
  type SizingOption,
  type TableAction,
} from "../poker/table/rules";
import { toCall as toCallOf } from "../poker/table/state";
import type { BeliefDistribution } from "../types";

// ---------------------------------------------------------------------------
// Presentation state
// ---------------------------------------------------------------------------

/** One row of a stage's breakdown: a size, a shard, a candidate line. */
export interface ThinkFact {
  label: string;
  value: string;
}

/** One stage of the decision, as it is said. */
export interface ThinkLine {
  title: string;
  detail: string | null;
  /**
   * Per-item detail the stage can table out, one row per bet size being
   * priced. Optional, and the narrow thought bubble ignores it; `<Thinking />`
   * is where it earns its place.
   */
  facts?: ThinkFact[];
}

/** One frame of a bot's visible "computing" sequence. */
export interface ThinkStep extends ThinkLine {
  /** Monotonic index so the UI can re-trigger its fade on each new message. */
  step: number;
  /** Stages already finished on this decision, oldest first. */
  done: ThinkLine[];
  /** Stages planned for this decision, this one included. */
  total: number;
}

export interface ChipFx {
  id: number;
  seat: number;
}

export interface SeatFx {
  bubble: string | null;
  thinking: ThinkStep | null;
}

export interface TableFx {
  /** True while a sequence is animating, the human's controls are hidden. */
  busy: boolean;
  /** Community cards currently revealed, for the staggered deal. */
  dealtCount: number;
  seats: Record<number, SeatFx>;
  chips: ChipFx[];
}

/**
 * What Coach mode puts in front of the human: the same equity the bots price
 * their own decisions from, against the seats actually still in the pot, plus
 * the same three prices they choose between.
 *
 * Computed only when the human is on the clock and only when a mode asks for
 * it. It is display state and feeds nothing the engine reads.
 *
 * It arrives in two parts, and the order is deliberate. `equity` is one Monte
 * Carlo run in the worker pool and is published the moment it lands, because
 * Coach's line is that number and nothing else. `sizes` and `call` are the
 * fold-equity pricers, they run on the main thread, and they are folded into a
 * second read a paint later; until then they are null and every consumer treats
 * that as "not priced", never as "priced at nothing".
 */
export interface HeroRead {
  /**
   * The decision point this read describes, `hand:actions`, the same key the
   * effect that builds it is mounted on.
   *
   * Carried because the prices below are compared against a state read from
   * `tableRef` at click time. The clearing discipline (see `act`) already means
   * the two agree; this makes a disagreement silence instead of a confident
   * number about the wrong spot.
   */
  key: string;
  equity: MultiwayEquity;
  /** Chips to call, and the pot they would be called into. */
  toCall: number;
  pot: number;
  /** Share of the final pot a call needs to break even: cost / (pot + cost). */
  required: number;
  /** Pot odds expressed the way they are spoken: "3.5 to 1". */
  odds: number | null;
  opponents: number[];
  /**
   * The hero's own bet and raise ladder, every rung priced with its own fold
   * equity against the range that continues against it. Null when there is no
   * aggressive action, when there is nobody to bet at, or when the human acted
   * before it was priced.
   */
  sizes: PricedSizes | null;
  /**
   * The call re-priced against the pot the seats behind will build. Null when
   * the call closes the action, where `actionEv`'s number is already exact, and
   * null when there is no call on the table.
   */
  call: FoldEquityBreakdown | null;
}

/**
 * What Drill has to say about a move already made, or null when it has nothing.
 *
 * Silence is the common case and it is the point of the mode: a trainer that
 * narrates every hand teaches you to read the narration, not the spot. This is
 * only ever populated when the action taken cost more than `DRILL_THRESHOLD_BB`
 * big blinds against the model.
 *
 * `better` is the action itself rather than a sentence, because how an action
 * is spoken is the view's business, and the store has no opinion on wording.
 */
export interface DrillVerdict {
  better: TableAction;
  /** Chips the move taken gave up against `better`, always positive. */
  loss: number;
}

interface TableContextValue {
  table: Table;
  options: TableOptions;
  mode: TableMode;
  /** Seat the human occupies, or null when watching the bots play. */
  heroSeat: number | null;
  legalActions: TableAction[];
  sizings: SizingOption[];
  fx: TableFx;
  /** Public reads, seat-keyed, the bots' information set, not a privileged one. */
  reads: Record<number, BeliefDistribution>;
  heroRead: HeroRead | null;
  /** Drill's read on the move just made. Priced in every mode, printed in one. */
  drillVerdict: DrillVerdict | null;
  /** Put the verdict away. It is advice, not an alert; it must be closable. */
  dismissDrill: () => void;
  history: TableHandReport[];
  lastReport: TableHandReport | null;
  /** How much the bots have learned about this player, for the UI to state. */
  memory: MemoryStats;
  /** Wipe what the bots have learned and go back to the shared prior. */
  forgetMe: () => void;
  act: (action: TableAction) => void;
  nextHand: () => void;
  newTable: (options: TableOptions) => void;
  setMode: (mode: TableMode) => void;
}

const TableContext = createContext<TableContextValue | null>(null);

// ---------------------------------------------------------------------------
// Building a table from the setup screen's choices
// ---------------------------------------------------------------------------

/**
 * Seat names, deduplicated. The picker allows the same archetype twice, and two
 * seats both called "Hyper-Aggressive" is unreadable at a glance.
 */
function seatNames(profiles: string[]): string[] {
  const seen = new Map<string, number>();
  return profiles.map((id) => {
    const base = BOT_PROFILES[id as keyof typeof BOT_PROFILES]?.name ?? "Bot";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  });
}

export function buildTable(options: TableOptions, seed?: number): Table {
  const lineup = [...options.lineup];
  // A lineup shorter than the table (corrupt storage, an older saved setup)
  // still has to seat everyone; the pure-EV baseline is the honest filler.
  while (lineup.length < options.seatCount) lineup.push("professor");
  const names = seatNames(lineup);

  const seats: SeatSetup[] = [];
  if (!options.observer) seats.push({ name: "You", kind: "human" });
  for (let i = 0; i < lineup.length && seats.length < options.seatCount; i++) {
    seats.push({ name: names[i], kind: "bot", profile: lineup[i] });
  }

  return createTable({
    seatCount: options.seatCount,
    startingStack: startingStack(options),
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind,
    seed,
    seats,
  });
}

// ---------------------------------------------------------------------------
// Choreography timing (ms)
// ---------------------------------------------------------------------------

const T = {
  chip: 420, // chip flight into the pot
  noChip: 200, // a check/fold beat with no chips
  settle: 100, // pause after committing before the bubble clears
  dealStep: 175, // delay between each community card landing
  blindGap: 150, // gap between the small and big blind chips
};

/**
 * Report a timer that arrived so late its animation beat is no longer usable.
 *
 * Two conditions, and it needs both. A ratio alone is wrong at the short end:
 * the shortest dwell here is `settle` at 100ms, so six times it is 600ms, and a
 * 600ms hiccup is ordinary on a loaded laptop. Bailing there would abandon a
 * perfectly good hand and hand the player a table that stopped for no reason,
 * which is the bug this guard exists to prevent, arriving by the front door.
 *
 * The absolute floor is set against what starvation actually looked like when
 * it was measured in Chrome: callbacks arriving 7.4, 11.2, 13.0 and 16.1
 * seconds late. A full second of overshoot is nowhere near that and nowhere
 * near ordinary jitter either, so the gap between a false positive and a true
 * one is roughly an order of magnitude in both directions.
 */
const STARVED_FLOOR_MS = 1000;

const sleep = (ms: number) => {
  const started = performance.now();
  return new Promise<boolean>((resolve) =>
    setTimeout(() => {
      const elapsed = performance.now() - started;
      resolve(elapsed > ms * 6 && elapsed - ms > STARVED_FLOOR_MS);
    }, ms)
  );
};

/**
 * Give the main thread back for one task, so React can paint what was just
 * set before the caller takes the thread again.
 *
 * Not `sleep(0)`: that returns a starvation verdict, and a caller that only
 * wants to let a frame out has no use for one and no business ignoring it.
 */
const yieldToPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Narrating the decision
// ---------------------------------------------------------------------------
//
// Every stage below names something `poker/model/decider.ts` genuinely does,
// and every number in it is read off the very inputs the decider is handed -
// the `EquityRequest` it will sample, the shard plan `equity/pool` will use,
// the ladder `table/rules` will size from, and (in the revealing modes) the
// `BotDecision` it returned. Nothing here is illustrative, and a stage whose
// data is not available is not shown rather than being filled in.
//
// The one thing that is not real is the clock. The pipeline lands in single-
// digit milliseconds on a fold and a few tens on a six-way priced decision,
// which is far too fast to read, so each stage is held on screen for the dwell
// below. That dwell is a *display minimum over work that has already happened*
//, the previous version of this app hid a ~7ms decision behind a fabricated
// 3.6-4.8s progress animation, and the difference between that and this is that
// no number here is invented and no stage here describes work that did not run.

/**
 * How long one stage stays on screen before the next replaces it.
 *
 * Purely a reading speed: nothing is waiting on it. Long enough that a two-clause
 * line with a count in it can be read once through.
 */
const STAGE_DWELL_MS = 480;

/**
 * Extra dwell per item a stage reports, past the first, a range, a bet size, a
 * candidate line. A stage with five bet sizes in it has five times the reading
 * to do, so the total length of a decision falls out of how much work that
 * decision actually involved rather than out of a chosen duration.
 */
const STAGE_ITEM_MS = 110;

/** Ceiling on one stage, so a full table stays watchable at six-handed. */
const STAGE_DWELL_MAX_MS = 900;

/** A stage of the pipeline, as planned before it is narrated. */
interface Stage extends ThinkLine {
  /** Real quantities this stage reports; the only thing that scales its dwell. */
  items: number;
}

function dwellFor(stage: Stage): number {
  return Math.min(
    STAGE_DWELL_MAX_MS,
    STAGE_DWELL_MS + STAGE_ITEM_MS * Math.max(0, stage.items - 1)
  );
}

const asLine = ({ title, detail, facts }: Stage): ThinkLine => ({
  title,
  detail,
  facts,
});

const nf = (n: number) => n.toLocaleString();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (n: number) => (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1));
const s = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * Combos a range still allows. `opponentRanges` zeroes every combo containing a
 * card the hero can see and no later factor can resurrect one, so this is the
 * live count for the whole decision, not a snapshot of one moment in it.
 */
function liveCombos(range: Range | undefined): number {
  if (!range) return 0;
  let n = 0;
  for (let i = 0; i < COMBO_COUNT; i++) if (range[i] > 0) n++;
  return n;
}

/**
 * The stages of one decision, in the order the decider runs them.
 *
 * `decision` is the completed `BotDecision` when the current mode is allowed to
 * print the bot's own numbers, and null otherwise. It only ever appends to a
 * stage's detail, so the stage list has the same length and the same order in
 * every mode, what changes is how much of each line is filled in.
 */
function planStages(
  state: Table,
  seat: number,
  request: EquityRequest,
  decision: BotDecision | null
): Stage[] {
  const opponents = request.opponents;
  const records = handActions(state).length;
  const stages: Stage[] = [];

  stages.push({
    title: "Reading the table",
    detail:
      opponents.length === 0
        ? "nobody left to beat"
        : `${opponents.length} ${s(opponents.length, "opponent")} live · ${records} ${s(records, "action")} on record`,
    items: 1,
  });

  // `asyncTableDecider` short-circuits an uncontested pot to `uncontestedEquity()`
  // before any of the below runs. Narrating ranges or trials here would be
  // describing work that provably did not happen.
  if (opponents.length === 0) {
    stages.push({
      title: "Taking it down",
      detail: "pot is already this seat's, nothing to simulate",
      items: 1,
    });
    return stages;
  }

  // Card removal, applied once up front inside `opponentRanges`. Genuinely
  // instant, 51 slots touched per dead card, so the line says what it found
  // rather than pretending it took a while.
  stages.push({
    title: "Removing known cards",
    detail: `${nf(liveCombos(request.ranges?.[opponents[0]]))} of ${nf(COMBO_COUNT)} combos survive · 2 hole + ${state.board.length} board`,
    items: 1,
  });

  // Only records belonging to a seat still contesting the pot become factors:
  // `opponentRanges` builds no range for a seat that folded, so its actions are
  // skipped. "Nobody has acted" would therefore be wrong on a record that is not
  // empty, the seats that acted are simply no longer in the hand.
  const live = new Set(opponents);
  const factors = handActions(state).filter((r) => live.has(r.seat)).length;
  stages.push({
    title: "Weighting their ranges",
    detail:
      factors === 0
        ? `${opponents.length} flat ${s(opponents.length, "prior")}, none of them has acted yet`
        : `${opponents.length} ${s(opponents.length, "range")} · ${factors} P(action | bucket) ${s(factors, "factor")}, renormalised each time`,
    items: opponents.length,
  });

  // The shard plan the pool will actually use. `SHARDS` is a constant decoupled
  // from the core count, so this split is the same on every machine, which is
  // exactly why it can be quoted.
  const shards = planShards(request.simulations, request.seed);
  const even = shards.every((sh) => sh.sims === shards[0].sims);
  let sampling = `${nf(request.simulations)} trials · ${shards.length} ${s(shards.length, "shard")} ${
    even
      ? `× ${nf(shards[0].sims)}`
      : `(${shards.map((sh) => nf(sh.sims)).join(" + ")})`
  }`;
  if (decision) {
    sampling += ` · ${pct(decision.equity.equity)} pot share ±${pct(decision.equity.se)}`;
  }
  stages.push({
    title: "Rejection-sampling the field",
    detail: sampling,
    items: 1,
  });

  const actions = legalActions(state, seat, state.config);
  const base = actions.find((a) => a.type === "bet" || a.type === "raise");
  const sizings = sizingLadder(state, seat, state.config);
  const candidates = base ? sizedCandidates(base, sizings) : [];
  const toCall = toCallOf(state, seat);
  const potAfterCall = state.pot + toCall;

  if (candidates.length > 0) {
    let detail = `${candidates.length} ${s(candidates.length, "size")}, each with its own continuing range · ${nf(FOLD_EQUITY_SIMS)} trials on common random numbers`;
    if (decision?.equityVsRange !== undefined) {
      detail += ` · ${pct(decision.equityVsRange)} vs their full ranges`;
    }
    stages.push({
      title: "Pricing every size",
      detail,
      items: candidates.length,
      // The pot fraction is the number `priceSizes` tilts each fold rate by, and
      // it is derived from the pot, the call and the size, all public. The fold
      // rate and continuing equity it produces are the bot's own read, so they
      // arrive only with `decision`.
      facts: candidates.map((a) => {
        const extra = Math.max(0, a.cost - toCall);
        const fraction = potAfterCall > 0 ? extra / potAfterCall : 0;
        const priced = decision?.foldEquity?.[a.label];
        return {
          label: a.label,
          value: priced
            ? `${fraction.toFixed(2)}× pot · folds ${pct(priced.pFold)} · eq ${pct(priced.eContinue)}`
            : `${fraction.toFixed(2)}× pot`,
        };
      }),
    });
  }

  // `priceCall` returns null, leaving `actionEv`'s exact number standing -
  // unless there is a call on the table that somebody behind can still raise
  // the price of. Same predicate, so this stage appears exactly when it runs.
  const call = actions.find((a) => a.type === "call");
  if (call && call.cost > 0 && !closesAction(state, seat)) {
    const behind = opponents.filter((id) => toCallOf(state, id) > 0).length;
    let detail = `${behind} ${s(behind, "seat")} behind still ${s(behind, "owes", "owe")} chips, the pot it is called into is not the final one`;
    const ev = decision?.evByAction[call.label];
    if (ev !== undefined) detail += ` · ${call.label} at ${signed(ev)}`;
    stages.push({
      title: "Re-pricing the call",
      detail,
      items: Math.max(1, behind),
    });
  }

  // `finish` swaps every aggressive action for the whole priced ladder before
  // the argmax, so this is the size of the set actually compared.
  const lines = base
    ? actions.length - 1 + candidates.length
    : actions.length;
  let compare = `${lines} priced ${s(lines, "line")} · ranked, then bent by the seat's profile`;
  if (decision) {
    const ev = decision.evByAction[decision.action.label];
    compare += ` · ${decision.action.label}${ev === undefined ? "" : ` at ${signed(ev)}`}`;
  }
  stages.push({ title: "Comparing the lines", detail: compare, items: lines });

  return stages;
}

// ---------------------------------------------------------------------------
// Pricing the hero's own lines
// ---------------------------------------------------------------------------

const isAggressive = (action: TableAction) =>
  action.type === "bet" || action.type === "raise";

/** The decision point a read describes: this hand, this many actions in. */
const decisionKey = (state: Table) =>
  `${state.handNumber}:${handActions(state).length}`;

/**
 * Sims per rung when it is the human's own ladder being priced.
 *
 * Three times `FOLD_EQUITY_SIMS`, and the multiplier is measured rather than
 * chosen. The bots' budget is sized for a bot: paid on every decision, under an
 * animation, with up to five other seats to get through before the human is back
 * on the clock. This one is paid once, for one decision, while a person reads the
 * board, so the same argument that caps theirs is what raises this.
 *
 * What the extra sims buy is the threshold. Over 228 sampled aggressive spots,
 * re-priced at fifteen times the budget to stand in for the truth: at 800 per
 * rung the verdict fires on 5 spots the long run calls silence and the worst of
 * those claims a 73-chip loss, i.e. `DRILL_THRESHOLD_BB` cleared by sampling
 * error rather than by a mistake, which is the one thing this mode may not do.
 * At 2400 it is 2 spots and 23 chips. Beyond that the curve flattens and the
 * main thread does not: the widest preflop ladder measured is 47 ms at 2400
 * against 19 ms at 800.
 *
 * Two independent draws at 800, firing only when both clear the threshold, was
 * the cheaper candidate and it does not work: 3 false verdicts instead of 5, and
 * three true ones lost. The near-threshold spots are the ones where the
 * estimator is thin rather than merely unlucky, so a second thin draw agrees
 * with the first.
 */
const HERO_FOLD_EQUITY_SIMS = FOLD_EQUITY_SIMS * 3;

/**
 * Price the hero's ladder and the hero's call the way the bots price their own.
 *
 * These are the decider's pricers, not a second set written here, and they are
 * handed the very ranges the showdown estimate was just run against. That is
 * the point of passing `request.ranges` and `request.seed` through: one read of
 * the opponents per decision, priced three ways, so the gap between a bet and a
 * call is the selection effect rather than two models disagreeing, and the rungs
 * are compared on common random numbers rather than on their sampling noise.
 *
 * Synchronous, on the main thread, and that is the same place and the same
 * budget every bot decision already pays: `decider.finish` runs both of these
 * after it joins the worker pool. What makes it affordable here is when it runs.
 * It is spent while the human is on the clock, i.e. while they are thinking, and
 * thrown away the moment they act.
 */
function priceHeroLines(
  state: Table,
  seat: number,
  request: EquityRequest
): Pick<HeroRead, "sizes" | "call"> {
  const actions = legalActions(state, seat, state.config);
  const base = actions.find(isAggressive);
  const call = actions.find((a) => a.type === "call");
  return {
    sizes: base
      ? priceSizes(
          state,
          seat,
          base,
          sizingLadder(state, seat, state.config),
          HERO_FOLD_EQUITY_SIMS,
          request.seed,
          request.ranges
        )
      : null,
    // Null whenever the call closes the action, on `closesAction`, the same
    // predicate `planStages` narrates the re-pricing under.
    call: call
      ? priceCall(
          state,
          seat,
          call,
          HERO_FOLD_EQUITY_SIMS,
          request.seed,
          request.ranges
        )
      : null,
  };
}

/**
 * The fold-equity price of one rung of the ladder, or null when there is no
 * honest one to report.
 *
 * `pFold` at zero is the case worth naming: somebody in the field is all-in and
 * has no decision left, so no size can win the pot uncontested and the rung is
 * worth only what it collects at showdown. That is `actionEv`'s assumption
 * arriving through the back door, and it is exactly the assumption a bet may not
 * be judged under, so the size is left unpriced instead. `simulations` at zero
 * with folds still on the table is the same failure in a smaller box: the called
 * branch never sampled, and `foldEquityEv` falls back to minus the cost there,
 * which is a one-directional bias against betting.
 */
function pricedRung(read: HeroRead, rung: TableAction): number | null {
  const priced = read.sizes?.byLabel[rung.label];
  if (!priced) return null;
  if (priced.pFold <= 0) return null;
  if (priced.simulations === 0 && priced.pFold < 1) return null;
  return priced.ev;
}

/**
 * What the table itself would pay for one line the hero can take, or null when
 * it cannot say.
 *
 * Three pricers, and they are the three `decider.finish` chooses between on a
 * bot's own move. That is the whole design: what Drill judges a human move
 * against, and what Study prints, are the numbers the table judged itself by, so
 * the mode cannot become a second and privately written valuer that disagrees
 * with the bot sitting next to it.
 *
 *   - Fold, check, and a call that closes the action: `evByAction`, i.e.
 *     `actionEv`. Exact, because no chip can enter the pot after it.
 *   - Bets and raises: the priced ladder. `actionEv` is not merely imprecise
 *     here, it is biased in one direction, its own header in `poker/ev.ts` says
 *     so ("a bet wins two different ways and `actionEv` only counts one of
 *     them"): the entire P(fold) · Pot term is missing, so a river bluff with no
 *     showdown equity prices at minus the bet every time and checking wins by
 *     construction. Priced that way Drill would tell a player who had just found
 *     a correct bluff that they were wrong, in the one mode whose whole promise
 *     is that it stays quiet unless you are. Confidently backwards coaching is
 *     worse than none, which is why this reads `foldEquityEv` against the range
 *     that continues instead. `coach/evLoss.ts` reaches the same conclusion from
 *     the same fact in its own header.
 *   - A call that does not close the action: the re-priced call. Not an extra.
 *     Pricing a raise against the pot the field builds while pricing the call
 *     against the pot as it stands compares a multiway pot with a heads-up one,
 *     and the gap runs entirely in the raise's favour (see `ev.callEv`: over 220
 *     six-handed hands it flipped the sign of the comparison in 37.5% of spots).
 *     Adding aggression to the comparison without this would not make Drill
 *     honest about bets, it would make it raise-happy.
 *
 * An aggressive action is matched to its rung by cost rather than by label,
 * because the two are formatted by different functions: `Actions.sized` spends
 * `money`, so it says "Bet $1,200" where `sizedCandidates` says "Bet $1200".
 * Cost is the quantity being priced; the label is how it is spoken.
 */
export function heroActionEv(
  read: HeroRead,
  action: TableAction
): number | null {
  if (isAggressive(action)) {
    const rung = read.sizes?.candidates.find((c) => c.cost === action.cost);
    return rung ? pricedRung(read, rung) : null;
  }
  if (action.type === "call" && read.call) return read.call.ev;
  return evByAction([action], read.equity, read.pot, read.toCall)[action.label];
}

/** Every line the hero could take here, priced, unpriceable ones dropped. */
function heroLines(
  read: HeroRead,
  choices: TableAction[]
): { action: TableAction; ev: number }[] {
  const lines: { action: TableAction; ev: number }[] = [];
  // The legal set with its aggressive entry replaced by the whole ladder, which
  // is the same substitution `finish` makes before its own argmax: the minimum
  // bet is one size among several and usually not the best one.
  const candidates = choices.flatMap((a) =>
    isAggressive(a) ? (read.sizes?.candidates ?? []) : [a]
  );
  for (const action of candidates) {
    const ev = heroActionEv(read, action);
    if (ev !== null) lines.push({ action, ev });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------

/**
 * Price one size the ladder does not carry.
 *
 * The presets are rungs of `sizingLadder`, but the slider can stop anywhere, so
 * the size a human actually chose often is not one of them, and calling the $37
 * bet the $33 rung would invent the number Drill exists to check. One rung is
 * priced here instead: an empty `sizings` makes `sizedCandidates` return this
 * action alone, so the cost is one field run and one range run rather than a
 * ladder: 3 ms on a river, 16 ms on the widest preflop spot measured. This is
 * the only work in this file the human waits on, and it buys the alternative to
 * staying silent on every size a slider can reach, which is most of them.
 *
 * The seed, the budget and the ranges are the ladder's, not a second set:
 * `decisionSeed` is a pure function of this state and this seat, and
 * `priceSizes` rebuilds the ranges from `opponentRanges`, which is a pure
 * function of the same. So this rung lands on the ladder's common random numbers
 * rather than beside them, which is what makes the two comparable at all.
 */
function priceTakenSize(
  state: Table,
  seat: number,
  taken: TableAction
): number | null {
  const priced = priceSizes(
    state,
    seat,
    taken,
    [],
    HERO_FOLD_EQUITY_SIMS,
    decisionSeed(state, seat)
  );
  if (!priced) return null;
  const breakdown = priced.byLabel[taken.label];
  if (!breakdown) return null;
  if (breakdown.pFold <= 0) return null;
  if (breakdown.simulations === 0 && breakdown.pFold < 1) return null;
  return breakdown.ev;
}

/**
 * Price the move the human just made against the best one available.
 *
 * Every legal line is in the comparison, bets and raises included, each on the
 * pricer that can value it, see `heroActionEv` for which and why. The ladder is
 * priced while the human is on the clock; only a size the ladder does not carry
 * is priced here.
 *
 * Null is the answer in five cases, and all five are silence rather than a
 * guess: no read arrived before the human acted (they were faster than one Monte
 * Carlo run), the read describes a different decision point, the move taken
 * cannot be priced honestly, there was nothing to choose between, or the loss is
 * inside `DRILL_THRESHOLD_BB`, which is roughly the width of the interval the
 * equity itself was measured to. Interrupting for that would be teaching
 * sampling error.
 *
 * The last of those is the one the wider comparison strains, and it is worth
 * being precise about: the rungs share common random numbers with each other, so
 * choosing between two sizes is a low-noise comparison, but a bet against a
 * check is a fold-equity estimate at `HERO_FOLD_EQUITY_SIMS` against a showdown
 * estimate at the per-street budget, and those two runs are independent. That is
 * what the raised budget buys and it is the reason it is raised; the threshold
 * itself is unchanged rather than quietly widened for aggression, because a
 * second threshold living here would be a private constant nobody could find
 * from the mode's own documentation. If it has to move it should move in
 * `lib/tableOptions.ts`, where the first one is stated.
 */
function priceDrill(
  read: HeroRead | null,
  state: Table,
  seat: number,
  choices: TableAction[],
  taken: TableAction,
  bigBlind: number
): DrillVerdict | null {
  if (!read || read.key !== decisionKey(state)) return null;
  /*
   * An aggressive move is judged only against a priced ladder. Pricing the size
   * taken while the sizes it should be compared against are missing would draw
   * the "better" line from the passive half of the set alone, and announce a
   * check over a bet on the strength of the bets it failed to look at.
   */
  if (isAggressive(taken) && !read.sizes) return null;

  const takenEv = isAggressive(taken)
    ? // A rung of the priced ladder if the human landed on one, which the preset
      // buttons and the default sizing do; otherwise its own single rung.
      (heroActionEv(read, taken) ?? priceTakenSize(state, seat, taken))
    : heroActionEv(read, taken);
  if (takenEv === null) return null;

  const lines = heroLines(read, choices);
  if (lines.length === 0) return null;
  let better = lines[0];
  for (const line of lines) if (line.ev > better.ev) better = line;

  const loss = better.ev - takenEv;
  if (loss <= DRILL_THRESHOLD_BB * bigBlind) return null;
  return { better: better.action, loss };
}

// ---------------------------------------------------------------------------

export function TableProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<TableOptions>(loadSetup);
  const [table, setTable] = useState<Table>(() => buildTable(loadSetup()));
  const [history, setHistory] = useState<TableHandReport[]>([]);

  // What the bots have learned about this player. Read on every decision,
  // written only when a hand ends, never on the decision path. Refs rather
  // than state because a re-render on every observation would be pointless: the
  // model is an input to the next decision, not something the UI renders live.
  const memoryRef = useRef<OpponentMemory>(loadMemory());
  const heroRef = useRef<number | null>(null);
  // Mirrored into state only so the UI can re-render when it changes; the
  // decision path reads the ref, never this.
  const [memory, setMemory] = useState<MemoryStats>(() =>
    memoryStats(memoryRef.current)
  );

  /**
   * The live decider: Monte Carlo goes to the worker pool, off the main thread.
   *
   * Built once. `models` is a function called per seat per decision, so it reads
   * through the refs and the decider never needs rebuilding when the memory
   * grows, which would otherwise throw away the worker pool mid-session.
   */
  const decide = useMemo(
    () =>
      asyncTableDecider({
        models: (seat) => seatModelsFor(heroRef.current, memoryRef.current)(seat),
      }),
    []
  );

  const [busy, setBusy] = useState(false);
  const [dealtCount, setDealtCount] = useState(0);
  const [bubbles, setBubbles] = useState<Record<number, string | null>>({});
  const [thinking, setThinking] = useState<Record<number, ThinkStep | null>>({});
  const [chips, setChips] = useState<ChipFx[]>([]);
  const [heroRead, setHeroRead] = useState<HeroRead | null>(null);
  const [drillVerdict, setDrillVerdict] = useState<DrillVerdict | null>(null);

  const tableRef = useRef(table);
  tableRef.current = table;
  // Read the same way `tableRef` is. `act` has to price the move against the
  // estimate that was live at the decision, and it clears that estimate in the
  // same call; listing `heroRead` as a dependency instead would rebuild `act`
  // on every Monte Carlo result and hand the action bar a new callback
  // mid-decision.
  const heroReadRef = useRef<HeroRead | null>(null);
  heroReadRef.current = heroRead;
  // Read the same way `tableRef` is, and for the same reason: the bot loop is a
  // long-lived async sequence that must see the mode as it is now, and putting
  // `options` in its dependency list would rebuild `drive`, and re-fire the
  // resume effect that depends on it, every time a setting changed.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const busyRef = useRef(false);
  const chipId = useRef(0);
  const startedRef = useRef(false);
  /**
   * Cleared when the provider unmounts. The bot loop is a long-lived async
   * sequence, so leaving the table mid-hand would otherwise keep dealing -
   * running Monte Carlo and setting state on a component nobody is looking at
   * until the hand happened to end.
   */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // ---- Pausing -------------------------------------------------------------
  //
  // The table deals only while it is the thing being looked at.
  //
  // `/review` and its siblings share this provider with `/table`, so walking off
  // the felt does not unmount the store and the bot loop keeps running behind
  // the page you navigated to: hands finish, new ones are dealt, and the hand
  // under review moves while it is being read. A hidden tab is the same
  // situation arriving by a different door, so both drive one flag.
  //
  // The flag is held in a ref as well as in state because the bot loop is a
  // long-lived async sequence that closes over neither, it re-reads the ref
  // between turns, the way it already re-reads `aliveRef` and `tableRef`.
  const { pathname } = useLocation();
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden"
  );
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Trailing slash stripped because the router matches `/table/` to the same
  // route: a literal comparison would leave that URL permanently paused, which
  // looks exactly like a dead table.
  const paused = pathname.replace(/\/+$/, "") !== "/table" || hidden;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /**
   * Set when the loop stopped because of the pause, as opposed to because the
   * hand ended or the human is on the clock. Only the first case has a turn
   * still owed, so only the first case is resumed, which is what keeps the
   * resume from re-entering a loop that already finished for a good reason.
   */
  const resumeRef = useRef(false);

  const heroSeat = options.observer ? null : 0;
  heroRef.current = heroSeat;

  // ---- Low-level presentation primitives ----------------------------------
  const commit = useCallback((next: Table) => {
    tableRef.current = next;
    setTable(next);
  }, []);

  const spawnChip = useCallback((seat: number) => {
    chipId.current += 1;
    const id = chipId.current;
    setChips((cur) => [...cur, { seat, id }]);
    window.setTimeout(
      () => setChips((cur) => cur.filter((c) => c.id !== id)),
      T.chip + 60
    );
  }, []);

  const say = useCallback((seat: number, text: string | null) => {
    setBubbles((cur) => ({ ...cur, [seat]: text }));
  }, []);

  const think = useCallback((seat: number, step: ThinkStep | null) => {
    setThinking((cur) => ({ ...cur, [seat]: step }));
  }, []);

  /** Reveal community cards one at a time, as if dealt off the deck. */
  const dealUpTo = useCallback(async (fromLen: number, toLen: number) => {
    for (let i = fromLen; i < toLen; i++) {
      /*
       * A pause can land while the previous card's timer is starved. Stopping
       * at the next card boundary keeps the stale sequence from holding the
       * table lock, and records that the live turn loop still has work owed.
       */
      if (pausedRef.current || !aliveRef.current) {
        resumeRef.current = true;
        return false;
      }
      setDealtCount(i + 1);
      if (await sleep(T.dealStep)) {
        /*
         * Starvation is not a pause. A pause means stop; a starved timer means
         * these beats are stale, and the honest answer is to stop animating
         * and show the rest at once. Returning early here left community cards
         * hidden while the engine had already dealt them, so a player could be
         * asked to act on a flop they could not see.
         */
        setDealtCount(toLen);
        return true;
      }
    }
    return true;
  }, []);

  // ---- One committed move, with its animation ------------------------------
  const perform = useCallback(
    async (seat: number, action: TableAction, decision?: BotDecision) => {
      const next = structuredClone(tableRef.current);
      const before = next.board.length;
      // Recorded on the clone the move is applied to, so the hand report
      // carries the full audit trail exactly as `playHandHeadless` builds it.
      if (decision) next.decisions.push(decision);

      say(seat, action.label);
      if (action.cost > 0) spawnChip(seat);
      /*
       * Pause and starvation are not the same interruption, and conflating them
       * dropped a human's click.
       *
       * A pause (navigated away, unmounted) means stop: nothing has reached the
       * engine, the move is still owed, and `performBot` will recompute it from
       * `(seed, hand number, action count, seat)` on resume. That is safe for a
       * bot. It is NOT safe for the human, because nothing recomputes a human's
       * choice: `act` returns early, the resume effect calls `drive`, and
       * `drive` stops because the human still owns the turn. The player pressed
       * Fold and watched nothing happen.
       *
       * A starved timer means something else entirely: the move is fine, the
       * animation beats around it are just minutes stale. So starvation now
       * skips the remaining choreography and completes the move, which is both
       * correct for the human and harmless for a bot.
       */
      const starved = await sleep(action.cost > 0 ? T.chip : T.noChip);
      if (pausedRef.current || !aliveRef.current) {
        resumeRef.current = true;
        return false;
      }

      applyAction(next, seat, action);
      commit(next);

      /*
       * Past this line the move is committed, so bailing can only ever leave
       * the table half-drawn: a bubble still showing and community cards the
       * engine has dealt still face down, which is how a player ended up being
       * asked to act on a flop they could not see. Finish the presentation
       * either way, immediately if the timers are starved.
       */
      const settleStarved = starved || (await sleep(T.settle));
      say(seat, null);
      if (settleStarved) {
        setDealtCount(next.board.length);
        return true;
      }
      await dealUpTo(before, next.board.length);
      return true;
    },
    [commit, dealUpTo, say, spawnChip]
  );

  /**
   * One bot's turn. False means it was abandoned before anything was applied.
   *
   * The abandon window is the wait on the worker, which is the longest part of
   * a turn and so the part a pause is most likely to land in. Dropping the
   * decision there costs nothing and duplicates nothing: it is a pure function
   * of `(seed, hand number, action count, seat)`, none of which the abandon
   * changes, so re-entering recomputes this exact move rather than a different
   * one, and the table has not moved in the meantime.
   */
  const performBot = useCallback(
    async (seat: number): Promise<boolean> => {
      const live = tableRef.current;
      const request = equityRequest(live, seat);
      // Kick the decision off first so the whole pipeline runs underneath the
      // narration rather than after it. It goes to the worker pool, so the main
      // thread stays free to animate while it is in flight, and by the time the
      // first stage has been read it has long since landed.
      const pending = decide(live, seat, live.config);
      // A pause can abandon this turn with the decision still in flight, and
      // then nothing awaits it. `runMultiwayEquity` falls back rather than
      // rejecting, so this is belt and braces, but an unhandled rejection is a
      // console error nobody can act on, which is worth one line to prevent.
      void pending.catch(() => {});

      // THE INFORMATION BOUNDARY.
      //
      // Counts are public facts about the computation: how many opponents, how
      // many combos the deck still allows, how many trials across how many
      // shards, which sizes the rules permit. Every mode gets those, because a
      // player could work out all of them from the felt.
      //
      // The bot's own equity, its per-size fold and continuing-range numbers and
      // its EVs are its hand talking, and handing those to the player mid-hand
      // is handing them the bot's cards in a slower form. Those show only where
      // the table already shows everything: Study, and the observer table, which
      // has no human seat to keep anything from. Same predicate as
      // `TableGame`'s `revealAll`, deliberately.
      const { mode, observer } = optionsRef.current;
      const reveal = mode === "study" || observer;

      // Only the revealing modes join the worker before narrating, because only
      // they have something to say that does not exist until it answers. Fair
      // and Coach narrate from the request alone and never wait on it at all.
      const early = reveal ? await pending : null;
      const stages = planStages(live, seat, request, early);

      const done: ThinkLine[] = [];
      for (let i = 0; i < stages.length; i++) {
        // Tested before each stage, never inside one: a paused table stops on a
        // stage boundary with nothing owed but the turn itself, which `drive`
        // re-runs whole. It cannot sit half-narrated.
        if (pausedRef.current || !aliveRef.current) {
          think(seat, null);
          return false;
        }
        think(seat, {
          ...asLine(stages[i]),
          step: i,
          done: [...done],
          total: stages.length,
        });
        done.push(asLine(stages[i]));
        const starved = await sleep(dwellFor(stages[i]));
        /*
         * A renderer-starved dwell is no longer narration, it is the reported
         * dead-table state: thinking disappears while the stale sequence keeps
         * the lock. Abandon at the same safe boundary as an explicit pause.
         */
        if (pausedRef.current || !aliveRef.current || starved) {
          think(seat, null);
          resumeRef.current = true;
          return false;
        }
      }

      if (pausedRef.current || !aliveRef.current) {
        think(seat, null);
        return false;
      }
      // For Fair and Coach this is the first and only join with the worker, and
      // it has had the entire narration to finish. If it somehow has not, the
      // last stage simply stays up until it does: the narration never runs out
      // ahead of the decision, and the decision is never applied without one.
      const decision = early ?? (await pending);
      think(seat, null);
      if (!(await perform(seat, decision.action, decision))) return false;
      return true;
    },
    [perform, think]
  );

  /**
   * Run bot moves until the human is on the clock, the hand ends, or the table
   * is paused. The step cap is a backstop: a cycling turn order would otherwise
   * spin here forever with the lock held, which is the one failure the user
   * cannot recover from.
   *
   * The pause is tested between turns, never inside one, so a turn either
   * happens whole or has not started, the seat still owes exactly the move it
   * owed before, and `resumeRef` is what remembers that it does.
   */
  const drive = useCallback(async () => {
    for (let steps = 0; steps < 400; steps++) {
      if (!aliveRef.current) return;
      if (pausedRef.current) {
        resumeRef.current = true;
        return;
      }
      const t = tableRef.current;
      if (t.status !== "playing") return;
      const seat = t.toAct;
      if (seat === null) return;
      if (t.seats[seat].kind === "human") return;
      if (!(await performBot(seat))) {
        resumeRef.current = true;
        return;
      }
    }
    throw new Error("table: bot loop exceeded its step budget");
  }, [performBot]);

  /** Post the blinds for an already-dealt hand, then run any bot turns. */
  const beginHand = useCallback(
    async (next: Table) => {
      commit(next);
      setDealtCount(next.board.length);
      setBubbles({});
      setThinking({});
      setHeroRead(null);
      setDrillVerdict(null);
      if (next.status === "playing") {
        const { sb, bb } = blindSeats(next.button, next.seats.length);
        spawnChip(sb);
        await sleep(T.blindGap);
        spawnChip(bb);
        await sleep(T.chip);
      }
      await drive();
    },
    [commit, drive, spawnChip]
  );

  // ---- Public actions ------------------------------------------------------
  /**
   * Run one animated sequence at a time, releasing the lock in `finally`. The
   * lock has to survive a throw: anything escaping the sequence, a rejected
   * decision, a worker that never answers, would otherwise leave `busy` true
   * forever, which kills every control on the table for good.
   */
  const runExclusive = useCallback((seq: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      try {
        await seq();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("table: action sequence failed", err);
      } finally {
        setThinking({});
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, []);

  const act = useCallback(
    (action: TableAction) => {
      if (busyRef.current) return;
      const t = tableRef.current;
      if (t.status !== "playing" || t.toAct === null) return;
      if (t.seats[t.toAct].kind !== "human") return;
      const seat = t.toAct;
      /*
       * Drill's verdict is priced here, before the move is applied, because
       * this is the last moment the pot, the price and the estimate all still
       * describe the decision that was actually faced.
       *
       * Written unconditionally, and that is the design: no mode is consulted,
       * every mode pays the same price for it, and `CoachPanel` alone decides
       * whether the result is printed. Gating it on `mode` here would put a
       * rendering choice on the path an action takes into the engine, which is
       * the one thing this file may not do.
       *
       * That price is a handful of multiplications off the read that is already
       * in hand, with one exception: a bet or raise at a size the ladder does
       * not carry costs one more field simulation, see `priceTakenSize`.
       *
       * Set on every hero action, so it also clears itself, a verdict from the
       * previous decision can never sit underneath the current one.
       */
      setDrillVerdict(
        priceDrill(
          heroReadRef.current,
          t,
          seat,
          legalActions(t, seat, t.config),
          action,
          t.config.bigBlind
        )
      );
      setHeroRead(null);
      runExclusive(async () => {
        if (!(await perform(seat, action))) return;
        await drive();
      });
    },
    [drive, perform, runExclusive]
  );

  const dismissDrill = useCallback(() => setDrillVerdict(null), []);

  /*
   * Why these two queue instead of returning.
   *
   * The result strip, and with it "Deal me another", renders as soon as the
   * table reaches `hand-over`, but the sequence that got it there is still
   * unwinding: the last reveals, the final `setThinking({})`. During that tail
   * `busyRef` is true, and `runExclusive` drops any call that arrives while it
   * is held. So a player who clicked the button the moment it appeared got
   * nothing at all, no error and no hand, and had to click it a second time.
   * It reproduced on roughly one hand in three, always the ones with the most
   * to reveal, which is exactly when the button is on screen the longest before
   * the lock clears.
   *
   * The same trap as the pause/resume path below, and the same escape: record
   * the intent and let the effect that watches `busy` spend it. Later intents
   * overwrite earlier ones, clicking "Deal me another" twice deals one hand,
   * and changing the table after asking for a hand gives you the new table.
   */
  const pendingRef = useRef<(() => void) | null>(null);

  const nextHand = useCallback(() => {
    const deal = () =>
      runExclusive(async () => {
        const next = structuredClone(tableRef.current);
        startHand(next);
        await beginHand(next);
      });
    if (busyRef.current) pendingRef.current = deal;
    else deal();
  }, [beginHand, runExclusive]);

  const newTable = useCallback(
    (next: TableOptions) => {
      const build = () => {
        saveSetup(next);
        setOptions(next);
        setHistory([]);
        runExclusive(async () => {
          const fresh = buildTable(next);
          startHand(fresh);
          await beginHand(fresh);
        });
      };
      if (busyRef.current) pendingRef.current = build;
      else build();
    },
    [beginHand, runExclusive]
  );

  /** Spend a queued deal the moment the lock clears. */
  useEffect(() => {
    if (busy || !pendingRef.current) return;
    const run = pendingRef.current;
    pendingRef.current = null;
    run();
  }, [busy]);

  /**
   * Switching mode mid-session is deliberately cheap: it re-renders and nothing
   * else. No hand is re-dealt and no decision is recomputed, because the bots
   * never saw the mode in the first place.
   */
  const setMode = useCallback((mode: TableMode) => {
    setOptions((cur) => {
      const next = { ...cur, mode };
      saveSetup(next);
      return next;
    });
  }, []);

  // ---- First hand ----------------------------------------------------------
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runExclusive(async () => {
      const fresh = structuredClone(tableRef.current);
      startHand(fresh);
      await beginHand(fresh);
    });
  }, [beginHand, runExclusive]);

  // ---- Resume where the pause stopped --------------------------------------
  //
  // Keyed on `busy` as well as `paused`, which is not belt-and-braces: a
  // sequence still unwinding when the user walks back onto the felt is holding
  // the lock, and `runExclusive` drops a call that arrives while it is held. Any
  // one-shot resume would be swallowed there and the table would sit dead with a
  // bot on the clock. Depending on `busy` re-fires this the moment the `finally`
  // releases it, so the handoff has neither a stall nor a double turn in it.
  useEffect(() => {
    if (paused || busy || !resumeRef.current) return;
    resumeRef.current = false;
    runExclusive(drive);
  }, [paused, busy, drive, runExclusive]);

  // ---- Archive finished hands ---------------------------------------------
  useEffect(() => {
    const report = table.lastReport;
    if (!report) return;
    setHistory((prev) =>
      prev.some((r) => r.handNumber === report.handNumber)
        ? prev
        : [...prev, report]
    );

    // The only place the bots learn. Hand-over, not decision time, so a growing
    // model never costs a player a millisecond. `recordReport` de-duplicates by
    // deal seed, so re-running this on the same hand is a no-op.
    if (heroSeat !== null) {
      recordReport(memoryRef.current, report, heroSeat);
      scheduleSave(memoryRef.current);
      setMemory(memoryStats(memoryRef.current));
    }
  }, [table.lastReport, heroSeat]);

  const forgetMe = useCallback(() => {
    memoryRef.current = clearMemory();
    setMemory(memoryStats(memoryRef.current));
  }, []);

  // ---- Observer mode deals itself on ---------------------------------------
  //
  // Gated on the pause too: dealing the next hand behind the review screen is
  // the same defect as playing the current one, and the louder half of it -
  // it is what moves the hand number.
  useEffect(() => {
    if (paused || !options.observer || busy || table.status === "playing") return;
    const id = window.setTimeout(nextHand, 2200);
    return () => window.clearTimeout(id);
  }, [paused, options.observer, busy, table.status, table.handNumber, nextHand]);

  // ---- Coach / Drill / Study equity for the human --------------------------
  //
  // Display only. It runs when the human is on the clock and is thrown away the
  // moment they act, so a stale number can never be shown next to a live board.
  //
  // Fair Play is the only mode that skips it. Drill needs this number even
  // though it prints nothing while you decide, it is what the verdict is priced
  // from once you have acted, and there is no second chance to measure a
  // decision after the cards have moved on.
  //
  // Two runs, published one after the other. The showdown estimate goes to the
  // worker pool and is set the moment it lands, because Coach's whole line is
  // that number. The fold-equity ladder is main-thread work and is folded into a
  // second read a paint later, which is why it is priced here and not on the
  // click: it is spent on the human's clock, where nothing is waiting on it, and
  // discarded unspent whenever they act first.
  const heroTurn =
    heroSeat !== null && table.status === "playing" && table.toAct === heroSeat;
  const heroKey = heroTurn ? decisionKey(table) : "";

  useEffect(() => {
    // Paused counts as "not on the clock": a Monte Carlo run for a decision
    // nobody is looking at is the same wasted work the bot loop was doing.
    if (paused || !heroTurn || heroSeat === null || options.mode === "fair") {
      setHeroRead(null);
      return;
    }
    let cancelled = false;
    const t = tableRef.current;
    const request = equityRequest(t, heroSeat);
    const pot = t.pot;
    const call = toCallOf(t, heroSeat);
    void (async () => {
      let showdown: HeroRead;
      try {
        const equity = await runMultiwayEquity(request);
        if (cancelled) return;
        showdown = {
          key: heroKey,
          equity,
          toCall: call,
          pot,
          required: call > 0 ? call / (pot + call) : 0,
          odds: call > 0 ? pot / call : null,
          opponents: request.opponents,
          sizes: null,
          call: null,
        };
      } catch {
        // A failed estimate must never block the hand; the panel just says so.
        if (!cancelled) setHeroRead(null);
        return;
      }
      setHeroRead(showdown);
      /*
       * Hand the frame back before taking the thread for the ladder. Without
       * this the `setHeroRead` above and the pricing below are one task and the
       * paint waits for the pricing anyway, which is the latency this ordering
       * exists to avoid.
       *
       * A click can land inside the yield, and `cancelled` does not catch it:
       * `act` clears the read at once but the move does not reach the engine
       * until the chip has flown, so this effect is not torn down for another
       * 400ms. The result is one wasted pricing pass and a read that reappears
       * after `act` cleared it, which `read.key` then refuses to price against
       * the state that has moved on. Both are harmless, and a second flag to
       * close a window one millisecond wide would cost more than it saves.
       */
      await yieldToPaint();
      if (cancelled) return;
      try {
        setHeroRead({ ...showdown, ...priceHeroLines(t, heroSeat, request) });
      } catch (err) {
        /*
         * The showdown read stands. Every consumer already treats a null ladder
         * as "not priced", so a failure here costs Drill its verdict on bets and
         * costs nothing else: it must not take Coach's equity line down with it.
         */
        // eslint-disable-next-line no-console
        console.error("table: pricing the hero's sizes failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `heroKey` identifies the decision point; the table object itself changes
    // identity on every commit and would re-run this for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroKey, heroTurn, heroSeat, options.mode, paused]);

  // ---- Derived -------------------------------------------------------------
  const canAct =
    !busy &&
    table.status === "playing" &&
    table.toAct !== null &&
    table.seats[table.toAct].kind === "human";

  const legal = useMemo(
    () =>
      canAct && table.toAct !== null
        ? legalActions(table, table.toAct, table.config)
        : [],
    [canAct, table]
  );

  const sizings = useMemo(
    () =>
      canAct && table.toAct !== null
        ? sizingLadder(table, table.toAct, table.config)
        : [],
    [canAct, table]
  );

  const reads = useMemo(
    () => readsFromActions(handActions(table), table.seats.length),
    [table]
  );

  const fx = useMemo<TableFx>(() => {
    const seats: Record<number, SeatFx> = {};
    for (const seat of table.seats) {
      seats[seat.id] = {
        bubble: bubbles[seat.id] ?? null,
        thinking: thinking[seat.id] ?? null,
      };
    }
    return { busy, dealtCount, seats, chips };
  }, [busy, dealtCount, bubbles, thinking, chips, table.seats]);

  const value = useMemo<TableContextValue>(
    () => ({
      table,
      options,
      mode: options.mode,
      heroSeat,
      legalActions: legal,
      sizings,
      fx,
      reads,
      heroRead,
      drillVerdict,
      dismissDrill,
      history,
      lastReport: table.lastReport,
      memory,
      forgetMe,
      act,
      nextHand,
      newTable,
      setMode,
    }),
    [
      table,
      options,
      heroSeat,
      legal,
      sizings,
      fx,
      reads,
      heroRead,
      drillVerdict,
      dismissDrill,
      history,
      memory,
      forgetMe,
      act,
      nextHand,
      newTable,
      setMode,
    ]
  );

  return (
    <TableContext.Provider value={value}>{children}</TableContext.Provider>
  );
}

export function useTable(): TableContextValue {
  const ctx = useContext(TableContext);
  if (!ctx) throw new Error("useTable must be used within a TableProvider");
  return ctx;
}
