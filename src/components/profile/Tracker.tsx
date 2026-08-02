/**
 * The tracker line: the six numbers a poker database would show you, plus the
 * positional breakdown that is the only reason to keep them per-hand.
 *
 * Every counter is a `{n, d}` pair, so a stat with no denominator is printed as
 * "—" rather than 0%. That distinction is the whole point of storing pairs: a
 * seat that has never faced a 3-bet has no fold-to-3-bet, and rendering that as
 * 0% would read as "never folds" — the opposite of what is known, which is
 * nothing.
 */

import type { Counter, PlayerStats, StatCounters } from "../../poker/coach/stats";
import { POSITIONS, percent, rate } from "../../poker/coach/stats";
import type { PositionName } from "../../poker/table/position";
import { Scroller, Stat } from "../report/ui";

interface StatSpec {
  key: string;
  label: string;
  /** Short label for the positional table's header. */
  short: string;
  blurb: string;
  format: (c: StatCounters) => string;
  /** 0..1 for the meter, or null when nothing was observed. */
  fraction: (c: StatCounters) => number | null;
}

const pctText = (c: Counter): string => {
  const p = percent(c);
  return p === null ? "—" : `${p.toFixed(1)}%`;
};

const pctFraction = (c: Counter): number | null => {
  const r = rate(c);
  return r === null ? null : r;
};

export const STAT_SPECS: StatSpec[] = [
  {
    key: "vpip",
    label: "VPIP",
    short: "VPIP",
    blurb: "Hands entered voluntarily",
    format: (c) => pctText(c.vpip),
    fraction: (c) => pctFraction(c.vpip),
  },
  {
    key: "pfr",
    label: "PFR",
    short: "PFR",
    blurb: "Hands raised preflop",
    format: (c) => pctText(c.pfr),
    fraction: (c) => pctFraction(c.pfr),
  },
  {
    key: "threeBet",
    label: "3-Bet",
    short: "3B",
    blurb: "Re-raises when facing an open",
    format: (c) => pctText(c.threeBet),
    fraction: (c) => pctFraction(c.threeBet),
  },
  {
    key: "af",
    label: "AF",
    short: "AF",
    blurb: "Postflop bets + raises per call",
    format: (c) => {
      const r = rate(c.af);
      return r === null ? "—" : r.toFixed(2);
    },
    // AF is unbounded; 3 is the top of the meter, not of the stat.
    fraction: (c) => {
      const r = rate(c.af);
      return r === null ? null : Math.min(1, r / 3);
    },
  },
  {
    key: "wtsd",
    label: "WTSD",
    short: "WTSD",
    blurb: "Saw a flop, then a showdown",
    format: (c) => pctText(c.wtsd),
    fraction: (c) => pctFraction(c.wtsd),
  },
  {
    key: "wsd",
    label: "W$SD",
    short: "W$SD",
    blurb: "Showdowns won",
    format: (c) => pctText(c.wsd),
    fraction: (c) => pctFraction(c.wsd),
  },
];

/** Small, so the meter is honest about it: below this the bar is dimmed. */
const THIN_SAMPLE = 12;

function Bar({ value, thin }: { value: number | null; thin: boolean }) {
  return (
    <div
      className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: "rgba(0,0,0,0.45)" }}
    >
      {value !== null && (
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(2, Math.min(1, value) * 100)}%`,
            backgroundColor: thin ? "rgba(201,162,39,0.35)" : "#e2c563",
          }}
        />
      )}
    </div>
  );
}

export function TrackerOverall({ stats }: { stats: PlayerStats }) {
  const thin = stats.total.hands < THIN_SAMPLE;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {STAT_SPECS.map((spec) => (
        <div
          key={spec.key}
          className="min-w-0 rounded-xl border p-2.5 sm:p-3"
          style={{
            borderColor: "rgba(244,237,228,0.14)",
            background: "rgba(0,0,0,0.25)",
          }}
          data-testid={`stat-${spec.key}`}
        >
          <p className="truncate text-[0.6rem] uppercase tracking-wider text-ivory/45 sm:text-xs">
            {spec.label}
          </p>
          <p className="mt-0.5 font-display text-lg font-semibold text-ivory sm:text-xl">
            {spec.format(stats.total)}
          </p>
          <Bar value={spec.fraction(stats.total)} thin={thin} />
          <p className="mt-1.5 text-[0.6rem] leading-snug text-ivory/40">{spec.blurb}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The same stats by position. Positions the seat has never occupied are left
 * out entirely rather than shown as a row of dashes — at four-handed there is
 * no hijack, and printing one implies a gap in the sample that does not exist.
 */
export function TrackerByPosition({ stats }: { stats: PlayerStats }) {
  const live = POSITIONS.filter((p) => stats.byPosition[p].hands > 0);
  if (live.length === 0) {
    return (
      <p className="text-sm text-ivory/50">
        No hands yet. Positional splits need at least one hand in a seat.
      </p>
    );
  }

  return (
    <Scroller>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            <th className="pb-2 pr-3 font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/40">
              Position
            </th>
            <th className="pb-2 pr-3 text-right font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/40">
              Hands
            </th>
            {STAT_SPECS.map((spec) => (
              <th
                key={spec.key}
                className="pb-2 pr-3 text-right font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/40"
              >
                {spec.short}
              </th>
            ))}
            <th className="pb-2 text-right font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/40">
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {live.map((position) => (
            <PositionRow
              key={position}
              position={position}
              counters={stats.byPosition[position]}
            />
          ))}
        </tbody>
      </table>
    </Scroller>
  );
}

function PositionRow({
  position,
  counters,
}: {
  position: PositionName;
  counters: StatCounters;
}) {
  return (
    <tr
      data-testid={`position-${position}`}
      style={{ borderTop: "1px solid rgba(244,237,228,0.08)" }}
    >
      <td className="py-2 pr-3">
        <span className="font-display text-xs font-semibold text-gold-soft">
          {position}
        </span>
      </td>
      <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/60">
        {counters.hands}
      </td>
      {STAT_SPECS.map((spec) => (
        <td key={spec.key} className="py-2 pr-3 text-right font-mono text-xs text-ivory">
          {spec.format(counters)}
        </td>
      ))}
      <td
        className="py-2 text-right font-mono text-xs"
        style={{
          color:
            counters.net > 0
              ? "#7fd3a8"
              : counters.net < 0
                ? "#e58a8a"
                : "rgba(244,237,228,0.4)",
        }}
      >
        {counters.net >= 0 ? `+$${counters.net}` : `−$${-counters.net}`}
      </td>
    </tr>
  );
}

/** Headline numbers that are not tracker stats: hands, net, biggest pot. */
export function SessionHeadline({ stats }: { stats: PlayerStats }) {
  const t = stats.total;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Hands" value={t.hands} />
      <Stat
        label="Net"
        value={t.net >= 0 ? `+$${t.net}` : `−$${-t.net}`}
        highlight={t.net >= 0}
      />
      <Stat
        label="Showdowns"
        value={t.wtsd.n}
        sub={`of ${t.wtsd.d} flops seen`}
      />
      <Stat
        label="Won at showdown"
        value={t.wsd.d > 0 ? `${t.wsd.n}/${t.wsd.d}` : "—"}
        sub={t.wsd.d > 0 ? pctText(t.wsd) : "no showdowns yet"}
      />
    </div>
  );
}
