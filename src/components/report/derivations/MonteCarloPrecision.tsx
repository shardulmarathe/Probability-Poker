/**
 * Why an equity figure carries a ±, and why the interval is Wilson's.
 *
 * Lifted out of `MathTab`'s "Monte Carlo Precision" section unchanged. It now
 * renders beside the equity bars on the Hand tab, because the `±` printed on a
 * bar is the thing that raises the question, and a reader who wants the answer
 * should not have to change tabs to find it.
 */

import { pct } from "../../../lib/format";
import { standardError, wilsonInterval } from "../../../poker/core/stats";
import type { BotDecision } from "../../../poker/table/contract";
import {
  Calc,
  EmptyPanel,
  Frac,
  Heading,
  HowCalculated,
  Lead,
  Stat,
  StatGrid,
  Why,
} from "../../ui";
import { STREET_LABEL } from "../derive";
import type { DerivationProps } from "./index";
import { Caption, NoTrail, isRestored, num, richest } from "./shared";

export function MonteCarloPrecision({ report, seatName }: DerivationProps) {
  const restored = isRestored(report);
  const sample = richest(report.decisions);

  if (!sample) {
    return (
      <>
        <Caption>
          {restored
            ? "The trial counts are not part of what the archive stores"
            : "No simulation was run this hand"}
        </Caption>
        {restored ? (
          <NoTrail what="the trial counts and the interval around them" />
        ) : (
          <EmptyPanel title="Nothing was simulated">
            The pot was never contested by a seat that had to price a decision,
            so no Monte Carlo ran. Play a hand that reaches a flop with two
            seats still live and this section fills in.
          </EmptyPanel>
        )}
      </>
    );
  }

  return (
    <>
      <Caption>
        {sample.equity.simulations.toLocaleString()} trials ·{" "}
        {STREET_LABEL[sample.street]} · {seatName(sample.seat)}
      </Caption>
      <MonteCarlo decision={sample} />
    </>
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
