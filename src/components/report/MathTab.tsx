/**
 * Tab 4 — the derivations, worked on this hand's own numbers.
 *
 * Every figure quoted here is pulled out of the report rather than invented for
 * the example, so the arithmetic can be checked against the tables on the other
 * tabs. Where the hand did not produce a number — nobody was ever priced, no
 * action moved a belief — the section says so instead of falling back to a
 * textbook illustration that never happened.
 */

import { pct } from "../../lib/format";
import { INITIAL_BELIEF } from "../../data/constants";
import { updateBelief } from "../../poker/bayesian";
import { standardError, wilsonInterval } from "../../poker/core/stats";
import { BUCKET_COUNT } from "../../poker/model/buckets";
import type { BotDecision, TableHandReport } from "../../poker/table/contract";
import type { PlayerActionType } from "../../types";
import {
  STREET_LABEL,
  appliedLikelihood,
  bucketName,
  readsAfter,
  type AppliedLikelihood,
} from "./derive";
import {
  Calc,
  EmptyPanel,
  Frac,
  Heading,
  HowCalculated,
  Lead,
  Section,
  Stat,
  Why,
} from "./ui";

interface Props {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}

function num(v: number, digits = 3): string {
  return v.toFixed(digits);
}

/** The decision with the most samples behind it — the best worked example. */
function richest(decisions: BotDecision[]): BotDecision | null {
  let best: BotDecision | null = null;
  for (const d of decisions) {
    if (d.equity.simulations === 0) continue;
    if (!best || d.equity.simulations > best.equity.simulations) best = d;
  }
  return best;
}

export function MathTab({ report, focus, seatName }: Props) {
  const sample = richest(report.decisions);
  const priced =
    report.decisions.find((d) => d.toCall > 0) ??
    report.decisions[report.decisions.length - 1] ??
    null;

  // First action that actually moved a read — the Bayes example. The
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
            : "No simulation was run this hand"
        }
      >
        {!sample ? (
          <EmptyPanel title="Nothing was simulated">
            The pot was never contested by a seat that had to price a decision, so
            no Monte Carlo ran. Play a hand that reaches a flop with two seats
            still live and this section fills in.
          </EmptyPanel>
        ) : (
          <MonteCarlo decision={sample} />
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section title="Multiway Is Not Heads-Up" subtitle="Why the field compounds">
        {!sample || Object.keys(sample.equity.perOpponent).length === 0 ? (
          <EmptyPanel title="Only one opponent was in the pot">
            With a single opponent, equity against the field and equity against
            that opponent are the same number, so there is nothing to compare.
          </EmptyPanel>
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
      <Section title="Expected Value" subtitle="What every action was worth">
        {!priced ? (
          <EmptyPanel title="Nothing was priced">
            No seat at this table ran the EV comparison this hand.
          </EmptyPanel>
        ) : (
          <EvWorked decision={priced} seatName={seatName} focus={focus} />
        )}
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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Stat label="Trials" value={n.toLocaleString()} />
        <Stat label="Outright wins" value={k.toLocaleString()} />
        <Stat label="Chops" value={e.ties.toLocaleString()} />
        <Stat label="Pot share" value={pct(e.equity)} highlight />
      </div>

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
      <Calc>EV = P(win) × gain + P(lose) × loss</Calc>
      <Lead>
        Folding is the zero baseline: risk nothing, win nothing. For a call the
        gain is the pot as it stands and the loss is only the chips put in, so
        the whole decision collapses to one comparison.
      </Lead>

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
