/**
 * What the table is allowed to tell you.
 *
 * Coach shows the price you are being offered, the equity you actually hold,
 * and the conclusion those two add up to. Study adds the numbers the bots price
 * from: equity against each opponent taken alone (which is the single biggest
 * way multiway differs from heads-up, you can beat every seat one-on-one and
 * still be an underdog to the field), and the EV of every legal action. Drill
 * says nothing at all until a move has already cost you chips.
 *
 * Closed, this is one line and one verdict, because a player reads a
 * conclusion and skims a table of four. Everything the four `Stat`s ever said
 * is still here, one click away, and on a wide screen that click opens a panel
 * over the felt rather than under it. In-flow growth here is how Fold and
 * Call ended up 240px below the fold.
 *
 * None of it reaches the engine. The equity shown here is a second, independent
 * run for display; removing this component would not change a single card or a
 * single bot decision.
 */

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { money, pct } from "../../lib/format";
import { evByAction } from "../../poker/model/decider";
import type { TableAction } from "../../poker/table/rules";
import { useTable, type DrillVerdict, type HeroRead } from "../../store/TableContext";
import type { TableMode } from "../../lib/tableOptions";
import type { TableSeat } from "../../poker/table/state";
import { LINE, RADIUS, SURFACE, Stat, TONE } from "../ui";

export interface CoachPanelProps {
  mode: TableMode;
  read: HeroRead | null;
  /** True while the human is on the clock, the panel only speaks then. */
  active: boolean;
  actions: TableAction[];
  seats: TableSeat[];
  narrow: boolean;
  /**
   * The hand has finished and `ResultStrip` is on screen.
   *
   * Drill's verdict moves inside that strip when it is, so the two do not stack
   * into a column the one-screen lock has no room for: at 1024x730 a 33px coach
   * row plus a two-line result block is taller than the space under the felt's
   * floor, and because the lock also clips, "Deal me another" was not merely
   * pushed down but unreachable. They belong together anyway, the verdict is
   * about the hand the strip is reporting.
   */
  handOver?: boolean;
}

export function CoachPanel({
  mode,
  read,
  active,
  actions,
  seats,
  narrow,
  handOver = false,
}: CoachPanelProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /*
   * Drill's verdict is read from the store rather than taken as a prop, and it
   * has to be: it exists precisely when `active` is false, and the call site
   * only knows about this component while the human is on the clock. It is
   * display state either way, the same as `read`.
   */
  const { drillVerdict, dismissDrill } = useTable();

  /*
   * Esc and a click outside put the expansion away. Both matter more than
   * usual here, because on a wide screen the panel is floating over the board
   * and a player who cannot dismiss it cannot see the turn card.
   *
   * `pointerdown` rather than `click`: a click that starts inside the overlay
   * and ends on the felt would otherwise close it mid-drag, and the toggle
   * itself is inside `rootRef`, so pressing it never double-fires.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  /*
   * Drill, the whole mode. Silent while you decide (a hint offered before the
   * decision is Coach, not Drill) and silent afterwards unless the move cost
   * more than the threshold, which `TableContext` has already applied: a
   * verdict existing at all means it is worth saying.
   */
  if (mode === "drill") {
    if (active || !drillVerdict || handOver) return null;
    return (
      <Shell tight testId="drill-panel">
        <DrillLine verdict={drillVerdict} onDismiss={dismissDrill} />
      </Shell>
    );
  }

  if (mode === "fair" || !active) return null;

  if (!read) {
    return (
      <Shell tight>
        <span className="font-mono text-xs text-ivory/45">
          Estimating equity...
        </span>
      </Shell>
    );
  }

  const share = read.equity.equity;
  const ahead = read.toCall === 0 || share >= read.required;

  /*
   * The closed line, and the one editorial decision in this file: it states a
   * conclusion. "17.4% equity, need 41.2%" is two numbers a player has to
   * subtract in their head while a clock runs; "calling is −EV" is the answer
   * they were subtracting toward, and the numbers that justify it are still
   * right beside it.
   *
   * Pot odds are deliberately absent. "1.4 : 1" and "need 41.2%" are the same
   * fact in two units, and printing both on one line taught players that they
   * were two things to reconcile. The ratio is in the expansion, next to the
   * percentage it converts to.
   */
  const summary = (
    <span className="flex min-w-0 items-baseline gap-x-2 overflow-hidden whitespace-nowrap">
      <span className="font-display text-lg font-bold leading-none text-gold-soft">
        {pct(share, 1)}
      </span>
      <span className="font-mono text-[0.58rem] uppercase tracking-[0.2em] text-ivory/45">
        equity
      </span>
      <Dot />
      {read.toCall > 0 ? (
        <>
          <span className="shrink-0 font-mono text-[0.68rem] leading-none text-ivory/60">
            need {pct(read.required, 1)}
          </span>
          <Dot />
          <span
            data-testid="coach-verdict"
            className="shrink-0 font-mono text-[0.68rem] leading-none"
            style={{ color: ahead ? TONE.good : TONE.bad }}
          >
            calling is {ahead ? "+EV" : "−EV"}
          </span>
        </>
      ) : (
        <span
          data-testid="coach-verdict"
          className="shrink-0 font-mono text-[0.68rem] leading-none text-ivory/55"
        >
          no bet to you
        </span>
      )}
    </span>
  );

  const details = (
    <Details read={read} ahead={ahead} mode={mode} actions={actions} seats={seats} />
  );

  return (
    <Shell tight ref={rootRef}>
      <div className="relative flex w-full min-w-0 flex-col gap-1.5">
        <button
          data-testid="coach-toggle"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="flex w-full min-w-0 items-center justify-between gap-2"
        >
          {summary}
          <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-widest text-ivory/40">
            {open ? "less ▴" : "more ▾"}
          </span>
        </button>

        {open &&
          (narrow ? (
            /*
             * A phone has nowhere to float a panel to, so the expansion stays
             * in the flow and is capped instead. Uncapped, Study's EV chips
             * grew until Fold and Call sat below the fold.
             */
            <div className="max-h-[9rem] overflow-y-auto overscroll-contain">
              {details}
            </div>
          ) : (
            /*
             * Wide screens float it upward over the felt. Absolute, never in
             * flow: the column between the table and the action bar has no
             * spare height at 760px, and anything that grows in it pushes the
             * buttons off the screen. This costs the layout nothing.
             */
            <div
              className={`absolute bottom-full left-0 right-0 z-30 mb-2 border p-3.5 ${RADIUS.surface}`}
              style={{
                borderColor: LINE.goldStrong,
                /*
                 * Opaque, not nearly opaque. This lands on top of the hero's
                 * own hole cards, and card faces are the brightest thing on
                 * the screen: at 0.96 alpha a king of diamonds was still
                 * legible straight through a ±1.1% interval, which makes both
                 * of them harder to read than either would be alone. Same
                 * ground as the sizing popover, because they are the same kind
                 * of object and appear in the same place.
                 */
                background:
                  "radial-gradient(120% 120% at 50% 0%, #16402c 0%, #0b2218 70%)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.65)",
              }}
            >
              {details}
            </div>
          ))}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

/**
 * Everything the closed line defers. Identical on both screens, only where it
 * is mounted changes, so the phone and the desktop can never drift into
 * showing different numbers for the same spot.
 */
function Details({
  read,
  ahead,
  mode,
  actions,
  seats,
}: {
  read: HeroRead;
  ahead: boolean;
  mode: TableMode;
  actions: TableAction[];
  seats: TableSeat[];
}) {
  return (
    <>
      <div
        className="grid grid-cols-2 gap-x-5 gap-y-2 sm:flex sm:flex-wrap sm:items-start sm:gap-x-7"
        data-testid="coach-stats"
      >
        <Stat
          label="Your equity"
          value={pct(read.equity.equity, 1)}
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
              value={read.odds ? `${read.odds.toFixed(1)} : 1` : "-"}
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
    </>
  );
}

/**
 * Drill breaking its silence. One sentence, and a way to shut it up.
 *
 * Dismissible because it outlives the decision it describes: the next bot to
 * act is worth watching, and a correction pinned under the felt while someone
 * else is deciding is noise. It also clears itself the moment the human acts
 * again, so a verdict can never sit under the wrong spot.
 */
export function DrillLine({
  verdict,
  onDismiss,
}: {
  verdict: DrillVerdict;
  onDismiss: () => void;
}) {
  /*
   * Announced, because this line is the entire mode.
   *
   * `Thinking` already marks the bots' running commentary `role="status"
   * aria-live="polite"`, so without this a screen-reader user was read every
   * stage of every opponent's transcript and told nothing at all about their
   * own mistake, which is the one sentence on the felt addressed to them.
   * `polite` rather than `assertive`: the hand is over by the time it appears,
   * so it can wait for a pause rather than interrupting one.
   */
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-full min-w-0 items-center justify-between gap-3"
    >
      <span
        data-testid="drill-verdict"
        className="min-w-0 truncate font-cormorant text-[0.95rem] italic text-ivory/75"
      >
        {spoken(verdict.better)} was better by{" "}
        <span
          className="font-display text-sm font-semibold not-italic"
          style={{ color: TONE.bad }}
        >
          {money(verdict.loss)}
        </span>
        .
      </span>
      <button
        data-testid="drill-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 font-mono text-[0.7rem] leading-none text-ivory/40 transition-colors hover:text-ivory/75"
      >
        ×
      </button>
    </div>
  );
}

/**
 * The better action as the subject of a sentence.
 *
 * Not `action.label`: a label reads "Raise to $150", and "Raise to $150 was
 * better by $53" is not a sentence anyone says at a table.
 */
function spoken(action: TableAction): string {
  switch (action.type) {
    case "fold":
      return "Folding";
    case "check":
      return "Checking";
    case "call":
      return `Calling ${money(action.cost)}`;
    case "bet":
      return `Betting ${money(action.cost)}`;
    case "raise":
      return `Raising to ${money(action.amount)}`;
  }
}

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
      className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t pt-1.5"
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

/** The separator between the closed line's three clauses. */
function Dot() {
  return <span className="shrink-0 text-[0.7rem] text-ivory/25">·</span>;
}

function Label({ children }: { children: ReactNode }) {
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
        background: SURFACE.sunk,
        color: tone ? TONE[tone] : TONE.neutral,
      }}
    >
      <span className="text-ivory/50">{label}</span> {value}
    </span>
  );
}

/**
 * The bar itself. `py-1.5` on every screen now, not just the phone: the closed
 * row is one line everywhere, and the wide screen's extra 4px was the last
 * thing between the action bar and the fold at 760px.
 */
function Shell({
  children,
  tight,
  testId = "coach-panel",
  ref,
}: {
  children: ReactNode;
  tight?: boolean;
  testId?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      data-testid={testId}
      className={`relative mx-auto flex w-full max-w-3xl items-center border ${
        tight ? "px-3 py-1.5" : "px-3.5 py-2"
      } ${RADIUS.surface}`}
      style={{ borderColor: LINE.gold, background: SURFACE.tray }}
    >
      {children}
    </div>
  );
}
