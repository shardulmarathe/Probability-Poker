/**
 * The player profile.
 *
 * Everything on this page is derived from the hand archive and nothing else —
 * `computeStats` for the tracker line, `classifyStats` for the style read,
 * `analyzeHands` for the leaks. No number here is stored; storing a derived
 * figure is how a profile ends up disagreeing with the hands it was computed
 * from.
 *
 * The EV analysis is the one expensive thing (a pair of Monte Carlo runs per
 * decision), so it happens off the first paint and over a bounded window of
 * recent hands. The page renders its cheap half immediately and fills the rest
 * in, rather than blocking on a second of arithmetic.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { classifyStats } from "../../poker/coach/archetype";
import { analyzeHands, type SessionEvLoss } from "../../poker/coach/evLoss";
import { computeStats } from "../../poker/coach/stats";
import { EmptyPanel, FeltBackground, Rail, Section } from "../report/ui";
import { ArchetypeCard } from "./Archetype";
import { LeakByStreet, LeakList, LeakTotals, LossCurve } from "./Leaks";
import { SessionHeadline, TrackerByPosition, TrackerOverall } from "./Tracker";
import { useProfileArchive } from "./useProfile";

/**
 * Hands the leak analysis prices.
 *
 * Each decision costs two Monte Carlo runs, so the work grows with the archive
 * while the lesson does not — the leaks that matter are the recent ones. 120
 * hands is roughly a second of arithmetic on a laptop, and the window is stated
 * on the page rather than applied quietly.
 */
const EV_WINDOW = 120;

export default function Profile() {
  const { hands, seat, setSeat, seatCount, seatName, storedCount, reset, bigBlind } =
    useProfileArchive();

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

  return (
    <main
      className="relative min-h-[100svh] overflow-x-hidden text-ivory"
      data-testid="profile"
      data-hands={hands.length}
      data-seat={seat}
    >
      <FeltBackground />

      <div
        className="relative z-10 mx-auto max-w-5xl px-3 pb-12 pt-4 sm:px-4 sm:pt-6"
        style={{
          paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
          paddingRight: "max(0.75rem, env(safe-area-inset-right))",
        }}
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to="/table"
              className="font-display text-xs tracking-wide text-ivory/70 transition hover:text-ivory sm:text-sm"
            >
              ← Back to table
            </Link>
            <h1 className="mt-1.5 font-display text-[clamp(1.5rem,6vw,2.1rem)] font-bold tracking-tight text-gold-soft">
              Player Profile
            </h1>
            <p className="mt-1 max-w-xl text-[0.8rem] leading-relaxed text-ivory/55 sm:text-sm">
              {hands.length === 0
                ? "Nothing recorded yet. Every finished hand is archived here."
                : `${hands.length} hand${hands.length === 1 ? "" : "s"} recorded${
                    storedCount > 0 ? `, ${storedCount} from earlier sessions` : ""
                  }.`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/replay"
              className="min-h-[36px] rounded-lg border px-3 py-1.5 font-display text-xs transition hover:-translate-y-px sm:text-sm"
              style={{ borderColor: "rgba(201,162,39,0.45)", background: "rgba(201,162,39,0.12)", color: "#e2c563" }}
              data-testid="to-replay"
            >
              Replay a hand
            </Link>
            <Rail>{bigBlind} bb</Rail>
          </div>
        </header>

        {/* ------------------------ Seat picker ------------------------ */}
        {seatCount > 1 && hands.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.2em] text-ivory/35">
              Profiling
            </span>
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
              {Array.from({ length: seatCount }, (_, id) => {
                const active = id === seat;
                return (
                  <button
                    key={id}
                    data-testid={`profile-seat-${id}`}
                    onClick={() => setSeat(id)}
                    className="min-h-[32px] shrink-0 rounded-md border px-2.5 py-1 font-display text-[0.64rem] tracking-wide transition"
                    style={{
                      borderColor: active ? "rgba(201,162,39,0.6)" : "rgba(244,237,228,0.14)",
                      background: active ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
                      color: active ? "#e2c563" : "rgba(244,237,228,0.55)",
                    }}
                  >
                    {seatName(id)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {hands.length === 0 ? (
          <div className="mt-8">
            <EmptyPanel title="No hands yet">
              Play a few at the table and they will collect here — tracker stats,
              a style read with the confidence it deserves, and what each mistake
              cost. The archive survives a reload.
              <div className="mt-4">
                <Link
                  to="/table"
                  className="inline-block min-h-[44px] rounded-xl border border-pkred-light/70 bg-pkred/80 px-6 py-3 font-display font-semibold text-ivory transition hover:-translate-y-0.5 hover:bg-pkred-light"
                >
                  Go to the table
                </Link>
              </div>
            </EmptyPanel>
          </div>
        ) : (
          <div className="mt-5 grid gap-3 sm:gap-4 lg:grid-cols-2">
            <Section title="This session" subtitle="Chips and showdowns" wide>
              <SessionHeadline stats={stats} />
            </Section>

            <Section title="Style read" subtitle="And how much to trust it">
              <ArchetypeCard verdict={verdict} />
            </Section>

            <Section title="Tracker" subtitle="Overall">
              <TrackerOverall stats={stats} />
            </Section>

            <Section title="By position" subtitle="The same six stats, sliced" wide>
              <TrackerByPosition stats={stats} />
            </Section>

            <Section
              title="Cost of mistakes"
              subtitle={
                hands.length > EV_WINDOW
                  ? `Priced over the most recent ${EV_WINDOW} hands`
                  : `Priced over all ${priced.length} hands`
              }
              wide
            >
              {pricing && !session ? (
                <p className="py-6 text-center text-sm text-ivory/50" data-testid="pricing">
                  Pricing {priced.length} hand{priced.length === 1 ? "" : "s"}…
                </p>
              ) : !session ? (
                <EmptyPanel title="Nothing to price yet">
                  This seat has not made a decision the model can put a number on.
                </EmptyPanel>
              ) : (
                <div className="space-y-5">
                  <LeakTotals session={session} />
                  <div>
                    <p className="mb-2 font-display text-[0.62rem] uppercase tracking-[0.22em] text-ivory/40">
                      Cumulative chips lost to mistakes
                    </p>
                    <LossCurve session={session} />
                  </div>
                  <div>
                    <p className="mb-2 font-display text-[0.62rem] uppercase tracking-[0.22em] text-ivory/40">
                      By street
                    </p>
                    <LeakByStreet session={session} />
                  </div>
                </div>
              )}
            </Section>

            <Section
              title="Biggest leaks"
              subtitle={`Ranked by model EV lost · ${session?.decisionCount ?? 0} decisions priced`}
              wide
            >
              {session ? (
                <LeakList session={session} />
              ) : (
                <p className="py-6 text-center text-sm text-ivory/50">
                  {pricing ? "Pricing…" : "Nothing priced yet."}
                </p>
              )}
            </Section>
          </div>
        )}

        {/* -------------------------- Archive -------------------------- */}
        {hands.length > 0 && (
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[0.68rem] text-ivory/40">
              Stored locally in this browser. Nothing leaves the device.
            </p>
            <button
              onClick={reset}
              data-testid="profile-reset"
              className="min-h-[36px] rounded-lg border px-3 py-1.5 font-display text-[0.68rem] tracking-wide text-ivory/60 transition hover:text-ivory"
              style={{ borderColor: "rgba(244,237,228,0.16)", background: "rgba(0,0,0,0.3)" }}
            >
              Clear archive
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
