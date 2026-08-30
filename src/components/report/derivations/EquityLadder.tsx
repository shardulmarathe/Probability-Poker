/**
 * The equity, street by street, as the deck stopped being a secret.
 *
 * Lifted out of `MathTab`'s "Equity As Information Arrives" section unchanged.
 * Its home is now the head-to-head panel on the Hand tab, which shows the same
 * matchups one street at a time; this is those same numbers drawn as a line, so
 * the two belong on one screen rather than four clicks apart.
 */

import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pct } from "../../../lib/format";
import { hashSeed } from "../../../poker/core/rng";
import type { TableHandReport } from "../../../poker/table/contract";
import type { Street } from "../../../types";
import {
  EmptyPanel,
  Heading,
  HowCalculated,
  LINE,
  Lead,
  Scroller,
  Well,
  Why,
} from "../../ui";
import { aliveAfter, headsUpEquity, reviewStreets } from "../derive";
import type { DerivationProps } from "./index";
import { AXIS, Caption, GRID, SERIES, possessive, subject, tooltipStyle } from "./shared";

export function EquityLadder(props: DerivationProps) {
  return (
    <>
      <Caption>Five unknown cards, then two, then one, then none</Caption>
      <Ladder {...props} />
    </>
  );
}

// ---------------------------------------------------------------------------

/** C(n, k), small n only, used for runout counts. */
function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}

interface LadderRow {
  street: Street;
  label: string;
  boardLen: number;
  vs: { seat: number; equity: number; exact: boolean }[];
  /** The seat's own recorded equity against the field, when the trail survived. */
  field: number | null;
}

const BETTING_STREETS: Street[] = ["preflop", "flop", "turn", "river"];

function streetIndexOf(street: Street): number {
  return street === "showdown" ? 3 : BETTING_STREETS.indexOf(street);
}

/**
 * The reviewed seat's equity against each opponent, street by street.
 *
 * Built from the action record and the cards, never from `decisions`: who
 * appears is "still contesting the pot entering this street", which is a fact
 * about the hand rather than about which seats happened to record a Monte
 * Carlo. That matters because a hand read back from the archive has no
 * decisions at all, and the story of the equity moving is exactly the part of
 * the review that should survive a reload.
 *
 * The numbers are `derive.headsUpEquity` under the same per-(hand, street,
 * matchup) seed the Hand tab uses, so the two panels cannot disagree.
 */
function ladderRows(report: TableHandReport, focus: number): LadderRow[] {
  const mine = report.seats.find((s) => s.seat === focus)?.hole ?? [];
  if (mine.length !== 2) return [];
  const hole = new Map(report.seats.map((s) => [s.seat, s.hole]));
  const rows: LadderRow[] = [];

  for (const street of reviewStreets(report)) {
    if (street.key === "final") continue;
    const live = aliveAfter(report, street.actionsUpTo);
    if (!live.includes(focus)) break;
    const board = report.board.slice(0, street.boardLen);

    const vs: LadderRow["vs"] = [];
    for (const seat of live) {
      if (seat === focus) continue;
      const theirs = hole.get(seat);
      if (!theirs || theirs.length !== 2) continue;
      const measured = headsUpEquity(
        mine,
        theirs,
        board,
        hashSeed(report.seed, streetIndexOf(street.street), focus, seat)
      );
      if (measured) {
        vs.push({ seat, equity: measured.equity, exact: measured.exact });
      }
    }

    const own = report.decisions
      .filter((d) => d.seat === focus && d.street === street.street)
      .pop();
    rows.push({
      street: street.street,
      label: street.label,
      boardLen: street.boardLen,
      vs,
      field: own ? own.equity.equity : null,
    });
  }
  return rows;
}

function Ladder({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const ladder = useMemo(() => ladderRows(report, focus), [report, focus]);

  if (ladder.length === 0 || ladder.every((r) => r.vs.length === 0)) {
    return (
      <EmptyPanel title="No matchup to trace">
        Nobody was in the pot with {subject(seatName(focus))} with cards on
        record, so there is no head-to-head equity to run out and no line to
        draw.
      </EmptyPanel>
    );
  }

  const opponents = Array.from(
    new Set(ladder.flatMap((s) => s.vs.map((v) => v.seat)))
  ).sort((a, b) => a - b);

  const data = ladder.map((s) => {
    const row: Record<string, number | string> = { street: s.label };
    for (const v of s.vs) row[seatName(v.seat)] = +(v.equity * 100).toFixed(1);
    if (s.field !== null) row["vs the field"] = +(s.field * 100).toFixed(1);
    return row;
  });
  const hasField = ladder.some((s) => s.field !== null);

  return (
    <>
      <Lead>
        Every point is {possessive(seatName(focus))} <em>full-knowledge equity</em>:
        both hole hands face up, the board run out from that street. Nobody had
        this number at the table (it needs cards that were face down) but the
        record has them now, so the review can show what the odds actually were
        rather than what anyone believed.
      </Lead>

      <Well testId="ladder-chart">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis dataKey="street" stroke={AXIS} fontSize={10} />
            <YAxis
              stroke={AXIS}
              fontSize={10}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "rgba(244,237,228,0.7)" }}
              iconSize={8}
            />
            {opponents.map((seat, i) => (
              <Line
                key={seat}
                type="monotone"
                dataKey={seatName(seat)}
                stroke={SERIES[i % SERIES.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            ))}
            {hasField && (
              <Line
                type="monotone"
                dataKey="vs the field"
                stroke="#f4ede4"
                strokeDasharray="4 3"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </Well>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        Solid lines are head-to-head against one opponent, both hands known, run
        out over the board as it stood, enumerated exactly wherever two or fewer
        cards were still to come. The dashed line, when the hand was played this
        session, is the seat's own recorded equity against the whole field:
        sampled from a read rather than from the cards, which is why it can sit
        below every solid line at once.
      </p>

      <Heading>What each street costs the uncertainty</Heading>
      <Scroller>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Street</th>
              <th className="py-2 pr-3 text-right">Board seen</th>
              <th className="py-2 pr-3 text-right">Cards unknown</th>
              <th className="py-2 pr-3 text-right">Runouts left</th>
              <th className="py-2 pr-3 text-right">Toughest opponent</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((s) => {
              const unknown = 5 - s.boardLen;
              const runouts = combinations(52 - 4 - s.boardLen, unknown);
              const threat = s.vs.reduce<LadderRow["vs"][number] | null>(
                (worst, h) => (worst === null || h.equity < worst.equity ? h : worst),
                null
              );
              return (
                <tr
                  key={s.street}
                  className="border-t"
                  style={{ borderColor: LINE.quietFaint }}
                >
                  <td className="py-2 pr-3 text-ivory/80">{s.label}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {s.boardLen}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {unknown}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {runouts.toLocaleString()}
                    {unknown > 2 && <span className="ml-1 text-ivory/30">sampled</span>}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                    {threat
                      ? `${pct(threat.equity)} vs ${seatName(threat.seat)}`
                      : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroller>

      <HowCalculated label="Why The Line Straightens Out">
        <Heading>The ladder</Heading>
        <Lead>
          Preflop there are five unknown board cards and 1,712,304 ways they can
          land, so almost every matchup is somewhere near a coin flip: the deck
          has more say than the cards do. The flop reveals three at once, which
          is the largest single transfer of information in the hand, and the line
          moves hardest there. The turn leaves 44 runouts. The river leaves one.
        </Lead>
        <Heading>The last rung is not an estimate</Heading>
        <Lead>
          With the board complete there is nothing left to sample: the hand is
          decided and the equity is exactly 100% or exactly 0%, or exactly 50%
          when the two hands tie. Every number on the right of this chart is a
          fact, and the ones on the left are probabilities. They are drawn on the
          same axis because they are the same quantity, seen with different
          amounts of the deck showing.
        </Lead>
        <Why>
          Watching this line is the clearest picture of what a community card is:
          not luck arriving, but information arriving, and value moving with it
          from whoever was ahead in the dark to whoever the board just chose.
        </Why>
      </HowCalculated>
    </>
  );
}
