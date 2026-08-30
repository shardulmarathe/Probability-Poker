/**
 * Concept 6: multiway.
 *
 * Six thousand trials per opponent count, memoised on the count alone. The seed
 * is fixed so the ladder from one opponent to five is a comparison rather than
 * five unrelated samples - change the seed and the reader would be watching
 * sampling noise instead of the compounding this concept is about.
 */

import { useMemo, useState } from "react";
import { pct } from "../../../lib/format";
import { runMultiwayEquitySync } from "../../../poker/equity/pool";
import { Calc, Group, Lead, Stat, StatGrid, Why } from "../../ui";
import { Choice } from "../controls";
import { cardCodes } from "../engine";

export function MultiwayConcept() {
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
        field of flat ranges, the same estimator the table runs, six thousand
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
              : "-"
          }
          note="head-to-head"
        />
      </StatGrid>

      <Calc>
        P(beat all) ≤ min&#8202;ᵢ P(beat i)
        <div className="mt-2 text-ivory/60">
          and the estimator measures the left side directly rather than assuming
          the matchups are independent. They are not, because every opponent
          draws from the same deck and runs out on the same board.
        </div>
      </Calc>

      <Lead>
        The second consequence is that "how often do I win" stops being the number
        that matters. A k-way chop is worth 1/k of the pot, so the value of a
        holding is its pot share (wins plus a fraction for every split) and
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
