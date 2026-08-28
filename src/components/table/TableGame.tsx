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
 * changing a single bot's information set, which is what makes a hand studied
 * the same hand as a hand played.
 */

import { useMemo } from "react";
import { HandCategory } from "../../types";
import { LG_CARD_BOX, MD_CARD_BOX, PlayingCard } from "../PlayingCard";
import { money } from "../../lib/format";
import { TABLE_MODES, type TableMode } from "../../lib/tableOptions";
import { findProfile } from "../../poker/model/profiles";
import { positionOf } from "../../poker/table/position";
import { useTable, type DrillVerdict } from "../../store/TableContext";
import type { Street } from "../../types";
import { PageHeader } from "../shell";
import { Button, ButtonLink, LINE, RADIUS, Rail, Tabs } from "../ui";
import { ActionBar } from "./Actions";
import { CoachPanel, DrillLine } from "./CoachPanel";
import { SeatView } from "./Seat";
import { TableChrome } from "./TableChrome";
import { Thinking } from "./Thinking";
import {
  ChipLayer,
  PotChips,
  TableStyles,
  boardTop,
  feltSize,
  potCentre,
  seatLayout,
  useNarrow,
  useWide,
} from "./chrome";

const STREET_LABEL: Record<Street, string> = {
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

/**
 * How a made hand is spoken, not how it is titled.
 *
 * `HAND_CATEGORY_NAMES` is a label, "Pair", "Flush", and lowercasing it after
 * the word "with" produces "with pair" and "with flush". These carry their own
 * articles so the showdown line reads as a sentence.
 */
const MADE_HAND: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "high card",
  [HandCategory.Pair]: "a pair",
  [HandCategory.TwoPair]: "two pair",
  [HandCategory.ThreeOfAKind]: "trips",
  [HandCategory.Straight]: "a straight",
  [HandCategory.Flush]: "a flush",
  [HandCategory.FullHouse]: "a full house",
  [HandCategory.FourOfAKind]: "quads",
  [HandCategory.StraightFlush]: "a straight flush",
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
    drillVerdict,
    dismissDrill,
  } = useTable();

  const narrow = useNarrow();
  const wide = useWide();
  const felt = feltSize(narrow, wide);
  const points = seatLayout(table.seats.length, felt);
  const playing = table.status === "playing";
  const handOver = !playing && !!lastReport;
  const heroTurn = playing && heroSeat !== null && table.toAct === heroSeat;

  /*
   * What each winner actually held, by seat. A showdown that only says who was
   * paid teaches nothing, the point of the table is that a player can see
   * *why* the chips moved. Folded seats have a null `final` and are skipped,
   * which is also why this is empty when everyone else folded.
   */
  const madeHands = useMemo(() => {
    const out = new Map<number, string>();
    for (const seat of lastReport?.seats ?? []) {
      if (seat.final) out.set(seat.seat, MADE_HAND[seat.final.category]);
    }
    return out;
  }, [lastReport]);

  /*
   * The pot chip, once the hand is over. `table.pot` is zero by then, the
   * chips have been pushed, and a showdown captioned "Pot $0" reads as a bug.
   * The total that was contested is the sum of the layers instead.
   */
  const potShown = handOver
    ? (lastReport?.pots ?? []).reduce((n, layer) => n + layer.amount, 0)
    : table.pot;

  // Which seat is narrating, if any. On a phone its panel is rendered below the
  // felt rather than beside the chair, so the whole screen needs to know.
  const thinkingId = table.seats.find((s) => fx.seats[s.id]?.thinking)?.id;
  const thinkingSeat =
    thinkingId === undefined
      ? null
      : {
          name: table.seats[thinkingId].name,
          step: fx.seats[thinkingId].thinking!,
        };

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
  /*
   * What the hand was worth to each seat, signed. Distinct from `won`, which is
   * the pot collected and includes the seat's own money, announcing "+$2010"
   * beside a player who profited $1010 overstates it, and says nothing at all
   * to the seat that paid for it. Every seat that put chips in gets a number.
   */
  const netBy = new Map<number, number>();
  if (handOver && lastReport) {
    for (const s of lastReport.seats) {
      if (s.won > 0) wonBy.set(s.seat, s.won);
      if (s.net !== 0) netBy.set(s.seat, s.net);
    }
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
        {/*
         * Wide screens hang the mode switch and the hand rail in the app bar
         * and keep nothing of the old header row but the heading, which stays
         * as the document outline's first entry. Losing it would leave a screen
         * reader's outline for the main activity of the product starting at
         * "Hand #4", which is the bug `PageHeader` was written to fix.
         *
         * Below `lg` the bar is already full at four nav links, so the page
         * keeps its own row.
         */}
        {wide ? (
          <>
            <h1 className="sr-only">
              {options.observer ? "The table" : "Your table"}
            </h1>
            <TableChrome
              handNumber={table.handNumber}
              seatCount={table.seats.length}
              mode={mode}
              onMode={setMode}
              observer={options.observer}
            />
          </>
        ) : (
          <TopBar
            handNumber={table.handNumber}
            seatCount={table.seats.length}
            mode={mode}
            onMode={setMode}
            observer={options.observer}
            narrow={narrow}
          />
        )}

        {/* ------------------------------ Table ----------------------------- */}
        {/*
         * Two elements, because a real table is two things: a padded rail you
         * rest your arms on, and a bed of cloth sunk below it. `.pp-table`
         * carries the rail, its padding *is* the rail's width, and
         * `.pp-table-bed` is the cloth, inset by exactly that much. Both
         * materials live in index.css; nothing here paints, and the table's
         * minimum height lives there too, because it is the *bed* that has to
         * clear a seat, the board and the hero, and only the rail knows how
         * much of the outer box it is taking.
         */}
        {/* `lg:mt-0`: at `lg` the row this was clearing is in the app bar, and
            a margin under nothing is 16px of the budget for free. */}
        <div className="pp-table mt-3 flex-1 sm:mt-4 lg:mt-0">
          <div className="pp-table-bed">
            {/* The dealer's arc, printed on the cloth. */}
            <div aria-hidden className="pp-table-arc" />

            {/*
             * Centre: the board, with the street and pot read out beside it at
             * `lg` and beneath it below that.
             *
             * Beside, because underneath cost a 34px row plus its gap directly
             * under the community cards, and that row is what set the board's
             * height in the no-overlap sum in `chrome.tsx`. Lifting it out
             * takes the whole block from 150px to the height of one card, which
             * is where the felt found the room to drop its seat arc into the
             * middle of the cloth. Under `lg` the bed is not wide enough to
             * hold five large cards and a pot readout side by side, so those
             * widths keep the stack, and `chrome.tsx` keeps the geometry that
             * goes with it.
             */}
            <div
              className="absolute z-[5] flex w-full flex-col items-center gap-2 px-2 sm:gap-2.5"
              style={{
                left: `${potCentre(felt).x}%`,
                top: `${boardTop(felt)}%`,
                transform: "translate(-50%, 0)",
              }}
            >
              <div className="flex items-center justify-center gap-1 sm:gap-2.5">
                {[0, 1, 2, 3, 4].map((i) => {
                  const card = table.board[i];
                  const dealt = i < fx.dealtCount && !!card;
                  const slot = narrow ? MD_CARD_BOX : LG_CARD_BOX;
                  return dealt ? (
                    <div key={`c-${i}`} className="pp-deal">
                      <PlayingCard card={card} size={narrow ? "md" : "lg"} />
                    </div>
                  ) : (
                    <div
                      key={`s-${i}`}
                      className={`pp-slot ${slot} rounded-xl sm:rounded-2xl`}
                    />
                  );
                })}
              </div>

              {/* Taken out of flow at `lg` rather than made a flex sibling of
                  the cards: as a sibling the pair would be centred *with* the
                  board, which slides the flop off the table's own axis. Pinned
                  to 14rem right of centre it clears the widest board (5 × 5rem
                  plus gaps) and the cards stay where the felt is drawn around
                  them. */}
              <div className="flex items-center gap-2 lg:absolute lg:left-1/2 lg:top-1/2 lg:ml-[14rem] lg:-translate-y-1/2 lg:flex-col lg:items-start lg:gap-1.5">
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
                  <PotChips pot={potShown} bigBlind={options.bigBlind} />
                  <span>
                    <span className="font-mono text-[0.55rem] uppercase tracking-[0.25em] text-ivory/50">
                      Pot{" "}
                    </span>
                    <span className="font-display text-base font-bold text-gold-soft sm:text-xl">
                      {money(potShown)}
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
                net={netBy.get(seat.id) ?? null}
                settled={handOver}
                showBlurb={mode === "study" && !narrow}
                bigBlind={options.bigBlind}
              />
            ))}

            <ChipLayer
              chips={fx.chips}
              points={points}
              centre={potCentre(felt)}
            />

            {/*
             * The deciding bot's transcript, on a rail rather than on its chair.
             *
             * It hung off the thinking seat until this round, which read well
             * and covered the flop: a chair on the top arc opens downward, and
             * at four-handed the chair above the board *is* the one above the
             * board. Every other direction runs into a neighbouring seat or off
             * the cloth, so it lives here instead, in the one strip of felt that
             * is guaranteed empty at every table size, below the board and to
             * the left of the hero. The seat's name goes inside the panel so the
             * narration is still attached to a player.
             *
             * The top is the board's own anchor plus a card (7rem) and a gap,
             * so the rail cannot reach the community cards however tall the bed
             * grows. `bottom` closes the box, which makes the panel's ceiling
             * the space that is actually free rather than a number guessed here,
             * and at the felt's floor height that is about 100px, which is what
             * caps the transcript at three stages.
             */}
            {wide && thinkingSeat && (
              <div
                className="pointer-events-none absolute z-30 flex items-end"
                style={{
                  left: "1.5rem",
                  width: "min(15rem, 24%)",
                  top: `calc(${boardTop(felt)}% + 8.25rem)`,
                  bottom: "1.25rem",
                }}
              >
                <Thinking
                  step={thinkingSeat.step}
                  rail
                  who={thinkingSeat.name}
                  className="max-h-full"
                />
              </div>
            )}
          </div>
        </div>

        {/* ---------------------------- Controls ---------------------------- */}
        {/* The old `sm:min-h-[6rem]` reserved room for the in-flow sizing
            panel, which is now a popover over the felt. Left in place it was
            44px of empty column directly above the buttons this round exists
            to bring back on screen. */}
        <div className="mt-2 flex min-h-[4.25rem] flex-col justify-end gap-1.5 sm:mt-3 sm:gap-2">
          <CoachPanel
            mode={mode}
            read={heroRead}
            active={heroTurn && !fx.busy}
            actions={legalActions}
            seats={table.seats}
            narrow={narrow}
            handOver={handOver}
          />

          {handOver ? (
            <ResultStrip
              names={table.seats.map((s) => s.name)}
              winners={[...wonBy.entries()]}
              showdown={lastReport!.wentToShowdown}
              madeHands={madeHands}
              observer={options.observer}
              onNext={nextHand}
              drill={mode === "drill" ? drillVerdict : null}
              onDismissDrill={dismissDrill}
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
          ) : !wide && thinkingSeat ? (
            /*
             * Below `lg` the narration does not fit on the cloth at all: the
             * felt is too narrow for the rail to clear the board. It docks
             * here, one live stage, and the gold-ringed seat is who is
             * deciding. The extra "X is deciding" line used to stack on the
             * transcript and steal a row the felt needed.
             */
            <Thinking step={thinkingSeat.step} compact who={thinkingSeat.name} />
          ) : (
            <p className="py-2 text-center font-cormorant text-sm italic text-ivory/40 sm:py-4 sm:text-base">
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
 * The table's own header, below `lg` only: what this page is, what it is
 * showing you, and how to change either.
 *
 * `/table` had no `<h1>` at all, the main activity of the whole product opened
 * with a link labelled "← New table" and a chip reading "HAND #1". It also had
 * the only copy of the mode switch, whose blurbs were `title=` attributes and
 * therefore invisible to every phone. Both fixed here: a real heading, and the
 * active mode's meaning printed under the control that sets it.
 *
 * From `lg` up this is not rendered at all and `TableChrome` puts the same
 * controls in the app bar, because the row is worth ~114px and a 760px window
 * has no 114px to spare between the felt and the buttons. It survives at the
 * smaller widths because the bar there is already full of nav.
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

  const modes = (
    <Tabs
      label="What the table shows you"
      as="options"
      layout="fill"
      size="sm"
      testIdPrefix="mode"
      showHint={false}
      value={mode}
      onChange={onMode}
      options={TABLE_MODES.map((m) => ({
        value: m.id,
        label: narrow ? m.name.split(" ")[0] : m.name,
        hint: m.blurb,
      }))}
    />
  );

  return (
    <div className="flex flex-col gap-1.5 sm:gap-2">
      <PageHeader
        compact
        title={observer ? "The table" : "Your table"}
        lede={`${seatCount}-handed`}
        meta={
          <>
            {observer && <Rail>Watching</Rail>}
            <Rail>Hand #{handNumber}</Rail>
            {narrow && change}
          </>
        }
      />

      {/*
       * Phone: modes get their own full-width row. Stuffing them into the
       * heading next to Hand and Change wrapped into a jumble. Desktop keeps
       * the switch, the blurb, and Change table on one line.
       */}
      {narrow ? (
        <div className="w-full">{modes}</div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="w-full max-w-[19rem] shrink-0 sm:w-[19rem]">{modes}</div>
          <p
            className="min-w-0 flex-1 font-cormorant text-[0.95rem] italic leading-snug text-ivory/55"
            data-testid="mode-hint"
          >
            {TABLE_MODES.find((m) => m.id === mode)?.blurb}
          </p>
          {change}
        </div>
      )}
    </div>
  );
}

function ResultStrip({
  names,
  winners,
  showdown,
  madeHands,
  observer,
  onNext,
  drill,
  onDismissDrill,
}: {
  names: string[];
  winners: [number, number][];
  showdown: boolean;
  /** Seat → the hand it showed down with. Empty when nobody showed. */
  madeHands: Map<number, string>;
  observer: boolean;
  onNext: () => void;
  /**
   * Drill's verdict on the hand that just ended, if it had one to give.
   *
   * It renders here rather than in its own row above: the one-screen lock has
   * no height for both, and clipping this block means clipping "Deal me
   * another". It also reads better, the strip already says what happened and
   * this says what it cost.
   */
  drill: DrillVerdict | null;
  onDismissDrill: () => void;
}) {
  const label = winners
    .map(([id, amount]) => `${names[id]} ${money(amount)}`)
    .join(" · ");

  /*
   * "Callin' Carla $3000" says who was paid. It does not say why, and the whole
   * table exists to answer why, so the winning hand is named right where the
   * chips are announced rather than one click away in the review.
   *
   * Only at a showdown: when everyone else folds, the winner's cards were never
   * shown, and naming them here would leak a hand the table never revealed.
   */
  const won = showdown
    ? winners
        .map(([id]) => madeHands.get(id))
        .filter((n): n is string => !!n)
    : [];
  const withHand = won.length > 0 ? [...new Set(won)].join(" · ") : null;

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
        {withHand && (
          <div className="font-cormorant text-sm italic text-ivory/60">
            with {withHand}
          </div>
        )}
        {drill && (
          <div className="mt-1.5 max-w-full">
            <DrillLine verdict={drill} onDismiss={onDismissDrill} />
          </div>
        )}
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
