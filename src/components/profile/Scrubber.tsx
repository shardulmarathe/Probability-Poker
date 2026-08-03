/**
 * Stepping through a hand, one action at a time.
 *
 * The frames come from `poker/replay` already built — this file decides what to
 * show, never what happened. Frame 0 is the deal and frame `k` is the state
 * after the `k`th action, which is why the caption reads the engine's own log
 * lines for the step rather than describing the action itself: a single action
 * can also turn a street, fill the board and settle the pot, and the log is
 * where the engine says so.
 */

import { useCallback, useEffect } from "react";
import { money } from "../../lib/format";
import type { ReplayFrame } from "../../poker/replay";
import { positionOf } from "../../poker/table/position";
import { CardRow, Tag } from "../ui";

const STREET_LABEL: Record<string, string> = {
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

const STATUS_TONE: Record<string, "neutral" | "gold" | "good" | "bad"> = {
  active: "good",
  allin: "gold",
  folded: "bad",
  out: "neutral",
};

export interface ScrubberProps {
  frames: ReplayFrame[];
  index: number;
  onIndex: (index: number) => void;
  button: number;
  seatCount: number;
  /** Seat the review is written from; highlighted, never privileged. */
  focus: number | null;
  seatName: (seat: number) => string;
}

export function Scrubber({
  frames,
  index,
  onIndex,
  button,
  seatCount,
  focus,
  seatName,
}: ScrubberProps) {
  const clamped = Math.max(0, Math.min(frames.length - 1, index));
  const frame = frames[clamped];
  const previous = clamped > 0 ? frames[clamped - 1] : null;

  const step = useCallback(
    (delta: number) => onIndex(Math.max(0, Math.min(frames.length - 1, clamped + delta))),
    [clamped, frames.length, onIndex]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  if (!frame) return null;

  // What the engine narrated during this step. Empty on frame 0, where the
  // whole log is the deal itself.
  const narration = previous ? frame.log.slice(previous.log.length) : frame.log;

  return (
    <div data-testid="scrubber" data-frame={clamped} data-frames={frames.length}>
      {/* ------------------------- Controls ------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <StepButton label="⏮" title="Deal" onClick={() => onIndex(0)} disabled={clamped === 0} />
          <StepButton
            label="◀"
            title="Previous action"
            onClick={() => step(-1)}
            disabled={clamped === 0}
            testId="scrub-prev"
          />
          <StepButton
            label="▶"
            title="Next action"
            onClick={() => step(1)}
            disabled={clamped >= frames.length - 1}
            testId="scrub-next"
          />
          <StepButton
            label="⏭"
            title="Showdown"
            onClick={() => onIndex(frames.length - 1)}
            disabled={clamped >= frames.length - 1}
          />
        </div>
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-ivory/45">
          {clamped === 0 ? "Deal" : `Action ${clamped}`} / {frames.length - 1}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Tag tone="neutral">{STREET_LABEL[frame.street] ?? frame.street}</Tag>
          <Tag tone="gold">Pot {money(frame.pot)}</Tag>
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={Math.max(0, frames.length - 1)}
        value={clamped}
        onChange={(e) => onIndex(Number(e.target.value))}
        aria-label="Hand timeline"
        data-testid="scrub-range"
        className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full"
        style={{ background: "rgba(0,0,0,0.5)", accentColor: "#c9a227" }}
      />

      {/* --------------------------- Board -------------------------- */}
      <div className="mt-4">
        <CardRow label="Board" cards={frame.board} size="md" empty="Not dealt yet" />
      </div>

      {/* ------------------------ Narration ------------------------- */}
      <div
        className="mt-3 min-h-[2.75rem] rounded-lg border-l-2 px-3 py-2"
        style={{ borderColor: "#c9a227", background: "rgba(201,162,39,0.07)" }}
        data-testid="scrub-narration"
      >
        {narration.length === 0 ? (
          <p className="text-[0.78rem] text-ivory/40">—</p>
        ) : (
          narration.map((line, i) => (
            <p key={i} className="text-[0.78rem] leading-relaxed text-ivory/75">
              {line}
            </p>
          ))
        )}
      </div>

      {/* --------------------------- Seats -------------------------- */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {frame.seats.map((seat) => {
          const isFocus = seat.seat === focus;
          const onClock = frame.toAct === seat.seat;
          return (
            <div
              key={seat.seat}
              data-testid={`frame-seat-${seat.seat}`}
              className="min-w-0 rounded-xl border p-2.5"
              style={{
                borderColor: onClock
                  ? "rgba(201,162,39,0.7)"
                  : isFocus
                    ? "rgba(201,162,39,0.35)"
                    : "rgba(244,237,228,0.12)",
                background: isFocus ? "rgba(201,162,39,0.07)" : "rgba(0,0,0,0.28)",
                opacity: seat.status === "folded" ? 0.55 : 1,
              }}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate font-display text-xs font-semibold text-ivory">
                  {seatName(seat.seat)}
                </span>
                <span className="font-mono text-[0.58rem] uppercase tracking-wider text-gold-soft/70">
                  {positionOf(seat.seat, button, seatCount)}
                </span>
                {onClock && <Tag tone="gold">To act</Tag>}
                <Tag tone={STATUS_TONE[seat.status] ?? "neutral"}>{seat.status}</Tag>
              </div>

              <div className="mt-2 flex items-end justify-between gap-2">
                <CardRow cards={seat.hole} size="sm" empty="—" />
                <div className="shrink-0 text-right">
                  <p className="font-mono text-[0.7rem] text-ivory">{money(seat.stack)}</p>
                  <p className="font-mono text-[0.6rem] text-ivory/45">
                    in {money(seat.invested)}
                    {seat.streetCommit > 0 ? ` · street ${money(seat.streetCommit)}` : ""}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StepButton({
  label,
  title,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      data-testid={testId}
      className="min-h-[36px] min-w-[36px] rounded-lg border px-2 font-display text-xs transition disabled:opacity-25"
      style={{ borderColor: "rgba(201,162,39,0.35)", background: "rgba(0,0,0,0.35)" }}
    >
      {label}
    </button>
  );
}
