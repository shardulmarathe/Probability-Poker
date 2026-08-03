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
import { netTone } from "../ui";
import { Scroller, Stat, StatGrid } from "../ui";

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

/**
 * Deliberately not exported. This module's other exports are all components,
 * and a stray constant among them costs React Fast Refresh — the whole file
 * reloads on every edit instead of re-rendering in place.
 */
const STAT_SPECS: StatSpec[] = [
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

export function TrackerOverall({ stats }: { stats: PlayerStats }) {
  const thin = stats.total.hands < THIN_SAMPLE;
  return (
    <>
      {/*
       * A dimmed meter was the only signal that a number came off two hands,
       * and a dimmed bar is not something a first-time reader can decode. The
       * figures themselves are unhedged and printed to a decimal — "VPIP
       * 100.0%" off two hands claims a precision of one part in a thousand for
       * an estimate whose resolution is a half. This says the quiet part.
       */}
      {thin && (
        <p className="mb-3 text-[0.8rem] leading-snug text-ivory/50" data-testid="thin-sample">
          {stats.total.hands === 0
            ? "No hands yet — these fill in as you play."
            : `From ${stats.total.hands} hand${stats.total.hands === 1 ? "" : "s"}. Every figure below still swings by tens of points with each new one; they start meaning something around ${THIN_SAMPLE}.`}
        </p>
      )}
      <StatGrid columns={3}>
        {STAT_SPECS.map((spec) => (
          <Stat
            key={spec.key}
            testId={`stat-${spec.key}`}
            label={spec.label}
            value={spec.format(stats.total)}
            meter={spec.fraction(stats.total)}
            meterThin={thin}
            note={spec.blurb}
          />
        ))}
      </StatGrid>
    </>
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
        style={{ color: netTone(counters.net) }}
      >
        {counters.net >= 0 ? `+$${counters.net}` : `−$${-counters.net}`}
      </td>
    </tr>
  );
}

/** Headline numbers that are not tracker stats: hands, net, showdowns. */
export function SessionHeadline({ stats }: { stats: PlayerStats }) {
  const t = stats.total;
  return (
    <StatGrid columns={4}>
      <Stat label="Hands played" value={t.hands} />
      <Stat
        label="Net"
        value={t.net >= 0 ? `+$${t.net}` : `−$${-t.net}`}
        tone={t.net > 0 ? "good" : t.net < 0 ? "bad" : "neutral"}
      />
      <Stat
        label="Showdowns"
        value={t.wtsd.n}
        note={`of ${t.wtsd.d} flop${t.wtsd.d === 1 ? "" : "s"} seen`}
      />
      <Stat
        label="Won at showdown"
        value={t.wsd.d > 0 ? `${t.wsd.n}/${t.wsd.d}` : "—"}
        note={t.wsd.d > 0 ? pctText(t.wsd) : "no showdowns yet"}
      />
    </StatGrid>
  );
}
