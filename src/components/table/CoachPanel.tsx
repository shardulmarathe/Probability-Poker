/**
 * What the table is allowed to tell you.
 *
 * Coach shows the price you are being offered and the equity you actually
 * hold, pot odds, required share, your share. Study adds the numbers the bots
 * price from: equity against each opponent taken alone (which is the single
 * biggest way multiway differs from heads-up, you can beat every seat
 * one-on-one and still be an underdog to the field), and the EV of every legal
 * action.
 *
 * None of it reaches the engine. The equity shown here is a second, independent
 * run for display; removing this component would not change a single card or a
 * single bot decision.
 */

import { useState } from "react";
import { money, pct } from "../../lib/format";
import { evByAction } from "../../poker/model/decider";
import type { TableAction } from "../../poker/table/rules";
import type { HeroRead } from "../../store/TableContext";
import type { TableMode } from "../../lib/tableOptions";
import type { TableSeat } from "../../poker/table/state";
import { LINE, RADIUS, Stat, TONE } from "../ui";

export interface CoachPanelProps {
  mode: TableMode;
  read: HeroRead | null;
  /** True while the human is on the clock, the panel only speaks then. */
  active: boolean;
  actions: TableAction[];
  seats: TableSeat[];
  narrow: boolean;
}

export function CoachPanel({
  mode,
  read,
  active,
  actions,
  seats,
  narrow,
}: CoachPanelProps) {
  const [open, setOpen] = useState(false);
  if (mode === "fair" || !active) return null;

  if (!read) {
    return (
      <Shell tight={narrow}>
        <span className="font-mono text-xs text-ivory/45">
          Estimating equity…
        </span>
      </Shell>
    );
  }

  const share = read.equity.equity;
  const ahead = read.toCall === 0 || share >= read.required;
  // One row on a phone: the extra "equity vs N" wrap was growing into the felt.
  const summary = (
    <span className="flex min-w-0 items-baseline gap-x-2.5 overflow-hidden whitespace-nowrap">
      <span className="font-display text-lg font-bold leading-none text-gold-soft">
        {pct(share, 1)}
      </span>
      {read.toCall > 0 && (
        <span
          className="shrink-0 font-mono text-[0.68rem] leading-none"
          style={{ color: ahead ? TONE.good : TONE.bad }}
        >
          need {pct(read.required, 1)}
        </span>
      )}
    </span>
  );

  // On a phone the panel is one tappable line until asked for; the table needs
  // the vertical space more than the numbers do.
  if (narrow && !open) {
    return (
      <Shell tight>
        <button
          data-testid="coach-toggle"
          onClick={() => setOpen(true)}
          className="flex w-full min-w-0 items-center justify-between gap-2"
        >
          {summary}
          <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-widest text-ivory/40">
            more ▾
          </span>
        </button>
      </Shell>
    );
  }

  return (
    <Shell tight={narrow}>
      <div className="flex w-full flex-col gap-1.5">
        {narrow && (
          <button
            data-testid="coach-toggle"
            onClick={() => setOpen(false)}
            className="flex w-full min-w-0 items-center justify-between gap-2"
          >
            {summary}
            <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-widest text-ivory/40">
              less ▴
            </span>
          </button>
        )}

        {/*
         * One surface, five numbers. On a phone the expanded body used to
         * grow until Fold and Call sat below the fold, so that path is
         * capped and the action bar stays on screen.
         */}
        <div
          className={
            narrow
              ? "max-h-[9rem] overflow-y-auto overscroll-contain"
              : undefined
          }
        >
          <div
            className="grid grid-cols-2 gap-x-5 gap-y-2 sm:flex sm:flex-wrap sm:items-start sm:gap-x-7"
            data-testid="coach-stats"
          >
          <Stat
            label="Your equity"
            value={pct(share, 1)}
            tone="gold"
            note={`±${pct(read.equity.se * 1.96, 1)}`}
          />
          <Stat
            label="Pot"
            value={money(read.pot)}
            tone="gold"
            note={read.toCall > 0 ? `${money(read.toCall)} to call` : "no bet to you"}
          />
          {read.toCall > 0 ? (
            <>
              <Stat
                label="Pot odds"
                value={read.odds ? `${read.odds.toFixed(1)} : 1` : "—"}
                tone="gold"
                note="pot : call"
              />
              <Stat
                label="Need to call"
                value={pct(read.required, 1)}
                note={ahead ? "you have enough" : "you are short"}
                tone={ahead ? "good" : "bad"}
              />
            </>
          ) : (
            <Stat
              label="Chop risk"
              value={pct(read.equity.pTie, 1)}
              tone="gold"
              note="ties split the pot"
            />
          )}
        </div>

        {mode === "study" && (
          <StudyDetail read={read} actions={actions} seats={seats} />
        )}
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function StudyDetail({
  read,
  actions,
  seats,
}: {
  read: HeroRead;
  actions: TableAction[];
  seats: TableSeat[];
}) {
  const evs = evByAction(actions, read.equity, read.pot, read.toCall);
  // One wrapping row rather than two labelled ones: the felt needs the height
  // more than these need their own lines, and the chips are self-labelling.
  return (
    <div
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t pt-1.5"
      style={{ borderColor: LINE.goldFaint }}
    >
      <Label>vs each</Label>
      {read.opponents.map((id) => (
        <Chip
          key={id}
          label={seats[id]?.name ?? `Seat ${id}`}
          value={pct(read.equity.perOpponent[id] ?? 0, 0)}
        />
      ))}
      <Label>EV</Label>
      {actions.map((a) => (
        <Chip
          key={a.label}
          label={a.label}
          value={`${evs[a.label] >= 0 ? "+" : ""}${evs[a.label].toFixed(1)}`}
          tone={evs[a.label] >= 0 ? "good" : "bad"}
        />
      ))}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.55rem] uppercase tracking-[0.2em] text-ivory/40">
      {children}
    </span>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  return (
    <span
      className={`border px-1.5 py-0.5 font-mono text-[0.62rem] ${RADIUS.marker}`}
      style={{
        borderColor: LINE.quiet,
        background: "rgba(0,0,0,0.35)",
        color: tone ? TONE[tone] : TONE.neutral,
      }}
    >
      <span className="text-ivory/50">{label}</span> {value}
    </span>
  );
}

function Shell({
  children,
  tight,
}: {
  children: React.ReactNode;
  tight?: boolean;
}) {
  return (
    <div
      data-testid="coach-panel"
      className={`mx-auto flex w-full max-w-3xl items-center border ${
        tight ? "px-3 py-1.5" : "px-3.5 py-2"
      } ${RADIUS.surface}`}
      style={{ borderColor: LINE.gold, background: "rgba(0,0,0,0.4)" }}
    >
      {children}
    </div>
  );
}
