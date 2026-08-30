/**
 * The same hand, dealt to a different table.
 *
 * A seed fixes the deal and nothing else, so re-running a hand with different
 * archetypes in the seats holds the cards constant and varies the opposition -
 * which is the only way to separate the two things a player usually credits to
 * one. A pot lost with the second-best hand was lost to the deck. A pot lost
 * because three maniacs would not fold is a different lesson, and the same hand
 * against three nits shows which one it was.
 *
 * Every move here is re-derived. Not one of the recorded actions is replayed -
 * they were answers to a different table and would mostly not even be legal -
 * so the whole hand carries `simulated: true`, including the seat the player
 * occupied, which a bot now plays. What is not simulated is the deal, and
 * `sameCards` proves it hand by hand rather than asserting it in a comment.
 */

import type { TableHandReport } from "../table/contract";
import { startHand } from "../table/engine";
import { snapshot, type ReplayFrame } from "./frames";
import { replayHand } from "./reconstruct";
import { defaultDecider, driveWithBots, type SimulationOptions } from "./simulate";
import { buildReplayTable } from "./table";

export interface SeatOutcome {
  seat: number;
  /** Archetype that played the seat in the simulation. */
  profile: string;
  /** Net in the hand as it was actually played. */
  actualNet: number;
  /** Net in this one simulation. */
  simulatedNet: number;
  delta: number;
}

export interface LineupReplay {
  /** Always true. Every move in this hand came from the model. */
  simulated: true;
  profiles: string[];
  /** The simulated hand's report. Not a record of anything that happened. */
  report: TableHandReport;
  frames: ReplayFrame[];
  /**
   * True when every seat was dealt exactly the cards it held in the real hand.
   * The claim the whole comparison rests on, checked rather than assumed.
   */
  sameCards: boolean;
  /** Moves the bots supplied, always the whole hand. */
  rederived: number;
  bySeat: SeatOutcome[];
}

export type LineupOutcome =
  | ({ ok: true } & LineupReplay)
  | { ok: false; reason: string };

/**
 * Deal this hand again to `profiles` and play it out.
 *
 * `profiles[i]` is the archetype for seat `i`; an unknown or missing id falls
 * through to the pure-EV baseline, which is `profileFor`'s own default and the
 * only neutral answer.
 */
export function replayWithLineup(
  report: TableHandReport,
  profiles: string[],
  options: SimulationOptions = {}
): LineupOutcome {
  const base = replayHand(report, options);
  if (!base.fidelity.ok) {
    return {
      ok: false,
      reason: `the recorded hand does not reconstruct: ${base.fidelity.mismatches[0]}`,
    };
  }

  const seated = Array.from(
    { length: report.seatCount },
    (_, i) => profiles[i] ?? "professor"
  );

  const { table, config } = buildReplayTable(report, {
    ...options,
    stacks: base.stacks,
    seats: seated.map((profile, i) => ({
      name: options.seats?.[i]?.name ?? `Seat ${i + 1}`,
      kind: "bot" as const,
      profile,
    })),
  });

  startHand(table);
  const frames: ReplayFrame[] = [snapshot(table, 0)];
  const { rederived, reason } = driveWithBots(
    table,
    config,
    options.decide ?? defaultDecider(options),
    frames
  );
  if (reason) return { ok: false, reason };

  const simulated = table.lastReport;
  if (!simulated) return { ok: false, reason: "the simulated hand never settled" };

  const sameCards = report.seats.every((want) => {
    const got = simulated.seats.find((s) => s.seat === want.seat);
    return (
      !!got &&
      got.hole.length === want.hole.length &&
      got.hole.every((code, i) => code === want.hole[i])
    );
  });

  const bySeat: SeatOutcome[] = report.seats.map((want) => {
    const got = simulated.seats.find((s) => s.seat === want.seat);
    const simulatedNet = got?.net ?? 0;
    return {
      seat: want.seat,
      profile: seated[want.seat],
      actualNet: want.net,
      simulatedNet,
      delta: simulatedNet - want.net,
    };
  });

  return {
    ok: true,
    simulated: true,
    profiles: seated,
    report: simulated,
    frames,
    sameCards,
    rederived,
    bySeat,
  };
}
