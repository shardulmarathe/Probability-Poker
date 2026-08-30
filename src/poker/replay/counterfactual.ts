/**
 * "What if I had done X instead?"
 *
 * A counterfactual rewinds a recorded hand to one decision, substitutes a
 * different move, and lets the hand run on. The cards are the real cards, the
 * seed is the same, so the deck is the same and nothing is being invented about
 * what anybody held.
 *
 * Everything after the substitution is invented, and that is the point this
 * module refuses to be quiet about. Opponents cannot be replayed past a change:
 * the moves they made were answers to a question that no longer got asked, and
 * a raise they folded to was never offered. So their responses are re-derived
 * by the bots, right now, at whatever the current model thinks. That is a
 * plausible continuation, not the continuation.
 *
 * Hence `simulated: true` on the result, a field, not a comment, so it cannot
 * be read past by accident, and `rederived`, the count of moves that came out
 * of the model rather than out of the record. A counterfactual presented as
 * what would have happened is worse than no counterfactual at all: it teaches
 * the player to trust a number that has a bot's whole strategy baked into it.
 *
 * The seat being asked about is played by a bot too, after the substitution.
 * There is no alternative, the recorded line is a response to a hand that no
 * longer exists, and it is why the honest reading of `deltaNet` is "this line
 * played out this way once", not "this line is worth this much".
 */

import type { ActionType } from "../../types";
import type { ActionRecord, TableHandReport } from "../table/contract";
import { applyAction, startHand, type Table } from "../table/engine";
import { legalActions, sizingLadder, type TableConfig } from "../table/rules";
import { snapshot, type ReplayFrame } from "./frames";
import {
  defaultDecider,
  driveWithBots,
  type SimulationOptions,
} from "./simulate";
import { recordedAction, replayHand } from "./reconstruct";
import { buildReplayTable } from "./table";

/** One move that was available at a decision point. */
export interface Alternative {
  type: ActionType;
  /** Chips this line would add now. */
  cost: number;
  label: string;
  /** True for the line the seat actually took. */
  actual: boolean;
}

export interface Counterfactual {
  /**
   * Always true, and never omitted. Everything after `index` was re-derived by
   * the bots, not observed, see the module comment.
   */
  simulated: true;
  /** Index into `report.actions` of the decision that was changed. */
  index: number;
  seat: number;
  /** The move actually made. */
  actual: ActionRecord;
  /** The move substituted for it. */
  substitute: Alternative;
  /** Frames for the whole simulated hand, deal to settle. */
  frames: ReplayFrame[];
  /** The simulated hand's report. Not a record of anything that happened. */
  report: TableHandReport;
  /** Moves after the substitution that came from the model, not the record. */
  rederived: number;
  /** The seat's net in the hand as it was actually played. */
  actualNet: number;
  /** The seat's net in this one simulation. */
  simulatedNet: number;
  /** `simulatedNet - actualNet`. One sample, not an expectation. */
  deltaNet: number;
}

export type CounterfactualOutcome =
  | ({ ok: true } & Counterfactual)
  | { ok: false; reason: string };

/**
 * A table wound forward to just before action `index`, with the entry stacks a
 * faithful reconstruction settled on.
 *
 * Refuses to rewind a hand that does not reconstruct: a counterfactual branched
 * off a state that is already not the recorded one compares a simulation
 * against a hand that never happened.
 */
function rewind(
  report: TableHandReport,
  index: number,
  options: SimulationOptions
): { table: Table; config: TableConfig; frames: ReplayFrame[] } | string {
  if (!Number.isInteger(index) || index < 0 || index >= report.actions.length) {
    return `no action at index ${index}`;
  }

  const base = replayHand(report, options);
  if (!base.fidelity.ok) {
    return `the recorded hand does not reconstruct: ${base.fidelity.mismatches[0]}`;
  }

  const { table, config } = buildReplayTable(report, {
    ...options,
    stacks: base.stacks,
  });
  startHand(table);
  const frames: ReplayFrame[] = [snapshot(table, 0)];

  for (let i = 0; i < index; i++) {
    const record = report.actions[i];
    const action = recordedAction(table, record, config);
    if (table.status !== "playing" || table.toAct !== record.seat || !action) {
      return `could not wind forward to action ${index}`;
    }
    applyAction(table, record.seat, action);
    frames.push(snapshot(table, frames.length));
  }
  return { table, config, frames };
}

/** Does this legal action match what the record says was played? */
function isActual(record: ActionRecord, type: ActionType, cost: number): boolean {
  return record.action === type && record.cost === cost;
}

const SIZE_VERB: Record<string, string> = { bet: "Bet", raise: "Raise" };

/**
 * Every move the seat could have made at `index`, with the one it made marked.
 *
 * Bets and raises are expanded into the same pot-fraction ladder the table
 * offers a human, plus the minimum and the jam, so the sizes on offer are ones
 * the seat was actually shown.
 *
 * The size it chose is then added whatever it was. No-Limit sizing is a
 * continuous range and the ladder is only the presets, so a seat that dragged
 * the slider to $63 has taken a line that no rung names, and a list of
 * alternatives that cannot show you what you did is not a list of alternatives.
 * Exactly one entry always comes back marked `actual`.
 */
export function alternativesAt(
  report: TableHandReport,
  index: number,
  options: SimulationOptions = {}
): Alternative[] {
  const wound = rewind(report, index, options);
  if (typeof wound === "string") return [];

  const { table, config } = wound;
  const record = report.actions[index];
  const legal = legalActions(table, record.seat, config);
  const committed = table.seats[record.seat].streetCommit;

  const passive: Alternative[] = [];
  const sized = new Map<number, string>();

  for (const action of legal) {
    if (action.type === "bet" || action.type === "raise") {
      // The minimum, which the pot-fraction ladder does not always contain.
      sized.set(action.cost, action.label);
      continue;
    }
    passive.push({
      type: action.type,
      cost: action.cost,
      label: action.label,
      actual: isActual(record, action.type, action.cost),
    });
  }

  const aggressive = legal.find((a) => a.type === "bet" || a.type === "raise");
  if (aggressive) {
    const verb = SIZE_VERB[aggressive.type] ?? "Raise";
    for (const size of sizingLadder(table, record.seat, config)) {
      if (sized.has(size.cost)) continue;
      sized.set(
        size.cost,
        size.label === "All-in" ? `All-in $${size.cost}` : `${verb} ${size.label}`
      );
    }
    // Whatever was actually chosen, rung or not.
    if (
      (record.action === "bet" || record.action === "raise") &&
      record.cost >= (aggressive.min ?? aggressive.cost) &&
      record.cost <= (aggressive.max ?? aggressive.cost) &&
      !sized.has(record.cost)
    ) {
      sized.set(
        record.cost,
        record.action === "bet"
          ? `Bet $${record.cost}`
          : `Raise to $${committed + record.cost}`
      );
    }
  }

  const sizes: Alternative[] = [...sized.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cost, label]) => ({
      type: aggressive?.type ?? ("raise" as ActionType),
      cost,
      label,
      actual: isActual(record, aggressive?.type ?? "raise", cost),
    }));

  return [...passive, ...sizes];
}

/**
 * Rewind to `index`, play `choice` instead, and let the bots finish the hand.
 *
 * Returns a reason rather than throwing on anything a UI can hand it: an index
 * off the end, a size that is not legal, a hand that does not reconstruct.
 */
export function runCounterfactual(
  report: TableHandReport,
  index: number,
  choice: { type: ActionType; cost: number },
  options: SimulationOptions = {}
): CounterfactualOutcome {
  const wound = rewind(report, index, options);
  if (typeof wound === "string") return { ok: false, reason: wound };

  const { table, config, frames } = wound;
  const record = report.actions[index];
  const seat = record.seat;

  if (table.status !== "playing" || table.toAct !== seat) {
    return { ok: false, reason: `seat ${seat} is not on the clock at action ${index}` };
  }

  const substitute = recordedAction(
    table,
    { ...record, action: choice.type, cost: choice.cost },
    config
  );
  if (!substitute) {
    return {
      ok: false,
      reason: `${choice.type} of ${choice.cost} is not legal for seat ${seat} here`,
    };
  }

  const label =
    alternativesAt(report, index, options).find(
      (a) => a.type === choice.type && a.cost === choice.cost
    )?.label ?? substitute.label;

  applyAction(table, seat, substitute);
  frames.push(snapshot(table, frames.length));

  const { rederived, reason } = driveWithBots(
    table,
    config,
    options.decide ?? defaultDecider(options),
    frames
  );
  if (reason) return { ok: false, reason };

  const simulatedReport = table.lastReport;
  if (!simulatedReport) return { ok: false, reason: "the simulated hand never settled" };

  const actualNet = report.seats.find((s) => s.seat === seat)?.net ?? 0;
  const simulatedNet = simulatedReport.seats.find((s) => s.seat === seat)?.net ?? 0;

  return {
    ok: true,
    simulated: true,
    index,
    seat,
    actual: { ...record },
    substitute: {
      type: choice.type,
      cost: choice.cost,
      label,
      actual: isActual(record, choice.type, choice.cost),
    },
    frames,
    report: simulatedReport,
    rederived,
    actualNet,
    simulatedNet,
    deltaNet: simulatedNet - actualNet,
  };
}

/** Indexes of the actions a given seat took, for a UI's decision picker. */
export function decisionIndexes(report: TableHandReport, seat: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < report.actions.length; i++) {
    if (report.actions[i].seat === seat) out.push(i);
  }
  return out;
}

/** A bare-bones `TableAction` for a chosen alternative, for callers that want one. */
export function toTableAction(alternative: Alternative): {
  type: ActionType;
  cost: number;
} {
  return { type: alternative.type, cost: alternative.cost };
}
