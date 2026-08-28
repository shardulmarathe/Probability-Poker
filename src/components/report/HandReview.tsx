/**
 * The hand review.
 *
 * Three tabs, one question each: what happened, what they had, and what you
 * did. Splitting it that way rather than by data source is deliberate, the same
 * equity estimate shows up on all three of these pages, answering a different
 * question every time.
 *
 * There was a fourth, `Math`, holding every derivation in the product in one
 * 13,000px scroll. It is gone as a tab and not as content: each derivation now
 * renders inside a `HowCalculated` disclosure next to the number it explains,
 * on whichever tab already shows that number (see `./derivations`). A tab whose
 * honest label is "the rest of it" is a filing cabinet, not a question.
 *
 * ## Where the hands come from
 *
 * The archive, not the table. This page used to read `history` off
 * `TableContext`, which is component state: it dies with the tab. That was
 * survivable while `/review` was reachable only by playing a hand and clicking
 * through from the felt, and stopped being survivable the moment the shell put
 * Review in the navigation, a player with fifty archived hands could land here
 * directly, or simply reload, and be told they had never played one while
 * `/profile` two tabs over listed all fifty.
 *
 * So the archive is the source of truth and the session is the part of it that
 * has not been written yet. The merge is `mergeHands`, the profile's own, so
 * the two pages cannot disagree about what was played, and it keeps the live
 * copy of a hand played this session on purpose: storage strips each report's
 * per-decision audit trail, and all three tabs read it. A hand restored from
 * storage says so rather than quietly showing empty panels.
 *
 * ## The chrome budget
 *
 * Thirteen controls in four stacked rows used to push the first sentence of
 * actual content to y=420 on an 874px screen, so half of the first screen of a
 * reading page was furniture. Two rows now: the hand and its navigation, then
 * the tabs and the seat the review is written from. The tab blurbs moved into
 * the panels they describe (they were pinned inside the sticky bar, costing
 * their height on every scroll position), and the seat chips became a `select`,
 * which is what four to six mutually exclusive options are.
 */

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { money } from "../../lib/format";
import type { TableHandReport } from "../../poker/table/contract";
import { useTable } from "../../store/TableContext";
import { loadArchive, mergeHands } from "../profile/store";
import { BackLink, PageBody, PageHeader } from "../shell";
import {
  Button,
  ButtonLink,
  EmptyState,
  LINE,
  Note,
  RADIUS,
  StickyTabs,
  Tabs,
  netTone,
} from "../ui";
import { HandTab } from "./HandTab";
import { PlayTab } from "./PlayTab";
import { RangeGridStyles } from "./RangeGrid";
import { RangesTab } from "./RangesTab";
import { STREET_LABEL, seatResult } from "./derive";

type TabId = "hand" | "ranges" | "play";

/**
 * The blurbs used to live in `title=` attributes, which no touch device has
 * ever shown to anyone, and then under the tab row inside `StickyTabs`, where
 * they were pinned to the top of the viewport for the whole length of a
 * three-screen panel. They print as the first line of the panel they describe:
 * read once, then scrolled past like any other sentence.
 */
const TABS: { id: TabId; label: string; blurb: string }[] = [
  { id: "hand", label: "Hand", blurb: "What happened, and what it cost each seat." },
  { id: "ranges", label: "Ranges", blurb: "What the table thought everyone held." },
  { id: "play", label: "Your play", blurb: "Every decision, re-priced two ways." },
];

/** Cards in the strip at the foot of the page. The archive holds up to 400. */
const STRIP = 24;

/** The two pickers in the header, so they read as one row of controls. */
const FIELD = `min-h-[34px] max-w-[16rem] truncate border px-2.5 py-1.5 font-display text-xs text-ivory outline-none sm:text-sm ${RADIUS.action}`;
const FIELD_STYLE = { borderColor: LINE.gold, background: "rgba(0,0,0,0.4)" };

/**
 * Which session each hand belongs to, oldest session numbered 1.
 *
 * Hand numbers restart at 1 with every new table, so an archive spanning three
 * sessions holds three different hands all labelled "Hand #1", and the strip
 * printed that label three times with three different results under it. `hands`
 * is chronological and deliberately never re-sorted, so a hand number that does
 * not climb is exactly where one session ended and the next began. Numbering
 * those runs gives every hand a label no other hand in the archive can wear.
 *
 * The deal seed would also be unique, and it is what the URL carries, but
 * "Hand #1 · 4013277781" is not something a reader can hold in their head while
 * comparing two hands.
 */
function sessionsOf(hands: TableHandReport[]): {
  of: (seed: number) => number;
  count: number;
} {
  const index = new Map<number, number>();
  let session = 0;
  let previous = Number.POSITIVE_INFINITY;
  for (const hand of hands) {
    if (hand.handNumber <= previous) session++;
    previous = hand.handNumber;
    index.set(hand.seed, session);
  }
  return { of: (seed) => index.get(seed) ?? session, count: session };
}

export default function HandReview() {
  const { history, lastReport, table, heroSeat } = useTable();
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("hand");

  // `history` lags a render behind, the store appends to it in an effect, so
  // the hand that just ended is still only in `lastReport`.
  const live = useMemo(() => {
    if (!lastReport) return history;
    return history.some((r) => r.seed === lastReport.seed)
      ? history
      : [...history, lastReport];
  }, [history, lastReport]);

  // Oldest first, deduplicated by deal seed, live copies winning. Deliberately
  // not re-sorted by hand number: those restart at 1 with every new table, so
  // sorting by them would shuffle three sessions into each other.
  const hands = useMemo(() => mergeHands(loadArchive().hands, live), [live]);
  const liveSeeds = useMemo(() => new Set(live.map((r) => r.seed)), [live]);
  const sessions = useMemo(() => sessionsOf(hands), [hands]);

  // Hand numbers restart with every table, so an archive spanning sessions can
  // hold several hand #3s and the route parameter alone cannot tell them apart.
  // `/review/:handNumber` is unchanged and still resolves to the most recent
  // match, which is what a link written today meant; every link this page
  // writes also carries `?seed=`, which is unique, so choosing the older of two
  // hand #3s in the picker opens the hand whose label you actually read rather
  // than a different hand wearing the same number.
  const requested = params.handNumber ? Number(params.handNumber) : undefined;
  const requestedSeed = search.get("seed");
  const report = useMemo(() => {
    if (requestedSeed !== null) {
      const exact = hands.find((r) => String(r.seed) === requestedSeed);
      if (exact) return exact;
    }
    if (requested !== undefined) {
      for (let i = hands.length - 1; i >= 0; i--) {
        if (hands[i].handNumber === requested) return hands[i];
      }
    }
    return hands[hands.length - 1] ?? null;
  }, [hands, requested, requestedSeed]);

  /** A hand that came back from storage has no decisions attached. See below. */
  const restored = report !== null && !liveSeeds.has(report.seed);

  const href = (r: TableHandReport) => `/review/${r.handNumber}?seed=${r.seed}`;
  /** "Session 2 · " when the archive holds more than one table's worth. */
  const era = (r: TableHandReport) =>
    sessions.count > 1 ? `Session ${sessions.of(r.seed)} · ` : "";

  // Seat names belong to the table, not to a hand, so they are only trustworthy
  // for a table the same size as the one that dealt it. A six-max hand read
  // while sitting three-handed gets "Seat 4", not whoever is in chair 4 now.
  const seatName = useMemo(() => {
    const named =
      report !== null && table.seats.length === report.seatCount
        ? table.seats.map((s) => s.name)
        : [];
    return (seat: number) =>
      named[seat] ?? (seat === heroSeat ? "You" : `Seat ${seat + 1}`);
  }, [table.seats, report, heroSeat]);

  // The seat the review is written from. The human when there is one; otherwise
  // the seat that put the most chips in, which is the hand worth reading.
  const defaultFocus = useMemo(() => {
    if (heroSeat !== null) return heroSeat;
    if (!report) return 0;
    return report.seats.reduce(
      (best, s) => (s.invested > (seatResult(report, best)?.invested ?? -1) ? s.seat : best),
      report.seats[0]?.seat ?? 0
    );
  }, [heroSeat, report]);
  // The override is sticky across hands, and the archive mixes table sizes: seat
  // 5 picked on a six-max hand does not exist in the heads-up hand before it.
  // Fall back rather than render a seat the hand never had.
  const [focusOverride, setFocusOverride] = useState<number | null>(null);
  const focus =
    focusOverride !== null && report?.seats.some((s) => s.seat === focusOverride)
      ? focusOverride
      : defaultFocus;
  const isHero = heroSeat !== null && focus === heroSeat;

  const index = report ? hands.findIndex((r) => r.seed === report.seed) : -1;
  const strip = useMemo(() => hands.slice(-STRIP).reverse(), [hands]);
  const blurb = TABS.find((t) => t.id === tab)?.blurb ?? "";

  return (
    <main
      className="relative overflow-x-hidden text-ivory"
      data-testid="review"
      data-tab={tab}
      data-hands={hands.length}
      data-hand={report?.handNumber ?? ""}
    >
      <RangeGridStyles />

      <PageBody width="full">
        {/*
         * Row one. The back-link earns its place, `/review` is entered from the
         * felt, but not a row of its own: it sits in the header line beside the
         * title it returns from. Nav handles all other movement.
         *
         * The "N hands" rail that used to sit here is gone rather than moved:
         * the strip at the foot of the page already opens with "All 12 of your
         * hands", so the header was printing a count the page states again 800
         * pixels lower.
         */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <BackLink to="/table">Table</BackLink>
          <div className="min-w-0 flex-1">
            <PageHeader
              compact
              title="Hand review"
              lede={
                // Both facts, not one: a showdown reached on the turn is a
                // table that got all in early, and "showdown" alone would drop
                // the street the old lede stated.
                report
                  ? `${era(report)}Hand #${report.handNumber} · ${report.seatCount}-handed · ${
                      report.wentToShowdown ? "showdown" : "folded out"
                    } on the ${STREET_LABEL[report.endStreet].toLowerCase()}`
                  : "Every finished hand, opened up."
              }
              actions={
                <>
                  {hands.length > 0 && (
                    <>
                      <Button
                        size="sm"
                        variant="quiet"
                        data-testid="review-prev"
                        disabled={index <= 0}
                        onClick={() => navigate(href(hands[index - 1]))}
                        aria-label="Previous hand"
                      >
                        ‹
                      </Button>
                      {/*
                       * Keyed by seed rather than by hand number: two sessions
                       * can both contain a hand #1, and a `<select>` whose two
                       * options carry the same value cannot tell them apart
                       * however carefully they are labelled.
                       */}
                      <select
                        data-testid="review-select"
                        aria-label="Hand to review"
                        value={report?.seed ?? ""}
                        onChange={(e) => {
                          const picked = hands.find(
                            (r) => String(r.seed) === e.target.value
                          );
                          if (picked) navigate(href(picked));
                        }}
                        className={FIELD}
                        style={FIELD_STYLE}
                      >
                        {hands
                          .slice()
                          .reverse()
                          .map((r) => (
                            <option key={r.seed} value={r.seed} className="bg-[#0b2218]">
                              {era(r)}Hand #{r.handNumber} · {r.seatCount}-handed
                            </option>
                          ))}
                      </select>
                      <Button
                        size="sm"
                        variant="quiet"
                        data-testid="review-next"
                        disabled={index < 0 || index >= hands.length - 1}
                        onClick={() => navigate(href(hands[index + 1]))}
                        aria-label="Next hand"
                      >
                        ›
                      </Button>
                    </>
                  )}
                  {report && (
                    <ButtonLink
                      to={`/replay/${report.seed}`}
                      size="sm"
                      testId="review-to-replay"
                    >
                      Replay
                    </ButtonLink>
                  )}
                </>
              }
            />
          </div>
        </div>

        {!report ? (
          <div className="mt-10">
            <EmptyState
              title="Play a hand and it will be waiting here"
              testId="review-empty"
              action={
                <ButtonLink to="/table" variant="primary" size="lg">
                  Go to the table
                </ButtonLink>
              }
            >
              Every hand you finish is opened up here — the cards, the chips, the
              range the table had you on, and what each of your decisions was
              worth against it. Nothing has finished yet, in this session or in
              this browser's archive.
            </EmptyState>
          </div>
        ) : (
          <>
            {/*
             * Row two: the three tabs, and the seat everything on them is
             * written from. The seat picker used to be a scrolling chip row on
             * a line of its own under the label "Reviewing from", which is a
             * whole row of a reading page spent on six mutually exclusive
             * values. It is the same choice, folded into the tab bar.
             */}
            <div className="mt-4">
              <StickyTabs>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <Tabs
                      label="Hand review sections"
                      layout="fill"
                      testIdPrefix="tab"
                      value={tab}
                      onChange={setTab}
                      options={TABS.map((t) => ({ value: t.id, label: t.label }))}
                    />
                  </div>
                  {report.seats.length > 1 && (
                    <label className="flex shrink-0 items-center gap-2">
                      <span className="font-display text-xs tracking-wide text-ivory/55">
                        from
                      </span>
                      <select
                        data-testid="focus-select"
                        aria-label="Seat to review from"
                        value={focus}
                        onChange={(e) => setFocusOverride(Number(e.target.value))}
                        className={FIELD}
                        style={FIELD_STYLE}
                      >
                        {report.seats.map((s) => {
                          // The table already names the human's chair "You";
                          // tagging that one again reads "You (you)".
                          const name = seatName(s.seat);
                          const mine = heroSeat === s.seat && name !== "You";
                          return (
                            <option
                              key={s.seat}
                              value={s.seat}
                              data-testid={`focus-${s.seat}`}
                              className="bg-[#0b2218]"
                            >
                              {mine ? `${name} (you)` : name}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  )}
                </div>
              </StickyTabs>
            </div>

            {/*
             * Storage keeps the hand and drops the audit trail, a Monte Carlo
             * record per bot move is an order of magnitude larger than the hand
             * itself. Everything derived from the action record still works; the
             * panels that read the trail would otherwise report "nothing was
             * simulated", which is a different and untrue statement.
             */}
            {restored && (
              <div className="mt-4">
                <Note label="Restored from this browser's archive" testId="review-restored">
                  Storage keeps the hand, not the bots' simulation records — so
                  the head-to-head equity, the engine's own pricing and the
                  worked derivations are empty here. Everything rebuilt from the
                  action record is unaffected.
                </Note>
              </div>
            )}

            {/* -------------------------- Panels -------------------------- */}
            <div
              className="mt-4"
              data-testid="review-panel"
              role="tabpanel"
              key={`${report.seed}:${focus}`}
            >
              <p
                className="mb-4 font-cormorant text-[0.95rem] italic leading-snug text-ivory/55"
                data-testid="tab-blurb"
              >
                {blurb}
              </p>
              {tab === "hand" && (
                <HandTab
                  report={report}
                  focus={focus}
                  seatName={seatName}
                  isHero={isHero}
                />
              )}
              {tab === "ranges" && (
                <RangesTab
                  report={report}
                  focus={focus}
                  seatName={seatName}
                  isHero={isHero}
                />
              )}
              {tab === "play" && (
                <PlayTab
                  report={report}
                  focus={focus}
                  seatName={seatName}
                  isHero={isHero}
                />
              )}
            </div>

            {/* ------------------------- Hand list ------------------------ */}
            <div className="mt-10">
              <p className="mb-3 font-display text-sm font-semibold tracking-wide text-ivory/70">
                {hands.length > STRIP
                  ? `Your last ${STRIP} hands`
                  : hands.length === 1
                    ? "Your one hand"
                    : `All ${hands.length} of your hands`}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {strip.map((r) => {
                  const mine = seatResult(r, focus);
                  const active = r.seed === report.seed;
                  return (
                    <Link
                      key={r.seed}
                      to={href(r)}
                      aria-label={`${era(r)}hand ${r.handNumber}`}
                      className={`border p-2.5 transition hover:-translate-y-0.5 ${RADIUS.control}`}
                      style={{
                        borderColor: active ? "rgba(201,162,39,0.6)" : LINE.quiet,
                        background: active ? "rgba(201,162,39,0.1)" : "rgba(0,0,0,0.25)",
                      }}
                    >
                      <p className="font-display text-xs font-semibold text-ivory">
                        Hand #{r.handNumber}
                        {/* Without this, three sessions print three "Hand #1"s
                            and the reader has to open each one to tell which
                            hand they are looking at. */}
                        {sessions.count > 1 && (
                          <span className="ml-1.5 font-normal text-ivory/40">
                            S{sessions.of(r.seed)}
                          </span>
                        )}
                      </p>
                      <p className="text-[0.65rem] text-ivory/50">
                        {STREET_LABEL[r.endStreet]}
                        {r.wentToShowdown ? " · showdown" : ""}
                      </p>
                      <p
                        className="mt-1 font-mono text-[0.7rem]"
                        style={{ color: netTone(mine?.net ?? 0) }}
                      >
                        {mine
                          ? mine.net >= 0
                            ? `+${money(mine.net)}`
                            : `−${money(-mine.net)}`
                          : "—"}
                      </p>
                    </Link>
                  );
                })}
              </div>
              {hands.length > STRIP && (
                <p className="mt-3 text-[0.8rem] text-ivory/45">
                  {hands.length - STRIP} older hand
                  {hands.length - STRIP === 1 ? " is" : "s are"} still in the
                  archive — step back through them with ‹, or read them all at
                  once on{" "}
                  <Link
                    to="/profile"
                    className="text-gold-soft underline-offset-4 hover:underline"
                  >
                    your profile
                  </Link>
                  .
                </p>
              )}
            </div>
          </>
        )}
      </PageBody>
    </main>
  );
}
