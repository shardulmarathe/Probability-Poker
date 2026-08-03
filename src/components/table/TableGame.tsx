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

import { PlayingCard } from "../PlayingCard";
import { money } from "../../lib/format";
import { TABLE_MODES, type TableMode } from "../../lib/tableOptions";
import { findProfile } from "../../poker/model/profiles";
import { positionOf } from "../../poker/table/position";
import { useTable } from "../../store/TableContext";
import type { Street } from "../../types";
import { PageHeader } from "../shell";
import { Button, ButtonLink, LINE, RADIUS, Rail, Tabs } from "../ui";
import { ActionBar } from "./Actions";
import { CoachPanel } from "./CoachPanel";
import { SeatView } from "./Seat";
import {
  ChipLayer,
  POT_CENTRE,
  PotChips,
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
      className="pp-screen relative overflow-x-hidden text-ivory"
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
      <TableStyles />

      <div
        className="pp-screen relative z-10 mx-auto flex max-w-6xl flex-col px-2 pt-3 sm:px-4 sm:pt-4"
        style={{
          paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
          paddingLeft: "max(0.5rem, env(safe-area-inset-left))",
          paddingRight: "max(0.5rem, env(safe-area-inset-right))",
        }}
      >
        <TopBar
          handNumber={table.handNumber}
          seatCount={table.seats.length}
          mode={mode}
          onMode={setMode}
          observer={options.observer}
          narrow={narrow}
        />

        {/* ------------------------------ Table ----------------------------- */}
        {/*
         * Two elements, because a real table is two things: a padded rail you
         * rest your arms on, and a bed of cloth sunk below it. `.pp-table`
         * carries the rail — its padding *is* the rail's width — and
         * `.pp-table-bed` is the cloth, inset by exactly that much. Both
         * materials live in index.css; nothing here paints — and the table's
         * minimum height lives there too, because it is the *bed* that has to
         * clear a seat, the board and the hero, and only the rail knows how
         * much of the outer box it is taking.
         */}
        <div className="pp-table mt-3 flex-1 sm:mt-4">
          <div className="pp-table-bed">
            {/* The dealer's arc, printed on the cloth. */}
            <div aria-hidden className="pp-table-arc" />

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
                      className={`pp-slot ${LG_CARD_BOX} rounded-xl sm:rounded-2xl`}
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
                  className="pp-pot-glow flex items-center gap-2 rounded-full border py-1 pl-2 pr-3 sm:pl-2.5 sm:pr-4"
                  style={{
                    borderColor: "rgba(201,162,39,0.45)",
                    background: "rgba(0,0,0,0.45)",
                  }}
                >
                  {/* The pot is chips before it is a number. */}
                  <PotChips pot={table.pot} bigBlind={options.bigBlind} />
                  <span>
                    <span className="font-mono text-[0.55rem] uppercase tracking-[0.25em] text-ivory/50">
                      Pot{" "}
                    </span>
                    <span className="font-display text-base font-bold text-gold-soft sm:text-xl">
                      {money(table.pot)}
                    </span>
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
                bigBlind={options.bigBlind}
              />
            ))}

            <ChipLayer chips={fx.chips} points={points} />
          </div>
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

/**
 * The table's own header: what this page is, what it is showing you, and how to
 * change either.
 *
 * `/table` had no `<h1>` at all — the main activity of the whole product opened
 * with a link labelled "← New table" and a chip reading "HAND #1". It also had
 * the only copy of the mode switch, whose three blurbs were `title=` attributes
 * and therefore invisible to every phone. Both fixed here: a real heading, and
 * the active mode's meaning printed under the control that sets it.
 */
function TopBar({
  handNumber,
  seatCount,
  mode,
  onMode,
  observer,
  narrow,
}: {
  handNumber: number;
  seatCount: number;
  mode: TableMode;
  onMode: (mode: TableMode) => void;
  observer: boolean;
  narrow: boolean;
}) {
  const change = (
    <ButtonLink to="/" variant="quiet" size="sm">
      {/* "Change table" and "Hand #1" and the heading do not share a 390px row,
          and the heading is the one thing that cannot wrap. */}
      {narrow ? "Change" : "Change table"}
    </ButtonLink>
  );

  return (
    <div className="flex flex-col gap-2">
      <PageHeader
        compact
        title={observer ? "The table" : "Your table"}
        lede={`${seatCount}-handed`}
        meta={
          <>
            {observer && <Rail>Watching</Rail>}
            <Rail>Hand #{handNumber}</Rail>
            {/* On a phone this is the only place the control fits without
                costing the felt a whole row of its own. */}
            {narrow && change}
          </>
        }
      />

      {/*
       * The mode switch is a setting on this screen, not a second navigation,
       * so it keeps its natural width instead of spanning the page — a
       * full-width three-up sitting under the shell's own nav read as one.
       * Its blurb sits beside it, which is the whole reason the blurb is on
       * screen at all rather than in a `title=`.
       *
       * Beside it on a wide screen. *Under* it on a phone, via the control's
       * own `showHint`: a 19rem switch and a sentence sharing a 390px row left
       * the sentence a 90px column, which set "Your equity, pot odds, and outs
       * shown while you decide." as seven lines and pushed the table 180px down
       * the screen. Same words, one line, and the felt gets the space back.
       */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="w-full max-w-[19rem] shrink-0 sm:w-[19rem]">
          <Tabs
            label="What the table shows you"
            as="options"
            layout="fill"
            size="sm"
            testIdPrefix="mode"
            showHint={narrow}
            value={mode}
            onChange={onMode}
            options={TABLE_MODES.map((m) => ({
              value: m.id,
              label: narrow ? m.name.split(" ")[0] : m.name,
              hint: m.blurb,
            }))}
          />
        </div>
        {!narrow && (
          <>
            <p
              className="min-w-0 flex-1 font-cormorant text-[0.95rem] italic leading-snug text-ivory/55"
              data-testid="mode-hint"
            >
              {TABLE_MODES.find((m) => m.id === mode)?.blurb}
            </p>
            {change}
          </>
        )}
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
      className={`mx-auto flex w-full max-w-3xl flex-col items-center gap-3 border px-4 py-3 sm:flex-row sm:justify-between ${RADIUS.surface}`}
      style={{
        borderColor: LINE.goldStrong,
        background:
          "radial-gradient(120% 140% at 50% 0%, rgba(26,74,50,0.9) 0%, rgba(11,34,24,0.9) 70%)",
      }}
    >
      <div className="text-center sm:text-left">
        <div className="text-[0.7rem] text-ivory/50">
          {showdown ? "Showdown" : "Everyone else folded"}
        </div>
        <div className="font-display text-base font-semibold text-gold-soft sm:text-lg">
          {label || "No winner"}
        </div>
      </div>
      {/* The review shares this route group's store, so the hand survives the
          hop. See the `/review` routes in App.tsx. */}
      <div className="flex w-full flex-wrap items-center justify-center gap-2 sm:w-auto">
        <ButtonLink to="/review" size="md" testId="open-review">
          See how it was played
        </ButtonLink>
        <Button data-testid="next-hand" variant="primary" size="md" onClick={onNext}>
          {observer ? "Deal the next hand" : "Deal me another"}
        </Button>
      </div>
    </div>
  );
}
