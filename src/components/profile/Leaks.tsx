/**
 * What the mistakes cost, under two lenses that are never added together.
 *
 * `evLoss.ts` prices every decision twice. The model loss is what was knowable:
 * the hand priced against the range the opponents' actions implied, which is
 * the only lens that can tell you whether a decision was right. The hindsight
 * loss is priced against the cards they actually held, which is knowable only
 * afterwards, it says what the decision cost, not whether it was wrong.
 *
 * Summing them, or ranking by their total, would teach precisely the habit the
 * split exists to break: judging a fold by whether it would have won. So they
 * never share a bar, a colour, a column or a total. The ranking is by model
 * loss alone; hindsight sits beside it, dimmer and dashed, labelled as the
 * results-oriented number it is.
 *
 * Three leaks are shown and everything else sits behind a `Reveal`, so the
 * costliest leak is not competing for attention with the ninth one down. Each
 * closed row still carries its own number, because a folded section that says
 * nothing forces the reader to open it to find out whether it was worth
 * opening. Every one of those numbers comes off the `session` the page has
 * already computed, so nothing is priced late.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import type {
  DecisionEvLoss,
  HandEvLoss,
  LeakAggregate,
  LeakKind,
  SessionEvLoss,
} from "../../poker/coach/evLoss";
import type { ConceptId } from "../learn/concepts";
import { money, pct } from "../../lib/format";
import {
  Button,
  EmptyState,
  HowCalculated,
  RADIUS,
  Reveal,
  Scroller,
  Tag,
} from "../ui";

/** Gold for what was knowable; slate for what only the cards knew. */
const MODEL_COLOR = "#e2c563";
const HINDSIGHT_COLOR = "#7f9fb8";

const chips = (value: number): string => {
  const n = Math.round(Math.abs(value));
  return n === 0 ? "$0" : `−${money(n)}`;
};

// ---------------------------------------------------------------------------
// Naming the pattern, and pointing at the maths that explains it
// ---------------------------------------------------------------------------

/**
 * What each leak kind is called, and which concept teaches the number behind it.
 *
 * The mapping lives here rather than on `LeakKind` because `poker/coach` is
 * engine code and has no business knowing that a page called `/learn` exists.
 * The engine names the error; this file decides what to say about it and where
 * to send someone who wants the derivation.
 *
 * `why` is one sentence and states the rule that was broken, not the chips it
 * cost. The cost is already in the row.
 */
const LEAK_COPY: Record<
  LeakKind,
  { label: string; concept: ConceptId; why: string }
> = {
  "results-oriented": {
    label: "Right decision, wrong result",
    concept: "monte-carlo",
    why: "The line you took was the best one available and the cards beat it anyway. This is variance, not a leak.",
  },
  "multiway-as-heads-up": {
    label: "Playing multiway like heads-up",
    concept: "multiway",
    why: "You were ahead of every opponent one-on-one and behind the field, which is the way multiway differs from heads-up.",
  },
  "fold-to-cbet": {
    label: "Overfolding to continuation bets",
    concept: "ev",
    why: "Folding a hand with more equity than the price required, against the flop bet the preflop raiser was always going to make.",
  },
  "fold-above-price": {
    label: "Folding a hand the price was laying",
    concept: "ev",
    why: "Your equity was above the share the pot odds asked for, so calling was profitable and folding gave that up.",
  },
  "call-below-price": {
    label: "Calling without the equity",
    concept: "ev",
    why: "Your equity was below the share the pot odds required, so the call could not break even.",
  },
  "missed-value": {
    label: "Passing up value",
    concept: "ev",
    why: "Checking or calling where betting priced better, once the folds a bet buys are counted alongside the times it is called.",
  },
};

/**
 * A named pattern, with its frequency, its cost, and a way to go and read it up.
 *
 * Ranked by total model EV lost rather than by the worst single hand: one
 * catastrophe and a habit repeated forty times are different problems, and only
 * the second one is fixable by understanding something. `rate` is over the
 * decisions that actually offered the error, so folding well ninety times does
 * not dilute it away.
 *
 * `results-oriented` is deliberately not in this list. It is the one bucket that
 * is not a mistake, so ranking it beside the leaks would file playing correctly
 * as something to fix.
 */
export function LeakPatterns({ session }: { session: SessionEvLoss }) {
  const patterns = useMemo(
    () =>
      session.leaks
        .filter(
          (l): l is LeakAggregate & { kind: LeakKind } =>
            l.kind !== null && l.kind !== "results-oriented" && l.count > 0
        )
        .sort((a, b) => a.totalModelEvLoss - b.totalModelEvLoss),
    [session]
  );
  const variance = session.leaks.find((l) => l.kind === "results-oriented");

  if (patterns.length === 0 && !variance?.count) {
    return (
      <EmptyState title="No pattern yet">
        A leak needs a handful of examples before it is a habit rather than a
        hand. Keep playing.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {patterns.map((leak) => {
        const copy = LEAK_COPY[leak.kind];
        return (
          <div
            key={leak.kind}
            data-testid={`leak-pattern-${leak.kind}`}
            className={`border p-3.5 ${RADIUS.surface}`}
            style={{ borderColor: "rgba(244,237,228,0.12)" }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="font-display text-sm text-ivory">{copy.label}</p>
              <p className="font-mono text-xs" style={{ color: MODEL_COLOR }}>
                {chips(leak.totalModelEvLoss)}
              </p>
            </div>
            <p className="mt-1 text-[0.72rem] leading-relaxed text-ivory/55">
              {copy.why}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-[0.66rem] text-ivory/45">
                {leak.count} of {leak.opportunities} spots ({pct(leak.rate, 0)}),
                {" "}
                {chips(leak.meanModelEvLoss)} each
              </span>
              {/*
               * The door between a priced mistake and the maths that explains
               * it. Without this the profile and the concepts page are two
               * separate buildings, and a player who has just been shown what a
               * leak cost has nowhere to go to find out why it is one.
               */}
              <Link
                to={`/learn?c=${copy.concept}`}
                className="font-mono text-[0.66rem] text-gold-soft underline decoration-gold/30 underline-offset-2 transition-colors hover:text-gold"
              >
                Read the maths
              </Link>
            </div>
          </div>
        );
      })}

      {variance && variance.count > 0 && (
        <div
          data-testid="leak-pattern-variance"
          className={`border p-3.5 ${RADIUS.surface}`}
          style={{
            borderColor: "rgba(127,159,184,0.3)",
            background: "rgba(127,159,184,0.06)",
          }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="font-display text-sm text-ivory">
              {LEAK_COPY["results-oriented"].label}
            </p>
            <Tag tone="neutral">Not a leak</Tag>
          </div>
          <p className="mt-1 text-[0.72rem] leading-relaxed text-ivory/55">
            {LEAK_COPY["results-oriented"].why} It happened{" "}
            {variance.count === 1 ? "once" : `${variance.count} times`}, and cost{" "}
            {chips(variance.totalHindsightEvLoss)} in chips you were never going
            to keep.
          </p>
          <Link
            to={`/learn?c=${LEAK_COPY["results-oriented"].concept}`}
            className="mt-2 inline-block font-mono text-[0.66rem] text-gold-soft underline decoration-gold/30 underline-offset-2 transition-colors hover:text-gold"
          >
            Read the maths
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export function LeakTotals({ session }: { session: SessionEvLoss }) {
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div
          className={`min-w-0 border p-3.5 ${RADIUS.surface}`}
          style={{ borderColor: "rgba(201,162,39,0.4)", background: "rgba(201,162,39,0.08)" }}
          data-testid="model-total"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-[0.6rem] uppercase tracking-wider text-ivory/50">
              Model EV lost
            </p>
            <Tag tone="gold">Knowable</Tag>
          </div>
          <p
            className="mt-1 font-display text-2xl font-semibold"
            style={{ color: MODEL_COLOR }}
          >
            {chips(session.totalModelEvLoss)}
          </p>
          <p className="mt-1 text-[0.68rem] leading-snug text-ivory/50">
            Priced against the range their actions implied. This is the number to
            coach from.
          </p>
        </div>

        <div
          className={`min-w-0 border border-dashed p-3.5 ${RADIUS.surface}`}
          style={{ borderColor: "rgba(127,159,184,0.45)", background: "rgba(127,159,184,0.06)" }}
          data-testid="hindsight-total"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-[0.6rem] uppercase tracking-wider text-ivory/50">
              Hindsight EV lost
            </p>
            <Tag>Results-oriented</Tag>
          </div>
          <p
            className="mt-1 font-display text-2xl font-semibold"
            style={{ color: HINDSIGHT_COLOR }}
          >
            {chips(session.totalHindsightEvLoss)}
          </p>
          <p className="mt-1 text-[0.68rem] leading-snug text-ivory/50">
            Priced against the cards they actually held. Nobody could have known
            this at the time.
          </p>
        </div>
      </div>

      {/*
       * The rule is in the label, the argument is behind it.
       *
       * This was a permanent callout, and the sentence it was making, "these
       * are never added", is a rule about the two boxes above rather than a
       * warning about the state the reader is in. Its own heading can carry
       * it, so the heading is the control: someone who already knows the rule
       * reads five words instead of three lines, and someone who does not gets
       * the whole argument on one tap. The `never-sum` hook moves with it onto
       * the toggle, so it is still addressable when the body is folded.
       */}
      <Reveal
        label="These two are never added"
        summary="a fold that would have won is not a mistake"
        tone="quiet"
        testId="never-sum"
      >
        <p className="text-[0.8rem] leading-relaxed text-ivory/65">
          These two are different questions about the same decisions, not two
          parts of one bill. They are never added, and the leaks below are
          ranked by the model number alone: a fold that would have won is not a
          mistake.
        </p>
      </Reveal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cumulative curve
// ---------------------------------------------------------------------------

interface CurvePoint {
  hand: number;
  model: number;
  hindsight: number;
}

function cumulative(hands: HandEvLoss[]): CurvePoint[] {
  let model = 0;
  let hindsight = 0;
  return hands.map((hand) => {
    model += Math.abs(hand.totalModelEvLoss);
    hindsight += Math.abs(hand.totalHindsightEvLoss);
    return { hand: hand.handNumber, model, hindsight };
  });
}

const W = 100;
const H = 40;

/**
 * The curve's endpoint, for the closed row of the reveal it lives in.
 *
 * Runs the same accumulation the chart does, off the same `session`, so the
 * summary cannot drift from the line it stands in for. Cheap: one pass over
 * hands already in memory, nothing sampled, nothing re-priced.
 */
export function LossCurveSummary({ session }: { session: SessionEvLoss }) {
  const points = cumulative(session.hands);
  if (points.length === 0) return <>nothing priced yet</>;
  const last = points[points.length - 1];
  return (
    <>
      {chips(last.model)} model · {chips(last.hindsight)} hindsight over{" "}
      {points.length} hand{points.length === 1 ? "" : "s"}
    </>
  );
}

/**
 * Chips given away, accumulating over the session.
 *
 * Two lines, drawn in one box because they share an axis, kept apart by weight
 * and dash rather than by stacking, stacking them would be the sum this whole
 * panel refuses to compute.
 */
export function LossCurve({ session }: { session: SessionEvLoss }) {
  const points = useMemo(() => cumulative(session.hands), [session.hands]);
  const peak = Math.max(
    1,
    ...points.map((p) => Math.max(p.model, p.hindsight))
  );

  // Says so rather than rendering nothing. The curve now lives inside a
  // reveal, and a reveal that opens onto an empty box reads as a broken
  // control; the old `return null` was invisible only because the heading
  // above it was always on screen to absorb the blame.
  if (points.length === 0) {
    return (
      <p className="text-sm text-ivory/50" data-testid="loss-curve-empty">
        No priced hands yet, so there is no curve to draw.
      </p>
    );
  }

  const x = (i: number) =>
    points.length === 1 ? W / 2 : (i / (points.length - 1)) * W;
  const y = (v: number) => H - (v / peak) * H;
  const path = (key: "model" | "hindsight") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p[key]).toFixed(2)}`).join(" ");

  const last = points[points.length - 1];

  return (
    <div data-testid="loss-curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full sm:h-40"
        role="img"
        aria-label={`Cumulative chips lost to mistakes over ${points.length} hands: ${Math.round(last.model)} by the model lens, ${Math.round(last.hindsight)} by hindsight.`}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={H * f}
            y2={H * f}
            stroke="rgba(244,237,228,0.08)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path
          d={path("hindsight")}
          fill="none"
          stroke={HINDSIGHT_COLOR}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          opacity={0.75}
        />
        <path
          d={path("model")}
          fill="none"
          stroke={MODEL_COLOR}
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.length === 1 && (
          <circle cx={x(0)} cy={y(last.model)} r={2} fill={MODEL_COLOR} vectorEffect="non-scaling-stroke" />
        )}
      </svg>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.68rem]">
          <span className="flex items-center gap-1.5 text-ivory/70">
            <span className="inline-block h-0.5 w-5 rounded" style={{ background: MODEL_COLOR }} />
            Model · {chips(last.model)}
          </span>
          <span className="flex items-center gap-1.5 text-ivory/55">
            <span
              className="inline-block h-0.5 w-5 rounded"
              style={{
                backgroundImage: `repeating-linear-gradient(90deg, ${HINDSIGHT_COLOR} 0 4px, transparent 4px 7px)`,
              }}
            />
            Hindsight · {chips(last.hindsight)}
          </span>
        </div>
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-ivory/35">
          {points.length} hand{points.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ranked list
// ---------------------------------------------------------------------------

const STREET_SHORT: Record<string, string> = {
  preflop: "Pre",
  flop: "Flop",
  turn: "Turn",
  river: "River",
};

function LeakRow({
  decision,
  worst,
  onReplay,
}: {
  decision: DecisionEvLoss;
  worst: number;
  onReplay?: (decision: DecisionEvLoss) => void;
}) {
  const share = worst > 0 ? Math.abs(decision.modelEvLoss) / worst : 0;
  return (
    <div
      className="border-t border-ivory/10 py-4 first:border-t-0 first:pt-0"
      data-testid="leak-row"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-display text-sm font-semibold text-ivory">
          Hand #{decision.handNumber}
        </span>
        <Tag>{STREET_SHORT[decision.street] ?? decision.street}</Tag>
        <Tag>{decision.position}</Tag>
        <span className="font-mono text-[0.68rem] uppercase tracking-wider text-ivory/50">
          {decision.action}
          {decision.cost > 0 ? ` ${money(decision.cost)}` : ""}
        </span>
        {onReplay && (
          <Button
            size="sm"
            onClick={() => onReplay(decision)}
            className="ml-auto shrink-0"
            data-testid="leak-replay"
          >
            Play it again
          </Button>
        )}
      </div>

      {/* -------- The knowable lens: bar, gold, ranked on -------- */}
      <div className="mt-2.5">
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[0.7rem]">
          <span className="text-ivory/60">
            Model: best was{" "}
            <span className="font-mono text-ivory/80">{decision.modelBestAction}</span>
          </span>
          <span className="font-mono" style={{ color: MODEL_COLOR }}>
            {chips(decision.modelEvLoss)}
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: "rgba(0,0,0,0.5)" }}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.max(2, share * 100)}%`, background: MODEL_COLOR }}
          />
        </div>
      </div>

      {/* ---- The results lens: no bar, dashed, kept apart ------- */}
      <div
        className={`mt-2.5 border border-dashed px-2.5 py-1.5 ${RADIUS.control}`}
        style={{ borderColor: "rgba(127,159,184,0.35)", background: "rgba(127,159,184,0.05)" }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[0.68rem]">
          <span className="text-ivory/45">
            Hindsight: with the cards face up, {decision.hindsightBestAction} was best
            {decision.hindsightExact ? "" : " (sampled runout)"}
          </span>
          <span className="font-mono" style={{ color: HINDSIGHT_COLOR }}>
            {chips(decision.hindsightEvLoss)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Leaks shown before the reader asks for more.
 *
 * Eight priced leaks is roughly 1,100px of ranked bars, and the eighth is
 * worth about a fifth of the first: past three, the list stops being a
 * priority order and starts being a wall that buries the one decision worth
 * replaying. The rest are one tap away, and the tap says what they cost.
 */
const LEAKS_SHOWN = 3;

export function LeakList({
  session,
  limit = 8,
  onReplay,
}: {
  session: SessionEvLoss;
  limit?: number;
  onReplay?: (decision: DecisionEvLoss) => void;
}) {
  const ranked = useMemo(
    () =>
      session.hands
        .flatMap((hand) => hand.decisions)
        // Ranked by the model lens only. See the module comment.
        .filter((d) => d.modelEvLoss < 0)
        .sort((a, b) => a.modelEvLoss - b.modelEvLoss)
        .slice(0, limit),
    [session.hands, limit]
  );

  if (ranked.length === 0) {
    return (
      <EmptyState title="Nothing has cost you yet">
        Every decision so far came out at or above the best line the model could
        find. Keep playing: leaks show up faster than they feel like they
        should.
      </EmptyState>
    );
  }

  // Every bar is scaled against the worst leak overall, not against the worst
  // one currently on screen, so opening the rest does not silently rescale the
  // three the reader was already looking at.
  const worst = Math.abs(ranked[0].modelEvLoss);
  const shown = ranked.slice(0, LEAKS_SHOWN);
  const rest = ranked.slice(LEAKS_SHOWN);
  const restTotal = rest.reduce((sum, d) => sum + Math.abs(d.modelEvLoss), 0);

  const row = (decision: DecisionEvLoss) => (
    <LeakRow
      key={`${decision.handNumber}:${decision.index}`}
      decision={decision}
      worst={worst}
      onReplay={onReplay}
    />
  );

  return (
    <div>
      {/*
       * `data-count` stays the number of leaks found, not the number rendered,
       * so anything reading it still learns what the analysis produced rather
       * than what the disclosure happens to be showing. `data-shown` is the
       * new, narrower fact.
       */}
      <div
        data-testid="leak-list"
        data-count={ranked.length}
        data-shown={shown.length}
      >
        {shown.map(row)}
      </div>

      {rest.length > 0 && (
        <Reveal
          label={`${rest.length} more, ranked`}
          summary={`${chips(restTotal)} between them`}
          tone="quiet"
          testId="reveal-more-leaks"
        >
          <div data-testid="leak-list-rest">{rest.map(row)}</div>
        </Reveal>
      )}

      <HowCalculated label="Why two numbers, and why they are never added">
        <p className="mb-2">
          Every decision is priced twice, from the same pot odds and the same
          alternatives, differing only in what the equity is measured against.
        </p>
        <p className="mb-2">
          <span style={{ color: MODEL_COLOR }}>Model</span> uses the range the
          opponents' own actions implied: public information, available while
          the decision was live. A negative model loss means a better line was
          visible at the time. This is the only one worth changing your play over.
        </p>
        <p className="mb-2">
          <span style={{ color: HINDSIGHT_COLOR }}>Hindsight</span> uses the cards
          they actually turned over. It answers "what did that cost", which is a
          fact about the deck rather than about the decision. A perfectly correct
          call against a range can lose the maximum in hindsight, every time.
        </p>
        <p>
          Adding them would double-count the same chips under two incompatible
          definitions and produce a number that means nothing. Ranking by their
          sum would promote every decision that ran badly, which is exactly the
          bias this split exists to remove.
        </p>
      </HowCalculated>
    </div>
  );
}

const STREETS = ["preflop", "flop", "turn", "river"] as const;

/** Streets that actually cost something, in the order they are played. */
function costlyStreets(session: SessionEvLoss) {
  return STREETS.filter(
    (s) => session.byStreet[s].model < 0 || session.byStreet[s].hindsight < 0
  );
}

/**
 * Which street is doing the damage, for the closed row of its reveal.
 *
 * The whole point of a per-street split is to answer one question, "where does
 * it go wrong", and the table answers it by making the reader scan four rows
 * of two columns. The worst street by the model lens is that answer, so it is
 * what the folded row says.
 */
export function LeakByStreetSummary({ session }: { session: SessionEvLoss }) {
  const rows = costlyStreets(session);
  if (rows.length === 0) return <>nothing lost on any street</>;
  const worst = rows.reduce((a, b) =>
    session.byStreet[b].model < session.byStreet[a].model ? b : a
  );
  return (
    <>
      worst {STREET_SHORT[worst]} · {chips(session.byStreet[worst].model)} model
    </>
  );
}

/** Per-street roll-up, both lenses, still side by side and still not summed. */
export function LeakByStreet({ session }: { session: SessionEvLoss }) {
  const rows = costlyStreets(session);
  // See `LossCurve`: inside a reveal, nothing is a bug rather than a blank.
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ivory/50" data-testid="by-street-empty">
        No street has cost you anything yet.
      </p>
    );
  }

  return (
    <Scroller>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            <th className="pb-2 pr-3 font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/40">
              Street
            </th>
            <th className="pb-2 pr-3 text-right font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/40">
              Model EV lost
            </th>
            <th className="pb-2 text-right font-display text-[0.6rem] uppercase tracking-[0.18em] text-ivory/40">
              Hindsight EV lost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((street) => (
            <tr key={street} style={{ borderTop: "1px solid rgba(244,237,228,0.08)" }}>
              <td className="py-2 pr-3 font-display text-xs text-gold-soft">
                {STREET_SHORT[street]}
              </td>
              <td
                className="py-2 pr-3 text-right font-mono text-xs"
                style={{ color: MODEL_COLOR }}
              >
                {chips(session.byStreet[street].model)}
              </td>
              <td
                className="py-2 text-right font-mono text-xs"
                style={{ color: HINDSIGHT_COLOR }}
              >
                {chips(session.byStreet[street].hindsight)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroller>
  );
}
