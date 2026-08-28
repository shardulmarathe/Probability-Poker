/**
 * Concept 7: equilibrium and exploitability.
 *
 * The only concept that never computes on mount. A river solve is hundreds of
 * milliseconds of synchronous CFR, so it runs on the button and nowhere else,
 * and `run` stays null until the reader asks — which is why selecting this tab
 * is instant even though the thing it demonstrates is the most expensive
 * computation in the product.
 *
 * The chart palette lives here rather than in `controls.tsx` because this is the
 * only concept that draws one.
 */

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  HandBucket,
  classifyAll,
  makeBoardContext,
} from "../../../poker/model/buckets";
import {
  COMBO_COUNT,
  emptyRange,
  normalizeRange,
  type Range,
} from "../../../poker/model/range";
import {
  Calc,
  CardRow,
  Group,
  Heading,
  HowCalculated,
  Lead,
  Stat,
  StatGrid,
  Well,
  Why,
} from "../../ui";
import { RunButton } from "../controls";
import { cardCodes, solveDemo, type SolveDemo } from "../engine";

const AXIS = "rgba(244,237,228,0.45)";
const GRID = "rgba(244,237,228,0.12)";
const tooltipStyle = {
  background: "rgba(6,15,10,0.95)",
  border: "1px solid rgba(201,162,39,0.4)",
  borderRadius: 8,
  color: "#f4ede4",
  fontSize: 12,
};

const SOLVE_BOARD = "Ks 9d 4c 7h 2s";
const CHECKPOINTS = [10, 25, 50, 100, 200, 400];

/**
 * Every combination on this board whose class falls in `[min, max]`.
 *
 * The two ranges below are defined this way rather than trimmed to a hand count,
 * because a trimmed uniform range is an arbitrary slice of the combo index, it
 * would solve just as fast and describe nothing. These are the hands a class
 * boundary actually names, and the counts they produce (~210 a side on this
 * board) are what the solve runs on.
 */
function classRange(board: number[], min: number, max: number): Range {
  const classes = classifyAll(makeBoardContext(board));
  const range = emptyRange();
  for (let c = 0; c < COMBO_COUNT; c++) {
    if (classes[c] >= min && classes[c] <= max) range[c] = 1;
  }
  return normalizeRange(range);
}

export function EquilibriumConcept() {
  const [run, setRun] = useState<SolveDemo | null>(null);
  const board = cardCodes(SOLVE_BOARD);

  const solve = () => {
    // Out of position: one pair, middle to over, the bluff-catchers. In
    // position: top pair or better, the range that would be betting.
    const oop = classRange(board, HandBucket.MidPair, HandBucket.Overpair);
    const ip = classRange(board, HandBucket.TopPair, HandBucket.Monster);
    setRun(
      solveDemo(board, oop, ip, CHECKPOINTS, { pot: 100, stack: 200, bigBlind: 2 })
    );
  };

  return (
    <Group
      id="equilibrium"
      title="Equilibrium and exploitability"
      lede="The strategy that cannot be beaten, and the number that proves it."
    >
      <Lead>
        Everything else on this page prices a decision against a <em>read</em>.
        An equilibrium asks the other question: what strategy could not be beaten
        by any opponent at all, including one who knew it in advance? In a
        two-player zero-sum game such a strategy exists, and playing it guarantees
        you cannot lose in the long run no matter who sits down.
      </Lead>

      <Heading>How it is found</Heading>
      <Lead>
        By regret. The solver plays the game against itself, and after every pass
        it asks, at each decision point and for each hand it might hold there: how
        much better off would I have been had I always taken this action instead?
        Actions that would have done better accumulate regret, and the next pass
        plays each action in proportion to its accumulated positive regret. The
        <em> average</em> of all those strategies — not the last one — converges to
        equilibrium. This one is Discounted CFR, which discounts early regret
        because the early passes were played against a worse opponent: itself, at
        the start.
      </Lead>

      <Heading>How you check it</Heading>
      <Lead>
        A broken solver still produces strategies that look like poker: it bets
        strong hands and folds weak ones, because the payoffs force that much.
        What it cannot do is drive exploitability down. Exploitability is what a
        perfect counter-strategy wins against the profile, computed exactly rather
        than by running a second solver, and it is zero only at equilibrium. Press
        the button and watch it fall:
      </Lead>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <RunButton onClick={solve} testId="solve-demo">
          {run ? "Solve it again" : "Solve a river spot"}
        </RunButton>
        <span className="text-xs text-ivory/45">
          A one-pair bluff-catching range out of position — middle pair through
          overpair — against a range of top pair or better in position. $100 pot,
          $200 behind, and the board below.
        </span>
      </div>
      <div className="mb-3">
        <CardRow label="Board" cards={board} />
      </div>

      {run && (
        <>
          <StatGrid columns={4}>
            <Stat
              label="Hands"
              value={`${run.hands[0]} × ${run.hands[1]}`}
              note={`${run.decisionNodes} decision nodes`}
            />
            <Stat
              label="Iterations"
              value={CHECKPOINTS[CHECKPOINTS.length - 1]}
              note="Discounted CFR"
            />
            <Stat
              label="Total time"
              value={`${run.totalMs.toFixed(0)} ms`}
              tone="gold"
              note="including every exploitability check"
            />
            <Stat
              label="Final exploitability"
              value={`${run.points[run.points.length - 1].mbb.toFixed(0)}`}
              note="mbb/h"
            />
          </StatGrid>

          <Well testId="exploit-chart">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={run.points.map((p) => ({
                  iterations: p.iterations,
                  mbb: +p.mbb.toFixed(1),
                }))}
                margin={{ top: 6, right: 10, bottom: 0, left: -10 }}
              >
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="iterations" stroke={AXIS} fontSize={10} />
                <YAxis stroke={AXIS} fontSize={10} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v) => [`${v} mbb/h`, "exploitability"]}
                />
                <Line
                  type="monotone"
                  dataKey="mbb"
                  stroke="#e2c563"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </Well>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            Exploitability in mbb/h — thousandths of a big blind per hand — at a
            big blind of ${run.bigBlind}. It fell by a factor of{" "}
            {(run.points[0].mbb / Math.max(1e-9, run.points[run.points.length - 1].mbb)).toFixed(0)}{" "}
            over these {CHECKPOINTS[CHECKPOINTS.length - 1]} iterations and would
            keep falling; the shape is the deliverable, because a solver that is
            not working produces a flat or wandering line no matter how sensible
            its strategies look.
          </p>
        </>
      )}

      <Calc>
        exploitability = ½ · [ BR(player 0) + BR(player 1) ]
        <div className="mt-2 text-ivory/60">
          BR is the best-response value: the most a perfect opponent can win from
          this strategy, per hand dealt. Zero exactly at equilibrium, and never
          negative in a two-player zero-sum game.
        </div>
      </Calc>

      <HowCalculated label="Why It Is Tested Against Toy Games">
        <Heading>Kuhn poker and push/fold charts</Heading>
        <Lead>
          The solver's tests do not check that it plays well — "plays well" is not
          a testable claim. They check it against Kuhn poker, a three-card game
          whose equilibrium has a known closed form, and against published Nash
          push/fold charts for short-stack heads-up play. Both are external
          answers this code cannot influence, so agreeing with them is evidence
          rather than self-congratulation.
        </Lead>
        <Heading>Why the river only</Heading>
        <Lead>
          A public tree with a few dozen nodes and a vector of hands at each is
          tractable in a browser; the whole game is not, and would need card
          abstraction and days of compute. The river is where the abstraction is
          least lossy — there are no cards to come, so a hand is exactly its
          showdown strength — which makes it the honest place to stop.
        </Lead>
        <Why>
          An equilibrium is not the best way to play any particular table: a read
          beats it against anyone exploitable, which is what the rest of this page
          is for. It is the floor — the strategy nobody can beat — and therefore
          the yardstick that says whether a clever line was clever or just lucky.
        </Why>
      </HowCalculated>
    </Group>
  );
}
