/**
 * Tab 4, the derivations, worked on this hand's own numbers.
 *
 * Every figure quoted here is pulled out of the report rather than invented for
 * the example, so the arithmetic can be checked against the tables on the other
 * tabs. Where the hand did not produce a number, nobody was ever priced, no
 * action moved a belief, the section says so instead of falling back to a
 * textbook illustration that never happened.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pct } from "../../lib/format";
import {
  INITIAL_BELIEF,
  LEARNING_PRIOR_ALPHA,
  LEARNING_PRIOR_DENOM,
} from "../../data/constants";
import { updateBelief } from "../../poker/bayesian";
import { hashSeed } from "../../poker/core/rng";
import { standardError, wilsonInterval } from "../../poker/core/stats";
import {
  BUCKET_COUNT,
  classifyHole,
  makeBoardContext,
  tierFromBucket,
  type HandBucket,
} from "../../poker/model/buckets";
import {
  ACTIONS,
  FACINGS,
  POOLED_STRENGTH,
  POSITIONS,
  PRIOR_STRENGTH,
  STREETS,
  collapsedLikelihoods,
  explainLikelihood,
} from "../../poker/model/likelihood";
import type { FoldEquityBreakdown } from "../../poker/ev";
import type { BotDecision, TableHandReport } from "../../poker/table/contract";
import { useTable } from "../../store/TableContext";
import { loadArchive, mergeHands } from "../profile/store";
import type { PlayerActionType, Street } from "../../types";
import {
  categoryRun,
  learnSeat,
  priceLadder,
  solveReviewRiver,
  type CategoryRun,
  type RiverSolveResult,
  type SessionModel,
} from "../learn/engine";
import {
  STREET_LABEL,
  aliveAfter,
  appliedLikelihood,
  bucketName,
  headsUpEquity,
  rangeView,
  readsAfter,
  reviewStreets,
  type AppliedLikelihood,
} from "./derive";
import {
  Calc,
  EmptyPanel,
  Frac,
  Heading,
  HowCalculated,
  LINE,
  Lead,
  Meter,
  Note,
  RADIUS,
  Scroller,
  Section,
  Stat,
  StatGrid,
  Tag,
  Well,
  Why,
} from "../ui";

interface Props {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}

function num(v: number, digits = 3): string {
  return v.toFixed(digits);
}

/**
 * "Callin' Carla's", or "your" when the seat under review is the reader's.
 *
 * `seatName` returns the table's own label for a seat, and for the human that
 * label is "You", which reads correctly as a subject and not at all as a
 * possessive. One helper rather than a second name-for-prose function, so a new
 * sentence cannot pick the wrong one.
 */
function possessive(name: string): string {
  return name === "You" ? "your" : `${name}'s`;
}

/** The same seat as the object of a sentence: "in the pot with you". */
function subject(name: string): string {
  return name === "You" ? "you" : name;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The decision with the most samples behind it, the best worked example. */
function richest(decisions: BotDecision[]): BotDecision | null {
  let best: BotDecision | null = null;
  for (const d of decisions) {
    if (d.equity.simulations === 0) continue;
    if (!best || d.equity.simulations > best.equity.simulations) best = d;
  }
  return best;
}

/**
 * The decision whose fold-equity breakdown makes the best worked example: the
 * reviewed seat's own if it has one, otherwise the one that priced the most
 * sizes. Returns null when nobody ever bet, checks, calls and folds carry no
 * fold-equity term, so there is nothing to show rather than something to
 * approximate.
 */
function bluffing(decisions: BotDecision[], focus: number): BotDecision | null {
  const priced = decisions.filter(
    (d) => d.foldEquity && Object.keys(d.foldEquity).length > 0
  );
  if (priced.length === 0) return null;
  const mine = priced.filter((d) => d.seat === focus);
  const pool = mine.length > 0 ? mine : priced;
  return pool.reduce((best, d) =>
    Object.keys(d.foldEquity!).length > Object.keys(best.foldEquity!).length ? d : best
  );
}

/**
 * A hand read back from the archive rather than played this session.
 *
 * `profile/store.ts` strips `decisions` before writing, the Monte Carlo audit
 * trail is a build-specific object and a stored one is either absent or no
 * longer understood, so a restored hand has a full action record and no
 * pricing. Every panel below that reads `BotDecision` has to say *that* rather
 * than "nobody was ever priced", which would be a claim about the hand instead
 * of a fact about the storage.
 */
function isRestored(report: TableHandReport): boolean {
  return report.decisions.length === 0 && report.actions.length > 0;
}

/** The stated absence a decision-derived panel falls back to. */
function NoTrail({ what }: { what: string }) {
  return (
    <EmptyPanel title="The decision trail was not stored">
      This hand came back from the archive, and the audit trail of what the
      engine priced is not part of what gets written down — only the cards, the
      chips and every action. So {what} cannot be shown for this hand. Every
      panel built from the action record works normally, here and below.
    </EmptyPanel>
  );
}

export function MathTab({ report, focus, seatName }: Props) {
  const restored = isRestored(report);
  const sample = richest(report.decisions);
  const priced =
    report.decisions.find((d) => d.toCall > 0) ??
    report.decisions[report.decisions.length - 1] ??
    null;
  const bluff = bluffing(report.decisions, focus);

  // The whole archive, not just this hand: a likelihood model estimated from one
  // hand's four decisions would be a demonstration of the formula rather than a
  // read on anybody. Assembled exactly the way `HandReview` assembles its own
  // list, stored hands, then the live ones on top, so the panel counts the
  // same hands the picker at the top of the page offers, and survives a reload.
  //
  // Restricted to tables of this size, because a seat index is all the record
  // identifies a player by: chair 2 at a six-max table and chair 2 heads-up are
  // not the same opponent, and pooling them would build a read on nobody.
  const { history, lastReport } = useTable();
  const hands = useMemo(() => {
    const live =
      lastReport && !history.some((r) => r.seed === lastReport.seed)
        ? [...history, lastReport]
        : history;
    return mergeHands(loadArchive().hands, live).filter(
      (r) => r.seatCount === report.seatCount
    );
  }, [history, lastReport, report.seatCount]);

  // First action that actually moved a read, the Bayes example. The
  // likelihoods come from `appliedLikelihood` rather than from the constants
  // module: the worked example has to be a readout of what the engine did to
  // this hand, not a second opinion about it.
  const moveIndex = report.actions.findIndex((a) => a.action !== "fold");
  const applied = moveIndex >= 0 ? appliedLikelihood(report, moveIndex) : null;
  const bayes =
    moveIndex >= 0 && applied
      ? {
          record: report.actions[moveIndex],
          applied,
          prior: readsAfter(report.actions, moveIndex, report.seatCount)[
            report.actions[moveIndex].seat
          ],
        }
      : null;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* ------------------------------------------------------------------ */}
      <Section
        title="Monte Carlo Precision"
        subtitle={
          sample
            ? `${sample.equity.simulations.toLocaleString()} trials · ${STREET_LABEL[sample.street]} · ${seatName(sample.seat)}`
            : restored
              ? "The trial counts are not part of what the archive stores"
              : "No simulation was run this hand"
        }
      >
        {!sample ? (
          restored ? (
            <NoTrail what="the trial counts and the interval around them" />
          ) : (
            <EmptyPanel title="Nothing was simulated">
              The pot was never contested by a seat that had to price a decision,
              so no Monte Carlo ran. Play a hand that reaches a flop with two
              seats still live and this section fills in.
            </EmptyPanel>
          )
        ) : (
          <MonteCarlo decision={sample} />
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="What This Hand Could Become"
        subtitle="The shape behind the win rate"
      >
        <CategoryShape report={report} focus={focus} seatName={seatName} />
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Equity As Information Arrives"
        subtitle="Five unknown cards, then two, then one, then none"
      >
        <EquityLadder report={report} focus={focus} seatName={seatName} />
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="Multiway Is Not Heads-Up" subtitle="Why the field compounds">
        {!sample || Object.keys(sample.equity.perOpponent).length === 0 ? (
          restored ? (
            <NoTrail what="the per-opponent equities the sampler measured" />
          ) : (
            <EmptyPanel title="Only one opponent was in the pot">
              With a single opponent, equity against the field and equity against
              that opponent are the same number, so there is nothing to compare.
            </EmptyPanel>
          )
        ) : (
          <Multiway decision={sample} seatName={seatName} />
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="Bayes, Worked" subtitle="One action, one posterior">
        {!bayes ? (
          <EmptyPanel title="No action moved a read">
            Every seat folded, so nothing updated. Beliefs stayed at the prior.
          </EmptyPanel>
        ) : (
          <BayesWorked
            action={bayes.record.action as PlayerActionType}
            street={bayes.record.street}
            seat={bayes.record.seat}
            prior={bayes.prior}
            applied={bayes.applied}
            seatName={seatName}
          />
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="What This Table Would Learn"
        subtitle={`${hands.length} archived hand${hands.length === 1 ? "" : "s"} at this table size · seat ${focus + 1}`}
      >
        <LearnedModel
          hands={hands}
          report={report}
          focus={focus}
          seatName={seatName}
        />
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Hand Classes Are Board-Relative"
        subtitle="The nine rungs the sampler actually works in"
      >
        <BucketLadder report={report} focus={focus} seatName={seatName} />
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="Expected Value" subtitle="What every action was worth">
        {!priced ? (
          restored ? (
            <NoTrail what="the EV the engine put on each action" />
          ) : (
            <EmptyPanel title="Nothing was priced">
              No seat at this table ran the EV comparison this hand.
            </EmptyPanel>
          )
        ) : (
          <EvWorked decision={priced} seatName={seatName} focus={focus} />
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Fold Equity, α and MDF"
        subtitle="The half of a bet that never reaches showdown"
      >
        {!bluff ? (
          <>
            {restored ? (
              <NoTrail what="the fold probability and the equity against the callers" />
            ) : report.actions.some(
                (a) => a.action === "bet" || a.action === "raise"
              ) ? (
              <EmptyPanel title="The seats that bet were not priced by the engine">
                A fold-equity breakdown is recorded by the decider, so it exists
                for the seats the engine plays and not for a human one — which
                runs no Monte Carlo and leaves no estimate of how often a bet got
                through. The threshold every one of those bets had to clear is
                arithmetic, though, and it is below.
              </EmptyPanel>
            ) : (
              <EmptyPanel title="Nothing was bet">
                Fold equity is the value of a bet nobody calls, so it is priced
                only for bets and raises. Every seat this hand checked, called or
                folded — actions that have no fold-equity term — so there is
                none to show.
              </EmptyPanel>
            )}
            <AlphaLadder report={report} focus={focus} seatName={seatName} />
          </>
        ) : (
          <FoldEquityWorked decision={bluff} seatName={seatName} />
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Equilibrium, And What It Would Have Done"
        subtitle="The river subgame, solved"
      >
        <Equilibrium report={report} focus={focus} seatName={seatName} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MonteCarlo({ decision }: { decision: BotDecision }) {
  const e = decision.equity;
  const n = e.simulations;
  const k = e.wins;
  const wilson = wilsonInterval(k, n);
  const se = standardError(e.pWin, n);
  const wald = { lo: Math.max(0, e.pWin - 1.96 * se), hi: Math.min(1, e.pWin + 1.96 * se) };
  const worst = n > 0 ? 100 / Math.sqrt(n) : 0;

  return (
    <>
      <StatGrid columns={4}>
        <Stat label="Trials" value={n.toLocaleString()} />
        <Stat label="Outright wins" value={k.toLocaleString()} />
        <Stat label="Chops" value={e.ties.toLocaleString()} />
        <Stat label="Pot share" value={pct(e.equity)} tone="gold" />
      </StatGrid>

      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P̂(win) =
          <Frac n={<>wins</>} d={<>trials</>} />=
          <Frac n={<>{k.toLocaleString()}</>} d={<>{n.toLocaleString()}</>} />=
          <span className="text-gold-soft">{num(e.pWin, 4)}</span>
        </div>
        <div className="mt-3">
          SE = √(p̂(1−p̂)/n) = √({num(e.pWin, 3)} × {num(1 - e.pWin, 3)} /{" "}
          {n.toLocaleString()}) ={" "}
          <span className="text-gold-soft">{num(se, 5)}</span>
        </div>
        <div className="mt-1 text-ivory/60">
          ≈ {(se * 100).toFixed(2)} percentage points. Worst case over any p is
          ±{worst.toFixed(2)} points, since p(1−p) peaks at ½.
        </div>
      </Calc>

      <Heading>The interval that is actually reported</Heading>
      <Calc>
        <div>
          Wilson 95%: [
          <span className="text-gold-soft">
            {pct(e.ciWin.lo, 2)}, {pct(e.ciWin.hi, 2)}
          </span>
          ]
        </div>
        <div className="mt-1 text-ivory/60">
          recomputed here from k = {k.toLocaleString()}, n = {n.toLocaleString()}:
          [{pct(wilson.lo, 2)}, {pct(wilson.hi, 2)}]
        </div>
        <div className="mt-3">
          Wald p̂ ± 1.96·SE: [{pct(wald.lo, 2)}, {pct(wald.hi, 2)}]
        </div>
      </Calc>

      <HowCalculated label="Why Wilson, Not p ± 1.96·SE">
        <Heading>Where Wald breaks</Heading>
        <Lead>
          Every simulation is one Bernoulli trial, so the estimate carries
          sampling error and both intervals are trying to describe the same
          thing. They agree in the middle. They part company at the edges, and a
          poker equity spends a lot of its life at the edges: by the river the
          hand is decided, p̂ is exactly 0 or 1, and the standard error collapses
          to zero — Wald then claims perfect certainty from a finite sample, and
          can report bounds outside [0, 1] on the way there.
        </Lead>
        <Heading>What Wilson does instead</Heading>
        <Calc>
          <div className="flex flex-wrap items-center gap-1">
            centre =
            <Frac n={<>p̂ + z²/2n</>} d={<>1 + z²/n</>} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            half-width =
            <Frac n={<>z</>} d={<>1 + z²/n</>} />
            × √( p̂(1−p̂)/n + z²/4n² )
          </div>
        </Calc>
        <Lead>
          The z²/2n in the numerator pulls the centre off the observed proportion
          and toward ½, by an amount that shrinks as n grows. At k = 0 the
          interval still has width — it says "we saw none in n tries", not "it
          cannot happen" — and it never leaves [0, 1].
        </Lead>
        {n > 0 && (
          <>
            <Heading>This estimate</Heading>
            <Lead>
              With {n.toLocaleString()} trials the two agree to within{" "}
              {((Math.abs(wilson.hi - wald.hi) + Math.abs(wilson.lo - wald.lo)) * 50).toFixed(3)}{" "}
              percentage points, which is the normal case. The reason the code
              uses Wilson everywhere is the abnormal one.
            </Lead>
          </>
        )}
        <Why>
          Sample size is not a footnote on an equity estimate — it is part of the
          estimate. Two hands both showing 62% are different hands if one ran
          20,000 trials and the other 5,000.
        </Why>
      </HowCalculated>
    </>
  );
}

// ---------------------------------------------------------------------------

function Multiway({
  decision,
  seatName,
}: {
  decision: BotDecision;
  seatName: (seat: number) => string;
}) {
  const e = decision.equity;
  const pairs = Object.entries(e.perOpponent).map(([seat, value]) => ({
    seat: Number(seat),
    value,
  }));
  const product = pairs.reduce((p, x) => p * x.value, 1);
  const weakest = pairs.reduce((a, b) => (a.value <= b.value ? a : b));

  return (
    <>
      <Lead>
        {seatName(decision.seat)} on the {STREET_LABEL[decision.street].toLowerCase()},
        against {pairs.length} opponent{pairs.length === 1 ? "" : "s"}:
      </Lead>
      <Calc>
        {pairs.map((p) => (
          <div key={p.seat}>
            vs {seatName(p.seat)} alone ={" "}
            <span className={p.seat === weakest.seat ? "text-[#e58a8a]" : "text-ivory"}>
              {pct(p.value)}
            </span>
          </div>
        ))}
        <div className="mt-3 border-t pt-2" style={{ borderColor: "rgba(244,237,228,0.2)" }}>
          against the whole field ={" "}
          <span className="text-gold-soft">{pct(e.equity)}</span>
        </div>
      </Calc>
      <Heading>Why the field number is lower than every pairwise one</Heading>
      <Lead>
        Winning means being strictly best, which is a conjunction: beat this one{" "}
        <em>and</em> that one <em>and</em> the next. If the matchups were
        independent the field equity would be their product —{" "}
        <span className="font-mono text-gold-soft">{pct(product)}</span> here — and
        they are not independent, because every opponent draws from the same deck
        and the same board. So the true figure sits between that product and the
        smallest pairwise number ({pct(weakest.value)}), which is where{" "}
        {pct(e.equity)} lands.
      </Lead>
      <Calc>
        P(beat all) ≤ min&#8202;ᵢ P(beat i) = {pct(weakest.value)}
        <div className="mt-1">
          and the sampler measures it directly rather than assuming independence.
        </div>
      </Calc>
      <Heading>Chops are not half a win</Heading>
      <Lead>
        Heads-up a tie is worth half the pot, so counting{" "}
        <span className="font-mono">wins + ½·ties</span> is right. Multiway a
        three-way chop is worth a third and a four-way chop a quarter, so the
        estimator has to track the <em>size</em> of each tie:
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          equity =
          <Frac n={<>wins + Σ 1/k over each k-way chop</>} d={<>trials</>} />
        </div>
        <div className="mt-2 text-ivory/60">
          this run: outright wins {e.wins.toLocaleString()}, chops{" "}
          {e.ties.toLocaleString()}, losses {e.losses.toLocaleString()} — pot
          share {pct(e.equity)} against an outright win rate of {pct(e.pWin)}.
        </div>
      </Calc>
      <Heading>One deck, drawn once</Heading>
      <Lead>
        The field is not sampled one opponent at a time. Every seat's hole cards
        are proposed together from that seat's own range, and if any two seats
        want the same card the whole tuple is thrown away and redrawn — so what
        survives is <span className="font-mono">Π p(hᵢ)</span> conditioned on the
        hands being disjoint, which is symmetric under relabelling the seats.
        Sampling seat by seat instead would let the first seat drawn quietly
        block the ones behind it, and the answer would depend on the order the
        chairs happen to be numbered in — see{" "}
        <span className="font-mono">poker/equity/multiway.ts</span>.
      </Lead>
      <Why>
        EV is driven by the share of the pot a hand collects, not by how often it
        is best. Multiway those two numbers stop being interchangeable, and using
        the wrong one systematically underprices hands that chop.
      </Why>
    </>
  );
}

// ---------------------------------------------------------------------------

function BayesWorked({
  action,
  street,
  seat,
  prior,
  applied,
  seatName,
}: {
  action: PlayerActionType;
  street: string;
  seat: number;
  prior: { weak: number; medium: number; strong: number };
  applied: AppliedLikelihood;
  seatName: (seat: number) => string;
}) {
  const like = applied.tier;
  const nw = like.weak * prior.weak;
  const nm = like.medium * prior.medium;
  const ns = like.strong * prior.strong;
  const z = nw + nm + ns;
  const posterior = updateBelief(prior, action);
  const label = action.charAt(0).toUpperCase() + action.slice(1);

  return (
    <>
      <Heading>The question</Heading>
      <Lead>
        Nobody can see a seat's cards, so the table keeps a probability
        distribution over how strong the hand is — weak, medium or strong — and
        revises it after every public action. Priors start at the model's opening
        read:
      </Lead>
      <Calc>
        P(weak) = {num(INITIAL_BELIEF.weak, 2)} &nbsp; P(medium) ={" "}
        {num(INITIAL_BELIEF.medium, 2)} &nbsp; P(strong) ={" "}
        {num(INITIAL_BELIEF.strong, 2)}
      </Calc>

      <Heading>Bayes' rule</Heading>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(H | A) =
          <Frac n={<>P(A | H) · P(H)</>} d={<>Σ&#8202;ᵢ P(A | Hᵢ) · P(Hᵢ)</>} />
        </div>
        <p className="mt-2 text-ivory/60">
          H = the hidden strength tier, A = the action just observed.
        </p>
      </Calc>

      <Heading>
        This hand — {seatName(seat)} on the {String(street).toLowerCase()}
      </Heading>
      <Lead>
        {seatName(seat)} chose to{" "}
        <strong className="uppercase text-gold-soft">{label}</strong>. These are
        the three numbers this update was multiplied by — the flat table, one row
        per action, the same on every street and in every seat:
      </Lead>
      <Calc>
        P({label} | weak) = {num(like.weak, 2)}
        <br />
        P({label} | medium) = {num(like.medium, 2)}
        <br />
        P({label} | strong) = {num(like.strong, 2)}
      </Calc>

      <Heading>Posterior</Heading>
      <Calc>
        <div>Numerators = likelihood × prior:</div>
        <div className="mt-1">
          weak: &nbsp;{num(like.weak, 2)} × {num(prior.weak, 3)} = {num(nw, 4)}
        </div>
        <div>
          medium: {num(like.medium, 2)} × {num(prior.medium, 3)} = {num(nm, 4)}
        </div>
        <div>
          strong: {num(like.strong, 2)} × {num(prior.strong, 3)} = {num(ns, 4)}
        </div>
        <div className="mt-2">
          Normaliser Σ = {num(nw, 4)} + {num(nm, 4)} + {num(ns, 4)} = {num(z, 4)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          P(strong | {label}) =
          <Frac n={<>{num(ns, 4)}</>} d={<>{num(z, 4)}</>} />=
          <span className="text-gold-soft">{pct(posterior.strong)}</span>
        </div>
      </Calc>

      <div
        className="grid grid-cols-2 gap-3 rounded-lg border p-3"
        style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.25)" }}
      >
        <div>
          <p className="text-[0.6rem] uppercase tracking-wider text-ivory/45">Prior</p>
          <p className="mt-1 font-mono text-[0.68rem] text-ivory/80">
            weak {pct(prior.weak)} · med {pct(prior.medium)} · strong{" "}
            {pct(prior.strong)}
          </p>
        </div>
        <div>
          <p className="text-[0.6rem] uppercase tracking-wider text-gold-soft/80">
            Posterior
          </p>
          <p className="mt-1 font-mono text-[0.68rem] text-gold-soft">
            weak {pct(posterior.weak)} · med {pct(posterior.medium)} · strong{" "}
            {pct(posterior.strong)}
          </p>
        </div>
      </div>

      <Heading>The likelihoods the ranges were actually built from</Heading>
      <Lead>
        The three numbers above move the coarse read, and that is all they do.
        The distribution the sampler drew this seat's hands from was reweighted
        by a different row: the same action conditioned on the{" "}
        <em>class of hand on this board</em>, plus the street, the position and
        what the seat was facing. Same action, same hand, nine answers —{" "}
        {applied.street}, {applied.position}, {applied.facing.replace("-", " ")}:
      </Lead>
      <Calc>
        {Array.from({ length: BUCKET_COUNT }, (_, b) => b).map((b) => (
          <div key={b}>
            P({label} | {bucketName(b)}) = {num(applied.byBucket[b], 3)}
          </div>
        ))}
        <div className="mt-2 text-ivory/60">
          spread from {num(Math.min(...applied.byBucket), 3)} to{" "}
          {num(Math.max(...applied.byBucket), 3)} — a factor of{" "}
          {num(
            Math.max(...applied.byBucket) / Math.max(1e-9, Math.min(...applied.byBucket)),
            2
          )}{" "}
          between the class this action is least likely from and the class it is
          most likely from.
        </div>
      </Calc>
      <Lead>
        The report records no likelihoods, so both rows above are recomputed
        rather than read back — but neither is a guess. The three-tier table is a
        constant, the conditioned model is a fixed prior with no player data in
        it, and the node (street, position, facing) is fully determined by the
        action record. Re-running the lookup returns what ran at the table.
      </Lead>
      <Why>
        Two models over one action, and only one of them prices anything. The
        three tiers are a summary a human can hold in their head; the nine
        classes are what the 13×13 charts on the Ranges tab are made of.
      </Why>
    </>
  );
}

// ---------------------------------------------------------------------------

function EvWorked({
  decision,
  seatName,
  focus,
}: {
  decision: BotDecision;
  seatName: (seat: number) => string;
  focus: number;
}) {
  const d = decision;
  const share = d.equity.equity;
  const entries = Object.entries(d.evByAction).sort((a, b) => b[1] - a[1]);
  const evCall = share * d.potBefore - (1 - share) * d.toCall;

  return (
    <>
      <Heading>The general form</Heading>
      <Calc>
        EV = P(win) × gain + P(tie) × (chop − stake) + P(lose) × loss
        <div className="mt-2 text-ivory/60">
          this decision: P(win) = {num(d.equity.pWin, 3)}, P(tie) ={" "}
          {num(d.equity.pTie, 3)}, P(lose) = {num(d.equity.pLoss, 3)} — they sum
          to {num(d.equity.pWin + d.equity.pTie + d.equity.pLoss, 3)}, because
          those three outcomes are all there are.
        </div>
      </Calc>
      <Lead>
        Folding is the zero baseline: risk nothing, win nothing. For a call the
        gain is the pot as it stands and the loss is only the chips put in, so
        the whole decision collapses to one comparison.
      </Lead>
      <Heading>Where the tie term goes</Heading>
      <Lead>
        Heads-up a chop returns the stake and splits the rest, so the middle term
        is worth half the pot and{" "}
        <span className="font-mono">P(win) + ½·P(tie)</span> can stand in for the
        whole expression — which is what <span className="font-mono">poker/ev.ts</span>{" "}
        means when it says ties are
        "chip-neutral". Multiway that shortcut breaks: a three-way chop is worth a
        third and a four-way chop a quarter, so the estimator tracks the size of
        every tie and reports <em>pot share</em> instead. Pot share supersedes the
        tie term rather than dropping it — it is the tie term, already integrated.
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          pot share =
          <Frac n={<>wins + Σ 1/k over each k-way chop</>} d={<>trials</>} />=
          <span className="text-gold-soft">{num(share, 4)}</span>
        </div>
        <div className="mt-2 text-ivory/60">
          against an outright win rate of {num(d.equity.pWin, 4)}. The gap —{" "}
          {num(share - d.equity.pWin, 4)} — is what the chops were worth, and it
          is exactly what a formula using P(win) alone would throw away.
        </div>
      </Calc>

      <Heading>
        This hand — {seatName(d.seat)}
        {d.seat === focus ? "" : " (the seat the engine priced)"}, {STREET_LABEL[d.street].toLowerCase()}
      </Heading>
      <Calc>
        pot = {d.potBefore} &nbsp; to call = {d.toCall} &nbsp; pot share ={" "}
        {num(share, 4)}
        {d.toCall > 0 ? (
          <div className="mt-3">
            EV(call) = {num(share, 3)} × {d.potBefore} − {num(1 - share, 3)} ×{" "}
            {d.toCall}
            <div className="mt-1">
              = <span className="text-gold-soft">{evCall.toFixed(2)}</span> chips
            </div>
          </div>
        ) : (
          <div className="mt-3">
            Nothing to call, so checking risks nothing and the comparison is
            between betting and taking a free card.
          </div>
        )}
      </Calc>

      <Heading>Every action the engine considered</Heading>
      <div className="space-y-1.5">
        {entries.map(([label, value]) => {
          const chosen = label === d.action.label;
          return (
            <div
              key={label}
              className="flex items-center justify-between gap-2 rounded-md px-3 py-1.5 font-mono text-xs"
              style={{
                background: chosen ? "rgba(201,162,39,0.15)" : "rgba(0,0,0,0.25)",
                border: chosen ? "1px solid rgba(201,162,39,0.5)" : "1px solid transparent",
              }}
            >
              <span className={chosen ? "text-gold-soft" : "text-ivory/70"}>{label}</span>
              <span className={chosen ? "font-bold text-gold-soft" : "text-ivory/80"}>
                {value >= 0 ? "+" : "−"}
                {Math.abs(value).toFixed(1)}
                {chosen ? "  ← taken" : ""}
              </span>
            </div>
          );
        })}
      </div>

      <HowCalculated label="Why The Highest Number Is Not Always Chosen">
        <Heading>EV ranks the actions; the profile picks one</Heading>
        <Lead>
          The engine prices every legal action and hands that table to the seat's
          personality. A pure maximiser takes the top row every time — that is
          the "professor" seat. Every other archetype bends it: an aggressive
          profile multiplies the EV of betting and raising, a nit needs a better
          hand before it will enter a pot at all, and a bluffing profile will
          sometimes fire with a holding that has no value.
        </Lead>
        <Lead>
          So the chosen row above may not be the largest, and that is not a bug
          in the arithmetic — it is the difference between knowing what a spot is
          worth and being the kind of player who takes it.
        </Lead>
        <Why>
          It also means the EV column is a fair yardstick for your own decisions:
          it is what the spot was worth, before anyone's temperament got involved.
        </Why>
      </HowCalculated>
    </>
  );
}

// ===========================================================================
// The shape behind a win rate
// ===========================================================================

/** Trials per distribution run. Matches the budget `derive.headsUpEquity` uses,
 *  so the two panels' sampling error is the same size. */
const SHAPE_SIMS = 20000;

/** Axis and grid ink for every chart on this tab. */
const AXIS = "rgba(244,237,228,0.45)";
const GRID = "rgba(244,237,228,0.12)";
const SERIES = ["#e2c563", "#7fd3a8", "#e58a8a", "#b07fd4", "#8ab4e5"];

const tooltipStyle = {
  background: "rgba(6,15,10,0.95)",
  border: "1px solid rgba(201,162,39,0.4)",
  borderRadius: 8,
  color: "#f4ede4",
  fontSize: 12,
};

/** The opponent worth running a hand out against: the one who put in the most. */
function mainVillain(report: TableHandReport, focus: number) {
  const others = report.seats.filter(
    (s) => s.seat !== focus && s.hole.length === 2
  );
  if (others.length === 0) return null;
  const shown = others.filter((s) => s.final !== null);
  const pool = shown.length > 0 ? shown : others;
  return pool.reduce((best, s) => (s.invested > best.invested ? s : best));
}

function CategoryShape({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const hero = report.seats.find((s) => s.seat === focus);
  const villain = mainVillain(report, focus);
  const streets = useMemo(
    () => reviewStreets(report).filter((s) => s.key !== "final"),
    [report]
  );
  const [pick, setPick] = useState<string>(streets[0]?.key ?? "preflop");
  const street = streets.find((s) => s.key === pick) ?? streets[0];

  const run: CategoryRun | null = useMemo(() => {
    if (!hero || !villain || !street) return null;
    return categoryRun(
      hero.hole,
      villain.hole,
      report.board.slice(0, street.boardLen),
      SHAPE_SIMS,
      // Fixed per (hand, street) so the same review always draws the same
      // histogram, and distinct across streets so the runs are independent.
      report.seed + street.boardLen
    );
  }, [hero, villain, street, report.board, report.seed]);

  if (!hero || hero.hole.length !== 2 || !villain || !run || !street) {
    return (
      <EmptyPanel title="No two hands to run out">
        A category distribution needs a holding and somebody to hold it against.
        This hand's record does not have both.
      </EmptyPanel>
    );
  }

  const data = run.shares
    .filter((s) => s.p > 0)
    .map((s) => ({ name: s.name, prob: +(s.p * 100).toFixed(2) }));
  const top = [...run.shares].sort((a, b) => b.p - a.p).slice(0, 3);

  return (
    <>
      <Lead>
        Given {possessive(seatName(focus))} two cards and the board as it stood,
        how often does each final five-card category turn up? Same run as the
        equity estimate, different thing recorded: the <em>category</em> of the
        best hand rather than whether it won. The run deals out of the deck{" "}
        {seatName(villain.seat)}'s cards left behind, which is the only way the
        opponent enters this chart at all — what a hand can <em>become</em>
        depends on the cards it can still see, not on what it is up against.
      </Lead>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {streets.map((s) => (
          <button
            key={s.key}
            onClick={() => setPick(s.key)}
            data-testid={`shape-${s.key}`}
            className={`min-h-[32px] border px-2.5 py-1 font-display text-[0.65rem] tracking-wide transition ${RADIUS.control}`}
            style={{
              borderColor:
                s.key === street.key ? "rgba(201,162,39,0.6)" : LINE.quiet,
              background:
                s.key === street.key ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
              color: s.key === street.key ? "#e2c563" : "rgba(244,237,228,0.55)",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <Well testId="shape-chart">
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 30)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 12, bottom: 0, left: 4 }}
          >
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              stroke={AXIS}
              fontSize={10}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              type="category"
              dataKey="name"
              stroke={AXIS}
              fontSize={10}
              width={78}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              formatter={(v) => [`${v}%`, "of runouts"]}
            />
            <Bar dataKey="prob" radius={[0, 4, 4, 0]} fill="#e2c563" />
          </BarChart>
        </ResponsiveContainer>
      </Well>

      <Heading>How it is computed</Heading>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(category) =
          <Frac
            n={<>runouts ending in that category</>}
            d={
              <>
                {run.settled ? "1 settled board" : `${SHAPE_SIMS.toLocaleString()} simulations`}
              </>
            }
          />
        </div>
        <div className="mt-2 text-ivory/60">
          {run.settled ? (
            <>
              The board was already complete here, so nothing was sampled: there
              is one runout, the hand is what it is, and the distribution is a
              single bar at 100%.
            </>
          ) : (
            <>
              {run.unknown} board card{run.unknown === 1 ? "" : "s"} still to
              come and {run.runouts.toLocaleString()} distinct runouts the deck
              allowed. The estimate drew {SHAPE_SIMS.toLocaleString()} of them at
              random, with repeats — so where the deck allows fewer than that,
              every runout is hit many times and the shape is exact to within
              rounding.
            </>
          )}
        </div>
      </Calc>

      <Heading>Most likely results</Heading>
      <ul className="space-y-1 text-sm text-ivory/75">
        {top.map((t) => (
          <li key={t.name} className="flex justify-between gap-3">
            <span>{t.name}</span>
            <span className="font-mono text-gold-soft">
              {pct(t.p)}
              {!run.settled && (
                <span className="text-ivory/40"> · {t.hits.toLocaleString()} sims</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <Why>
        Two hands can share a win rate and be nothing alike. One that gets there
        by making flushes plays differently from one that gets there by making
        top pair — same average, different shape, different bets. The win
        probability is one number off this whole distribution; the distribution
        is what a strategy is built on.
      </Why>
    </>
  );
}

// ===========================================================================
// The information ladder
// ===========================================================================

/** C(n, k), small n only, used for runout counts. */
function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}

interface LadderRow {
  street: Street;
  label: string;
  boardLen: number;
  vs: { seat: number; equity: number; exact: boolean }[];
  /** The seat's own recorded equity against the field, when the trail survived. */
  field: number | null;
}

const BETTING_STREETS: Street[] = ["preflop", "flop", "turn", "river"];

function streetIndexOf(street: Street): number {
  return street === "showdown" ? 3 : BETTING_STREETS.indexOf(street);
}

/**
 * The reviewed seat's equity against each opponent, street by street.
 *
 * Built from the action record and the cards, never from `decisions`: who
 * appears is "still contesting the pot entering this street", which is a fact
 * about the hand rather than about which seats happened to record a Monte
 * Carlo. That matters because a hand read back from the archive has no
 * decisions at all, and the story of the equity moving is exactly the part of
 * the review that should survive a reload.
 *
 * The numbers are `derive.headsUpEquity` under the same per-(hand, street,
 * matchup) seed the Hand tab uses, so the two panels cannot disagree.
 */
function ladderRows(report: TableHandReport, focus: number): LadderRow[] {
  const mine = report.seats.find((s) => s.seat === focus)?.hole ?? [];
  if (mine.length !== 2) return [];
  const hole = new Map(report.seats.map((s) => [s.seat, s.hole]));
  const rows: LadderRow[] = [];

  for (const street of reviewStreets(report)) {
    if (street.key === "final") continue;
    const live = aliveAfter(report, street.actionsUpTo);
    if (!live.includes(focus)) break;
    const board = report.board.slice(0, street.boardLen);

    const vs: LadderRow["vs"] = [];
    for (const seat of live) {
      if (seat === focus) continue;
      const theirs = hole.get(seat);
      if (!theirs || theirs.length !== 2) continue;
      const measured = headsUpEquity(
        mine,
        theirs,
        board,
        hashSeed(report.seed, streetIndexOf(street.street), focus, seat)
      );
      if (measured) {
        vs.push({ seat, equity: measured.equity, exact: measured.exact });
      }
    }

    const own = report.decisions
      .filter((d) => d.seat === focus && d.street === street.street)
      .pop();
    rows.push({
      street: street.street,
      label: street.label,
      boardLen: street.boardLen,
      vs,
      field: own ? own.equity.equity : null,
    });
  }
  return rows;
}

function EquityLadder({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const ladder = useMemo(() => ladderRows(report, focus), [report, focus]);

  if (ladder.length === 0 || ladder.every((r) => r.vs.length === 0)) {
    return (
      <EmptyPanel title="No matchup to trace">
        Nobody was in the pot with {subject(seatName(focus))} with cards on
        record, so there is no head-to-head equity to run out and no line to
        draw.
      </EmptyPanel>
    );
  }

  const opponents = Array.from(
    new Set(ladder.flatMap((s) => s.vs.map((v) => v.seat)))
  ).sort((a, b) => a - b);

  const data = ladder.map((s) => {
    const row: Record<string, number | string> = { street: s.label };
    for (const v of s.vs) row[seatName(v.seat)] = +(v.equity * 100).toFixed(1);
    if (s.field !== null) row["vs the field"] = +(s.field * 100).toFixed(1);
    return row;
  });
  const hasField = ladder.some((s) => s.field !== null);

  return (
    <>
      <Lead>
        Every point is {possessive(seatName(focus))} <em>full-knowledge equity</em>:
        both hole hands face up, the board run out from that street. Nobody had
        this number at the table — it needs cards that were face down — but the
        record has them now, so the review can show what the odds actually were
        rather than what anyone believed.
      </Lead>

      <Well testId="ladder-chart">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis dataKey="street" stroke={AXIS} fontSize={10} />
            <YAxis
              stroke={AXIS}
              fontSize={10}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "rgba(244,237,228,0.7)" }}
              iconSize={8}
            />
            {opponents.map((seat, i) => (
              <Line
                key={seat}
                type="monotone"
                dataKey={seatName(seat)}
                stroke={SERIES[i % SERIES.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            ))}
            {hasField && (
              <Line
                type="monotone"
                dataKey="vs the field"
                stroke="#f4ede4"
                strokeDasharray="4 3"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </Well>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        Solid lines are head-to-head against one opponent, both hands known, run
        out over the board as it stood — enumerated exactly wherever two or fewer
        cards were still to come. The dashed line, when the hand was played this
        session, is the seat's own recorded equity against the whole field:
        sampled from a read rather than from the cards, which is why it can sit
        below every solid line at once.
      </p>

      <Heading>What each street costs the uncertainty</Heading>
      <Scroller>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Street</th>
              <th className="py-2 pr-3 text-right">Board seen</th>
              <th className="py-2 pr-3 text-right">Cards unknown</th>
              <th className="py-2 pr-3 text-right">Runouts left</th>
              <th className="py-2 pr-3 text-right">Toughest opponent</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((s) => {
              const unknown = 5 - s.boardLen;
              const runouts = combinations(52 - 4 - s.boardLen, unknown);
              const threat = s.vs.reduce<LadderRow["vs"][number] | null>(
                (worst, h) => (worst === null || h.equity < worst.equity ? h : worst),
                null
              );
              return (
                <tr
                  key={s.street}
                  className="border-t"
                  style={{ borderColor: LINE.quietFaint }}
                >
                  <td className="py-2 pr-3 text-ivory/80">{s.label}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {s.boardLen}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {unknown}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {runouts.toLocaleString()}
                    {unknown > 2 && <span className="ml-1 text-ivory/30">sampled</span>}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                    {threat
                      ? `${pct(threat.equity)} vs ${seatName(threat.seat)}`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroller>

      <HowCalculated label="Why The Line Straightens Out">
        <Heading>The ladder</Heading>
        <Lead>
          Preflop there are five unknown board cards and 1,712,304 ways they can
          land, so almost every matchup is somewhere near a coin flip: the deck
          has more say than the cards do. The flop reveals three at once, which
          is the largest single transfer of information in the hand, and the line
          moves hardest there. The turn leaves 44 runouts. The river leaves one.
        </Lead>
        <Heading>The last rung is not an estimate</Heading>
        <Lead>
          With the board complete there is nothing left to sample: the hand is
          decided and the equity is exactly 100% or exactly 0% — or exactly 50%
          when the two hands tie. Every number on the right of this chart is a
          fact, and the ones on the left are probabilities. They are drawn on the
          same axis because they are the same quantity, seen with different
          amounts of the deck showing.
        </Lead>
        <Why>
          Watching this line is the clearest picture of what a community card is:
          not luck arriving, but information arriving — and value moving with it
          from whoever was ahead in the dark to whoever the board just chose.
        </Why>
      </HowCalculated>
    </>
  );
}

// ===========================================================================
// Fold equity with no trail: the arithmetic half, which always survives
// ===========================================================================

function AlphaLadder({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const bets = report.actions
    .map((record, index) => ({ record, index }))
    .filter(
      ({ record }) =>
        (record.action === "bet" || record.action === "raise") &&
        record.cost - record.toCall > 0
    );
  if (bets.length === 0) return null;

  return (
    <>
      <Heading>What the bets in this hand had to buy</Heading>
      <Lead>
        Whether the fold probability was recorded or not, the threshold every one
        of these bets had to clear is not an estimate: α is exact arithmetic on
        the pot and the size, and both are in the action record. A bluff at this
        price is profitable above the line and loses below it, whatever anyone
        believed at the time.
      </Lead>
      <Scroller>
        <table className="w-full text-sm" data-testid="alpha-ladder">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Street</th>
              <th className="py-2 pr-3">Seat</th>
              <th className="py-2 pr-3 text-right">Pot</th>
              <th className="py-2 pr-3 text-right">Risked</th>
              <th className="py-2 pr-3 text-right">α</th>
              <th className="py-2 pr-3 text-right">MDF</th>
            </tr>
          </thead>
          <tbody>
            {bets.map(({ record, index }) => {
              const size = record.cost - record.toCall;
              const pot = record.potBefore + record.toCall;
              const alpha = size / (pot + size);
              return (
                <tr
                  key={index}
                  className="border-t"
                  style={{
                    borderColor: LINE.quietFaint,
                    background:
                      record.seat === focus ? "rgba(201,162,39,0.10)" : undefined,
                  }}
                >
                  <td className="py-2 pr-3 text-ivory/80">
                    {STREET_LABEL[record.street]}
                  </td>
                  <td className="py-2 pr-3 text-ivory/70">{seatName(record.seat)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {pot}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {size}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                    {pct(alpha, 1)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {pct(1 - alpha, 1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroller>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          α =
          <Frac n={<>s</>} d={<>Pot + s</>} />
          &nbsp;&nbsp; MDF = 1 − α =
          <Frac n={<>Pot</>} d={<>Pot + s</>} />
        </div>
        <div className="mt-2 text-ivory/60">
          s is the increment risked beyond any call and Pot is the pot once that
          call is in — the frame <span className="font-mono">model/decider.ts</span>{" "}
          sizes bets in. A pure bluff
          breaks even at α; below that it is losing money, above it, it prints.
        </div>
      </Calc>
    </>
  );
}

// ===========================================================================
// The learned opponent model
// ===========================================================================

const TIER_KEYS: ("weak" | "medium" | "strong")[] = ["weak", "medium", "strong"];

function LearnedModel({
  hands,
  report,
  focus,
  seatName,
}: {
  hands: TableHandReport[];
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const session: SessionModel = useMemo(
    () => learnSeat(hands, focus),
    [hands, focus]
  );
  const who = subject(seatName(focus));

  // The node to quote the model at: this seat's last decision in this hand, so
  // the table below is the row that would have priced the move the review is
  // already looking at.
  const index = useMemo(() => {
    for (let i = report.actions.length - 1; i >= 0; i--) {
      if (report.actions[i].seat === focus) return i;
    }
    return -1;
  }, [report, focus]);
  const node = index >= 0 ? appliedLikelihood(report, index) : null;

  const seat = report.seats.find((s) => s.seat === focus);
  const bucket: HandBucket | null =
    node && seat && seat.hole.length === 2
      ? classifyHole(
          seat.hole[0],
          seat.hole[1],
          makeBoardContext(
            report.board.slice(
              0,
              Math.min(
                node.street === "preflop" ? 0 : node.street === "flop" ? 3 : node.street === "turn" ? 4 : 5,
                report.board.length
              )
            )
          )
        )
      : null;

  const learned = node
    ? collapsedLikelihoods(session.model, node.street, node.position, node.facing)
    : null;
  const untouched = node
    ? collapsedLikelihoods(session.fresh, node.street, node.position, node.facing)
    : null;

  const walk =
    node && bucket !== null
      ? explainLikelihood(session.model, node.action, {
          bucket,
          street: node.street,
          position: node.position,
          facing: node.facing,
        })
      : null;

  return (
    <>
      <Lead>
        Every likelihood on this tab so far came from a fixed prior — a model of
        poker in general, not of the seat sitting in that chair. This panel is the
        other half: what the same machinery says once it has watched somebody
        play. Each decision {who} took is one observation, filed by the hand class
        it was taken with, the street, the position and what it was facing.
      </Lead>

      <StatGrid columns={4}>
        <Stat label="Hands with a decision" value={session.hands} />
        <Stat label="Decisions recorded" value={session.observations} tone="gold" />
        <Stat
          label="Revealed at showdown"
          value={session.attributed}
          note="carry a hand class"
        />
        <Stat
          label="Mucked"
          value={session.unattributed}
          note="action only, no class"
        />
      </StatGrid>

      {session.attributed > 0 && (
        <>
          <Heading>The hands {who} showed down</Heading>
          <Scroller>
            <table className="w-full text-sm" data-testid="observed-classes">
              <thead>
                <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
                  <th className="py-2 pr-3">Class held</th>
                  <th className="py-2 pr-3 text-right">Decisions seen</th>
                  <th className="py-2 pr-3 text-right">Share of the revealed</th>
                  <th className="py-2 pr-3">Legacy tier</th>
                </tr>
              </thead>
              <tbody>
                {session.byBucket.map((count, b) =>
                  count === 0 ? null : (
                    <tr
                      key={b}
                      className="border-t"
                      style={{ borderColor: LINE.quietFaint }}
                    >
                      <td className="py-2 pr-3 text-ivory/80">{bucketName(b)}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                        {count}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/60">
                        {pct(count / session.attributed, 1)}
                      </td>
                      <td className="py-2 pr-3 text-xs capitalize text-ivory/45">
                        {tierFromBucket(b as HandBucket)}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </Scroller>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            One row per decision, not per hand — each decision was taken at its
            own node with its own class, so a hand that was air on the flop and a
            monster on the river contributes to both rows. These are the counts
            that make P(action | class) estimable at all; the {session.unattributed}{" "}
            decisions from hands that never got shown are not in this table and
            cannot be.
          </p>
        </>
      )}

      {session.observations === 0 ? (
        <Note label="Nothing observed yet">
          This seat has not taken a decision in the archive this review can see.
          Play a hand out and the counts below start moving.
        </Note>
      ) : (
        <p className="mt-3 text-[0.7rem] leading-relaxed text-ivory/45">
          Counted over every stored hand dealt to a table of this size, because
          the seat index is the only thing the record identifies a player by.
          Across a session at one table that is exactly the player in that chair;
          across two different tables it is two different people, which is why
          hands from other table sizes are left out rather than pooled in.
        </p>
      )}

      {learned && untouched && node && (
        <>
          <Heading>
            P(action | tier) at this seat's last node —{" "}
            {STREET_LABEL[node.street as Street] ?? node.street}, {node.position},{" "}
            {node.facing.replace("-", " ")}
          </Heading>
          <Lead>
            The old model had one such table for the whole game. This one is a
            table per node, which is why the numbers below are not the numbers
            anywhere else in the hand: the same raise unopened on the button and
            facing a three-bet in the big blind are different events, and a model
            that averages them cannot say anything a player did not already know.
          </Lead>
          <Scroller>
            <table className="w-full text-sm" data-testid="learned-table">
              <thead>
                <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
                  <th className="py-2 pr-3">P(action | ·)</th>
                  {TIER_KEYS.map((t) => (
                    <th key={t} className="py-2 pr-3 text-right capitalize">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ACTIONS.map((action) => (
                  <tr
                    key={action}
                    className="border-t"
                    style={{ borderColor: LINE.quietFaint }}
                  >
                    <td className="py-2 pr-3 capitalize text-ivory/80">
                      {action}
                      {action === node.action && (
                        <span className="ml-2">
                          <Tag tone="gold">taken</Tag>
                        </span>
                      )}
                    </td>
                    {TIER_KEYS.map((t) => {
                      const now = learned[action][t];
                      const before = untouched[action][t];
                      const moved = Math.abs(now - before) > 0.0005;
                      return (
                        <td key={t} className="py-2 pr-3 text-right font-mono text-xs">
                          <span className={moved ? "text-gold-soft" : "text-ivory/75"}>
                            {pct(now, 1)}
                          </span>
                          {moved && (
                            <span className="ml-1 text-ivory/35">
                              from {pct(before, 1)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            Gold means this session's play has moved the estimate off the prior;
            the grey figure beside it is where the prior had it. Each column is
            the average over the buckets in that tier — three of the nine rungs
            each, uniformly, because weighting them would need a range this module
            deliberately does not depend on.
          </p>
        </>
      )}

      <Heading>The update, in one line</Heading>
      <Lead>
        Raw frequencies swing wildly on small samples — one raise out of one hand
        is not a 100% raiser — so every probability is a posterior mean with a
        Dirichlet prior behind it.{" "}
        <span className="font-mono">model/likelihood.ts</span> writes it as:
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(action) =
          <Frac
            n={<>count + δ · priorMean</>}
            d={<>total + δ</>}
          />
        </div>
        <div className="mt-3 text-ivory/60">
          with δ = {PRIOR_STRENGTH} pseudo-decisions of prior weight. Substituting
          the flat prior mean α/δ = {LEARNING_PRIOR_ALPHA}/{LEARNING_PRIOR_DENOM}{" "}
          = {num(LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM, 2)} gives back the
          original form exactly:
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          P(action | tier) =
          <Frac
            n={<>handsWithAction + {LEARNING_PRIOR_ALPHA}</>}
            d={<>handsObserved + {LEARNING_PRIOR_DENOM}</>}
          />
        </div>
        <div className="mt-2 text-ivory/60">
          No data returns the prior mean; total → ∞ returns the empirical
          frequency. The only generalisation is that the prior mean is now
          supplied by a coarser estimate instead of being pinned at{" "}
          {num(LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM, 2)} — which is what
          turns one Beta update into a hierarchy.
        </div>
      </Calc>

      {walk && node && bucket !== null && (
        <>
          <Heading>
            The hierarchy, walked — P({node.action} | {bucketName(bucket)}) here
          </Heading>
          <Lead>
            Nine hand classes × {STREETS.length} streets × {POSITIONS.length}{" "}
            positions × {FACINGS.length} facings is{" "}
            {session.cellSpace.toLocaleString()} cells, and a session produces a
            few hundred decisions. Most cells are empty forever, so the lookup
            starts at the prior and walks coarse to fine, each level using only
            the evidence the finer ones did not see. A level with no data is the
            identity — it hands its parent's estimate straight through, which is
            what decides whether the model is useful after fifty hands or only
            after five thousand.
          </Lead>
          <Scroller>
            <table className="w-full text-sm" data-testid="backoff-table">
              <thead>
                <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
                  <th className="py-2 pr-3">Level</th>
                  <th className="py-2 pr-3">Cell</th>
                  <th className="py-2 pr-3 text-right">Own evidence</th>
                  <th className="py-2 pr-3 text-right">Took it</th>
                  <th className="py-2 pr-3 text-right">Estimate</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t" style={{ borderColor: LINE.quietFaint }}>
                  <td className="py-2 pr-3 text-ivory/80">prior</td>
                  <td className="py-2 pr-3 font-mono text-[0.65rem] text-ivory/40">
                    generated, no data
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/40">—</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/40">—</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/75">
                    {pct(walk.prior, 1)}
                  </td>
                </tr>
                {walk.steps.map((step) => (
                  <tr
                    key={step.key}
                    className="border-t"
                    style={{ borderColor: LINE.quietFaint }}
                  >
                    <td className="py-2 pr-3 text-ivory/80">{step.level}</td>
                    <td className="py-2 pr-3 font-mono text-[0.65rem] text-ivory/40">
                      {step.key}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                      {step.observations}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                      {step.matching}
                    </td>
                    <td
                      className="py-2 pr-3 text-right font-mono text-xs"
                      style={{
                        color: step.observations > 0 ? "#e2c563" : "rgba(244,237,228,0.5)",
                      }}
                    >
                      {pct(step.estimate, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            "Own evidence" is exclusive: every decision is counted once, at the
            finest level that saw it, by inclusion and exclusion over the six
            cells. Summing that column returns the total number of decisions
            recorded. The two coarsest levels pool over hand classes, so their
            evidence is discounted — prior strength {POOLED_STRENGTH} against{" "}
            {PRIOR_STRENGTH}, i.e. {POOLED_STRENGTH / PRIOR_STRENGTH} pooled
            observations move a bucket about as far as one attributed observation
            does.
          </p>
        </>
      )}

      <Heading>What a fold teaches, and what it does not</Heading>
      <Lead>
        {session.unattributed === 0 ? "None" : session.unattributed} of this
        seat's {session.observations} decisions came from hands that were never
        shown. Those write to the two bucket-free
        levels and stop: how often this player takes this action at this node is
        fully observable, and P(action | hand class) is not, because the cards
        went in the muck. Assigning them a class would launder a guess into a
        number presented as a fact about somebody's play.
      </Lead>
      <Lead>
        That is not a consolation prize. The bucket-free levels are the shrinkage
        target for the bucket-conditioned ones, so unattributed data moves every
        class's estimate <em>together</em> — which compresses the likelihood ratio
        between classes. Learning that a player raises constantly, without ever
        seeing what they raise with, should make a raise mean <em>less</em>, not
        make it mean "strong". That is where a bluffer discount comes from, and it
        works before the first showdown.
      </Lead>

      <Note label="Where this model is, and is not, used">
        The live table does not learn. <span className="font-mono">model/decider.ts</span>{" "}
        prices every hand
        against a fresh prior model that is never written to, and nothing in the
        app calls the accumulator — so the numbers above are what this session's
        own play <em>would</em> teach, rebuilt from the archive after the fact,
        not a read any bot acted on. The machinery is real and tested; the wiring
        from the table into it is the piece that does not exist yet.
      </Note>

      <HowCalculated label="Why Conditioning Needed A Backoff">
        <Heading>The sparsity the axes create</Heading>
        <Lead>
          Conditioning is free to write down and expensive to estimate. Splitting
          one table into {session.cellSpace.toLocaleString()} means each cell sees
          a few hundredths of the data, and a cell with three observations in it
          produces a confident-looking number that is mostly noise. The backoff is
          not a refinement of the conditioning — it is the thing that makes
          conditioning affordable at all.
        </Lead>
        <Heading>Why position is dropped first</Heading>
        <Lead>
          The six levels are ordered by how fast each fills with data. Position
          goes first because it is the weakest signal per unit of sparsity: six
          values, and most of what position does is already visible through what
          the seat is facing. The hand class is introduced late and never dropped
          from the four finest levels, because it is the axis being estimated.
        </Lead>
        <Heading>The honest caveat</Heading>
        <Lead>
          Attributed data is selection-biased. Hands survive to showdown
          disproportionately when they were strong enough to keep calling, so
          P(action | class) estimated from showdowns over-represents hands that
          wanted to see the river. The bucket-free levels are not biased that way,
          which is a second reason to keep them in the chain.
        </Lead>
      </HowCalculated>
    </>
  );
}

// ===========================================================================
// Board-relative hand classes
// ===========================================================================

function BucketLadder({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const seat = report.seats.find((s) => s.seat === focus);
  const villain = mainVillain(report, focus);
  const streets = useMemo(() => reviewStreets(report), [report]);
  const final = streets[streets.length - 1];

  const view = useMemo(
    () =>
      villain && seat && seat.hole.length === 2 && final
        ? rangeView(report, final, villain.seat, seat.hole)
        : null,
    [report, villain, seat, final]
  );

  const path = useMemo(() => {
    if (!seat || seat.hole.length !== 2) return [];
    return streets
      .filter((s) => s.key !== "final")
      .map((s) => ({
        label: s.label,
        bucket: classifyHole(
          seat.hole[0],
          seat.hole[1],
          makeBoardContext(report.board.slice(0, s.boardLen))
        ) as HandBucket,
      }));
  }, [seat, streets, report.board]);

  return (
    <>
      <Lead>
        The engine does not ask "is this a good hand". It asks "what is this hand
        <em> on this board</em>", and the answer is one of nine classes. That
        replaced a preflop score that was being applied on every street: on
        K-7-2-9-4 a Chen-style score still files 7-2 under <em>weak</em>, when it
        has flopped two pair and is beating most of the deck. Bucketing an
        opponent's range with that is not a small inaccuracy — it puts the made
        hands in the wrong bin, and every equity number sampled out of those bins
        inherits the error.
      </Lead>

      {path.length > 0 && (
        <>
          <Heading>
            {capitalise(possessive(seatName(focus)))} hand, reclassified as the board arrived
          </Heading>
          <div className="flex flex-wrap items-center gap-2" data-testid="bucket-path">
            {path.map((p, i) => (
              <span key={p.label} className="flex items-center gap-2">
                {i > 0 && <span className="text-ivory/30">→</span>}
                <span className="flex flex-col">
                  <span className="font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
                    {p.label}
                  </span>
                  <span className="mt-0.5">
                    <Tag
                      tone={
                        p.bucket >= 7 ? "good" : p.bucket >= 3 ? "gold" : "neutral"
                      }
                    >
                      {bucketName(p.bucket)}
                    </Tag>
                  </span>
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            Same two cards throughout. The class changes because the board does,
            which is the entire point of measuring strength against it.
          </p>
        </>
      )}

      {view && villain && (
        <>
          <Heading>
            Where {seatName(villain.seat)}'s range sat on the ladder, at the end
          </Heading>
          <div className="space-y-1.5" data-testid="bucket-weights">
            {Array.from({ length: BUCKET_COUNT }, (_, b) => b).map((b) => (
              <Meter
                key={b}
                label={
                  <span className="text-ivory/70">
                    {b}. {bucketName(b)}
                    <span className="ml-2 text-ivory/35">{tierFromBucket(b as HandBucket)}</span>
                  </span>
                }
                value={view.buckets[b] / Math.max(1e-9, Math.max(...view.buckets))}
                text={pct(view.buckets[b], 1)}
                color={b >= 6 ? "#7fd3a8" : b >= 3 ? "#e2c563" : "rgba(244,237,228,0.35)"}
              />
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            This is the range the sampler drew that seat's cards from, weighed by
            class rather than by chart cell — the same numbers the Ranges tab
            paints, read along the strength axis instead of the 13×13 one.
          </p>
        </>
      )}

      <Heading>Two results that contradict the obvious guess</Heading>
      <Lead>
        The order of the ladder is load-bearing: downstream code aggregates
        "belief mass at or above class k", which only means anything if the index
        is monotone in strength. The cut points were placed by measurement — every
        combo rolled out on forty random boards per street — and two of the
        answers are not what intuition says.
      </Lead>
      <Calc>
        <div>
          Strong Draw sits <span className="text-gold-soft">below</span> Weak Pair.
        </div>
        <div className="mt-1 text-ivory/60">
          A bare flush draw or open-ender with no pair measures 0.514 on the flop
          and 0.392 on the turn against a random hand; bottom pair measures 0.571
          and 0.550. Draws feel stronger than that because they are usually held
          alongside something — and this class is what is left once that something
          has been classified on its own.
        </div>
        <div className="mt-3">
          Top Pair and Overpair are the <span className="text-gold-soft">same rung</span>.
        </div>
        <div className="mt-1 text-ivory/60">
          0.776 / 0.796 on the flop, 0.773 / 0.756 on the turn, 0.783 / 0.791 on
          the river — the sign of the gap flips with the boards drawn, so the test
          asserts they are close rather than pretending the ladder is sharper than
          the game is.
        </div>
      </Calc>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        Both figures are quoted from{" "}
        <span className="font-mono">poker/model/buckets.ts</span>, where{" "}
        <span className="font-mono">buckets.test.ts</span> measures them on every run.
      </p>

      <HowCalculated label="Is Nine Classes The Right Abstraction?">
        <Heading>The objection</Heading>
        <Lead>
          Ordering classes by mean equity is expected hand strength, and EHS is
          the metric the abstraction literature rejects: it "fails to account for
          the entire probability distribution of hand strength" (Ganzfried &
          Sandholm, AAAI-14). So the ladder was re-audited against distributions
          rather than means.
        </Lead>
        <Heading>What the audit found</Heading>
        <Lead>
          Searching all 9! orderings for the one whose Earth Mover's Distance
          matrix is most monotone away from the diagonal returns <em>this</em>{" "}
          order, on every street. The only alternative that ever ties it is the
          one that swaps Top Pair and Overpair — the single adjacency the
          measurement above already declines to order. Hands sharing a class are
          about three times closer in EMD than hands from different ones, and
          roughly 99% of combos have their nearest neighbour inside their own
          class.
        </Lead>
        <Heading>What it does not excuse</Heading>
        <Lead>
          The tails. On Ks-7s-Qc the flop puts a backdoor flush and a gutshot to
          Broadway in the same draw class, 21.1 EMD bins apart — further than Air
          is from Weak Pair. On a four-flush board, Monster holds both a straight
          flush and the same straight losing to every diamond. Nine hand-crafted
          classes have nowhere to put "ace-high with a gutshot". Fixing that means
          more classes, and the class count is frozen by the keys the learned
          model persists — so it is not a change that can be made in one file.
        </Lead>
        <Why>
          Every range chart, every reweighting and every simulated opponent hand
          in this product is built on these nine bins. Knowing where they are
          honest and where they are coarse is knowing how much to trust the
          numbers they produce.
        </Why>
      </HowCalculated>
    </>
  );
}

// ===========================================================================
// Fold equity
// ===========================================================================

/** The chip figure a sizing label carries: "Bet $30" → 30. */
function sizeFromLabel(label: string): number | null {
  const m = /\$(\d+(?:\.\d+)?)/.exec(label);
  return m ? Number(m[1]) : null;
}

function FoldEquityWorked({
  decision,
  seatName,
}: {
  decision: BotDecision;
  seatName: (seat: number) => string;
}) {
  const d = decision;
  const breakdowns = Object.entries(d.foldEquity ?? {}) as [
    string,
    FoldEquityBreakdown,
  ][];
  const pot = d.potBefore;
  const opening = d.toCall === 0;
  const chosen = breakdowns.find(([label]) => label === d.action.label)?.[1] ?? null;
  const eRange = d.equityVsRange ?? null;
  const ladder = priceLadder(pot);

  return (
    <>
      <Lead>
        A bet wins two different ways and the showdown formula only counts one of
        them. Everything above this section prices a call: chips in, pot share
        out. A bet also wins whenever nobody calls it at all — and that branch is
        the whole reason a hand with no showdown value can be worth betting.
      </Lead>

      <Heading>The formula, from poker/ev.ts</Heading>
      <Calc>
        EV(bet s) = P(fold) · Pot + (1 − P(fold)) · [ E_continue · (Pot + 2s) − s ]
        <div className="mt-2 text-ivory/60">
          The bracket is the same arithmetic a call gets — E·(Pot + s) − (1 − E)·s
          — with E_continue substituted for the win rate. That identity is why
          this extends the old formula rather than competing with it.
        </div>
      </Calc>

      <Heading>
        {seatName(d.seat)}, {STREET_LABEL[d.street].toLowerCase()} — every size the
        engine priced
      </Heading>
      <Scroller>
        <table className="w-full text-sm" data-testid="fold-equity-table">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Size</th>
              <th className="py-2 pr-3 text-right">P(all fold)</th>
              <th className="py-2 pr-3 text-right">α = s/(P+s)</th>
              <th className="py-2 pr-3 text-right">MDF</th>
              <th className="py-2 pr-3 text-right">E_continue</th>
              <th className="py-2 pr-3 text-right">Callers</th>
              <th className="py-2 pr-3 text-right">Fold EV</th>
              <th className="py-2 pr-3 text-right">Call EV</th>
              <th className="py-2 pr-3 text-right">EV</th>
            </tr>
          </thead>
          <tbody>
            {breakdowns.map(([label, b]) => {
              const size = opening ? sizeFromLabel(label) : null;
              const taken = label === d.action.label;
              return (
                <tr
                  key={label}
                  className="border-t"
                  style={{
                    borderColor: LINE.quietFaint,
                    background: taken ? "rgba(201,162,39,0.10)" : undefined,
                  }}
                >
                  <td className="py-2 pr-3 text-ivory/80">
                    {label}
                    {taken && (
                      <span className="ml-2">
                        <Tag tone="gold">taken</Tag>
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/85">
                    {pct(b.pFold, 1)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                    {size !== null ? pct(size / (pot + size), 1) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {size !== null ? pct(pot / (pot + size), 1) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {b.simulations > 0 ? pct(b.eContinue, 1) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                    {b.callers.toFixed(2)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {b.foldEv.toFixed(1)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {b.callEv.toFixed(1)}
                  </td>
                  <td
                    className="py-2 pr-3 text-right font-mono text-xs"
                    style={{ color: b.ev >= 0 ? "#7fd3a8" : "#e58a8a" }}
                  >
                    {b.ev >= 0 ? "+" : "−"}
                    {Math.abs(b.ev).toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroller>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        P(all fold), E_continue, the two EV terms and the mean number of callers
        are all recorded by the engine at the moment it priced this move. α and
        MDF are exact arithmetic on the pot of {pot}
        {opening
          ? ""
          : " — left blank here because this seat was facing a bet, so the label carries a total rather than the increment α is defined on"}
        .
      </p>

      <Heading>Where α comes from</Heading>
      <Lead>
        Set E_continue to zero — a pure bluff, no equity at all — and the formula
        collapses to <span className="font-mono">P(fold)·Pot − (1 − P(fold))·s</span>,
        which is zero exactly at:
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          α =
          <Frac n={<>s</>} d={<>Pot + s</>} />
          &nbsp;&nbsp; MDF = 1 − α =
          <Frac n={<>Pot</>} d={<>Pot + s</>} />
        </div>
        <div className="mt-3">Evaluated at this hand's pot of {pot} chips:</div>
        <div className="mt-1">
          {ladder.map((rung) => (
            <div key={rung.fraction}>
              {rung.fraction === 2 ? "twice pot" : `${rung.fraction * 100}% pot`} — bet{" "}
              {rung.size.toFixed(1)}: α = {pct(rung.alpha, 1)}, MDF ={" "}
              {pct(rung.mdf, 1)}
            </div>
          ))}
        </div>
        <div className="mt-2 text-ivory/60">
          These are the published numbers — 33.3, 42.9, 50, 66.7 — and they are a
          closed-form result from the literature rather than a property of this
          code, which is exactly why{" "}
          <span className="font-mono">ev.test.ts</span> pins all four against the
          implementation. If the two disagree, the code is wrong.
        </div>
      </Calc>

      {eRange !== null && chosen && chosen.simulations > 0 && (
        <>
          <Heading>The gap that makes a bluff work</Heading>
          <StatGrid columns={3}>
            <Stat
              label="Equity vs the whole range"
              value={pct(eRange)}
              note="everything they could hold"
            />
            <Stat
              label="Equity vs the callers"
              value={pct(chosen.eContinue)}
              tone={chosen.eContinue < eRange ? "bad" : "good"}
              note="what is left facing the bet"
            />
            <Stat
              label="Bought by folding"
              value={pct(chosen.pFold)}
              tone="gold"
              note={`${chosen.foldEv.toFixed(1)} chips uncontested`}
            />
          </StatGrid>
          <Lead>
            Those two equities are the load-bearing pair, and they differ by{" "}
            <span className="font-mono text-gold-soft">
              {pct(Math.abs(eRange - chosen.eContinue), 1)}
            </span>{" "}
            here. Pricing a bet against the wrong one of them systematically
            overvalues betting — it turns every missed draw into a "profitable"
            bet against a range that has already folded its air, which is a worse
            failure than never bluffing at all.
          </Lead>
          <Lead>
            {chosen.eContinue < eRange ? (
              <>
                Here the continuing equity is the <em>lower</em> of the two, which
                is the usual case and the reason this distinction exists: folding
                is strength-correlated, so the hands that fold are the weak ones
                and what is left facing the bet is the strong tail.
              </>
            ) : (
              <>
                Here the continuing equity is the <em>higher</em> of the two, and
                that is a multiway effect rather than a contradiction. Equity
                against the range is measured against{" "}
                {chosen.pFoldEach.length} opponent
                {chosen.pFoldEach.length === 1 ? "" : "s"} at once; equity against
                the callers is measured against the{" "}
                {chosen.callers.toFixed(2)} that stayed, on average. Two forces
                pull on it — the folders being weak pulls it down, the field
                getting smaller pushes it up — and with a field this size the
                second one wins.
              </>
            )}
          </Lead>
          <Calc>
            <div>
              continuing range: each combo weighted by 1 − P(fold | class), then
              renormalised
            </div>
            <div className="mt-1 text-ivory/60">
              which is exactly the posterior over their holding conditioned on
              "did not fold".
            </div>
          </Calc>
        </>
      )}

      {chosen && chosen.pFoldEach.length > 1 && (
        <>
          <Heading>Fold equity dies exponentially in the field</Heading>
          <Calc>
            {chosen.pFoldEach.map((p, i) => (
              <div key={i}>opponent {i + 1} folds with probability {num(p, 3)}</div>
            ))}
            <div className="mt-2">
              P(all {chosen.pFoldEach.length} fold) = Π = {num(chosen.pFold, 4)}
            </div>
            <div className="mt-2 text-ivory/60">
              A 55% fold rate is 55% heads-up, 30% against two, 9% against four.
              That decay is why bluffing multiway is bad long before any
              second-order dependence between the opponents' ranges matters.
            </div>
          </Calc>
        </>
      )}

      <HowCalculated label="Why The Call Branch Is Not Two Numbers Multiplied">
        <Heading>The tempting shortcut</Heading>
        <Lead>
          The table above reports a mean equity against the callers and a mean
          number of callers, so it looks as if the call branch should be
          E_continue × (pot + callers·s) − (1 − E_continue)·cost. It is not, and
          the difference runs one way.
        </Lead>
        <Heading>Why it fails</Heading>
        <Lead>
          That form factorises an expectation of a product. Heads-up it is exact
          because the field size is the constant one; multiway both the hero's
          share and the field size are random, and they are{" "}
          <em>negatively correlated</em> — the hero takes a smaller fraction of
          the pot in exactly the simulations where more opponents stayed to
          contest it. By that correlation E[share]·(Pot + E[k]·s) is strictly
          greater than E[share·(Pot + k·s)] whenever k varies at all, and the gap
          runs entirely in the "betting looks better" direction: on a 100-chip pot
          it reached +12 chips against five opponents, enough to flip bets that
          are really checks.
        </Lead>
        <Lead>
          So the call term is accumulated one simulation at a time, with that
          simulation's own share and its own field, and never reassembled out of
          the two marginal means. E_continue and the caller count survive only as
          reporting — which is what they are doing in this panel.
        </Lead>
        <Why>
          Two independent errors, both flattering to aggression, both removed. The
          one remaining approximation is that P(all fold) is taken to be the
          product of the per-opponent marginals, which ignores the weak coupling
          card removal creates between their ranges — and that too runs one way,
          so the bot is slightly over-optimistic about bluffing into a field.
        </Why>
      </HowCalculated>
    </>
  );
}

// ===========================================================================
// Equilibrium
// ===========================================================================

type SolveState =
  | { status: "working" }
  | { status: "done"; value: RiverSolveResult };

/** Tree action labels, in English. */
function moveLabel(label: string): string {
  if (label === "allin") return "all-in";
  const m = /^([br])(\d+)$/.exec(label);
  if (m) return `${m[1] === "b" ? "bet" : "raise"} ${m[2]}% pot`;
  return label;
}

/**
 * Solve the river subgame off the first paint.
 *
 * A solve is a few dozen milliseconds of tight loops, fast enough to be worth
 * doing, far too slow to do during a render that also has two charts in it. The
 * same zero-timeout the EV-loss panel uses: the section paints, then the work
 * happens, then the numbers arrive.
 */
function useRiverSolve(report: TableHandReport, focus: number): SolveState {
  const [state, setState] = useState<SolveState>({ status: "working" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "working" });
    const id = window.setTimeout(() => {
      let value: RiverSolveResult;
      try {
        const river = reviewStreets(report).find(
          (s) => s.key === "river"
        );
        value = river
          ? solveReviewRiver(
              report,
              focus,
              (seat) => rangeView(report, river, seat, []).range
            )
          : { ok: false, reason: "the hand never reached a river" };
      } catch (err) {
        value = {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (!cancelled) setState({ status: "done", value });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [report, focus]);

  return state;
}

function Equilibrium({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const state = useRiverSolve(report, focus);
  const solved = state.status === "done" && state.value.ok ? state.value.solve : null;

  return (
    <>
      <Lead>
        Every other number on this tab prices a decision against a <em>read</em> —
        what these opponents, with these tendencies, are likely holding. An
        equilibrium asks a different question: what strategy could not be beaten
        by <em>any</em> opponent, including one who knew it in advance and played
        perfectly against it?
      </Lead>

      {state.status === "working" && (
        <div className="flex h-[6rem] items-center justify-center gap-3 text-sm text-ivory/55">
          <span className={`h-2 w-2 animate-pulse bg-gold-soft ${RADIUS.marker}`} />
          Solving the river…
        </div>
      )}

      {state.status === "done" && !state.value.ok && (
        <Note label="This hand has no subgame to solve">
          {state.value.reason}. The solver handles a two-player river: a complete
          board, both ranges known from the betting, and a decision to compare
          against. The explanation below stands either way.
        </Note>
      )}

      {solved && (
        <>
          <StatGrid columns={4}>
            <Stat
              label="Hands solved"
              value={`${solved.handCounts[0]} × ${solved.handCounts[1]}`}
              note={`${solved.decisionNodes} decision nodes`}
            />
            <Stat
              label="Iterations"
              value={solved.iterations.toLocaleString()}
              note="Discounted CFR"
            />
            <Stat
              label="Solve time"
              value={`${solved.solveMs.toFixed(0)} ms`}
              tone="gold"
              note={`${solved.totalMs.toFixed(0)} ms including ranges`}
            />
            <Stat
              label="Exploitability"
              value={`${solved.exploitChips.toFixed(2)}`}
              note={`chips/hand — ${pct(solved.exploitPotShare, 2)} of the pot`}
            />
          </StatGrid>

          <Heading>
            What equilibrium does with {possessive(seatName(focus))} exact hand, here
          </Heading>
          <Lead>
            {seatName(solved.oop)} was out of position and acts first.{" "}
            {seatName(focus)} held a hand ranked {solved.handRank} of{" "}
            {solved.handTotal} by showdown strength inside its own solved range,
            facing a pot of {solved.pot}. This is the mix the solved strategy
            plays with <em>that specific holding</em> at that node — not with the
            range in aggregate:
          </Lead>
          <div className="space-y-1.5" data-testid="equilibrium-mix">
            {solved.mix.map((m) => (
              <Meter
                key={m.label}
                label={
                  <span className={m.taken ? "text-ivory" : "text-ivory/60"}>
                    {moveLabel(m.label)}
                    {m.taken && " ← what actually happened"}
                  </span>
                }
                value={m.probability}
                text={pct(m.probability, 1)}
                color={m.taken ? "#e2c563" : "rgba(244,237,228,0.3)"}
              />
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            A mix rather than a choice is the point: at equilibrium most holdings
            in most spots are played more than one way, because a strategy that
            always did the same thing with the same hand would be readable and
            therefore beatable. "{seatName(focus)} took the{" "}
            {solved.matched ? moveLabel(solved.matched) : solved.actual.action}{" "}
            branch" is not a verdict — it is a comparison against a distribution.
          </p>

          <Note label="What this solve assumed">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <strong>Stack depth.</strong> The hand record carries no stack
                sizes, so the subgame was solved at an effective stack of{" "}
                {solved.stack} chips — the largest commitment the river actually
                saw, floored at one pot. Change the depth and the equilibrium
                changes.
              </li>
              <li>
                <strong>Range size.</strong> The heaviest combos of each range
                were kept, holding {pct(solved.coverage[0], 1)} and{" "}
                {pct(solved.coverage[1], 1)} of their weight. A full 1081 × 1081
                river runs about 2 ms per iteration, which is a solve a browser
                tab cannot afford between two paints.
              </li>
              <li>
                <strong>Bet sizes.</strong> The tree offers a third, two thirds,
                pot and all-in.
                {solved.approximated
                  ? " A real bet here was snapped to its nearest rung, so the branch labels are the abstraction's, not the table's."
                  : " Every move replayed here landed on a rung exactly."}
              </li>
              <li>
                <strong>Exploitability in chips.</strong> mbb/h — thousandths of a
                big blind per hand — is the standard unit, and the record carries
                no blind level, so it is quoted here in chips and as a share of
                the pot instead.
              </li>
            </ul>
          </Note>
        </>
      )}

      <HowCalculated label="What An Equilibrium Is, And How You Check One">
        <Heading>Regret, minimised</Heading>
        <Lead>
          The solver is Discounted CFR (Brown & Sandholm, AAAI 2019). It plays the
          subgame against itself thousands of times, and after each pass it asks,
          for every decision point and every hand it could hold there: how much
          better off would I have been had I always taken this action instead? That
          quantity is regret, and the next iteration plays each action in
          proportion to its accumulated positive regret. The <em>average</em> of
          the strategies over all iterations — not the last one — is what
          converges to equilibrium.
        </Lead>
        <Heading>Exploitability is the only honest test</Heading>
        <Lead>
          A solver with a sign error still produces strategies that look like
          poker: it bets strong hands and folds weak ones, because the payoffs
          force that much. What a broken solver cannot do is drive exploitability
          down. Exploitability is how much a perfect counter-strategy beats the
          profile for — computed here exactly, by best-responding at every node
          rather than by running a second solver — and it is zero exactly at
          equilibrium and never negative in a two-player zero-sum game.
        </Lead>
        <Calc>
          exploitability = ½ · [ BR(player 0) + BR(player 1) ]
          <div className="mt-2 text-ivory/60">
            reported in mbb/h — thousandths of a big blind per hand — so that a
            number from one game is comparable with a number from another. 50
            mbb/h means a perfect opponent takes 0.05 big blinds per hand off this
            strategy.
          </div>
        </Calc>
        <Heading>Why it is validated against toys</Heading>
        <Lead>
          The solver's tests do not check that it plays well. They check it
          against Kuhn poker, a three-card game whose equilibrium has a known
          closed form, and against published Nash push/fold charts for short-stack
          heads-up play. Both are external answers this code cannot influence,
          which is what makes agreeing with them evidence rather than
          self-congratulation.
        </Lead>
        <Why>
          An equilibrium is not the best way to play these opponents — a read
          beats it against anybody exploitable, which is what the rest of this tab
          is for. It is the floor: the strategy that cannot be beaten, so it is
          the yardstick that tells you whether a "clever" line was clever or just
          lucky.
        </Why>
      </HowCalculated>
    </>
  );
}
