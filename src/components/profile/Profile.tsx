/**
 * The player profile.
 *
 * Everything on this page is derived from the hand archive and nothing else -
 * `computeStats` for the tracker line, `classifyStats` for the style read,
 * `analyzeHands` for the leaks. No number here is stored; storing a derived
 * figure is how a profile ends up disagreeing with the hands it was computed
 * from.
 *
 * The EV analysis is the one expensive thing (a pair of Monte Carlo runs per
 * decision), so it happens off the first paint and over a bounded window of
 * recent hands. The page renders its cheap half immediately and fills the rest
 * in, rather than blocking on a second of arithmetic.
 *
 * Presentation note: this page used to put every one of those numbers in its
 * own rounded box inside another rounded box, six panels, each a grid of six
 * bordered tiles. The boxes were doing no work, so they are gone. Sections are
 * a heading, a hairline and content; metrics are grouped by whitespace. The
 * only remaining surfaces are the ones where the container is genuinely the
 * object: the style verdict, and the empty state.
 *
 * That argument had a second half it had not got to. Removing the boxes made
 * the page cheaper to look at without making it shorter: six sections, all
 * expanded, came to 3,473px, and a reader asking the only question this page
 * exists to answer, "how am I doing, and what should I fix", had to scroll
 * past a six-row positional table, a cumulative curve and a per-street
 * breakdown to reach the ranked leaks that are the answer. Boxes were never
 * the clutter; simultaneity was.
 *
 * So the page now paints its answer and offers the rest. Open: the session
 * headline, the tracker line, the style verdict with its confidence caveat,
 * the two EV totals and the top three leaks. Behind a `Reveal`: the positional
 * table, the curve, the per-street split and leaks four onward, each with a
 * `summary` that states its own headline number while closed, because a folded
 * section that says nothing makes the reader open it to discover it was not
 * worth opening.
 *
 * Nothing about the arithmetic moved. Every summary above is derived from
 * `stats` and `session`, which are computed exactly as before, on the same
 * schedule, over the same `EV_WINDOW`. Deferring the *computation* to the
 * moment a section opens would be the obvious next step and the wrong one: the
 * closed summaries need those numbers, so it would trade a scroll for a
 * spinner and make the summary lie until it was expanded.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { classifyStats } from "../../poker/coach/archetype";
import { analyzeHands, type SessionEvLoss } from "../../poker/coach/evLoss";
import { computeStats } from "../../poker/coach/stats";
import { storageNotice, useSync } from "../account";
import { PageBody, PageHeader } from "../shell";
import {
  Button,
  ButtonLink,
  EmptyState,
  Group,
  Rail,
  Reveal,
  Tabs,
} from "../ui";
import { ArchetypeCard } from "./Archetype";
import { DemoBanner, DemoSessionButton } from "./DemoSession";
import { getArchiveScope, setArchiveScope } from "./store";
import type { DemoResult } from "../../poker/replay/demoSession";
import {
  LeakByStreet,
  LeakByStreetSummary,
  LeakList,
  LeakTotals,
  LossCurve,
  LossCurveSummary,
} from "./Leaks";
import {
  SessionHeadline,
  TrackerByPosition,
  TrackerByPositionSummary,
  TrackerOverall,
} from "./Tracker";
import { useProfileArchive } from "./useProfile";

/**
 * Hands the leak analysis prices.
 *
 * Each decision costs two Monte Carlo runs, so the work grows with the archive
 * while the lesson does not, the leaks that matter are the recent ones. 120
 * hands is roughly a second of arithmetic on a laptop, and the window is stated
 * on the page rather than applied quietly.
 */
const EV_WINDOW = 120;

export default function Profile() {
  const navigate = useNavigate();
  // Where the hands actually are. The line under the archive used to be a
  // fixed promise ("Nothing leaves the device") that a single sync would have
  // made false; `storageNotice` returns the sentence that is true right now.
  const sync = useSync();
  const {
    hands,
    seat,
    setSeat,
    seatCount,
    seatName,
    storedCount,
    reset,
    refresh,
    smallBlind,
    bigBlind,
  } = useProfileArchive();

  // A leak names a hand number; the replay is addressed by deal seed, because
  // hand numbers restart with every new table.
  const seedOf = useMemo(() => {
    const byNumber = new Map<number, number>();
    for (const hand of hands) byNumber.set(hand.handNumber, hand.seed);
    return byNumber;
  }, [hands]);

  const openReplay = useCallback(
    (decision: { handNumber: number }) => {
      const seed = seedOf.get(decision.handNumber);
      if (seed !== undefined) navigate(`/replay/${seed}`);
    },
    [navigate, seedOf]
  );

  const stats = useMemo(() => computeStats(hands, seat), [hands, seat]);
  const verdict = useMemo(() => classifyStats(stats), [stats]);

  const priced = useMemo(() => hands.slice(-EV_WINDOW), [hands]);
  const [session, setSession] = useState<SessionEvLoss | null>(null);
  const [pricing, setPricing] = useState(false);

  // Off the first paint: the page is readable while this runs, and a stale
  // result can never be shown next to a newer archive because the key changes.
  const key = `${seat}:${priced.length}:${priced[priced.length - 1]?.seed ?? 0}`;
  useEffect(() => {
    if (priced.length === 0) {
      setSession(null);
      return;
    }
    let cancelled = false;
    setPricing(true);
    const id = window.setTimeout(() => {
      try {
        const result = analyzeHands(priced, seat);
        if (!cancelled) setSession(result);
      } catch {
        // A single unpriceable hand must not take the page down with it.
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setPricing(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /*
   * The demo lives in component state rather than in storage, deliberately.
   * A reload must land the reader back in their own archive: waking up inside
   * somebody else's sixty hands, with no memory of having asked for them, is
   * a worse first impression than the empty state this replaces.
   */
  const [demo, setDemo] = useState<DemoResult | null>(null);
  const inDemo = getArchiveScope() === "demo";

  const loadDemo = useCallback(
    (result: DemoResult) => {
      setDemo(result);
      setSeat(result.heroSeat);
      refresh();
    },
    [refresh, setSeat]
  );

  const exitDemo = useCallback(() => {
    setArchiveScope("player");
    setDemo(null);
    refresh();
  }, [refresh]);

  const empty = hands.length === 0;

  return (
    <main
      className="relative overflow-x-hidden text-ivory"
      data-testid="profile"
      data-hands={hands.length}
      data-seat={seat}
    >
      <PageBody>
        <PageHeader
          title="Your profile"
          lede={
            empty
              ? "Everything here is computed from hands you have finished — tracker stats, a style read with the confidence it deserves, and what each mistake cost."
              : `Computed from ${hands.length} finished hand${hands.length === 1 ? "" : "s"}${
                  storedCount > 0
                    ? `, ${storedCount} of them restored from this browser's archive`
                    : ""
                }.`
          }
          actions={
            !empty && (
              <ButtonLink to="/replay" size="sm" testId="to-replay">
                Replay a hand
              </ButtonLink>
            )
          }
          meta={
            <Rail>
              ${smallBlind} / ${bigBlind}
            </Rail>
          }
        />

        {/*
         * ------------------------ Whose profile ------------------------
         *
         * `seatCount` is the widest table the *archive* holds, never the table
         * sitting now. The picker therefore lists chairs that have played, so
         * a four-handed archive read at a six-max table no longer offers Seat 5
         * and Seat 6 and then profiles them from nothing. The fix is in
         * `useProfile.ts`; filtering here would have left the same wrong number
         * in every other consumer of the view.
         */}
        {seatCount > 1 && !empty && (
          <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-display text-sm font-semibold tracking-wide text-ivory/70">
              Reading
            </span>
            <Tabs
              label="Seat to profile"
              as="options"
              layout="scroll"
              size="sm"
              testIdPrefix="profile-seat"
              value={seat}
              onChange={setSeat}
              options={Array.from({ length: seatCount }, (_, id) => ({
                value: id,
                label: seatName(id),
              }))}
            />
          </div>
        )}

        {inDemo && <DemoBanner result={demo} onExit={exitDemo} />}

        {empty ? (
          <div className="mt-10">
            <EmptyState
              title="Play a hand and this fills itself in"
              action={
                <ButtonLink to="/table" variant="primary" size="lg">
                  Go to the table
                </ButtonLink>
              }
            >
              Every hand you finish is archived in this browser and priced here:
              how often you enter a pot, how you play each position, what your
              style looks like from the outside, and which decisions cost the
              most. A dozen hands is enough for the first read.
              <DemoSessionButton onLoaded={loadDemo} />
            </EmptyState>
          </div>
        ) : (
          <div className="mt-10 space-y-12">
            {/*
             * No lede here, and none on "How you play" or on the style verdict
             * either. A section opening heading-then-explanatory-sentence, over
             * and over, is the templated rhythm the failure catalog calls out;
             * a lede earns its place only where the heading genuinely cannot
             * say the thing. Two survive on this page, and both state scope
             * rather than restate a title: the pricing window, and the basis
             * the leaks are ranked on.
             */}
            <Group title="This session">
              <SessionHeadline stats={stats} />
            </Group>

            <div className="grid gap-12 lg:grid-cols-2">
              <Group title="How you play">
                <TrackerOverall stats={stats} />
                {/*
                 * The positional split was its own full-width section, which
                 * gave a six-by-eight table of percentages the same weight on
                 * the page as the six numbers it is a breakdown of. It is the
                 * same six stats, so it belongs under them, and it opens.
                 */}
                <Reveal
                  label="The same six, by position"
                  summary={<TrackerByPositionSummary stats={stats} />}
                  tone="quiet"
                  testId="reveal-by-position"
                >
                  <TrackerByPosition stats={stats} />
                </Reveal>
              </Group>

              {/*
               * The lede here read "And how much of it the sample can actually
               * support", which is what the confidence meter directly below it
               * says, in a number, with a bar. Two ways of saying one thing is
               * one too many when the second one is quantified.
               */}
              <Group title="Your style, from the outside">
                <ArchetypeCard verdict={verdict} />
              </Group>
            </div>

            <Group
              title="What your mistakes cost"
              lede={
                hands.length > EV_WINDOW
                  ? `Priced over your most recent ${EV_WINDOW} hands — each decision costs two simulations, so the window is bounded.`
                  : `Priced over all ${priced.length} recorded hand${priced.length === 1 ? "" : "s"}.`
              }
            >
              {pricing && !session ? (
                <p className="py-6 text-sm text-ivory/50" data-testid="pricing">
                  Pricing {priced.length} hand{priced.length === 1 ? "" : "s"}…
                </p>
              ) : !session ? (
                <EmptyState
                  title="Nothing to price yet"
                  action={
                    <ButtonLink to="/table" variant="primary">
                      Play a hand out
                    </ButtonLink>
                  }
                >
                  This seat has not yet made a decision the model can put a
                  number on — that needs a hand you took past the blinds.
                </EmptyState>
              ) : (
                <div className="space-y-6">
                  <LeakTotals session={session} />
                  {/*
                   * These two were headings with content permanently under
                   * them, roughly 380px of chart and table between the totals
                   * and the ranked leaks. Both answer a follow-up question
                   * ("when did it happen", "on which street"), and neither is
                   * the question the page is for. The heading text is now the
                   * toggle's label, so the words on screen are unchanged when
                   * closed; the `summary` beside each carries the number the
                   * chart or table would have been read for anyway.
                   */}
                  <div>
                    <Reveal
                      label="Chips given away, accumulating"
                      summary={<LossCurveSummary session={session} />}
                      tone="quiet"
                      testId="reveal-loss-curve"
                    >
                      <LossCurve session={session} />
                    </Reveal>
                    <Reveal
                      label="Where it went, by street"
                      summary={<LeakByStreetSummary session={session} />}
                      tone="quiet"
                      testId="reveal-by-street"
                    >
                      <LeakByStreet session={session} />
                    </Reveal>
                  </div>
                </div>
              )}
            </Group>

            {/*
             * The lede kept its first clause, which names the ranking basis
             * and the sample it ranked over, and lost its second, "Open any of
             * them and play the hand again differently", which described the
             * button labelled "Play it again" sitting in every row below it.
             */}
            <Group
              title="Your biggest leaks"
              lede={`Ranked by the model's EV, over ${session?.decisionCount ?? 0} priced decision${
                session?.decisionCount === 1 ? "" : "s"
              }.`}
            >
              {session ? (
                <LeakList session={session} onReplay={openReplay} />
              ) : (
                <p className="py-6 text-sm text-ivory/50">
                  {pricing ? "Pricing…" : "Nothing priced yet."}
                </p>
              )}
            </Group>
          </div>
        )}

        {/* -------------------------- Archive -------------------------- */}
        {!empty && (
          <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-ivory/10 pt-5">
            <p className="text-[0.72rem] text-ivory/40" data-testid="storage-notice">
              {storageNotice(sync)}
            </p>
            <Button
              size="sm"
              variant="quiet"
              onClick={reset}
              data-testid="profile-reset"
            >
              Clear the archive
            </Button>
          </div>
        )}
      </PageBody>
    </main>
  );
}
