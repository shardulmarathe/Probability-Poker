/**
 * What every action was worth, in the frame the engine priced it in.
 *
 * Lifted out of `MathTab`'s "Expected Value" section unchanged. It now sits
 * against the EV columns on the Play tab, which print the answer; this is the
 * arithmetic that produced it, including the part readers most often trip on,
 * that the highest number is not always the one taken.
 */

import type { BotDecision } from "../../../poker/table/contract";
import {
  Calc,
  EmptyPanel,
  Frac,
  Heading,
  HowCalculated,
  Lead,
  Why,
} from "../../ui";
import { STREET_LABEL } from "../derive";
import type { DerivationProps } from "./index";
import { Caption, NoTrail, isRestored, num } from "./shared";

export function ExpectedValue({ report, focus, seatName }: DerivationProps) {
  const restored = isRestored(report);
  const priced =
    report.decisions.find((d) => d.toCall > 0) ??
    report.decisions[report.decisions.length - 1] ??
    null;

  return (
    <>
      <Caption>What every action was worth</Caption>
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
          {num(d.equity.pTie, 3)}, P(lose) = {num(d.equity.pLoss, 3)}, they sum
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
        whole expression, which is what <span className="font-mono">poker/ev.ts</span>{" "}
        means when it says ties are
        "chip-neutral". Multiway that shortcut breaks: a three-way chop is worth a
        third and a four-way chop a quarter, so the estimator tracks the size of
        every tie and reports <em>pot share</em> instead. Pot share supersedes the
        tie term rather than dropping it. It is the tie term, already integrated.
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          pot share =
          <Frac n={<>wins + Σ 1/k over each k-way chop</>} d={<>trials</>} />=
          <span className="text-gold-soft">{num(share, 4)}</span>
        </div>
        <div className="mt-2 text-ivory/60">
          against an outright win rate of {num(d.equity.pWin, 4)}. The gap,{" "}
          {num(share - d.equity.pWin, 4)}, is what the chops were worth, and it
          is exactly what a formula using P(win) alone would throw away.
        </div>
      </Calc>

      <Heading>
        This hand: {seatName(d.seat)}
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
          personality. A pure maximiser takes the top row every time. That is
          the "professor" seat. Every other archetype bends it: an aggressive
          profile multiplies the EV of betting and raising, a nit needs a better
          hand before it will enter a pot at all, and a bluffing profile will
          sometimes fire with a holding that has no value.
        </Lead>
        <Lead>
          So the chosen row above may not be the largest, and that is not a bug
          in the arithmetic. It is the difference between knowing what a spot is
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
