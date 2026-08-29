/**
 * Sixty hands against a bluffer, run in a few seconds.
 *
 * This exists because the most interesting claim this product makes is also the
 * one nobody has ever seen. The bots do not merely play well, they learn the
 * person opposite them: watch a seat bluff often enough and `P(bet | air)` in
 * the likelihood model climbs from the shared poker prior towards what that
 * seat actually does, and the read the table holds on them shifts onto air.
 * `lib/opponentMemory.test.ts` measures exactly that, and the README leads with
 * the numbers.
 *
 * A visitor will never see it. The model needs on the order of sixty hands
 * before it can say anything a confidence interval would defend, and a hand at
 * the live table takes several seconds because the bots really are running
 * Monte Carlo. That is eight minutes of grinding before the feature switches
 * on, in a product most people open once. The profile page is honest about the
 * consequence, it tells a new reader that twenty-four hands is under the thirty
 * a style label needs, which is true and also an admission that the page cannot
 * do its job yet.
 *
 * So the same experiment runs here, headless, at a simulation count chosen for
 * speed rather than for pricing a real decision, and drops the reader into a
 * populated profile with the before-and-after printed. Nothing is faked: it is
 * the production engine, the production likelihood model and the production
 * `recordReport`, playing the same scripted opponent the test plays.
 */

import {
  createLikelihoodModel,
  likelihoodOf,
  type LikelihoodModel,
} from "../model/likelihood";
import { tableDecider } from "../model/decider";
import { playHandHeadless, type Table } from "../table/engine";
import type { TableHandReport } from "../table/contract";
import { HandBucket } from "../model/buckets";
import {
  emptyMemory,
  memoryStats,
  recordReport,
  type MemoryStats,
} from "../../lib/opponentMemory";
import { bluffer, tableWithBluffer } from "./bluffer";

/** The seat the scripted bluffer occupies, matching `tableWithBluffer`. */
export const DEMO_HERO_SEAT = 0;

/** Hands played. Sixty is where the measured experiment lands its effect. */
export const DEMO_HANDS = 60;

/**
 * Simulations per bot decision.
 *
 * Far below the table's own budget, and deliberately. This run exists to move a
 * likelihood model, which is driven by the *actions* the bluffer takes and the
 * cards it shows down, not by how finely the bots priced their replies. The
 * measured experiment in `opponentMemory.test.ts` uses the same 200, and that
 * is the reason to leave this number alone even though lowering it is faster.
 * Measured over the same sixty hands: 200 sims lands P(bet | air) at 0.553,
 * which is the figure the README quotes; 96 lands 0.605 and 48 lands 0.610,
 * because weaker replies let the bluffer away with more and the model sees a
 * louder signal. A demo that beats the documented claim is not a better demo,
 * it is a different experiment wearing the same headline.
 */
const DEMO_SIMS = 200;

/**
 * The node the read is quoted at: a flop bet from the button into an unopened
 * pot. One cell has to be chosen to print a number, and this is the one the
 * bluffer visits most, so it is where its behaviour shows up soonest.
 */
const QUOTED = { street: "flop", position: "BTN", facing: "unopened" } as const;

function betAir(model: LikelihoodModel): number {
  return likelihoodOf(
    model,
    "bet",
    HandBucket.Air,
    QUOTED.street,
    QUOTED.position,
    QUOTED.facing
  );
}

export interface DemoResult {
  reports: TableHandReport[];
  heroSeat: number;
  /** `P(bet | air)` under the shared prior, before this session was watched. */
  before: number;
  /** The same cell after sixty hands of watching the bluffer. */
  after: number;
  stats: MemoryStats;
}

/**
 * Play the session, yielding to the browser between hands.
 *
 * `await` on a macrotask every few hands rather than running the loop straight
 * through: sixty hands of real deciding is seconds of work, and seconds of
 * uninterrupted main thread is a frozen tab with no progress bar, which is the
 * exact failure this product has already been bitten by once in its equity
 * pool. `onProgress` is what lets the caller draw a bar at all.
 */
export async function runBlufferDemo(
  onProgress?: (played: number, total: number) => void,
  hands: number = DEMO_HANDS
): Promise<DemoResult> {
  const decide = tableDecider({ simulations: DEMO_SIMS });
  const table: Table = tableWithBluffer(0xb1bff);
  const memory = emptyMemory();
  const before = betAir(createLikelihoodModel("poker"));
  const reports: TableHandReport[] = [];

  for (let played = 0; played < hands; played++) {
    const hand = playHandHeadless(table, (state, seat, config) =>
      seat === DEMO_HERO_SEAT
        ? bluffer(state as Table, seat)
        : decide(state, seat, config)
    );
    // Recorded exactly the way the live table records a finished hand, so the
    // model this produces is the model a real session would have produced.
    recordReport(memory, hand, DEMO_HERO_SEAT);
    reports.push(hand);

    if (played % 4 === 3 || played === hands - 1) {
      onProgress?.(played + 1, hands);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    reports,
    heroSeat: DEMO_HERO_SEAT,
    before,
    after: betAir(memory.model),
    stats: memoryStats(memory),
  };
}
