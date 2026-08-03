/**
 * The N-handed hand lifecycle: deal, bet, advance, settle.
 *
 * Everything mechanical is delegated — turn order and round closure to
 * `state.ts`, legal action sets to `rules.ts`, side-pot layout to `pots.ts`,
 * blinds and odd chips to `position.ts`. What is left here is the sequencing:
 * which of those to call, in what order, and what a finished hand looks like.
 *
 * The engine never imports the bot or the equity code. A move arrives as an
 * already-chosen `TableAction`, and `playHandHeadless` asks for one through an
 * injected `SyncBotDecider` — so the entire lifecycle can be exercised with a
 * two-line scripted decider and no Monte Carlo anywhere in sight.
 */

import { HAND_CATEGORY_NAMES } from "../../types";
import type { HandResult } from "../../types";
import { decodeCard, encodeCards } from "../core/card";
import { hashSeed, makeRng } from "../core/rng";
import { categoryOf, scoreInts } from "../handEvaluator";
import type {
  ActionRecord,
  BotDecision,
  PotRecord,
  SeatResult,
  SyncBotDecider,
  TableHandReport,
} from "./contract";
import { MAX_SEATS, MIN_SEATS, oddChipOrder, seatsFrom } from "./position";
import { awardPots, buildPots, type SeatContribution } from "./pots";
import { legalActions, type TableAction, type TableConfig } from "./rules";
import {
  actingSeats,
  bettingClosed,
  commitChips,
  contestingSeats,
  nextToAct,
  onlyOneLeft,
  openingActor,
  postBlinds,
  recordAction,
  resetStreetBetting,
  seatOf,
  toCall,
  type TableSeat,
  type TableState,
} from "./state";

/**
 * A table is a `TableState` plus the handful of things the lifecycle needs that
 * one hand's state does not carry: the blinds, the rebuy level, and the records
 * accumulated while a hand plays. It *extends* `TableState` rather than
 * wrapping it, so every primitive — and every bot, which is handed a
 * `TableState` — keeps working on it unchanged.
 */
export interface Table extends TableState {
  config: TableConfig;
  /** Stack a busted seat reloads to; also the stack every seat starts on. */
  startingStack: number;
  /**
   * Chips injected by auto-rebuy over this table's life. Chips are otherwise
   * conserved, so `totalChips(table) === seatCount * startingStack + rebuys` is
   * the invariant that catches every accounting bug the engine can have.
   */
  rebuys: number;
  /** Actions and bot decisions for the hand in progress. */
  actions: ActionRecord[];
  decisions: BotDecision[];
  lastReport: TableHandReport | null;
}

export interface SeatSetup {
  name: string;
  kind: "human" | "bot";
  profile?: string;
}

export interface TableSetup extends TableConfig {
  seatCount: number;
  startingStack: number;
  /** Session seed; each hand derives its own from this and the hand number. */
  seed?: number;
  /** Seat identities. Defaults to a human in seat 0 and bots everywhere else. */
  seats?: SeatSetup[];
}

/** Integer card codes, shuffled as ints because that is what the evaluator eats. */
const CODES = Array.from({ length: 52 }, (_, i) => i);

/**
 * Entropy enters here and nowhere else — everything downstream is a
 * deterministic function of this seed. Tests and replays pass one in.
 */
function randomSeed(): number {
  return (Date.now() ^ (Math.random() * 0x100000000)) >>> 0;
}

/**
 * The seed a single hand is dealt from. Derived rather than stored so any hand
 * of a session can be reconstructed from the session seed and its number alone.
 */
export function handSeed(sessionSeed: number, handNumber: number): number {
  return hashSeed(sessionSeed, handNumber);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createTable(setup: TableSetup): Table {
  const { seatCount, startingStack, smallBlind, bigBlind } = setup;
  if (seatCount < MIN_SEATS || seatCount > MAX_SEATS) {
    throw new Error(
      `unsupported table size: ${seatCount} (expected ${MIN_SEATS}-${MAX_SEATS})`
    );
  }
  if (startingStack <= 0) throw new Error("startingStack must be positive");
  if (smallBlind <= 0 || bigBlind < smallBlind) {
    throw new Error(`bad blinds: ${smallBlind}/${bigBlind}`);
  }

  const seats: TableSeat[] = Array.from({ length: seatCount }, (_, id) => ({
    id,
    name: setup.seats?.[id]?.name ?? (id === 0 ? "You" : `Bot ${id}`),
    kind: setup.seats?.[id]?.kind ?? (id === 0 ? "human" : "bot"),
    profile: setup.seats?.[id]?.profile,
    stack: startingStack,
    hole: [],
    status: "active",
    streetCommit: 0,
    invested: 0,
    hasActed: false,
    mayRaise: true,
  }));

  return {
    seed: setup.seed ?? randomSeed(),
    handNumber: 0,
    seats,
    // `startHand` rotates first, so the first hand is on the button we want.
    button: seatCount - 1,
    street: "preflop",
    deck: [],
    board: [],
    currentBet: 0,
    lastRaiseSize: 0,
    lastAggressor: null,
    toAct: null,
    pot: 0,
    log: [],
    status: "playing",
    config: { smallBlind, bigBlind },
    startingStack,
    rebuys: 0,
    actions: [],
    decisions: [],
    lastReport: null,
  };
}

// ---------------------------------------------------------------------------
// Starting a hand
// ---------------------------------------------------------------------------

/** Deal a fresh hand. Mutates and returns the table. */
export function startHand(table: Table): Table {
  table.handNumber += 1;
  table.button = (table.button + 1) % table.seats.length;

  for (const seat of table.seats) {
    seat.hole = [];
    seat.status = "active";
    seat.streetCommit = 0;
    seat.invested = 0;
    seat.hasActed = false;
    seat.mayRaise = true;
  }

  table.street = "preflop";
  table.board = [];
  table.pot = 0;
  table.currentBet = 0;
  table.lastRaiseSize = 0;
  table.lastAggressor = null;
  table.actions = [];
  table.decisions = [];
  table.lastReport = null;
  table.status = "playing";
  table.log = [
    `Hand #${table.handNumber} — ${table.seats[table.button].name} on the button.`,
  ];

  deal(table);
  postBlinds(table, table.config.smallBlind, table.config.bigBlind);
  table.log.push(`Blinds ${table.config.smallBlind}/${table.config.bigBlind}.`);

  // Stacks shorter than the blinds can put everyone all-in before a single
  // voluntary action; then the round is already closed and the board just runs.
  if (bettingClosed(table)) advanceStreet(table);
  return table;
}

/**
 * Two cards each, one at a time starting left of the button — the real order,
 * and no more expensive than slicing the deck in seat order.
 */
function deal(table: Table): void {
  const n = table.seats.length;
  const deck = makeRng(handSeed(table.seed, table.handNumber))
    .shuffle(CODES)
    .map(decodeCard);

  const order = seatsFrom((table.button + 1) % n, n);
  let next = 0;
  for (let round = 0; round < 2; round++) {
    for (const id of order) table.seats[id].hole.push(deck[next++]);
  }
  table.deck = deck.slice(next);
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/** Apply a seat's chosen action, then advance the hand. */
export function applyAction(
  table: Table,
  seat: number,
  action: TableAction
): void {
  if (table.status !== "playing") throw new Error("no hand in progress");
  if (table.toAct !== seat) {
    throw new Error(`seat ${seat} acted out of turn (seat ${table.toAct} is up)`);
  }
  checkLegal(table, seat, action);

  const actor = seatOf(table, seat);
  const record: ActionRecord = {
    seat,
    street: table.street,
    action: action.type,
    cost: action.cost,
    potBefore: table.pot,
    toCall: toCall(table, seat),
  };

  switch (action.type) {
    case "fold":
      actor.status = "folded";
      recordAction(table, seat, null);
      break;
    case "check":
      recordAction(table, seat, null);
      break;
    case "call":
      commitChips(table, seat, action.cost);
      recordAction(table, seat, null);
      break;
    case "bet":
    case "raise": {
      commitChips(table, seat, action.cost);
      // The increment is measured over the level this seat faced, not over what
      // it had already put in. That difference is exactly what `recordAction`
      // needs to tell a full raise from a short all-in, which owes the others
      // chips but does not reopen their right to re-raise.
      const increment = actor.streetCommit - table.currentBet;
      table.currentBet = actor.streetCommit;
      recordAction(table, seat, increment);
      break;
    }
  }

  table.actions.push(record);
  table.log.push(describe(actor, action));

  if (onlyOneLeft(table)) {
    resolve(table);
    return;
  }
  if (bettingClosed(table)) {
    advanceStreet(table);
    return;
  }
  const next = nextToAct(table, seat);
  // Unreachable: an open round means some *other* active seat still owes an
  // action, and `nextToAct` scans every seat but this one. Saying so beats
  // parking a null in `toAct`, where it would surface as a frozen table.
  if (next === null) throw new Error("betting is open but no seat can act");
  table.toAct = next;
}

/**
 * Reject anything `legalActions` did not offer. Bet and raise carry a legal
 * `[min, max]` range for the slider, so their cost is checked against it rather
 * than for equality.
 */
function checkLegal(table: Table, seat: number, action: TableAction): void {
  const offered = legalActions(table, seat, table.config).find(
    (a) => a.type === action.type
  );
  if (!offered) {
    throw new Error(`illegal action ${action.type} for seat ${seat}`);
  }
  if (offered.min !== undefined && offered.max !== undefined) {
    if (action.cost < offered.min || action.cost > offered.max) {
      throw new Error(
        `${action.type} of ${action.cost} outside [${offered.min}, ${offered.max}]`
      );
    }
    return;
  }
  if (action.cost !== offered.cost) {
    throw new Error(
      `${action.type} costs ${offered.cost}, not ${action.cost}`
    );
  }
}

/**
 * A verb that agrees with its subject.
 *
 * The hero's seat is literally named "You", so writing the log in the third
 * person printed "You folds.", "You calls $960." and "You rebuys for $2000."
 * throughout the replay narration. `WhatIf.tsx` already special-cases the same
 * name for its possessive; this is the verb half of that, and every log line
 * with a subject goes through it so a new one cannot reintroduce the bug.
 */
function verb(seat: TableSeat, third: string): string {
  return seat.name === "You" ? third.replace(/s$/, "") : third;
}

function describe(seat: TableSeat, action: TableAction): string {
  const allIn = seat.stack === 0 ? " (all-in)" : "";
  switch (action.type) {
    case "fold":
      return `${seat.name} ${verb(seat, "folds")}.`;
    case "check":
      return `${seat.name} ${verb(seat, "checks")}.`;
    case "call":
      return `${seat.name} ${verb(seat, "calls")} $${action.cost}${allIn}.`;
    case "bet":
      return `${seat.name} ${verb(seat, "bets")} $${seat.streetCommit}${allIn}.`;
    case "raise":
      return `${seat.name} ${verb(seat, "raises")} to $${seat.streetCommit}${allIn}.`;
  }
}

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

/** Close the current betting round and open the next street. */
export function advanceStreet(table: Table): void {
  if (table.street === "river" || table.street === "showdown") {
    showdown(table);
    return;
  }

  resetStreetBetting(table);
  switch (table.street) {
    case "preflop":
      table.board.push(...table.deck.splice(0, 3));
      table.street = "flop";
      break;
    case "flop":
      table.board.push(...table.deck.splice(0, 1));
      table.street = "turn";
      break;
    case "turn":
      table.board.push(...table.deck.splice(0, 1));
      table.street = "river";
      break;
  }
  table.log.push(`${table.street}: ${table.board.map((c) => c.id).join(" ")}`);

  // One seat with chips left has nobody to bet against, so there is nothing to
  // decide on any remaining street: deal the rest and settle.
  if (actingSeats(table).length < 2) {
    showdown(table);
    return;
  }
  table.toAct = openingActor(table);
}

function showdown(table: Table): void {
  while (table.board.length < 5) table.board.push(...table.deck.splice(0, 1));
  table.street = "showdown";
  resolve(table);
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

/**
 * Split the pot into layers, pay the winners, and record the hand.
 *
 * Called for both endings: a showdown, and everyone folding to one seat. The
 * only difference is where the scores come from — with a single seat left there
 * is nothing to compare, and its cards stay face down.
 */
export function resolve(table: Table): TableHandReport {
  const contenders = contestingSeats(table);
  if (contenders.length === 0) throw new Error("hand ended with no live seat");
  const wentToShowdown = contenders.length > 1;

  const score: Record<number, number> = {};
  if (wentToShowdown) {
    for (const seat of contenders) {
      const cards = encodeCards([...seat.hole, ...table.board]);
      score[seat.id] = scoreInts(cards, cards.length);
    }
  } else {
    score[contenders[0].id] = 0;
  }

  const contributions: SeatContribution[] = table.seats.map((s) => ({
    id: s.id,
    invested: s.invested,
    folded: s.status === "folded",
  }));
  const { pots, refunds } = buildPots(contributions);
  const winnings = awardPots(
    pots,
    score,
    oddChipOrder(table.button, table.seats.length)
  );

  const paid = table.seats.reduce(
    (n, s) => n + (winnings[s.id] ?? 0) + (refunds[s.id] ?? 0),
    0
  );
  // The layers partition the pot exactly, so a mismatch means chips were
  // created or destroyed — never worth shipping past the hand it happened in.
  if (paid !== table.pot) {
    throw new Error(`payout ${paid} does not match pot ${table.pot}`);
  }

  const seats: SeatResult[] = table.seats.map((s) => {
    // An uncalled bet coming back is not winnings, but it is a chip movement,
    // so it belongs in `won` — that is what makes `net` the stack delta.
    const won = (winnings[s.id] ?? 0) + (refunds[s.id] ?? 0);
    return {
      seat: s.id,
      hole: Array.from(encodeCards(s.hole)),
      final:
        wentToShowdown && s.status !== "folded"
          ? handResult(score[s.id])
          : null,
      invested: s.invested,
      won,
      net: won - s.invested,
      status: s.status,
    };
  });
  for (const s of seats) table.seats[s.seat].stack += s.won;
  table.pot = 0;
  table.toAct = null;
  table.status = "hand-over";

  // Re-derived per pot rather than read off `winnings`: a seat can win the main
  // pot and lose the side pot, so a non-zero total says nothing about which
  // layers it actually took.
  const potRecords: PotRecord[] = pots.map((pot) => {
    const best = Math.max(...pot.eligible.map((id) => score[id]));
    return {
      amount: pot.amount,
      eligible: [...pot.eligible],
      winners: pot.eligible.filter((id) => score[id] === best),
    };
  });
  for (const pot of potRecords) {
    table.log.push(
      `Pot of $${pot.amount} to ${pot.winners.map((id) => table.seats[id].name).join(", ")}.`
    );
  }

  const report: TableHandReport = {
    handNumber: table.handNumber,
    seed: handSeed(table.seed, table.handNumber),
    button: table.button,
    seatCount: table.seats.length,
    board: Array.from(encodeCards(table.board)),
    seats,
    pots: potRecords,
    decisions: table.decisions.map((d) => ({ ...d })),
    actions: table.actions.map((a) => ({ ...a })),
    endStreet: table.street,
    wentToShowdown,
  };
  table.lastReport = report;

  rebuy(table);
  return report;
}

/**
 * Reload every busted seat. The alternative — seats going "out" — shrinks the
 * table mid-session and breaks the positional layouts, so a cash-game rebuy is
 * both the simpler rule and the more realistic one. It is the only place chips
 * enter the table, which is why the amount is tracked.
 */
function rebuy(table: Table): void {
  for (const seat of table.seats) {
    if (seat.stack > 0) continue;
    seat.stack = table.startingStack;
    table.rebuys += table.startingStack;
    table.log.push(
      `${seat.name} ${verb(seat, "rebuys")} for $${table.startingStack}.`
    );
  }
}

/** Rebuild the display form of a score the fast path already computed. */
function handResult(score: number): HandResult {
  const category = categoryOf(score);
  return { category, score, name: HAND_CATEGORY_NAMES[category] };
}

// ---------------------------------------------------------------------------
// Headless play
// ---------------------------------------------------------------------------

/**
 * A hand cannot legitimately run longer than this.
 *
 * Every raise lifts the bet by at least a big blind (a shorter one is an all-in,
 * and a seat can only jam once), so a street holds at most `stack / bigBlind + n`
 * raises, and each of those puts the other `n - 1` seats back in exactly once.
 * Four streets of that is the ceiling. Exceeding it means the turn order is
 * cycling — as a hang that would be far harder to find than as a throw.
 */
function actionBound(table: Table): number {
  const n = table.seats.length;
  const deepest = Math.max(...table.seats.map((s) => s.stack + s.invested));
  return 4 * n * (Math.ceil(deepest / table.config.bigBlind) + n + 1);
}

/**
 * Play one complete hand, asking `decider` for every move. This is how tests
 * and offline scripts run thousands of hands; the UI drives the same lifecycle
 * one `applyAction` at a time.
 */
export function playHandHeadless(
  table: Table,
  decider: SyncBotDecider
): TableHandReport {
  startHand(table);

  const limit = actionBound(table);
  let steps = 0;
  while (table.status === "playing") {
    if (++steps > limit) {
      throw new Error(`hand #${table.handNumber} exceeded ${limit} actions`);
    }
    const seat = table.toAct;
    if (seat === null) throw new Error("hand is live but no seat is to act");
    const decision = decider(table, seat, table.config);
    table.decisions.push(decision);
    applyAction(table, seat, decision.action);
  }

  if (!table.lastReport) throw new Error("hand ended without a report");
  return table.lastReport;
}
