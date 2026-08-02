/**
 * Hand replay.
 *
 * Three things, in increasing order of how much they invent:
 *
 *   `replayHand`         reconstructs a recorded hand and proves it did, by
 *                        comparing the report it rebuilt against the recorded
 *                        one field by field. Invents nothing.
 *   `runCounterfactual`  changes one decision and lets the bots answer. The
 *                        cards are real; every response after the change is
 *                        `simulated`.
 *   `replayWithLineup`   deals the same cards to different archetypes. Only
 *                        the deal survives; the whole hand is `simulated`.
 *
 * All three are deterministic functions of the report and their options. The
 * seed a hand was dealt from is recoverable from the report alone (`seed.ts`),
 * so nothing here needs a session, a store, or a network.
 */

export {
  alternativesAt,
  decisionIndexes,
  runCounterfactual,
  toTableAction,
  type Alternative,
  type Counterfactual,
  type CounterfactualOutcome,
} from "./counterfactual";

export {
  frameOfAction,
  snapshot,
  type ReplayFrame,
  type ReplaySeatFrame,
} from "./frames";

export {
  replayWithLineup,
  type LineupOutcome,
  type LineupReplay,
  type SeatOutcome,
} from "./lineup";

export {
  compareReports,
  recordedAction,
  recoveredStacks,
  replayHand,
  type HandReplay,
  type ReplayFidelity,
} from "./reconstruct";

export { seedRecoveryHolds, sessionSeedForHand } from "./seed";

export {
  SIMULATION_SIMS,
  defaultDecider,
  type SimulationOptions,
} from "./simulate";

export {
  ASSUMED_DEPTH_BB,
  buildReplayTable,
  entryStacks,
  inferBlinds,
  replayBlocker,
  type ReplaySeatSetup,
  type ReplayTable,
  type ReplayTableOptions,
} from "./table";
