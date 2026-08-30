/**
 * What this hand could still become, as a distribution rather than a number.
 *
 * Lifted out of `MathTab`'s "What This Hand Could Become" section unchanged. It
 * now sits under the Seats table on the Hand tab, beside the "Final hand"
 * column: that column reports the one category the deck actually produced, and
 * this is the distribution it was drawn from.
 */

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pct } from "../../../lib/format";
import type { TableHandReport } from "../../../poker/table/contract";
import { categoryRun, type CategoryRun } from "../../learn/engine";
import {
  Calc,
  EmptyPanel,
  Frac,
  Heading,
  LINE,
  Lead,
  RADIUS,
  Well,
  Why,
} from "../../ui";
import { reviewStreets } from "../derive";
import type { DerivationProps } from "./index";
import { AXIS, Caption, GRID, mainVillain, possessive, tooltipStyle } from "./shared";

export function MadeHandDistribution(props: DerivationProps) {
  return (
    <>
      <Caption>The shape behind the win rate</Caption>
      <CategoryShape {...props} />
    </>
  );
}

// ---------------------------------------------------------------------------

/** Trials per distribution run. Matches the budget `derive.headsUpEquity` uses,
 *  so the two panels' sampling error is the same size. */
const SHAPE_SIMS = 20000;

function CategoryShape({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const hero = report.seats.find((s) => s.seat === focus);
  const villain = mainVillain(report, focus);
  const streets = useMemo(
    () => reviewStreets(report).filter((s) => s.key !== "final"),
    [report]
  );
  const [pick, setPick] = useState<string>(streets[0]?.key ?? "preflop");
  const street = streets.find((s) => s.key === pick) ?? streets[0];

  const run: CategoryRun | null = useMemo(() => {
    if (!hero || !villain || !street) return null;
    return categoryRun(
      hero.hole,
      villain.hole,
      report.board.slice(0, street.boardLen),
      SHAPE_SIMS,
      // Fixed per (hand, street) so the same review always draws the same
      // histogram, and distinct across streets so the runs are independent.
      report.seed + street.boardLen
    );
  }, [hero, villain, street, report.board, report.seed]);

  if (!hero || hero.hole.length !== 2 || !villain || !run || !street) {
    return (
      <EmptyPanel title="No two hands to run out">
        A category distribution needs a holding and somebody to hold it against.
        This hand's record does not have both.
      </EmptyPanel>
    );
  }

  const data = run.shares
    .filter((s) => s.p > 0)
    .map((s) => ({ name: s.name, prob: +(s.p * 100).toFixed(2) }));
  const top = [...run.shares].sort((a, b) => b.p - a.p).slice(0, 3);

  return (
    <>
      <Lead>
        Given {possessive(seatName(focus))} two cards and the board as it stood,
        how often does each final five-card category turn up? Same run as the
        equity estimate, different thing recorded: the <em>category</em> of the
        best hand rather than whether it won. The run deals out of the deck{" "}
        {seatName(villain.seat)}'s cards left behind, which is the only way the
        opponent enters this chart at all, what a hand can <em>become</em>
        depends on the cards it can still see, not on what it is up against.
      </Lead>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {streets.map((s) => (
          <button
            key={s.key}
            onClick={() => setPick(s.key)}
            data-testid={`shape-${s.key}`}
            className={`min-h-[32px] border px-2.5 py-1 font-display text-[0.65rem] tracking-wide transition ${RADIUS.control}`}
            style={{
              borderColor:
                s.key === street.key ? "rgba(201,162,39,0.6)" : LINE.quiet,
              background:
                s.key === street.key ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
              color: s.key === street.key ? "#e2c563" : "rgba(244,237,228,0.55)",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <Well testId="shape-chart">
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 30)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 12, bottom: 0, left: 4 }}
          >
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              stroke={AXIS}
              fontSize={10}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              type="category"
              dataKey="name"
              stroke={AXIS}
              fontSize={10}
              width={78}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              formatter={(v) => [`${v}%`, "of runouts"]}
            />
            <Bar dataKey="prob" radius={[0, 4, 4, 0]} fill="#e2c563" />
          </BarChart>
        </ResponsiveContainer>
      </Well>

      <Heading>How it is computed</Heading>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(category) =
          <Frac
            n={<>runouts ending in that category</>}
            d={
              <>
                {run.settled ? "1 settled board" : `${SHAPE_SIMS.toLocaleString()} simulations`}
              </>
            }
          />
        </div>
        <div className="mt-2 text-ivory/60">
          {run.settled ? (
            <>
              The board was already complete here, so nothing was sampled: there
              is one runout, the hand is what it is, and the distribution is a
              single bar at 100%.
            </>
          ) : (
            <>
              {run.unknown} board card{run.unknown === 1 ? "" : "s"} still to
              come and {run.runouts.toLocaleString()} distinct runouts the deck
              allowed. The estimate drew {SHAPE_SIMS.toLocaleString()} of them at
              random, with repeats, so where the deck allows fewer than that,
              every runout is hit many times and the shape is exact to within
              rounding.
            </>
          )}
        </div>
      </Calc>

      <Heading>Most likely results</Heading>
      <ul className="space-y-1 text-sm text-ivory/75">
        {top.map((t) => (
          <li key={t.name} className="flex justify-between gap-3">
            <span>{t.name}</span>
            <span className="font-mono text-gold-soft">
              {pct(t.p)}
              {!run.settled && (
                <span className="text-ivory/40"> · {t.hits.toLocaleString()} sims</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <Why>
        Two hands can share a win rate and be nothing alike. One that gets there
        by making flushes plays differently from one that gets there by making
        top pair, same average, different shape, different bets. The win
        probability is one number off this whole distribution; the distribution
        is what a strategy is built on.
      </Why>
    </>
  );
}
