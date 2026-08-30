/**
 * Concept 5: board-relative hand classes.
 *
 * `boardClasses` and `makeBoardContext` are keyed on `board.id`, not on `codes`,
 * because `cardCodes` returns a fresh array every render - a `[codes]`
 * dependency would classify all 1,326 combinations on every keystroke anywhere
 * in the tree. The id is the board's identity; the array is only its shape.
 */

import { useMemo, useState } from "react";
import { pct } from "../../../lib/format";
import {
  BUCKET_COUNT,
  BUCKET_NAMES,
  HandBucket,
  classifyHole,
  makeBoardContext,
  tierFromBucket,
} from "../../../poker/model/buckets";
import {
  CardRow,
  Group,
  Heading,
  LINE,
  Lead,
  Meter,
  Scroller,
  Tag,
  Why,
} from "../../ui";
import { Choice } from "../controls";
import { boardClasses, cardCodes } from "../engine";

const BOARDS = [
  { id: "k72", label: "K♣7♥2♠", cards: "Kc 7h 2s" },
  { id: "wet", label: "9♥8♥6♣", cards: "9h 8h 6c" },
  { id: "straight", label: "5♣6♦7♥8♠9♣", cards: "5c 6d 7h 8s 9c" },
] as const;

const SAMPLE_HANDS = ["7d 2c", "Ad Ac", "Kd Qs", "Jh Th", "3h 4h"];

export function BucketsConcept() {
  const [pick, setPick] = useState<string>(BOARDS[0].id);
  const board = BOARDS.find((b) => b.id === pick) ?? BOARDS[0];
  const codes = cardCodes(board.cards);
  const classes = useMemo(() => boardClasses(codes), [board.id]);
  const ctx = useMemo(() => makeBoardContext(codes), [board.id]);
  const max = Math.max(...classes.shares);

  return (
    <Group
      id="classes"
      title="Hand classes are board-relative"
      lede="The same two cards are a different hand on a different board, so the engine classifies against the board, every time."
    >
      <Lead>
        Nine classes, ordered by strength, and a combination's class is recomputed
        against the community cards on every street. That replaced a preflop score
        that was being applied postflop, and the difference is not cosmetic: pick
        a board and watch what happens to 7-2.
      </Lead>

      <div className="mb-3">
        <Choice
          label="Board"
          value={pick}
          onChange={setPick}
          options={BOARDS.map((b) => ({ value: b.id, label: b.label }))}
          testId="board-choice"
        />
      </div>
      <div className="mb-4">
        <CardRow label="Community cards" cards={codes} size="md" />
      </div>

      <Scroller>
        <table className="w-full text-sm" data-testid="classify-table">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Holding</th>
              <th className="py-2 pr-3">Class on this board</th>
              <th className="py-2 pr-3">Legacy tier</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_HANDS.map((hand) => {
              const c = cardCodes(hand);
              if (codes.some((b) => c.includes(b))) return null;
              const bucket = classifyHole(c[0], c[1], ctx) as HandBucket;
              return (
                <tr key={hand} className="border-t" style={{ borderColor: LINE.quietFaint }}>
                  <td className="py-2 pr-3 font-mono text-xs text-ivory/80">{hand}</td>
                  <td className="py-2 pr-3">
                    <Tag tone={bucket >= 7 ? "good" : bucket >= 3 ? "gold" : "neutral"}>
                      {BUCKET_NAMES[bucket]}
                    </Tag>
                  </td>
                  <td className="py-2 pr-3 text-xs capitalize text-ivory/50">
                    {tierFromBucket(bucket)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroller>

      <Heading>What this board does to the whole deck</Heading>
      <div className="space-y-1.5" data-testid="class-shares">
        {Array.from({ length: BUCKET_COUNT }, (_, b) => b).map((b) => (
          <Meter
            key={b}
            label={
              <span className="text-ivory/70">
                {b}. {BUCKET_NAMES[b as HandBucket]}
              </span>
            }
            value={classes.shares[b] / Math.max(1e-9, max)}
            text={`${pct(classes.shares[b], 1)} · ${classes.counts[b]}`}
            color={b >= 6 ? "#7fd3a8" : b >= 3 ? "#e2c563" : "rgba(244,237,228,0.35)"}
          />
        ))}
      </div>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        Every one of the {classes.live.toLocaleString()} combinations this board
        leaves alive, classified: the same call a decision makes, counted instead
        of weighted. A dry board leaves most of the deck with nothing; a
        coordinated one hands a third of it a draw.
      </p>

      <Why>
        A range chart is only meaningful because this classification is: the
        weights on the chart are what the likelihood model does to these classes,
        and if the classes were wrong the chart would be a picture of a mistake.
      </Why>
    </Group>
  );
}
