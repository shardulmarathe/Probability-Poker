/**
 * Concept 1: Monte Carlo.
 *
 * Every number here is drawn when this module mounts, which is the moment the
 * reader selects the concept rather than the moment `/learn` loads. That is why
 * `LearnPage` mounts one concept at a time: four convergence runs, a 540-cell
 * likelihood prior, a six-thousand-trial multiway sample and a river solve would
 * otherwise all be triggered by a single navigation.
 */

import { useMemo, useState } from "react";
import { pct } from "../../../lib/format";
import {
  Calc,
  CardRow,
  Frac,
  Group,
  Heading,
  HowCalculated,
  LINE,
  Lead,
  Note,
  Scroller,
  Why,
} from "../../ui";
import { Choice, RunButton } from "../controls";
import { cardCodes, convergence, type ConvergencePoint } from "../engine";

const MATCHUPS = [
  { id: "race", label: "A♥K♥ vs 7♣7♦", hero: "Ah Kh", villain: "7c 7d", board: "" },
  { id: "dominated", label: "A♠Q♦ vs A♥J♣", hero: "As Qd", villain: "Ah Jc", board: "" },
  { id: "draw", label: "J♥T♥ vs K♠K♣ on 9♥8♣2♥", hero: "Jh Th", villain: "Ks Kc", board: "9h 8c 2h" },
] as const;

const SAMPLE_SIZES = [500, 2000, 8000, 32000];

export function MonteCarloConcept() {
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
        who won, and repeats. The fraction of wins converges on the
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
                  {pct(r.ci.lo, 1)} - {pct(r.ci.hi, 1)}
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
        Press "draw a fresh sample" a few times. The estimate moves. That is
        sampling error being sampling error, and it moves less in the bottom row
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
          a finite sample, and can report bounds outside 0-1 on the way there.
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
          interval still has width. It says "we saw none in n tries", not "it
          cannot happen", and it never leaves 0-1.
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
