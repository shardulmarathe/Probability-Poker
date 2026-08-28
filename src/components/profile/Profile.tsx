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
  Tabs,
} from "../ui";
import { ArchetypeCard } from "./Archetype";
import { LeakByStreet, LeakList, LeakTotals, LossCurve } from "./Leaks";
import { SessionHeadline, TrackerByPosition, TrackerOverall } from "./Tracker";
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
            </EmptyState>
          </div>
        ) : (
          <div className="mt-10 space-y-12">
            {/*
             * No lede here, and none on "How you play" either. Six sections
             * each opening heading-then-explanatory-sentence is the templated
             * rhythm the failure catalog calls out; a lede earns its place only
             * where the heading genuinely cannot say the thing, the pricing
             * window, the ranking basis, what a sample can support.
             */}
            <Group title="This session">
              <SessionHeadline stats={stats} />
            </Group>

            <div className="grid gap-12 lg:grid-cols-2">
              <Group title="How you play">
                <TrackerOverall stats={stats} />
              </Group>

              <Group
                title="Your style, from the outside"
                lede="And how much of it the sample can actually support."
              >
                <ArchetypeCard verdict={verdict} />
              </Group>
            </div>

            <Group title="The same six, by position">
              <TrackerByPosition stats={stats} />
            </Group>

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
                <div className="space-y-8">
                  <LeakTotals session={session} />
                  <div>
                    <h3 className="font-display text-sm font-semibold tracking-wide text-ivory/75">
                      Chips given away, accumulating
                    </h3>
                    <div className="mt-3">
                      <LossCurve session={session} />
                    </div>
                  </div>
                  <div>
                    <h3 className="font-display text-sm font-semibold tracking-wide text-ivory/75">
                      Where it went, by street
                    </h3>
                    <div className="mt-3">
                      <LeakByStreet session={session} />
                    </div>
                  </div>
                </div>
              )}
            </Group>

            <Group
              title="Your biggest leaks"
              lede={`Ranked by the model's EV, over ${session?.decisionCount ?? 0} priced decision${
                session?.decisionCount === 1 ? "" : "s"
              }. Open any of them and play the hand again differently.`}
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
