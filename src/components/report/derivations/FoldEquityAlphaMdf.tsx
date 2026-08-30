/**
 * The half of a bet that never reaches showdown.
 *
 * Lifted out of `MathTab`'s "Fold Equity, α and MDF" section unchanged. It sits
 * against the per-move EV columns on the Play tab, which already print α and
 * MDF for every bet: those two numbers are exact arithmetic and need no
 * apology, but what a bet is actually worth needs the equity against the
 * hands that do not fold, and that is what this derivation supplies.
 */

import { pct } from "../../../lib/format";
import type { FoldEquityBreakdown } from "../../../poker/ev";
import type {
  BotDecision,
  TableHandReport,
} from "../../../poker/table/contract";
import { priceLadder } from "../../learn/engine";
import {
  Calc,
  EmptyPanel,
  Frac,
  Heading,
  HowCalculated,
  LINE,
  Lead,
  Scroller,
  Stat,
  StatGrid,
  Tag,
  Why,
} from "../../ui";
import { STREET_LABEL } from "../derive";
import type { DerivationProps } from "./index";
import { Caption, NoTrail, bluffing, isRestored, num } from "./shared";

export function FoldEquityAlphaMdf({ report, focus, seatName }: DerivationProps) {
  const restored = isRestored(report);
  const bluff = bluffing(report.decisions, focus);

  return (
    <>
      <Caption>The half of a bet that never reaches showdown</Caption>
      {!bluff ? (
        <>
          {restored ? (
            <NoTrail what="the fold probability and the equity against the callers" />
          ) : report.actions.some(
              (a) => a.action === "bet" || a.action === "raise"
            ) ? (
            <EmptyPanel title="The seats that bet were not priced by the engine">
              A fold-equity breakdown is recorded by the decider, so it exists
              for the seats the engine plays and not for a human one, which
              runs no Monte Carlo and leaves no estimate of how often a bet got
              through. The threshold every one of those bets had to clear is
              arithmetic, though, and it is below.
            </EmptyPanel>
          ) : (
            <EmptyPanel title="Nothing was bet">
              Fold equity is the value of a bet nobody calls, so it is priced
              only for bets and raises. Every seat this hand checked, called or
              folded (actions that have no fold-equity term) so there is
              none to show.
            </EmptyPanel>
          )}
          <AlphaLadder report={report} focus={focus} seatName={seatName} />
        </>
      ) : (
        <FoldEquityWorked decision={bluff} seatName={seatName} />
      )}
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
          call is in, the frame <span className="font-mono">model/decider.ts</span>{" "}
          sizes bets in. A pure bluff
          breaks even at α; below that it is losing money, above it, it prints.
        </div>
      </Calc>
    </>
  );
}

// ===========================================================================
// Fold equity, as the engine priced it
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
        them. Every other derivation here prices a call: chips in, pot share
        out. A bet also wins whenever nobody calls it at all, and that branch is
        the whole reason a hand with no showdown value can be worth betting.
      </Lead>

      <Heading>The formula, from poker/ev.ts</Heading>
      <Calc>
        EV(bet s) = P(fold) · Pot + (1 − P(fold)) · [ E_continue · (Pot + 2s) − s ]
        <div className="mt-2 text-ivory/60">
          The bracket is the same arithmetic a call gets, E·(Pot + s) − (1 − E)·s,
          with E_continue substituted for the win rate. That identity is why
          this extends the old formula rather than competing with it.
        </div>
      </Calc>

      <Heading>
        {seatName(d.seat)}, {STREET_LABEL[d.street].toLowerCase()}, every size the
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
                    {size !== null ? pct(size / (pot + size), 1) : "-"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {size !== null ? pct(pot / (pot + size), 1) : "-"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                    {b.simulations > 0 ? pct(b.eContinue, 1) : "-"}
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
          : ", left blank here because this seat was facing a bet, so the label carries a total rather than the increment α is defined on"}
        .
      </p>

      <Heading>Where α comes from</Heading>
      <Lead>
        Set E_continue to zero (a pure bluff, no equity at all) and the formula
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
              {rung.fraction === 2 ? "twice pot" : `${rung.fraction * 100}% pot`}: bet{" "}
              {rung.size.toFixed(1)}: α = {pct(rung.alpha, 1)}, MDF ={" "}
              {pct(rung.mdf, 1)}
            </div>
          ))}
        </div>
        <div className="mt-2 text-ivory/60">
          These are the published numbers (33.3, 42.9, 50, 66.7) and they are a
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
            overvalues betting, it turns every missed draw into a "profitable"
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
                pull on it, the folders being weak pulls it down, the field
                getting smaller pushes it up, and with a field this size the
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
          <em>negatively correlated</em>, the hero takes a smaller fraction of
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
          reporting, which is what they are doing in this panel.
        </Lead>
        <Why>
          Two independent errors, both flattering to aggression, both removed. The
          one remaining approximation is that P(all fold) is taken to be the
          product of the per-opponent marginals, which ignores the weak coupling
          card removal creates between their ranges, and that too runs one way,
          so the bot is slightly over-optimistic about bluffing into a field.
        </Why>
      </HowCalculated>
    </>
  );
}
