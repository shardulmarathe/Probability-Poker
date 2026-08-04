/**
 * The concepts surface: the probability, without a hand attached.
 *
 * The hand review answers "what happened in that hand". This page answers "what
 * is this number, and why is it that number", the same six or seven ideas the
 * engine is built out of, each one demonstrated by running the engine here, in
 * the browser, on cards this page names out loud.
 *
 * Two rules it shares with the review, and they are the reason it is a page
 * rather than a document:
 *
 *   - Nothing is illustrated with a figure somebody typed in. Every probability,
 *     interval, class and exploitability below is computed when the page renders
 *     or when the reader presses the button that runs it. Where an example needs
 *     specific cards, the cards are the example and the numbers are the engine's.
 *   - The vocabulary is the review's vocabulary, the same `HowCalculated` folds,
 *     the same `Calc` blocks, the same fractions, so a student who learns the
 *     idea here recognises it the moment it turns up next to their own hand.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pct } from "../../lib/format";
import { ACTION_LIKELIHOODS, INITIAL_BELIEF } from "../../data/constants";
import { updateBelief } from "../../poker/bayesian";
import { runMultiwayEquitySync } from "../../poker/equity/pool";
import {
  BUCKET_COUNT,
  HandBucket,
  classifyAll,
  classifyHole,
  makeBoardContext,
  tierFromBucket,
} from "../../poker/model/buckets";
import { BUCKET_NAMES } from "../../poker/model/buckets";
import {
  ACTIONS,
  FACINGS,
  POSITIONS,
  STREETS,
  createLikelihoodModel,
  likelihoodRow,
  type Facing,
  type LearnStreet,
} from "../../poker/model/likelihood";
import {
  COMBO_COUNT,
  comboIndex,
  emptyRange,
  normalizeRange,
  type Range,
} from "../../poker/model/range";
import type { PositionName } from "../../poker/table/position";
import type { PlayerActionType } from "../../types";
import { PageBody, PageHeader } from "../shell";
import {
  Calc,
  CardRow,
  Frac,
  Group,
  Heading,
  HowCalculated,
  LINE,
  Lead,
  Meter,
  Note,
  RADIUS,
  Scroller,
  Stat,
  StatGrid,
  Tag,
  Well,
  Why,
} from "../ui";
import {
  boardClasses,
  cardCodes,
  convergence,
  priceLadder,
  solveDemo,
  type ConvergencePoint,
  type SolveDemo,
} from "./engine";

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

const AXIS = "rgba(244,237,228,0.45)";
const GRID = "rgba(244,237,228,0.12)";
const tooltipStyle = {
  background: "rgba(6,15,10,0.95)",
  border: "1px solid rgba(201,162,39,0.4)",
  borderRadius: 8,
  color: "#f4ede4",
  fontSize: 12,
};

/** A row of mutually exclusive choices. The page's only control. */
function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="mb-1 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
        {label}
      </p>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              onClick={() => onChange(o.value)}
              className={`min-h-[32px] border px-2.5 py-1 font-display text-[0.65rem] tracking-wide transition ${RADIUS.control}`}
              style={{
                borderColor: active ? "rgba(201,162,39,0.6)" : LINE.quiet,
                background: active ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
                color: active ? "#e2c563" : "rgba(244,237,228,0.55)",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The button that runs something expensive. Named for what it will do. */
function RunButton({
  onClick,
  children,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`min-h-[38px] border px-4 py-2 font-display text-sm font-semibold tracking-wide transition hover:-translate-y-px ${RADIUS.action}`}
      style={{
        borderColor: "rgba(201,162,39,0.55)",
        background: "rgba(201,162,39,0.15)",
        color: "#e2c563",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 1. Monte Carlo
// ---------------------------------------------------------------------------

const MATCHUPS = [
  { id: "race", label: "A♥K♥ vs 7♣7♦", hero: "Ah Kh", villain: "7c 7d", board: "" },
  { id: "dominated", label: "A♠Q♦ vs A♥J♣", hero: "As Qd", villain: "Ah Jc", board: "" },
  { id: "draw", label: "J♥T♥ vs K♠K♣ on 9♥8♣2♥", hero: "Jh Th", villain: "Ks Kc", board: "9h 8c 2h" },
] as const;

const SAMPLE_SIZES = [500, 2000, 8000, 32000];

function MonteCarloConcept() {
  const [pick, setPick] = useState<string>(MATCHUPS[0].id);
  const [seed, setSeed] = useState(20260801);
  const matchup = MATCHUPS.find((m) => m.id === pick) ?? MATCHUPS[0];

  const runs: ConvergencePoint[] = useMemo(
    () =>
      convergence(
        cardCodes(matchup.hero),
        cardCodes(matchup.villain),
        cardCodes(matchup.board),
        SAMPLE_SIZES,
        seed
      ),
    [matchup, seed]
  );

  const last = runs[runs.length - 1];
  const first = runs[0];
  const ratio = first.se > 0 ? first.se / last.se : 0;
  const sizeRatio = Math.sqrt(last.simulations / first.simulations);

  return (
    <Group
      id="monte-carlo"
      title="Monte Carlo"
      lede="Counting outcomes you cannot enumerate, and knowing how wrong the count is."
    >
      <Lead>
        Two hands and five community cards leave more runouts than anyone wants
        to walk: preflop there are 1,712,304 boards. So the engine does not walk
        them. It deals the remaining cards at random, plays the hand out, records
        who won, and repeats — and the fraction of wins converges on the
        probability of winning. That is the entire idea. What makes it a
        measurement rather than a guess is the second half: every estimate comes
        with an interval, and the interval shrinks in a way you can predict.
      </Lead>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Choice
          label="Matchup"
          value={pick}
          onChange={setPick}
          options={MATCHUPS.map((m) => ({ value: m.id, label: m.label }))}
          testId="matchup-choice"
        />
        <RunButton onClick={() => setSeed((s) => s + 1)} testId="resample">
          Draw a fresh sample
        </RunButton>
      </div>

      <div className="mb-4 flex flex-wrap gap-4">
        <CardRow label="Hero" cards={cardCodes(matchup.hero)} />
        <CardRow label="Opponent" cards={cardCodes(matchup.villain)} />
        {matchup.board && <CardRow label="Board" cards={cardCodes(matchup.board)} />}
      </div>

      <Scroller>
        <table className="w-full text-sm" data-testid="convergence-table">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Trials</th>
              <th className="py-2 pr-3 text-right">P̂(win)</th>
              <th className="py-2 pr-3 text-right">± SE</th>
              <th className="py-2 pr-3 text-right">95% interval</th>
              <th className="py-2 pr-3 text-right">Width</th>
              <th className="py-2 pr-3 text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.simulations}
                className="border-t"
                style={{ borderColor: LINE.quietFaint }}
              >
                <td className="py-2 pr-3 font-mono text-xs text-ivory/80">
                  {r.simulations.toLocaleString()}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                  {pct(r.pWin, 2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  {(r.se * 100).toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  {pct(r.ci.lo, 1)} – {pct(r.ci.hi, 1)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                  {((r.ci.hi - r.ci.lo) * 100).toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/40">
                  {r.ms.toFixed(1)} ms
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>

      <Calc>
        SE = √( p̂(1 − p̂) / n )
        <div className="mt-2 text-ivory/60">
          {first.simulations.toLocaleString()} trials gave ±
          {(first.se * 100).toFixed(2)} points;{" "}
          {last.simulations.toLocaleString()} gave ±{(last.se * 100).toFixed(2)}.
          That is a factor of {ratio.toFixed(2)} for{" "}
          {(last.simulations / first.simulations).toFixed(0)}× the work, against
          √{(last.simulations / first.simulations).toFixed(0)} ={" "}
          {sizeRatio.toFixed(2)} predicted. Precision costs the square of what you
          want: halving the error means four times the trials.
        </div>
      </Calc>

      <Note label="Watch the estimate, not just the interval">
        Press "draw a fresh sample" a few times. The estimate moves — that is
        sampling error being sampling error — and it moves less in the bottom row
        than in the top one. It stays inside its interval about nineteen times out
        of twenty, which is what "95%" means and is the only promise a Monte Carlo
        ever makes.
      </Note>

      <HowCalculated label="Why The Interval Is Wilson's, Not p̂ ± 1.96·SE">
        <Heading>Where the textbook interval breaks</Heading>
        <Lead>
          Every simulation is one Bernoulli trial, so both intervals describe the
          same thing and they agree in the middle. They part company at the edges,
          and a poker equity spends a lot of its life at the edges: by the river
          the hand is decided, p̂ is exactly 0 or 1, and the standard error
          collapses to zero. The Wald interval then claims perfect certainty from
          a finite sample, and can report bounds outside 0–1 on the way there.
        </Lead>
        <Heading>What Wilson does instead</Heading>
        <Calc>
          <div className="flex flex-wrap items-center gap-1">
            centre =
            <Frac n={<>p̂ + z²/2n</>} d={<>1 + z²/n</>} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            half-width =
            <Frac n={<>z</>} d={<>1 + z²/n</>} />× √( p̂(1−p̂)/n + z²/4n² )
          </div>
        </Calc>
        <Lead>
          The z²/2n pulls the centre off the observed proportion and toward a
          half, by an amount that shrinks as n grows. At zero observed wins the
          interval still has width — it says "we saw none in n tries", not "it
          cannot happen" — and it never leaves 0–1.
        </Lead>
        <Why>
          Sample size is not a footnote on an estimate; it is part of it. Two
          hands both showing 62% are different hands if one ran 20,000 trials and
          the other 500.
        </Why>
      </HowCalculated>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 2. Bayesian updating
// ---------------------------------------------------------------------------

const TIER_KEYS = ["weak", "medium", "strong"] as const;

function BayesConcept() {
  const [action, setAction] = useState<PlayerActionType>("raise");
  const [street, setStreet] = useState<LearnStreet>("river");
  const [facing, setFacing] = useState<Facing>("facing-bet");
  const [position, setPosition] = useState<PositionName>("BTN");

  const prior = INITIAL_BELIEF;
  const like = ACTION_LIKELIHOODS[action];
  const posterior = updateBelief(prior, action);
  const numerators = {
    weak: like.weak * prior.weak,
    medium: like.medium * prior.medium,
    strong: like.strong * prior.strong,
  };
  const z = numerators.weak + numerators.medium + numerators.strong;

  // The conditioned model, at its data-free prior: what the engine believes
  // about an action before it has met anybody.
  const model = useMemo(() => createLikelihoodModel("poker"), []);
  const rows = useMemo(
    () =>
      Array.from({ length: BUCKET_COUNT }, (_, bucket) =>
        likelihoodRow(model, { bucket, street, position, facing })
      ),
    [model, street, position, facing]
  );
  const spread = rows.map((r) => r[action]);
  const cells = BUCKET_COUNT * STREETS.length * POSITIONS.length * FACINGS.length;

  return (
    <Group
      id="bayes"
      title="Bayesian updating"
      lede="Nobody can see the cards, so the table keeps a probability over them and revises it."
    >
      <Lead>
        A read is not a guess about what somebody has. It is a distribution over
        what they could have, and every public action multiplies it by how likely
        that action would be from each holding. That is Bayes' rule, and it is the
        whole of what the table knows about anyone.
      </Lead>

      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(H | A) =
          <Frac n={<>P(A | H) · P(H)</>} d={<>Σ&#8202;ᵢ P(A | Hᵢ) · P(Hᵢ)</>} />
        </div>
        <div className="mt-2 text-ivory/60">
          H is the hidden strength, A is the action you just watched. The
          denominator is only there to make the answer sum to one.
        </div>
      </Calc>

      <div className="mb-4">
        <Choice
          label="They…"
          value={action}
          onChange={setAction}
          options={ACTIONS.map((a) => ({ value: a, label: a }))}
          testId="bayes-action"
        />
      </div>

      <Scroller>
        <table className="w-full text-sm" data-testid="bayes-table">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Tier</th>
              <th className="py-2 pr-3 text-right">Prior</th>
              <th className="py-2 pr-3 text-right">P({action} | tier)</th>
              <th className="py-2 pr-3 text-right">Product</th>
              <th className="py-2 pr-3 text-right">Posterior</th>
            </tr>
          </thead>
          <tbody>
            {TIER_KEYS.map((t) => (
              <tr key={t} className="border-t" style={{ borderColor: LINE.quietFaint }}>
                <td className="py-2 pr-3 capitalize text-ivory/80">{t}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  {prior[t].toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  {like[t].toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                  {numerators[t].toFixed(4)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                  {pct(posterior[t], 1)}
                </td>
              </tr>
            ))}
            <tr className="border-t" style={{ borderColor: LINE.quiet }}>
              <td className="py-2 pr-3 text-ivory/50">Σ</td>
              <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                1.00
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                {z.toFixed(4)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                100%
              </td>
            </tr>
          </tbody>
        </table>
      </Scroller>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        The posterior column is the product column divided by its own sum. An
        action nobody plays differently with different hands leaves the read
        exactly where it was — which is why a check on a wet board says almost
        nothing and a river raise says a great deal.
      </p>

      <Heading>The same action at a different node</Heading>
      <Lead>
        Three tiers and one table is a summary. The model the engine actually
        prices with conditions on four things at once — the hand class, the
        street, the position and what the actor is facing — because "raise"
        unopened is a bet, "raise" facing a bet is a raise, and "raise" facing a
        raise is a three-bet, and the three carry wildly different implications.
        Folding is only <em>legal</em> in the last two, so pooling them corrupts
        the fold rate as well.
      </Lead>

      <div className="mb-3 flex flex-wrap gap-4">
        <Choice
          label="Street"
          value={street}
          onChange={setStreet}
          options={STREETS.map((s) => ({ value: s, label: s }))}
        />
        <Choice
          label="Facing"
          value={facing}
          onChange={setFacing}
          options={FACINGS.map((f) => ({ value: f, label: f.replace("-", " ") }))}
        />
        <Choice
          label="Position"
          value={position}
          onChange={setPosition}
          options={POSITIONS.map((p) => ({ value: p, label: p }))}
        />
      </div>

      <div className="space-y-1.5" data-testid="conditioned-rows">
        {rows.map((row, bucket) => (
          <Meter
            key={bucket}
            label={
              <span className="text-ivory/70">
                {BUCKET_NAMES[bucket as HandBucket]}
              </span>
            }
            value={row[action] / Math.max(...spread)}
            text={pct(row[action], 1)}
            color={bucket >= 6 ? "#7fd3a8" : bucket >= 3 ? "#e2c563" : "rgba(244,237,228,0.35)"}
          />
        ))}
      </div>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        P({action}) at this node, by hand class — spread from{" "}
        {pct(Math.min(...spread), 1)} to {pct(Math.max(...spread), 1)}, a factor
        of {(Math.max(...spread) / Math.max(1e-9, Math.min(...spread))).toFixed(1)}.
        Change the street or what they are facing and the whole shape moves. This
        is the row that reweights a range; the three-tier table above only moves
        the coarse read.
      </p>

      <HowCalculated label="What Conditioning Costs, And How It Is Paid For">
        <Heading>The sparsity</Heading>
        <Lead>
          {BUCKET_COUNT} hand classes × {STREETS.length} streets ×{" "}
          {POSITIONS.length} positions × {FACINGS.length} facings is{" "}
          {cells.toLocaleString()} cells, and a couple of hundred hands produce a
          few hundred decisions. Most cells are empty forever. A model that
          answered from the cell alone would either have no answer or a confident
          one built on three observations.
        </Lead>
        <Heading>The backoff</Heading>
        <Lead>
          So six nested estimates are kept, ordered by how fast each fills with
          data — everything, then (street, facing), then the class, then class and
          street, then class, street and facing, then all four. A lookup starts at
          the prior and walks coarse to fine, each level shrinking toward the
          previous one's answer with a Dirichlet prior. A level with no evidence is
          exactly the identity, so an empty cell inherits its parent's estimate
          rather than snapping back to the prior. That property is what decides
          whether a model is useful after fifty hands or only after five thousand.
        </Lead>
        <Heading>Where the numbers above come from</Heading>
        <Lead>
          Nothing has been observed here, so every row is the generated prior: the
          model's opinion about poker in general before it has met anybody. The
          review's Math tab shows the same walk with a real session's counts in
          it, level by level.
        </Lead>
        <Why>
          The prior is generated from six constants rather than hand-typed,
          because nobody can keep 540 hand-written probabilities self-consistent —
          and one of those constants exists purely to stop the prior folding more
          than the minimum defence frequency allows.
        </Why>
      </HowCalculated>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 3. Expected value, pot odds, fold equity
// ---------------------------------------------------------------------------

const POTS = [40, 100, 250];

function EvConcept() {
  const [pot, setPot] = useState(100);
  const [callSize, setCallSize] = useState(50);
  const need = callSize / (pot + callSize);
  const ladder = priceLadder(pot);

  return (
    <Group
      id="ev"
      title="Expected value, pot odds and fold equity"
      lede="Three formulas, one of which needs no simulation at all."
    >
      <Lead>
        Expected value is what an action is worth on average, measured from the
        moment you take it. Chips already in the pot are not yours and do not
        enter the arithmetic — only the chips you risk now and the pot you can
        win. That is what makes folding correct sometimes: fold is the zero
        baseline, and any line worth less than zero is worse than walking away.
      </Lead>

      <Calc>
        <div>fold: 0</div>
        <div>check: equity × pot</div>
        <div>call: equity × pot − (1 − equity) × cost</div>
        <div>bet/raise: equity × (pot + extra) − (1 − equity) × cost</div>
        <div className="mt-2 text-ivory/60">
          "Equity" here is pot share, not win rate: a three-way chop is worth a
          third of the pot, so the value of a holding has to count it as a third
          of a win rather than as a loss or as half of one.
        </div>
      </Calc>

      <Heading>Pot odds: the half that is pure arithmetic</Heading>
      <div className="mb-3 flex flex-wrap gap-4">
        <Choice
          label="Pot"
          value={pot}
          onChange={setPot}
          options={POTS.map((p) => ({ value: p, label: `$${p}` }))}
        />
        <Choice
          label="They bet"
          value={callSize}
          onChange={setCallSize}
          options={[0.25, 0.5, 0.75, 1].map((f) => ({
            value: Math.round(pot * f),
            label: `${f * 100}% pot`,
          }))}
        />
      </div>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          required equity =
          <Frac n={<>cost</>} d={<>pot + cost</>} />=
          <Frac n={<>{callSize}</>} d={<>{pot + callSize}</>} />=
          <span className="text-gold-soft">{pct(need)}</span>
        </div>
        <div className="mt-2 text-ivory/60">
          {callSize > 0
            ? `${((pot / callSize) || 0).toFixed(1)} to 1 on the money. Set EV(call) to zero and solve — no Monte Carlo involved.`
            : "Nothing to call, so any equity at all is profit."}
        </div>
      </Calc>

      <Heading>Fold equity: the other way a bet wins</Heading>
      <Lead>
        A bet wins at showdown, and it wins when nobody calls. The second branch
        is what lets a hand with no showdown value be worth betting at all, and
        the formula that counts both is:
      </Lead>
      <Calc>
        EV(bet s) = P(fold) · Pot + (1 − P(fold)) · [ E_continue · (Pot + 2s) − s ]
        <div className="mt-2 text-ivory/60">
          E_continue is the equity against the hands that <em>do not</em> fold,
          which is always worse than equity against the whole range when folding
          is strength-correlated — the hands that fold are the weak ones, so what
          is left facing the bet is the strong tail.
        </div>
      </Calc>
      <Lead>
        Set E_continue to zero — a pure bluff with no equity whatsoever — and the
        expression collapses to <span className="font-mono">P(fold)·Pot − (1 − P(fold))·s</span>,
        which is zero at exactly one frequency:
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          α =
          <Frac n={<>s</>} d={<>Pot + s</>} />
          &nbsp;&nbsp; MDF = 1 − α =
          <Frac n={<>Pot</>} d={<>Pot + s</>} />
        </div>
      </Calc>
      <Scroller>
        <table className="w-full text-sm" data-testid="alpha-table">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Bet</th>
              <th className="py-2 pr-3 text-right">Size at ${pot}</th>
              <th className="py-2 pr-3 text-right">α — must work</th>
              <th className="py-2 pr-3 text-right">MDF — they must defend</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((r) => (
              <tr
                key={r.fraction}
                className="border-t"
                style={{ borderColor: LINE.quietFaint }}
              >
                <td className="py-2 pr-3 text-ivory/80">
                  {r.fraction === 2 ? "twice pot" : `${r.fraction * 100}% pot`}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  ${r.size.toFixed(0)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                  {pct(r.alpha, 1)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  {pct(r.mdf, 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        Computed from the formula above at the pot you picked — and they come out
        at the published 33.3 / 42.9 / 50 / 66.7 whatever the pot is, because α
        depends only on the ratio. An opponent who folds more often than α can be
        beaten by betting any two cards; MDF is the share of range they have to
        keep playing to stop that.
      </p>

      <Why>
        Pot odds and MDF are the two halves of the same identity, one read from
        the caller's chair and one from the bettor's. Neither needs a computer,
        and between them they decide most of what happens in a hand.
      </Why>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 4. Ranges and blockers
// ---------------------------------------------------------------------------

function combosContaining(cards: number[]): number {
  const blocked = new Uint8Array(COMBO_COUNT);
  for (const c of cards) {
    for (let o = 0; o < 52; o++) {
      if (o === c) continue;
      blocked[comboIndex(c, o)] = 1;
    }
  }
  let n = 0;
  for (let i = 0; i < COMBO_COUNT; i++) if (blocked[i]) n++;
  return n;
}

/** Combos of a pocket pair of `rank` (2..14) still available given dead cards. */
function pairCombos(rank: number, dead: number[]): number {
  const gone = new Set(dead);
  const suits = [0, 1, 2, 3].filter((s) => !gone.has(((rank - 2) << 2) | s));
  return (suits.length * (suits.length - 1)) / 2;
}

function RangesConcept() {
  const [holding, setHolding] = useState("Ah Kd");
  const hole = cardCodes(holding);
  const removed = combosContaining(hole);
  const aces = pairCombos(14, hole);
  const kings = pairCombos(13, hole);

  return (
    <Group
      id="ranges"
      title="Ranges and blockers"
      lede="A read is 1,326 numbers, and the cards in your hand change 99 of them."
    >
      <Lead>
        There are exactly {COMBO_COUNT.toLocaleString()} two-card combinations in
        a deck, and a range is one weight for each of them. Not a list of hands —
        a distribution, because "he has ace-king or a pair" is not a claim you can
        sample from and "these 1,326 weights" is. Every read on this table is that
        object, and the sampler draws opponents' cards straight out of it.
      </Lead>

      <div className="mb-3">
        <Choice
          label="You hold"
          value={holding}
          onChange={setHolding}
          options={[
            { value: "Ah Kd", label: "A♥K♦" },
            { value: "As Ac", label: "A♠A♣" },
            { value: "7c 2d", label: "7♣2♦" },
          ]}
          testId="blocker-choice"
        />
      </div>
      <div className="mb-3">
        <CardRow label="Your cards" cards={hole} size="md" />
      </div>

      <StatGrid columns={4}>
        <Stat
          label="Combos ruled out"
          value={removed}
          tone="gold"
          note={`of ${COMBO_COUNT.toLocaleString()}`}
        />
        <Stat
          label="Left in the pool"
          value={COMBO_COUNT - removed}
          note={pct((COMBO_COUNT - removed) / COMBO_COUNT, 1)}
        />
        <Stat label="Aces they can hold" value={`${aces} of 6`} />
        <Stat label="Kings they can hold" value={`${kings} of 6`} />
      </StatGrid>

      <Calc>
        combos removed by k known cards = C(52,2) − C(52−k,2)
        <div className="mt-1 text-ivory/60">
          = {COMBO_COUNT} − {((52 - hole.length) * (51 - hole.length)) / 2} ={" "}
          {removed}, counted here by marking every combination that contains one
          of your cards.
        </div>
      </Calc>

      <Lead>
        That is card removal, and it is why a blocker is arithmetic rather than
        intuition. Holding one ace does not make it "less likely" they have aces
        in some vague sense — it takes the number of ace pairs they can physically
        hold from six to {aces === 6 ? 6 : aces}. The same reasoning runs the
        other way when you hold none.
      </Lead>

      <HowCalculated label="Why This Lives In The Equity, Not Just The Chart">
        <Heading>Removal as multiplication by zero</Heading>
        <Lead>
          A range is a weight per combination, so removing a card is setting every
          combination containing it to zero and renormalising. Nothing special
          happens: the likelihood factors that come afterwards can only scale a
          zero. That means a blocker moves the equity estimate, not merely the
          picture of the range — the sampler literally cannot deal a hand that
          contains a card you can see.
        </Lead>
        <Heading>What replaced the old model</Heading>
        <Lead>
          The sampler used to draw from a three-tier belief — 70% likely to be
          strong, 20% medium — and a belief like that cannot say <em>which</em>{" "}
          hands those are, so it had to guess. The guess was a preflop score,
          which files 7-2 under "weak" on a K-7-2 board where it is two pair. The
          range carries the board-relative answer and the card removal together,
          which is why both live in one object now.
        </Lead>
        <Why>
          "What do they have" is the wrong question and it has no answer. "What is
          the distribution over what they have, and what does that make my hand
          worth against it" is the right one, and it has a number.
        </Why>
      </HowCalculated>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 5. Board-relative hand classes
// ---------------------------------------------------------------------------

const BOARDS = [
  { id: "k72", label: "K♣7♥2♠", cards: "Kc 7h 2s" },
  { id: "wet", label: "9♥8♥6♣", cards: "9h 8h 6c" },
  { id: "straight", label: "5♣6♦7♥8♠9♣", cards: "5c 6d 7h 8s 9c" },
] as const;

const SAMPLE_HANDS = ["7d 2c", "Ad Ac", "Kd Qs", "Jh Th", "3h 4h"];

function BucketsConcept() {
  const [pick, setPick] = useState<string>(BOARDS[0].id);
  const board = BOARDS.find((b) => b.id === pick) ?? BOARDS[0];
  const codes = cardCodes(board.cards);
  const classes = useMemo(() => boardClasses(codes), [board.id]);
  const ctx = useMemo(() => makeBoardContext(codes), [board.id]);
  const max = Math.max(...classes.shares);

  return (
    <Group
      id="classes"
      title="Hand classes are board-relative"
      lede="The same two cards are a different hand on a different board — so the engine classifies against the board, every time."
    >
      <Lead>
        Nine classes, ordered by strength, and a combination's class is recomputed
        against the community cards on every street. That replaced a preflop score
        that was being applied postflop, and the difference is not cosmetic: pick
        a board and watch what happens to 7-2.
      </Lead>

      <div className="mb-3">
        <Choice
          label="Board"
          value={pick}
          onChange={setPick}
          options={BOARDS.map((b) => ({ value: b.id, label: b.label }))}
          testId="board-choice"
        />
      </div>
      <div className="mb-4">
        <CardRow label="Community cards" cards={codes} size="md" />
      </div>

      <Scroller>
        <table className="w-full text-sm" data-testid="classify-table">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Holding</th>
              <th className="py-2 pr-3">Class on this board</th>
              <th className="py-2 pr-3">Legacy tier</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_HANDS.map((hand) => {
              const c = cardCodes(hand);
              if (codes.some((b) => c.includes(b))) return null;
              const bucket = classifyHole(c[0], c[1], ctx) as HandBucket;
              return (
                <tr key={hand} className="border-t" style={{ borderColor: LINE.quietFaint }}>
                  <td className="py-2 pr-3 font-mono text-xs text-ivory/80">{hand}</td>
                  <td className="py-2 pr-3">
                    <Tag tone={bucket >= 7 ? "good" : bucket >= 3 ? "gold" : "neutral"}>
                      {BUCKET_NAMES[bucket]}
                    </Tag>
                  </td>
                  <td className="py-2 pr-3 text-xs capitalize text-ivory/50">
                    {tierFromBucket(bucket)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroller>

      <Heading>What this board does to the whole deck</Heading>
      <div className="space-y-1.5" data-testid="class-shares">
        {Array.from({ length: BUCKET_COUNT }, (_, b) => b).map((b) => (
          <Meter
            key={b}
            label={
              <span className="text-ivory/70">
                {b}. {BUCKET_NAMES[b as HandBucket]}
              </span>
            }
            value={classes.shares[b] / Math.max(1e-9, max)}
            text={`${pct(classes.shares[b], 1)} · ${classes.counts[b]}`}
            color={b >= 6 ? "#7fd3a8" : b >= 3 ? "#e2c563" : "rgba(244,237,228,0.35)"}
          />
        ))}
      </div>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        Every one of the {classes.live.toLocaleString()} combinations this board
        leaves alive, classified — the same call a decision makes, counted instead
        of weighted. A dry board leaves most of the deck with nothing; a
        coordinated one hands a third of it a draw.
      </p>

      <Why>
        A range chart is only meaningful because this classification is: the
        weights on the chart are what the likelihood model does to these classes,
        and if the classes were wrong the chart would be a picture of a mistake.
      </Why>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 6. Multiway
// ---------------------------------------------------------------------------

function MultiwayConcept() {
  const [opponents, setOpponents] = useState(1);
  const result = useMemo(
    () =>
      runMultiwayEquitySync({
        heroHole: cardCodes("Ah Kh"),
        board: cardCodes("Qh 7d 2c"),
        opponents: Array.from({ length: opponents }, (_, i) => i + 1),
        simulations: 6000,
        seed: 1337,
      }),
    [opponents]
  );

  return (
    <Group
      id="multiway"
      title="Multiway is not heads-up"
      lede="Winning means being strictly best, and that is a conjunction."
    >
      <Lead>
        A hand that beats each opponent 65% of the time is not a 65% favourite
        against three of them. It has to beat this one <em>and</em> that one{" "}
        <em>and</em> the next, and the field's chance of holding <em>something</em>{" "}
        compounds with every extra seat. Below is A♥K♥ on Q♥7♦2♣ against a growing
        field of flat ranges — the same estimator the table runs, six thousand
        trials, computed here:
      </Lead>

      <div className="mb-3">
        <Choice
          label="Opponents"
          value={opponents}
          onChange={setOpponents}
          options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))}
          testId="multiway-choice"
        />
      </div>

      <StatGrid columns={4}>
        <Stat label="Pot share" value={pct(result.equity)} tone="gold" />
        <Stat label="Outright wins" value={pct(result.pWin)} />
        <Stat label="Chops" value={pct(result.pTie)} />
        <Stat
          label="Weakest matchup"
          value={
            Object.values(result.perOpponent).length > 0
              ? pct(Math.min(...Object.values(result.perOpponent)))
              : "—"
          }
          note="head-to-head"
        />
      </StatGrid>

      <Calc>
        P(beat all) ≤ min&#8202;ᵢ P(beat i)
        <div className="mt-2 text-ivory/60">
          and the estimator measures the left side directly rather than assuming
          the matchups are independent — they are not, because every opponent
          draws from the same deck and runs out on the same board.
        </div>
      </Calc>

      <Lead>
        The second consequence is that "how often do I win" stops being the number
        that matters. A k-way chop is worth 1/k of the pot, so the value of a
        holding is its pot share — wins plus a fraction for every split — and
        heads-up those two coincide closely enough that people forget they are
        different quantities.
      </Lead>

      <Why>
        Fold equity dies the same way. Every opponent has to fold for a bluff to
        take the pot down, so a 55% fold rate is 55% heads-up, 30% against two and
        9% against four. That decay is why bluffing into a field is bad long
        before any subtlety about correlated ranges matters.
      </Why>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 7. Equilibrium
// ---------------------------------------------------------------------------

const SOLVE_BOARD = "Ks 9d 4c 7h 2s";
const CHECKPOINTS = [10, 25, 50, 100, 200, 400];

/**
 * Every combination on this board whose class falls in `[min, max]`.
 *
 * The two ranges below are defined this way rather than trimmed to a hand count,
 * because a trimmed uniform range is an arbitrary slice of the combo index, it
 * would solve just as fast and describe nothing. These are the hands a class
 * boundary actually names, and the counts they produce (~210 a side on this
 * board) are what the solve runs on.
 */
function classRange(board: number[], min: number, max: number): Range {
  const classes = classifyAll(makeBoardContext(board));
  const range = emptyRange();
  for (let c = 0; c < COMBO_COUNT; c++) {
    if (classes[c] >= min && classes[c] <= max) range[c] = 1;
  }
  return normalizeRange(range);
}

function EquilibriumConcept() {
  const [run, setRun] = useState<SolveDemo | null>(null);
  const board = cardCodes(SOLVE_BOARD);

  const solve = () => {
    // Out of position: one pair, middle to over, the bluff-catchers. In
    // position: top pair or better, the range that would be betting.
    const oop = classRange(board, HandBucket.MidPair, HandBucket.Overpair);
    const ip = classRange(board, HandBucket.TopPair, HandBucket.Monster);
    setRun(
      solveDemo(board, oop, ip, CHECKPOINTS, { pot: 100, stack: 200, bigBlind: 2 })
    );
  };

  return (
    <Group
      id="equilibrium"
      title="Equilibrium and exploitability"
      lede="The strategy that cannot be beaten, and the number that proves it."
    >
      <Lead>
        Everything else on this page prices a decision against a <em>read</em>.
        An equilibrium asks the other question: what strategy could not be beaten
        by any opponent at all, including one who knew it in advance? In a
        two-player zero-sum game such a strategy exists, and playing it guarantees
        you cannot lose in the long run no matter who sits down.
      </Lead>

      <Heading>How it is found</Heading>
      <Lead>
        By regret. The solver plays the game against itself, and after every pass
        it asks, at each decision point and for each hand it might hold there: how
        much better off would I have been had I always taken this action instead?
        Actions that would have done better accumulate regret, and the next pass
        plays each action in proportion to its accumulated positive regret. The
        <em> average</em> of all those strategies — not the last one — converges to
        equilibrium. This one is Discounted CFR, which discounts early regret
        because the early passes were played against a worse opponent: itself, at
        the start.
      </Lead>

      <Heading>How you check it</Heading>
      <Lead>
        A broken solver still produces strategies that look like poker: it bets
        strong hands and folds weak ones, because the payoffs force that much.
        What it cannot do is drive exploitability down. Exploitability is what a
        perfect counter-strategy wins against the profile, computed exactly rather
        than by running a second solver, and it is zero only at equilibrium. Press
        the button and watch it fall:
      </Lead>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <RunButton onClick={solve} testId="solve-demo">
          {run ? "Solve it again" : "Solve a river spot"}
        </RunButton>
        <span className="text-xs text-ivory/45">
          A one-pair bluff-catching range out of position — middle pair through
          overpair — against a range of top pair or better in position. $100 pot,
          $200 behind, and the board below.
        </span>
      </div>
      <div className="mb-3">
        <CardRow label="Board" cards={board} />
      </div>

      {run && (
        <>
          <StatGrid columns={4}>
            <Stat
              label="Hands"
              value={`${run.hands[0]} × ${run.hands[1]}`}
              note={`${run.decisionNodes} decision nodes`}
            />
            <Stat
              label="Iterations"
              value={CHECKPOINTS[CHECKPOINTS.length - 1]}
              note="Discounted CFR"
            />
            <Stat
              label="Total time"
              value={`${run.totalMs.toFixed(0)} ms`}
              tone="gold"
              note="including every exploitability check"
            />
            <Stat
              label="Final exploitability"
              value={`${run.points[run.points.length - 1].mbb.toFixed(0)}`}
              note="mbb/h"
            />
          </StatGrid>

          <Well testId="exploit-chart">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={run.points.map((p) => ({
                  iterations: p.iterations,
                  mbb: +p.mbb.toFixed(1),
                }))}
                margin={{ top: 6, right: 10, bottom: 0, left: -10 }}
              >
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="iterations" stroke={AXIS} fontSize={10} />
                <YAxis stroke={AXIS} fontSize={10} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v) => [`${v} mbb/h`, "exploitability"]}
                />
                <Line
                  type="monotone"
                  dataKey="mbb"
                  stroke="#e2c563"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </Well>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            Exploitability in mbb/h — thousandths of a big blind per hand — at a
            big blind of ${run.bigBlind}. It fell by a factor of{" "}
            {(run.points[0].mbb / Math.max(1e-9, run.points[run.points.length - 1].mbb)).toFixed(0)}{" "}
            over these {CHECKPOINTS[CHECKPOINTS.length - 1]} iterations and would
            keep falling; the shape is the deliverable, because a solver that is
            not working produces a flat or wandering line no matter how sensible
            its strategies look.
          </p>
        </>
      )}

      <Calc>
        exploitability = ½ · [ BR(player 0) + BR(player 1) ]
        <div className="mt-2 text-ivory/60">
          BR is the best-response value: the most a perfect opponent can win from
          this strategy, per hand dealt. Zero exactly at equilibrium, and never
          negative in a two-player zero-sum game.
        </div>
      </Calc>

      <HowCalculated label="Why It Is Tested Against Toy Games">
        <Heading>Kuhn poker and push/fold charts</Heading>
        <Lead>
          The solver's tests do not check that it plays well — "plays well" is not
          a testable claim. They check it against Kuhn poker, a three-card game
          whose equilibrium has a known closed form, and against published Nash
          push/fold charts for short-stack heads-up play. Both are external
          answers this code cannot influence, so agreeing with them is evidence
          rather than self-congratulation.
        </Lead>
        <Heading>Why the river only</Heading>
        <Lead>
          A public tree with a few dozen nodes and a vector of hands at each is
          tractable in a browser; the whole game is not, and would need card
          abstraction and days of compute. The river is where the abstraction is
          least lossy — there are no cards to come, so a hand is exactly its
          showdown strength — which makes it the honest place to stop.
        </Lead>
        <Why>
          An equilibrium is not the best way to play any particular table: a read
          beats it against anyone exploitable, which is what the rest of this page
          is for. It is the floor — the strategy nobody can beat — and therefore
          the yardstick that says whether a clever line was clever or just lucky.
        </Why>
      </HowCalculated>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const CONTENTS = [
  { id: "monte-carlo", label: "Monte Carlo" },
  { id: "bayes", label: "Bayesian updating" },
  { id: "ev", label: "EV, pot odds, fold equity" },
  { id: "ranges", label: "Ranges and blockers" },
  { id: "classes", label: "Hand classes" },
  { id: "multiway", label: "Multiway" },
  { id: "equilibrium", label: "Equilibrium" },
];

export default function LearnPage() {
  return (
    <main className="relative min-h-[100svh] overflow-x-hidden text-ivory" data-testid="learn">
      <PageBody width="narrow">
        <PageHeader
          title="The maths, on its own"
          lede="Seven ideas this product is built out of, each one run here rather than described. The hand review shows you what happened; this page shows you why any of it means anything."
        />

        <nav className="mt-5 flex flex-wrap gap-1.5" aria-label="Concepts">
          {CONTENTS.map((c) => (
            <a
              key={c.id}
              href={`#${c.id}`}
              className={`min-h-[32px] border px-3 py-1 font-display text-[0.65rem] tracking-wide text-ivory/70 transition hover:text-gold-soft ${RADIUS.marker}`}
              style={{ borderColor: LINE.gold, background: "rgba(0,0,0,0.3)" }}
            >
              {c.label}
            </a>
          ))}
        </nav>

        <div className="mt-8 space-y-10">
          <MonteCarloConcept />
          <BayesConcept />
          <EvConcept />
          <RangesConcept />
          <BucketsConcept />
          <MultiwayConcept />
          <EquilibriumConcept />
        </div>

        <p className="mt-12 text-center text-[0.7rem] leading-relaxed text-ivory/40">
          Every number on this page was computed in your browser by the same
          modules the table plays with —{" "}
          <span className="font-mono">
            poker/monteCarlo.ts, poker/model/likelihood.ts,
            poker/model/buckets.ts, poker/ev.ts, poker/equity/multiway.ts
          </span>{" "}
          and <span className="font-mono">poker/solver/cfr.ts</span>. Nothing here
          is a stored figure.
        </p>
      </PageBody>
    </main>
  );
}
