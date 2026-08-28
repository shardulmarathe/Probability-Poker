/**
 * Concept 3: expected value, pot odds and fold equity.
 *
 * The only concept on the page that runs no simulation at all. `priceLadder` is
 * four divisions, so it is called in render rather than memoised: a `useMemo`
 * around arithmetic this cheap costs more in comparison than it saves.
 */

import { useState } from "react";
import { pct } from "../../../lib/format";
import {
  Calc,
  Frac,
  Group,
  Heading,
  LINE,
  Lead,
  Scroller,
  Why,
} from "../../ui";
import { Choice } from "../controls";
import { priceLadder } from "../engine";

const POTS = [40, 100, 250];

export function EvConcept() {
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
