/**
 * The scripted opponent used to make the learning model visible in a replay.
 *
 * It lives in app code rather than in a test because this is the only way a
 * visitor can see the learning model do anything: the read takes 60 hands to
 * move, and nobody plays 60 hands of a portfolio demo.
 */

import { HandBucket, bucketOfCards } from "../model/buckets";
import { uncontestedEquity } from "../model/decider";
import type { BotDecision } from "../table/contract";
import { createTable, type Table } from "../table/engine";
import { legalActions } from "../table/rules";
import { toCall as toCallOf } from "../table/state";

/**
 * A scripted human seat with an obvious, exploitable leak: it bets and raises
 * exactly when it holds nothing, checks when it holds something, and never
 * folds. Every claim below is about whether the bots can come to see that.
 *
 * Never folding is what puts hands in front of a showdown, which is what makes
 * the observations attributed, the difference this whole file turns on.
 */
export function bluffer(table: Table, seat: number): BotDecision {
  const actions = legalActions(table, seat, table.config);
  const hole = table.seats[seat].hole;
  const bucket = bucketOfCards(hole[0], hole[1], table.board);
  const weak = bucket <= HandBucket.WeakDraw;

  const aggressive = actions.find((a) => a.type === "bet" || a.type === "raise");
  const check = actions.find((a) => a.type === "check");
  const call = actions.find((a) => a.type === "call");
  const action =
    (weak ? aggressive : undefined) ?? check ?? call ?? aggressive ?? actions[0];

  return {
    seat,
    street: table.street,
    action,
    potBefore: table.pot,
    toCall: toCallOf(table, seat),
    equity: uncontestedEquity(),
    evByAction: {},
    beliefs: {},
    profile: "professor",
  };
}

/** Seat 0 is the scripted human; the rest think for themselves. */
export function tableWithBluffer(seed: number): Table {
  return createTable({
    seatCount: 4,
    startingStack: 200,
    smallBlind: 5,
    bigBlind: 10,
    seed,
    seats: [
      { name: "You", kind: "human" },
      { name: "Bot 1", kind: "bot", profile: "tag" },
      { name: "Bot 2", kind: "bot", profile: "station" },
      { name: "Bot 3", kind: "bot", profile: "rock" },
    ],
  });
}
