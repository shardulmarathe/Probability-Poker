/**
 * The player profile.
 *
 * Everything on this page is derived from the hand archive and nothing else:
 * `computeStats` for the tracker line, `classifyStats` for the style read,
 * `analyzeHands` for the leaks. No number here is stored, because storing a
 * derived figure is how a profile ends up disagreeing with the hands it was
 * computed from.
 *
 * The EV analysis is the one expensive step, a pair of Monte Carlo runs per
 * decision, so it runs after the first paint and over a bounded window of
 * recent hands (`EV_WINDOW`). The page renders its cheap half immediately and
 * fills the rest in rather than blocking on a second of arithmetic.
 *
 * The page answers its own question first and offers the detail second.
 * Immediately visible: the session headline, the tracker line, the style
 * verdict with its confidence caveat, the two EV totals, and the top three
 * leaks. Behind a `Reveal`: the positional table, the cumulative curve, the
 * per-street split, and leaks four onward. Every closed `Reveal` states its own
 * headline number in its `summary`, because a folded section that says nothing
 * forces the reader to open it to find out whether it was worth opening.
 *
 * Those summaries are why the computation is not deferred to the moment a
 * section opens: the closed rows need the same `stats` and `session` the open
 * ones do, so deferring would trade a scroll for a spinner and leave the
 * summary lying until it was expanded.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MIN_CLASSIFY_HANDS, classifyStats } from "../../poker/coach/archetype";
import { analyzeHands, type SessionEvLoss } from "../../poker/coach/evLoss";
import { computeStats } from "../../poker/coach/stats";
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
import { CalibrationCard } from "./Calibration";
import { DemoBanner, DemoSessionButton } from "./DemoSession";
import { getArchiveScope, setArchiveScope } from "./store";
import { enqueueLeaks, queueSummary, saveQueue } from "../../lib/drillQueue";
import type { DemoResult } from "../../poker/replay/demoSession";
import {
  LeakByStreet,
  LeakByStreetSummary,
  LeakList,
  LeakPatterns,
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
  const [drills, setDrills] = useState<{ total: number; due: number } | null>(null);

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
        /*
         * Queue every priced mistake for the drill page.
         *
         * Here rather than behind a button because the analysis is the only
         * place the priced decisions exist, and asking the reader to press
         * "add these to my drills" is asking them to opt into the thing the
         * page just told them they need. `enqueueLeaks` is idempotent on
         * (seed, index) and leaves an existing item's schedule alone, which is
         * what makes it safe to run on every visit.
         *
         * The player scope only. The demo's sixty hands come from a scripted
         * driver, and they are namespaced away from the archive for exactly this
         * reason: they are not how the reader plays. Queueing them would fill
         * the drill page with somebody else's mistakes, and the drill page
         * would then prune them all anyway, because it reads the player archive
         * and could not find the hand a demo seed points at.
         */
        if (!cancelled && getArchiveScope() === "player") {
          const queue = saveQueue(
            enqueueLeaks(
              result.hands.flatMap((h) => h.decisions),
              (handNumber) => seedOf.get(handNumber)
            )
          );
          // Reported back on the page that filled it. The queue was being
          // written silently, so a reader who had just been shown their named
          // patterns had no way to know a drill existed, let alone that these
          // were in it.
          setDrills(queueSummary(queue));
        }
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

  /*
   * Offer the demo for as long as the page cannot do its job, not only when the
   * archive is empty.
   *
   * `MIN_CLASSIFY_HANDS` is the point below which the style verdict flags itself
   * `provisional` and says so out loud ("24 hands is well under the 30 a label
   * needs to mean anything"). A reader in that state is exactly who the demo is
   * for, and offering it only at zero hands excluded them: play three hands out
   * of curiosity and the way to see what the page is actually for disappeared.
   */
  const thin = !inDemo && hands.length > 0 && hands.length < MIN_CLASSIFY_HANDS;

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
              ? "Everything here is computed from hands you have finished: tracker stats, a style read with the confidence it deserves, and what each mistake cost."
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
         * `seatCount` is the widest table the archive holds, never the table
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

        {thin && <DemoSessionButton onLoaded={loadDemo} thin />}

        {/*
         * Outside the empty/non-empty split on purpose. Calibration is measured
         * from guesses committed on the concepts page, not from hands played,
         * so a reader who has used the guess gates and never sat down has a
         * result here and an empty archive. Gating it on the archive would hide
         * the one number on this page that does not come from the archive.
         *
         * It renders nothing until a quantity has three estimates behind it.
         */}
        <CalibrationCard />

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
                  ? `Priced over your most recent ${EV_WINDOW} hands. Each decision costs two simulations, so the window is bounded.`
                  : `Priced over all ${priced.length} recorded hand${priced.length === 1 ? "" : "s"}.`
              }
            >
              {pricing && !session ? (
                <p className="py-6 text-sm text-ivory/50" data-testid="pricing">
                  Pricing {priced.length} hand{priced.length === 1 ? "" : "s"}...
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
                  number on. That needs a hand you took past the blinds.
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
            {/*
             * Patterns first, individual hands second, and the order is the
             * point. A ranked list of hands answers "what did that cost", which
             * is a fact about one hand and not something a player can act on. A
             * named pattern with its frequency answers "what do I keep doing",
             * which is, and it carries a link to the concept that derives the
             * number it broke.
             */}
            <Group
              title="What you keep doing"
              lede="Named patterns, ranked by what the habit costs rather than by the worst single hand."
              actions={
                drills && drills.total > 0 ? (
                  <ButtonLink to="/drill" size="sm" testId="to-drill">
                    {drills.due > 0
                      ? `Drill ${drills.due} of these`
                      : `${drills.total} queued`}
                  </ButtonLink>
                ) : undefined
              }
            >
              {session ? (
                <LeakPatterns session={session} />
              ) : (
                <p className="py-6 text-sm text-ivory/50">
                  {pricing ? "Pricing..." : "Nothing priced yet."}
                </p>
              )}
            </Group>

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
                  {pricing ? "Pricing..." : "Nothing priced yet."}
                </p>
              )}
            </Group>
          </div>
        )}

        {/* -------------------------- Archive -------------------------- */}
        {!empty && (
          <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-ivory/10 pt-5">
            {/*
             * An unconditional promise, and safe to state as one: the archive
             * is localStorage, there is no account and no endpoint, and nothing
             * reads it but this browser. Were a sync path ever added, this
             * sentence would have to become a function of its state rather than
             * a constant, or it would be false directly above the control that
             * made it so.
             */}
            <p className="text-[0.72rem] text-ivory/40" data-testid="storage-notice">
              Stored locally in this browser. Nothing leaves the device.
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
