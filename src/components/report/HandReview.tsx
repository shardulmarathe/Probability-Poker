/**
 * The hand review.
 *
 * Four tabs, one question each: what happened, what they had, what you did, and
 * why the numbers are the numbers. Splitting it that way rather than by data
 * source is deliberate, the same equity estimate shows up on three of these
 * pages, answering a different question every time.
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
 * per-decision audit trail, and three of the four tabs read it. A hand restored
 * from storage says so rather than quietly showing empty panels.
 */

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { money } from "../../lib/format";
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
  Rail,
  StickyTabs,
  Tabs,
  netTone,
} from "../ui";
import { HandTab } from "./HandTab";
import { MathTab } from "./MathTab";
import { PlayTab } from "./PlayTab";
import { RangeGridStyles } from "./RangeGrid";
import { RangesTab } from "./RangesTab";
import { STREET_LABEL, seatResult } from "./derive";

type TabId = "hand" | "ranges" | "play" | "math";

/**
 * The blurbs used to live in `title=` attributes, which no touch device has
 * ever shown to anyone. `Tabs` prints the active one under the row.
 */
const TABS: { id: TabId; label: string; blurb: string }[] = [
  { id: "hand", label: "Hand", blurb: "What happened, and what it cost each seat." },
  { id: "ranges", label: "Ranges", blurb: "What the table thought everyone held." },
  { id: "play", label: "Your play", blurb: "Every decision, re-priced two ways." },
  { id: "math", label: "Math", blurb: "Where the numbers on the other tabs come from." },
];

/** Cards in the strip at the foot of the page. The archive holds up to 400. */
const STRIP = 24;

export default function HandReview() {
  const { history, lastReport, table, heroSeat } = useTable();
  const params = useParams();
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

  // Hand numbers restart with every table, so an archive spanning sessions can
  // hold several hand #3s and this route's parameter cannot tell them apart.
  // The most recent wins: it is the one a link written today meant.
  const requested = params.handNumber ? Number(params.handNumber) : undefined;
  const report = useMemo(() => {
    if (requested !== undefined) {
      for (let i = hands.length - 1; i >= 0; i--) {
        if (hands[i].handNumber === requested) return hands[i];
      }
    }
    return hands[hands.length - 1] ?? null;
  }, [hands, requested]);

  /** A hand that came back from storage has no decisions attached. See below. */
  const restored = report !== null && !liveSeeds.has(report.seed);

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
        {/* The one back-link on this page, and it earns its place: `/review` is
            entered from the felt. Nav handles everything else. */}
        <BackLink to="/table">Table</BackLink>

        <div className="mt-2">
          <PageHeader
            title="Hand review"
            lede={
              report
                ? `Hand #${report.handNumber} — ${report.seatCount}-handed, ended on the ${STREET_LABEL[report.endStreet].toLowerCase()}.`
                : "Every finished hand, opened up."
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {report && (
                  <ButtonLink
                    to={`/replay/${report.seed}`}
                    size="sm"
                    testId="review-to-replay"
                  >
                    Replay
                  </ButtonLink>
                )}
                {hands.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="quiet"
                      data-testid="review-prev"
                      disabled={index <= 0}
                      onClick={() => navigate(`/review/${hands[index - 1].handNumber}`)}
                      aria-label="Previous hand"
                    >
                      ‹
                    </Button>
                    <select
                      data-testid="review-select"
                      aria-label="Hand to review"
                      value={report?.handNumber ?? ""}
                      onChange={(e) => navigate(`/review/${e.target.value}`)}
                      className={`min-h-[34px] border px-3 py-1.5 font-display text-xs text-ivory outline-none sm:text-sm ${RADIUS.action}`}
                      style={{ borderColor: LINE.gold, background: "rgba(0,0,0,0.4)" }}
                    >
                      {hands
                        .slice()
                        .reverse()
                        .map((r) => (
                          <option key={r.seed} value={r.handNumber} className="bg-[#0b2218]">
                            Hand #{r.handNumber} · {r.seatCount}-handed
                          </option>
                        ))}
                    </select>
                    <Button
                      size="sm"
                      variant="quiet"
                      data-testid="review-next"
                      disabled={index < 0 || index >= hands.length - 1}
                      onClick={() => navigate(`/review/${hands[index + 1].handNumber}`)}
                      aria-label="Next hand"
                    >
                      ›
                    </Button>
                  </>
                )}
              </div>
            }
            meta={
              <Rail>
                {hands.length} hand{hands.length === 1 ? "" : "s"}
              </Rail>
            }
          />
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
            {/* --------------------------- Tabs --------------------------- */}
            <div className="mt-5">
              <StickyTabs>
                <Tabs
                  label="Hand review sections"
                  layout="fill"
                  showHint
                  testIdPrefix="tab"
                  value={tab}
                  onChange={setTab}
                  options={TABS.map((t) => ({
                    value: t.id,
                    label: t.label,
                    hint: t.blurb,
                  }))}
                />
              </StickyTabs>
            </div>

            {/* ---------------------- Viewpoint seat ---------------------- */}
            {report.seats.length > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="font-display text-sm font-semibold tracking-wide text-ivory/70">
                  Reviewing from
                </span>
                <Tabs
                  label="Seat to review from"
                  as="options"
                  layout="scroll"
                  size="sm"
                  testIdPrefix="focus"
                  value={focus}
                  onChange={setFocusOverride}
                  options={report.seats.map((s) => {
                    // The table already names the human's chair "You"; tagging
                    // that one again reads "You (you)".
                    const name = seatName(s.seat);
                    const mine = heroSeat === s.seat && name !== "You";
                    return { value: s.seat, label: mine ? `${name} (you)` : name };
                  })}
                />
              </div>
            )}

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
                  the head-to-head equity, the engine's own pricing and the Math
                  tab's worked examples are empty here. Everything rebuilt from
                  the action record is unaffected.
                </Note>
              </div>
            )}

            {/* -------------------------- Panels -------------------------- */}
            <div
              className="mt-5"
              data-testid="review-panel"
              role="tabpanel"
              key={`${report.seed}:${focus}`}
            >
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
              {tab === "math" && (
                <MathTab report={report} focus={focus} seatName={seatName} />
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
                      to={`/review/${r.handNumber}`}
                      className={`border p-2.5 transition hover:-translate-y-0.5 ${RADIUS.control}`}
                      style={{
                        borderColor: active ? "rgba(201,162,39,0.6)" : LINE.quiet,
                        background: active ? "rgba(201,162,39,0.1)" : "rgba(0,0,0,0.25)",
                      }}
                    >
                      <p className="font-display text-xs font-semibold text-ivory">
                        Hand #{r.handNumber}
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
