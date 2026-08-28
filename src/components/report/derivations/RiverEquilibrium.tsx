/**
 * The river subgame, solved, and what equilibrium would have done with this
 * exact holding.
 *
 * Lifted out of `MathTab`'s "Equilibrium, And What It Would Have Done" section
 * unchanged. It now sits under the costliest-decision callout on the Play tab.
 * That callout says a different action priced better against the read; this is
 * the other yardstick, the strategy that cannot be beaten by anybody, and the
 * two answer the same question from opposite ends.
 */

import { useEffect, useState } from "react";
import { pct } from "../../../lib/format";
import type { TableHandReport } from "../../../poker/table/contract";
import { solveReviewRiver, type RiverSolveResult } from "../../learn/engine";
import {
  Calc,
  Heading,
  HowCalculated,
  Lead,
  Meter,
  Note,
  RADIUS,
  Stat,
  StatGrid,
  Why,
} from "../../ui";
import { rangeView, reviewStreets } from "../derive";
import type { DerivationProps } from "./index";
import { Caption, possessive } from "./shared";

export function RiverEquilibrium(props: DerivationProps) {
  return (
    <>
      <Caption>The river subgame, solved</Caption>
      <Equilibrium {...props} />
    </>
  );
}

// ---------------------------------------------------------------------------

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
        Every other number in this review prices a decision against a <em>read</em> —
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
          beats it against anybody exploitable, which is what the rest of this review
          is for. It is the floor: the strategy that cannot be beaten, so it is
          the yardstick that tells you whether a "clever" line was clever or just
          lucky.
        </Why>
      </HowCalculated>
    </>
  );
}
