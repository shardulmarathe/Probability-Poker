/**
 * The two replays that invent something, and the labelling that says so.
 *
 * A counterfactual holds the cards fixed and changes one decision. A lineup
 * replay holds the cards fixed and changes the opposition. In both, everything
 * that happens after the change is the bots' answer *now* — not a record of
 * anything, and in the counterfactual's case not even the opponents' real
 * strategy, since they were answering a different question at the time.
 *
 * So the result is never shown as an outcome. It is shown behind a banner, in a
 * different colour from every other panel on the site, with the number of
 * re-derived moves printed next to the chip figure. `deltaNet` is one sample
 * from one run of a model, and the copy says exactly that. A counterfactual
 * dressed as a fact teaches the player to trust a simulation over their read,
 * which is worse than showing them nothing.
 */

import { useMemo, useState } from "react";
import { money } from "../../lib/format";
import {
  alternativesAt,
  decisionIndexes,
  replayWithLineup,
  runCounterfactual,
  type Alternative,
  type Counterfactual,
  type LineupReplay,
} from "../../poker/replay";
import { BOT_ARCHETYPES, BOT_PROFILES } from "../../poker/model/profiles";
import type { SimulationOptions } from "../../poker/replay";
import type { TableHandReport } from "../../poker/table/contract";
import { positionOf } from "../../poker/table/position";
import { CardRow, EmptyState, RADIUS } from "../ui";
import { Scrubber } from "./Scrubber";

const SIM = "#b07fd4";
const SIM_BG = "rgba(176,127,212,0.10)";
const SIM_BORDER = "rgba(176,127,212,0.5)";

/**
 * The banner. Deliberately a colour used nowhere else on the site, so a
 * screenshot of a simulated result cannot be mistaken for a screenshot of a
 * hand — including by the person who took it.
 */
export function SimulatedBanner({
  rederived,
  children,
}: {
  rederived: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`border-2 border-dashed px-3 py-2.5 ${RADIUS.surface}`}
      style={{ borderColor: SIM_BORDER, background: SIM_BG }}
      data-testid="simulated-banner"
      data-rederived={rederived}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`px-2 py-0.5 font-display text-[0.62rem] font-bold uppercase tracking-[0.18em] ${RADIUS.marker}`}
          style={{ background: SIM, color: "#150a1d" }}
        >
          Simulated
        </span>
        <span className="font-mono text-[0.62rem] uppercase tracking-wider" style={{ color: SIM }}>
          {/* Zero is a real and common answer — a fold that ends the hand
              leaves nothing to re-derive — and "0 moves re-derived" reads as a
              failure rather than as that fact. */}
          {rederived === 0
            ? "nothing to re-derive"
            : `${rederived} move${rederived === 1 ? "" : "s"} re-derived`}
        </span>
      </div>
      <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ivory/70">{children}</p>
    </div>
  );
}

/** "You" is already possessive in the only way English allows here. */
function possessive(name: string): string {
  if (name === "You") return "your";
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function netColor(value: number): string {
  return value > 0 ? "#7fd3a8" : value < 0 ? "#e58a8a" : "rgba(244,237,228,0.5)";
}

const signed = (value: number): string =>
  value >= 0 ? `+${money(value)}` : `−${money(-value)}`;

// ---------------------------------------------------------------------------
// Counterfactual
// ---------------------------------------------------------------------------

export function CounterfactualPanel({
  report,
  options,
  seat,
  seatName,
}: {
  report: TableHandReport;
  options: SimulationOptions;
  seat: number;
  seatName: (seat: number) => string;
}) {
  const indexes = useMemo(() => decisionIndexes(report, seat), [report, seat]);
  const [index, setIndex] = useState<number | null>(null);
  const [result, setResult] = useState<Counterfactual | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);

  const chosen = index ?? indexes[0] ?? null;
  const alternatives = useMemo(
    () => (chosen === null ? [] : alternativesAt(report, chosen, options)),
    [report, chosen, options]
  );

  const run = (alternative: Alternative) => {
    if (chosen === null) return;
    const outcome = runCounterfactual(report, chosen, alternative, options);
    if (outcome.ok) {
      setResult(outcome);
      setError(null);
      setFrame(outcome.frames.length - 1);
    } else {
      setResult(null);
      setError(outcome.reason);
    }
  };

  if (indexes.length === 0) {
    return (
      <EmptyState title="No decisions to change">
        {seatName(seat)} never acted in this hand — there is nothing to replace.
      </EmptyState>
    );
  }

  return (
    <div data-testid="counterfactual">
      <p className="text-[0.8rem] leading-relaxed text-ivory/65">
        Pick one of {possessive(seatName(seat))} decisions and play a different
        move. The cards stay exactly as they were dealt; everything the table
        does afterwards is re-derived by the bots, because their real answers
        were answers to a hand that no longer exists.
      </p>

      {/* --------------------- Decision picker --------------------- */}
      <div className="mt-4">
        <p className="mb-1.5 font-display text-[0.6rem] uppercase tracking-[0.2em] text-ivory/40">
          Decision
        </p>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {indexes.map((i) => {
            const record = report.actions[i];
            const active = i === chosen;
            return (
              <button
                key={i}
                data-testid={`cf-decision-${i}`}
                onClick={() => {
                  setIndex(i);
                  setResult(null);
                  setError(null);
                }}
                className={`min-h-[34px] shrink-0 border px-2.5 py-1 font-display text-[0.64rem] tracking-wide transition ${RADIUS.control}`}
                style={{
                  borderColor: active ? "rgba(201,162,39,0.6)" : "rgba(244,237,228,0.14)",
                  background: active ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
                  color: active ? "#e2c563" : "rgba(244,237,228,0.55)",
                }}
              >
                {record.street} · {record.action}
                {record.cost > 0 ? ` ${money(record.cost)}` : ""}
              </button>
            );
          })}
        </div>
      </div>

      {/* --------------------- Alternatives ------------------------ */}
      <div className="mt-4">
        <p className="mb-1.5 font-display text-[0.6rem] uppercase tracking-[0.2em] text-ivory/40">
          Play instead
        </p>
        <div className="flex flex-wrap gap-1.5">
          {alternatives.map((alternative) => (
            <button
              key={`${alternative.type}:${alternative.cost}`}
              data-testid={`cf-alt-${alternative.type}-${alternative.cost}`}
              disabled={alternative.actual}
              onClick={() => run(alternative)}
              title={alternative.actual ? "This is what actually happened" : undefined}
              className={`min-h-[38px] border px-3 py-1.5 font-display text-[0.68rem] tracking-wide transition enabled:hover:-translate-y-px disabled:opacity-45 ${RADIUS.control}`}
              style={{
                borderColor: alternative.actual ? "rgba(244,237,228,0.16)" : SIM_BORDER,
                background: alternative.actual ? "rgba(0,0,0,0.3)" : SIM_BG,
                color: alternative.actual ? "rgba(244,237,228,0.5)" : SIM,
              }}
            >
              {alternative.label}
              {alternative.actual && (
                <span className="ml-1.5 font-mono text-[0.55rem] uppercase opacity-70">
                  played
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-3 text-[0.75rem]" style={{ color: "#e58a8a" }} data-testid="cf-error">
          {error}
        </p>
      )}

      {/* ------------------------- Result -------------------------- */}
      {result && (
        <div className="mt-5 space-y-3" data-testid="cf-result">
          <SimulatedBanner rederived={result.rederived}>
            {seatName(seat)} played{" "}
            <span style={{ color: SIM }}>{result.substitute.label.toLowerCase()}</span> instead
            of {result.actual.action}
            {result.actual.cost > 0 ? ` ${money(result.actual.cost)}` : ""}.{" "}
            {/* With nothing left to re-derive there is no sampling in the
                answer, so the usual "one way it could have gone" caveat would
                be understating it. */}
            {result.rederived === 0
              ? "That ended the hand where it stood, so nothing after it had to come from the bots — this outcome is exact."
              : `The ${result.rederived} move${result.rederived === 1 ? "" : "s"} after it came from the bots just now, not from the record. This is one way the hand could have gone, not the way it would have gone.`}
          </SimulatedBanner>

          <div className="grid grid-cols-3 gap-2">
            <Outcome label="Actually made" value={result.actualNet} />
            <Outcome label="In this run" value={result.simulatedNet} simulated />
            <Outcome label="Difference" value={result.deltaNet} simulated />
          </div>

          <div
            className={`border-2 border-dashed p-3 ${RADIUS.surface}`}
            style={{ borderColor: SIM_BORDER, background: "rgba(0,0,0,0.2)" }}
          >
            <Scrubber
              frames={result.frames}
              index={frame}
              onIndex={setFrame}
              button={report.button}
              seatCount={report.seatCount}
              focus={seat}
              seatName={seatName}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Outcome({
  label,
  value,
  simulated,
}: {
  label: string;
  value: number;
  simulated?: boolean;
}) {
  return (
    <div
      className={`min-w-0 border p-2.5 ${RADIUS.control} ${simulated ? "border-dashed" : ""}`}
      style={{
        borderColor: simulated ? SIM_BORDER : "rgba(244,237,228,0.14)",
        background: simulated ? SIM_BG : "rgba(0,0,0,0.25)",
      }}
    >
      <p className="truncate text-[0.58rem] uppercase tracking-wider text-ivory/45">
        {label}
      </p>
      <p
        className="mt-0.5 font-display text-base font-semibold sm:text-lg"
        style={{ color: netColor(value) }}
      >
        {signed(value)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lineup
// ---------------------------------------------------------------------------

export function LineupPanel({
  report,
  options,
  seat,
  seatName,
}: {
  report: TableHandReport;
  options: SimulationOptions;
  seat: number;
  seatName: (seat: number) => string;
}) {
  const [profiles, setProfiles] = useState<string[]>(() =>
    Array.from({ length: report.seatCount }, (_, i) =>
      BOT_ARCHETYPES[i % BOT_ARCHETYPES.length]
    )
  );
  const [result, setResult] = useState<LineupReplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);

  const run = () => {
    const outcome = replayWithLineup(report, profiles, options);
    if (outcome.ok) {
      setResult(outcome);
      setError(null);
      setFrame(outcome.frames.length - 1);
    } else {
      setResult(null);
      setError(outcome.reason);
    }
  };

  const setSeatProfile = (id: number, profile: string) => {
    setProfiles((cur) => cur.map((p, i) => (i === id ? profile : p)));
    setResult(null);
  };

  return (
    <div data-testid="lineup">
      <p className="text-[0.8rem] leading-relaxed text-ivory/65">
        The same deal against different opponents. The seed fixes the deck, so
        every seat is dealt exactly the cards it held — what changes is who is
        holding them. This is how you tell a pot lost to the deck from a pot lost
        to the table.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {profiles.map((profile, id) => (
          <label
            key={id}
            className={`flex min-w-0 items-center gap-2 border p-2.5 ${RADIUS.control}`}
            style={{ borderColor: "rgba(244,237,228,0.12)", background: "rgba(0,0,0,0.28)" }}
          >
            <span className="min-w-0 flex-1 truncate font-display text-xs text-ivory">
              {seatName(id)}
              <span className="ml-1.5 font-mono text-[0.55rem] uppercase tracking-wider text-gold-soft/60">
                {positionOf(id, report.button, report.seatCount)}
              </span>
            </span>
            <select
              value={profile}
              data-testid={`lineup-seat-${id}`}
              onChange={(e) => setSeatProfile(id, e.target.value)}
              className={`min-h-[34px] shrink-0 border px-2 py-1 font-display text-[0.68rem] text-ivory outline-none ${RADIUS.control}`}
              style={{ borderColor: "rgba(201,162,39,0.35)", background: "rgba(0,0,0,0.5)" }}
            >
              {BOT_ARCHETYPES.map((id) => (
                <option key={id} value={id} className="bg-[#0b2218]">
                  {BOT_PROFILES[id].name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <button
        onClick={run}
        data-testid="lineup-run"
        className={`mt-3 min-h-[42px] w-full border-2 border-dashed px-4 py-2 font-display text-sm font-semibold tracking-wide transition hover:-translate-y-px sm:w-auto ${RADIUS.action}`}
        style={{ borderColor: SIM_BORDER, background: SIM_BG, color: SIM }}
      >
        Deal it again to this table
      </button>

      {error && (
        <p className="mt-3 text-[0.75rem]" style={{ color: "#e58a8a" }} data-testid="lineup-error">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-5 space-y-3" data-testid="lineup-result">
          <SimulatedBanner rederived={result.rederived}>
            Not one move here was replayed — the recorded actions were answers to
            a different table, so{" "}
            {result.rederived === 0
              ? "the hand ended before anyone had a decision to make"
              : `all ${result.rederived} came from the bots just now, including the seat you played`}
            .{" "}
            {result.sameCards ? (
              <span style={{ color: "#7fd3a8" }}>
                Every seat was dealt the same cards as the real hand (verified).
              </span>
            ) : (
              <span style={{ color: "#e58a8a" }}>
                Warning: the deal did not match the recorded hand.
              </span>
            )}
          </SimulatedBanner>

          <div className="grid gap-2 sm:grid-cols-2">
            {result.bySeat.map((row) => (
              <div
                key={row.seat}
                data-testid={`lineup-outcome-${row.seat}`}
                className={`min-w-0 border p-2.5 ${RADIUS.control}`}
                style={{
                  borderColor:
                    row.seat === seat ? "rgba(201,162,39,0.45)" : "rgba(244,237,228,0.12)",
                  background: row.seat === seat ? "rgba(201,162,39,0.07)" : "rgba(0,0,0,0.25)",
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-display text-xs text-ivory">
                    {seatName(row.seat)}
                  </span>
                  <span className="shrink-0 font-mono text-[0.58rem] uppercase tracking-wider text-gold-soft/70">
                    {BOT_PROFILES[row.profile as keyof typeof BOT_PROFILES]?.name ?? row.profile}
                  </span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[0.7rem]">
                  <span className="text-ivory/45">
                    Really made{" "}
                    <span className="font-mono" style={{ color: netColor(row.actualNet) }}>
                      {signed(row.actualNet)}
                    </span>
                  </span>
                  <span className="font-mono" style={{ color: SIM }}>
                    sim {signed(row.simulatedNet)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className={`border p-3 ${RADIUS.control}`} style={{ borderColor: "rgba(244,237,228,0.1)", background: "rgba(0,0,0,0.2)" }}>
            <CardRow label="Board in this run" cards={result.report.board} size="sm" empty="Folded out" />
          </div>

          <div
            className={`border-2 border-dashed p-3 ${RADIUS.surface}`}
            style={{ borderColor: SIM_BORDER, background: "rgba(0,0,0,0.2)" }}
          >
            <Scrubber
              frames={result.frames}
              index={frame}
              onIndex={setFrame}
              button={report.button}
              seatCount={report.seatCount}
              focus={seat}
              seatName={seatName}
            />
          </div>
        </div>
      )}
    </div>
  );
}
