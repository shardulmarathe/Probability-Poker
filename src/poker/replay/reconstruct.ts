/**
 * Replaying a recorded hand through the real engine.
 *
 * Every hand is a deterministic function of its seed, so a replay does not need
 * to store any state at all: it rebuilds the table the hand was played on, and
 * feeds the recorded actions back to `applyAction` one at a time.
 *
 * The guarantee is `fidelity`. Reconstruction is only worth anything if it
 * produces the same hand, so the replay finishes by comparing the report the
 * engine just built against the one it was given, board, hole cards, side-pot
 * layout, every seat's net, and each re-derived action record. Without that
 * check a replay is a plausible story about a hand rather than the hand, and it
 * would keep looking plausible after the engine changed underneath it.
 *
 * `decisions` is the one recorded field deliberately not compared: it holds the
 * bots' Monte Carlo audit trail, which a replay does not re-run because the
 * moves are already known. Everything a chip touched is compared.
 */

import { decodeCard } from "../core/card";
import type { ActionRecord, TableHandReport } from "../table/contract";
import { applyAction, startHand, type Table } from "../table/engine";
import { legalActions, type TableAction, type TableConfig } from "../table/rules";
import { snapshot, type ReplayFrame } from "./frames";
import { seedRecoveryHolds } from "./seed";
import {
  buildReplayTable,
  replayBlocker,
  type ReplayTableOptions,
} from "./table";

export interface ReplayFidelity {
  /** True when the reconstruction reproduced the report exactly. */
  ok: boolean;
  /** One line per field that differs. Empty when `ok`. */
  mismatches: string[];
  /** Recorded actions the engine accepted before anything went wrong. */
  actionsApplied: number;
  actionsRecorded: number;
}

export interface HandReplay {
  source: TableHandReport;
  /** What the engine produced this time, or null if it never settled. */
  replayed: TableHandReport | null;
  fidelity: ReplayFidelity;
  /** `actions.length + 1` frames when faithful: the deal, then each action. */
  frames: ReplayFrame[];
  config: TableConfig;
  stacks: number[];
  sessionSeed: number;
}

/**
 * Turn a recorded action back into a legal one for the live table.
 *
 * Not just `{ type, cost }`: `applyAction` re-checks every move against what
 * `legalActions` currently offers, and a bet or raise is checked against its
 * `[min, max]` range rather than for equality. So the offered action is taken
 * and its cost substituted, which is exactly what the UI's slider does.
 *
 * Returns null when the recorded move is not on offer at all, that is a real
 * divergence and the caller reports it rather than forcing the move through.
 */
export function recordedAction(
  table: Table,
  record: ActionRecord,
  config: TableConfig
): TableAction | null {
  const offered = legalActions(table, record.seat, config).find(
    (a) => a.type === record.action
  );
  if (!offered) return null;

  if (offered.min === undefined || offered.max === undefined) {
    return offered.cost === record.cost ? offered : null;
  }
  if (record.cost < offered.min || record.cost > offered.max) return null;
  return {
    ...offered,
    cost: record.cost,
    amount: table.seats[record.seat].streetCommit + record.cost,
  };
}

const cards = (codes: number[]): string =>
  codes.map((c) => decodeCard(c).id).join(" ") || "-";

const nums = (values: number[]): string => `[${values.join(", ")}]`;

/**
 * Every way two reports of the same hand differ, as readable lines.
 *
 * Ordered from the most structural difference to the least, because the first
 * line is the one that explains the rest: a board that diverged makes every
 * downstream mismatch a consequence rather than a separate fault.
 */
export function compareReports(
  expected: TableHandReport,
  actual: TableHandReport
): string[] {
  const out: string[] = [];
  const note = (what: string, a: unknown, b: unknown) => {
    if (a !== b) out.push(`${what}: expected ${String(a)}, replayed ${String(b)}`);
  };

  note("hand number", expected.handNumber, actual.handNumber);
  note("deal seed", expected.seed >>> 0, actual.seed >>> 0);
  note("button", expected.button, actual.button);
  note("seat count", expected.seatCount, actual.seatCount);

  if (cards(expected.board) !== cards(actual.board)) {
    out.push(`board: expected ${cards(expected.board)}, replayed ${cards(actual.board)}`);
  }

  for (const want of expected.seats) {
    const got = actual.seats.find((s) => s.seat === want.seat);
    if (!got) {
      out.push(`seat ${want.seat}: missing from the replay`);
      continue;
    }
    if (cards(want.hole) !== cards(got.hole)) {
      out.push(
        `seat ${want.seat} hole: expected ${cards(want.hole)}, replayed ${cards(got.hole)}`
      );
    }
    note(`seat ${want.seat} invested`, want.invested, got.invested);
    note(`seat ${want.seat} won`, want.won, got.won);
    note(`seat ${want.seat} net`, want.net, got.net);
    note(`seat ${want.seat} status`, want.status, got.status);
    note(`seat ${want.seat} hand`, want.final?.score ?? null, got.final?.score ?? null);
  }

  if (expected.pots.length !== actual.pots.length) {
    out.push(
      `pot layers: expected ${expected.pots.length}, replayed ${actual.pots.length}`
    );
  }
  const layers = Math.min(expected.pots.length, actual.pots.length);
  for (let i = 0; i < layers; i++) {
    const want = expected.pots[i];
    const got = actual.pots[i];
    note(`pot ${i} amount`, want.amount, got.amount);
    if (nums(want.eligible) !== nums(got.eligible)) {
      out.push(`pot ${i} eligible: expected ${nums(want.eligible)}, replayed ${nums(got.eligible)}`);
    }
    if (nums(want.winners) !== nums(got.winners)) {
      out.push(`pot ${i} winners: expected ${nums(want.winners)}, replayed ${nums(got.winners)}`);
    }
  }

  if (expected.actions.length !== actual.actions.length) {
    out.push(
      `actions: expected ${expected.actions.length}, replayed ${actual.actions.length}`
    );
  }
  const steps = Math.min(expected.actions.length, actual.actions.length);
  for (let i = 0; i < steps; i++) {
    const want = expected.actions[i];
    const got = actual.actions[i];
    note(`action ${i} seat`, want.seat, got.seat);
    note(`action ${i} street`, want.street, got.street);
    note(`action ${i} type`, want.action, got.action);
    note(`action ${i} cost`, want.cost, got.cost);
    note(`action ${i} pot before`, want.potBefore, got.potBefore);
    note(`action ${i} to call`, want.toCall, got.toCall);
  }

  note("end street", expected.endStreet, actual.endStreet);
  note("showdown", expected.wentToShowdown, actual.wentToShowdown);
  return out;
}

interface Pass {
  table: Table;
  frames: ReplayFrame[];
  applied: number;
  mismatches: string[];
  replayed: TableHandReport | null;
}

/** One reconstruction attempt at a fixed set of entry stacks. */
function runPass(
  report: TableHandReport,
  options: ReplayTableOptions,
  stacks: number[]
): Pass {
  const { table, config, handNumber } = buildReplayTable(report, {
    ...options,
    stacks,
  });
  const mismatches: string[] = [];

  // Cheap, and it localises the one failure that would otherwise present as an
  // entirely different hand with no explanation.
  if (!seedRecoveryHolds(report.seed, handNumber)) {
    mismatches.push(`seed recovery failed for hand ${handNumber}`);
  }

  startHand(table);
  const frames: ReplayFrame[] = [snapshot(table, 0)];

  let applied = 0;
  for (const record of report.actions) {
    if (table.status !== "playing") {
      mismatches.push(
        `hand settled after ${applied} of ${report.actions.length} recorded actions`
      );
      break;
    }
    if (table.toAct !== record.seat) {
      mismatches.push(
        `action ${applied}: recorded seat ${record.seat}, but seat ${String(table.toAct)} is on the clock`
      );
      break;
    }
    const action = recordedAction(table, record, config);
    if (!action) {
      mismatches.push(
        `action ${applied}: ${record.action} of ${record.cost} by seat ${record.seat} is not legal in the rebuilt hand`
      );
      break;
    }
    applyAction(table, record.seat, action);
    applied += 1;
    frames.push(snapshot(table, frames.length));
  }

  const replayed = table.lastReport;
  if (!replayed) mismatches.push("the rebuilt hand never settled");
  else mismatches.push(...compareReports(report, replayed));

  return { table, frames, applied, mismatches, replayed };
}

/**
 * Entry stacks tightened by what the record already pins down.
 *
 * `ActionRecord.toCall` is what the seat owed, clamped to what it had, so a
 * seat that folded facing more than its stack recorded its exact remaining
 * chips without meaning to. Adding back what it had already invested recovers
 * the stack it sat down with, and only for the seats where `entryStacks` had to
 * guess: a seat that went all-in is already pinned, and a seat that called or
 * raised was never clamped, because both need chips left over to be legal.
 *
 * This is a second pass rather than an up-front derivation because the invested
 * total at the moment of the fold is not in the record either. It comes out of
 * a reconstruction, and one reconstruction at a too-generous stack gets it: the
 * clamp affects the annotation, never the chips, so everything up to the fold
 * is already correct.
 */
function refineStacks(
  report: TableHandReport,
  pass: Pass,
  stacks: number[]
): number[] | null {
  const replayed = pass.table.actions;
  const next = [...stacks];
  let changed = false;

  const steps = Math.min(report.actions.length, replayed.length, pass.applied);
  for (let i = 0; i < steps; i++) {
    const want = report.actions[i];
    const got = replayed[i];
    if (want.seat !== got.seat || want.toCall === got.toCall) continue;
    if (report.seats.find((s) => s.seat === want.seat)?.status === "allin") continue;

    const investedBefore = pass.frames[i]?.seats[want.seat]?.invested ?? 0;
    const exact = investedBefore + want.toCall;
    if (exact > 0 && exact !== next[want.seat]) {
      next[want.seat] = exact;
      changed = true;
    }
  }
  return changed ? next : null;
}

/**
 * Passes allowed. One refinement is enough in every case the fixtures produce -
 * a seat folds once, so it can pin its own stack at most once, and the second
 * exists only so a report that somehow disagrees with itself terminates.
 */
const MAX_PASSES = 3;

/**
 * Rebuild a recorded hand, action by action, and check it came out the same.
 *
 * Never throws on a bad report: an unreplayable one comes back with `ok` false
 * and the reason, because these arrive from storage and a review page that
 * white-screens on one corrupt hand is worse than one that says so.
 */
export function replayHand(
  report: TableHandReport,
  options: ReplayTableOptions = {}
): HandReplay {
  const blocker = replayBlocker(report);
  if (blocker) {
    return {
      source: report,
      replayed: null,
      fidelity: {
        ok: false,
        mismatches: [`cannot replay: ${blocker}`],
        actionsApplied: 0,
        actionsRecorded: Array.isArray(report?.actions) ? report.actions.length : 0,
      },
      frames: [],
      config: { smallBlind: 0, bigBlind: 0 },
      stacks: [],
      sessionSeed: 0,
    };
  }

  const built = buildReplayTable(report, options);
  let stacks = built.stacks;
  let pass = runPass(report, options, stacks);

  for (let attempt = 1; attempt < MAX_PASSES && pass.mismatches.length > 0; attempt++) {
    const refined = refineStacks(report, pass, stacks);
    if (!refined) break;
    stacks = refined;
    pass = runPass(report, options, stacks);
  }

  return {
    source: report,
    replayed: pass.replayed,
    fidelity: {
      ok: pass.mismatches.length === 0,
      mismatches: pass.mismatches,
      actionsApplied: pass.applied,
      actionsRecorded: report.actions.length,
    },
    frames: pass.frames,
    config: built.config,
    stacks,
    sessionSeed: built.sessionSeed,
  };
}

/** The entry stacks a faithful replay settled on. Useful to simulations. */
export function recoveredStacks(replay: HandReplay): number[] {
  return replay.stacks;
}
