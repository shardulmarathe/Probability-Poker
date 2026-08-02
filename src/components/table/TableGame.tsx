/**
 * The N-handed table.
 *
 * Seats sit on an ellipse sized from the seat count, with the human pinned
 * bottom-centre and everyone else spread around the top arc. Below the felt sit
 * the two things the heads-up table never needed: a sizing control, because
 * No-Limit makes "how much" the actual decision, and a mode-gated readout of
 * what the interface is allowed to tell you.
 *
 * The modes gate *this file* and nothing else. `TableContext` never reads
 * `mode` before deciding anything, so switching to Study reveals cards without
 * changing a single bot's information set — which is what makes a hand studied
 * the same hand as a hand played.
 */

import { Link } from "react-router-dom";
import { PlayingCard } from "../PlayingCard";
import { money } from "../../lib/format";
import { TABLE_MODES, type TableMode } from "../../lib/tableOptions";
import { findProfile } from "../../poker/model/profiles";
import { positionOf } from "../../poker/table/position";
import { useTable } from "../../store/TableContext";
import type { Street } from "../../types";
import { ActionBar } from "./Actions";
import { CoachPanel } from "./CoachPanel";
import { SeatView } from "./Seat";
import {
  ChipLayer,
  FeltBackground,
  POT_CENTRE,
  Rail,
  TableStyles,
  boardTop,
  seatLayout,
  useNarrow,
} from "./chrome";

/**
 * The empty community slots, kept in step with `PlayingCard`'s `lg` footprint
 * so a slot and the card that lands in it are the same size. The board is `lg`
 * rather than `xl`: at four-handed a seat sits directly above it, and the
 * larger card leaves no room for both.
 */
const LG_CARD_BOX = "h-[clamp(5rem,17vw,7rem)] w-[clamp(3.5rem,12.2vw,5rem)]";

const STREET_LABEL: Record<Street, string> = {
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

export default function TableGame() {
  const {
    table,
    options,
    mode,
    heroSeat,
    legalActions,
    sizings,
    fx,
    reads,
    heroRead,
    lastReport,
    act,
    nextHand,
    setMode,
  } = useTable();

  const narrow = useNarrow();
  const points = seatLayout(table.seats.length, narrow);
  const playing = table.status === "playing";
  const handOver = !playing && !!lastReport;
  const heroTurn = playing && heroSeat !== null && table.toAct === heroSeat;

  // Reveal rules, in order of precedence: Study and observer show everything;
  // a showdown shows the hands that got there (a fold-out winner keeps its
  // cards, as at a real table); the human always sees its own.
  const showdownSeats = new Set(
    (lastReport?.seats ?? []).filter((s) => s.final !== null).map((s) => s.seat)
  );
  const revealAll = mode === "study" || options.observer;
  const revealed = (id: number) =>
    revealAll || id === heroSeat || (handOver && showdownSeats.has(id));

  const wonBy = new Map<number, number>();
  if (handOver && lastReport) {
    for (const s of lastReport.seats) if (s.won > 0) wonBy.set(s.seat, s.won);
  }

  const decisionKey = `${table.handNumber}:${table.street}:${table.actions.length}`;

  return (
    <main
      className="relative min-h-[100svh] overflow-x-hidden text-ivory"
      data-testid="table"
      data-hand={table.handNumber}
      data-status={table.status}
      data-street={table.street}
      data-seats={table.seats.length}
      data-pot={table.pot}
      data-rebuys={table.rebuys}
      data-busy={fx.busy ? "1" : "0"}
      data-mode={mode}
    >
      <FeltBackground />
      <TableStyles />

      <div
        className="relative z-10 mx-auto flex min-h-[100svh] max-w-6xl flex-col px-2 pt-3 sm:px-4 sm:pt-4"
        style={{
          paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
          paddingLeft: "max(0.5rem, env(safe-area-inset-left))",
          paddingRight: "max(0.5rem, env(safe-area-inset-right))",
        }}
      >
        <TopBar
          handNumber={table.handNumber}
          mode={mode}
          onMode={setMode}
          observer={options.observer}
          narrow={narrow}
        />

        {/* ------------------------------ Felt ------------------------------ */}
        <div
          className="relative mt-3 min-h-[25rem] flex-1 rounded-[1.75rem] border shadow-2xl sm:mt-4 sm:min-h-[32rem] sm:rounded-[2.5rem]"
          style={{
            borderColor: "rgba(201,162,39,0.35)",
            background:
              "radial-gradient(115% 85% at 50% 20%, #1a4a32 0%, #123524 46%, #0b2218 100%)",
            boxShadow:
              "0 30px 70px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(11,34,24,0.6), inset 0 0 120px rgba(0,0,0,0.45)",
          }}
        >
          {/* Table rim */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-[4%] inset-y-[6%] rounded-[50%] border"
            style={{ borderColor: "rgba(201,162,39,0.13)" }}
          />

          {/* Centre: the board, with the street and pot read out beneath it */}
          <div
            className="absolute z-[5] flex w-full flex-col items-center gap-2 px-2 sm:gap-2.5"
            style={{
              left: `${POT_CENTRE.x}%`,
              top: `${boardTop(narrow)}%`,
              transform: "translate(-50%, 0)",
            }}
          >
            <div className="flex items-center justify-center gap-1 sm:gap-2.5">
              {[0, 1, 2, 3, 4].map((i) => {
                const card = table.board[i];
                const dealt = i < fx.dealtCount && !!card;
                return dealt ? (
                  <div key={`c-${i}`} className="pp-deal">
                    <PlayingCard card={card} size="lg" />
                  </div>
                ) : (
                  <div
                    key={`s-${i}`}
                    className={`${LG_CARD_BOX} rounded-xl border border-dashed sm:rounded-2xl`}
                    style={{ borderColor: "rgba(244,237,228,0.12)" }}
                  />
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <span
                className="rounded-full border px-3 py-1 font-display text-[0.6rem] font-semibold uppercase tracking-[0.25em] sm:px-4 sm:text-[0.68rem] sm:tracking-[0.3em]"
                style={{
                  borderColor: "rgba(201,162,39,0.4)",
                  color: "#e2c563",
                  background: "rgba(0,0,0,0.4)",
                }}
              >
                {STREET_LABEL[table.street]}
              </span>
              <span
                data-testid="pot"
                className="pp-pot-glow rounded-full border px-3 py-1 sm:px-4"
                style={{
                  borderColor: "rgba(201,162,39,0.45)",
                  background: "rgba(0,0,0,0.45)",
                }}
              >
                <span className="font-mono text-[0.55rem] uppercase tracking-[0.25em] text-ivory/50">
                  Pot{" "}
                </span>
                <span className="font-display text-base font-bold text-gold-soft sm:text-xl">
                  {money(table.pot)}
                </span>
              </span>
            </div>
          </div>

          {/* Seats */}
          {table.seats.map((seat) => (
            <SeatView
              key={seat.id}
              seat={seat}
              point={points[seat.id]}
              position={positionOf(seat.id, table.button, table.seats.length)}
              profile={findProfile(seat.profile ?? "") ?? null}
              active={playing && table.toAct === seat.id}
              reveal={revealed(seat.id)}
              hero={seat.id === heroSeat}
              compact={narrow && seat.id !== heroSeat}
              fx={fx.seats[seat.id] ?? { bubble: null, thinking: null }}
              read={mode === "study" ? (reads[seat.id] ?? null) : null}
              won={wonBy.get(seat.id) ?? null}
              showBlurb={mode === "study" && !narrow}
            />
          ))}

          <ChipLayer chips={fx.chips} points={points} />
        </div>

        {/* ---------------------------- Controls ---------------------------- */}
        <div className="mt-3 flex min-h-[6rem] flex-col justify-end gap-2">
          <CoachPanel
            mode={mode}
            read={heroRead}
            active={heroTurn && !fx.busy}
            actions={legalActions}
            seats={table.seats}
            narrow={narrow}
          />

          {handOver ? (
            <ResultStrip
              names={table.seats.map((s) => s.name)}
              winners={[...wonBy.entries()]}
              showdown={lastReport!.wentToShowdown}
              observer={options.observer}
              onNext={nextHand}
            />
          ) : heroTurn && legalActions.length > 0 ? (
            <ActionBar
              actions={legalActions}
              sizings={sizings}
              decisionKey={decisionKey}
              pot={table.pot}
              stack={table.seats[heroSeat!].stack}
              narrow={narrow}
              onAct={act}
            />
          ) : (
            <p className="py-4 text-center font-cormorant text-base italic text-ivory/40">
              {fx.busy ? "Watching the table…" : " "}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function TopBar({
  handNumber,
  mode,
  onMode,
  observer,
  narrow,
}: {
  handNumber: number;
  mode: TableMode;
  onMode: (mode: TableMode) => void;
  observer: boolean;
  narrow: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link
        to="/"
        className="font-display text-xs tracking-wide text-ivory/70 transition hover:text-ivory sm:text-sm"
      >
        ← New table
      </Link>

      <div className="flex items-center gap-1.5 sm:gap-2">
        <div
          className="flex items-center gap-0.5 rounded-lg border p-0.5"
          style={{
            borderColor: "rgba(201,162,39,0.3)",
            background: "rgba(0,0,0,0.35)",
          }}
        >
          {TABLE_MODES.map((m) => (
            <button
              key={m.id}
              data-testid={`mode-${m.id}`}
              onClick={() => onMode(m.id)}
              title={m.blurb}
              className="rounded-md px-2 py-1 font-display text-[0.62rem] tracking-wide transition sm:px-3 sm:text-xs"
              style={{
                background: mode === m.id ? "rgba(201,162,39,0.25)" : "transparent",
                color: mode === m.id ? "#e2c563" : "rgba(244,237,228,0.6)",
              }}
            >
              {narrow ? m.name.split(" ")[0] : m.name}
            </button>
          ))}
        </div>
        {/* The hand review shares this route group's store, so the history
            survives the hop. See the `/review` routes in App.tsx. */}
        <Link
          to="/review"
          data-testid="open-review"
          className="rounded-full border px-2.5 py-1 font-display text-[0.6rem] uppercase tracking-[0.18em] transition hover:-translate-y-px sm:text-[0.65rem]"
          style={{
            borderColor: "rgba(201,162,39,0.5)",
            background: "rgba(201,162,39,0.12)",
            color: "#e2c563",
          }}
        >
          Review
        </Link>
        {observer && <Rail>WATCHING</Rail>}
        <Rail>HAND #{handNumber}</Rail>
      </div>
    </div>
  );
}

function ResultStrip({
  names,
  winners,
  showdown,
  observer,
  onNext,
}: {
  names: string[];
  winners: [number, number][];
  showdown: boolean;
  observer: boolean;
  onNext: () => void;
}) {
  const label = winners
    .map(([id, amount]) => `${names[id]} ${money(amount)}`)
    .join(" · ");

  return (
    <div
      data-testid="result"
      className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 rounded-2xl border px-4 py-3 sm:flex-row sm:justify-between"
      style={{
        borderColor: "rgba(201,162,39,0.4)",
        background:
          "radial-gradient(120% 140% at 50% 0%, rgba(26,74,50,0.9) 0%, rgba(11,34,24,0.9) 70%)",
      }}
    >
      <div className="text-center sm:text-left">
        <div className="font-mono text-[0.55rem] uppercase tracking-[0.3em] text-ivory/45">
          {showdown ? "Showdown" : "Everyone folded"}
        </div>
        <div className="font-display text-base font-semibold text-gold-soft sm:text-lg">
          {label || "No winner"}
        </div>
      </div>
      <button
        data-testid="next-hand"
        onClick={onNext}
        className="min-h-[46px] w-full rounded-xl border border-pkred-light/70 bg-pkred/80 px-6 py-2.5 font-display text-sm font-semibold tracking-wide text-ivory transition hover:-translate-y-0.5 hover:bg-pkred-light sm:w-auto"
      >
        {observer ? "Deal next hand" : "Next hand"}
      </button>
    </div>
  );
}
