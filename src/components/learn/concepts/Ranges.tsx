/**
 * Concept 4: ranges and blockers.
 *
 * `combosContaining` walks a 1,326-entry bitmap per render. That is microseconds
 * and it is deliberately not memoised, but it is also the reason this file is
 * mounted only when the reader asks for it: the same loop multiplied by seven
 * always-mounted concepts is how a page stops feeling instant.
 */

import { useState } from "react";
import { pct } from "../../../lib/format";
import { COMBO_COUNT, comboIndex } from "../../../poker/model/range";
import {
  Calc,
  CardRow,
  Group,
  Heading,
  HowCalculated,
  Lead,
  Stat,
  StatGrid,
  Why,
} from "../../ui";
import { Choice } from "../controls";
import { cardCodes } from "../engine";

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

export function RangesConcept() {
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
        a deck, and a range is one weight for each of them. Not a list of hands but
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
        in some vague sense. It takes the number of ace pairs they can physically
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
          picture of the range: the sampler literally cannot deal a hand that
          contains a card you can see.
        </Lead>
        <Heading>What replaced the old model</Heading>
        <Lead>
          The sampler used to draw from a three-tier belief (70% likely to be
          strong, 20% medium), and a belief like that cannot say <em>which</em>{" "}
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
