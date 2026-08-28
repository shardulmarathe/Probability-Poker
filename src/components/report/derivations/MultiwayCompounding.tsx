/**
 * Why beating everybody is not the average of beating each of them.
 *
 * Lifted out of `MathTab`'s "Multiway Is Not Heads-Up" section unchanged. It
 * sits beside the head-to-head bars, which is where the contradiction shows up:
 * a hand can be ahead of every bar on the panel and still be behind the field,
 * and the panel that prints both numbers is the one that owes the explanation.
 */

import { pct } from "../../../lib/format";
import type { BotDecision } from "../../../poker/table/contract";
import { Calc, EmptyPanel, Frac, Heading, Lead, Why } from "../../ui";
import { STREET_LABEL } from "../derive";
import type { DerivationProps } from "./index";
import { Caption, NoTrail, isRestored, richest } from "./shared";

export function MultiwayCompounding({ report, seatName }: DerivationProps) {
  const restored = isRestored(report);
  const sample = richest(report.decisions);

  if (!sample || Object.keys(sample.equity.perOpponent).length === 0) {
    return (
      <>
        <Caption>Why the field compounds</Caption>
        {restored ? (
          <NoTrail what="the per-opponent equities the sampler measured" />
        ) : (
          <EmptyPanel title="Only one opponent was in the pot">
            With a single opponent, equity against the field and equity against
            that opponent are the same number, so there is nothing to compare.
          </EmptyPanel>
        )}
      </>
    );
  }

  return (
    <>
      <Caption>Why the field compounds</Caption>
      <Multiway decision={sample} seatName={seatName} />
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
