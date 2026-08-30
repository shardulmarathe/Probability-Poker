/**
 * The nine rungs every range chart is actually made of.
 *
 * Lifted out of `MathTab`'s "Hand Classes Are Board-Relative" section
 * unchanged. It belongs beside the range charts, which are painted from these
 * nine bins: a reader looking at a weighted 13×13 grid is looking at the output
 * of this classification, and the two results below that contradict the obvious
 * guess are the reason the grid is shaped the way it is.
 */

import { useMemo } from "react";
import { pct } from "../../../lib/format";
import {
  BUCKET_COUNT,
  classifyHole,
  makeBoardContext,
  tierFromBucket,
  type HandBucket,
} from "../../../poker/model/buckets";
import type { TableHandReport } from "../../../poker/table/contract";
import {
  Calc,
  Heading,
  HowCalculated,
  Lead,
  Meter,
  Tag,
  Why,
} from "../../ui";
import { bucketName, rangeView, reviewStreets } from "../derive";
import type { DerivationProps } from "./index";
import { Caption, capitalise, mainVillain, possessive } from "./shared";

export function HandClasses(props: DerivationProps) {
  return (
    <>
      <Caption>The nine rungs the sampler actually works in</Caption>
      <BucketLadder {...props} />
    </>
  );
}

// ---------------------------------------------------------------------------

function BucketLadder({
  report,
  focus,
  seatName,
}: {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const seat = report.seats.find((s) => s.seat === focus);
  const villain = mainVillain(report, focus);
  const streets = useMemo(() => reviewStreets(report), [report]);
  const final = streets[streets.length - 1];

  const view = useMemo(
    () =>
      villain && seat && seat.hole.length === 2 && final
        ? rangeView(report, final, villain.seat, seat.hole)
        : null,
    [report, villain, seat, final]
  );

  const path = useMemo(() => {
    if (!seat || seat.hole.length !== 2) return [];
    return streets
      .filter((s) => s.key !== "final")
      .map((s) => ({
        label: s.label,
        bucket: classifyHole(
          seat.hole[0],
          seat.hole[1],
          makeBoardContext(report.board.slice(0, s.boardLen))
        ) as HandBucket,
      }));
  }, [seat, streets, report.board]);

  return (
    <>
      <Lead>
        The engine does not ask "is this a good hand". It asks "what is this hand
        <em> on this board</em>", and the answer is one of nine classes. That
        replaced a preflop score that was being applied on every street: on
        K-7-2-9-4 a Chen-style score still files 7-2 under <em>weak</em>, when it
        has flopped two pair and is beating most of the deck. Bucketing an
        opponent's range with that is not a small inaccuracy, it puts the made
        hands in the wrong bin, and every equity number sampled out of those bins
        inherits the error.
      </Lead>

      {path.length > 0 && (
        <>
          <Heading>
            {capitalise(possessive(seatName(focus)))} hand, reclassified as the board arrived
          </Heading>
          <div className="flex flex-wrap items-center gap-2" data-testid="bucket-path">
            {path.map((p, i) => (
              <span key={p.label} className="flex items-center gap-2">
                {i > 0 && <span className="text-ivory/30">→</span>}
                <span className="flex flex-col">
                  <span className="font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
                    {p.label}
                  </span>
                  <span className="mt-0.5">
                    <Tag
                      tone={
                        p.bucket >= 7 ? "good" : p.bucket >= 3 ? "gold" : "neutral"
                      }
                    >
                      {bucketName(p.bucket)}
                    </Tag>
                  </span>
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            Same two cards throughout. The class changes because the board does,
            which is the entire point of measuring strength against it.
          </p>
        </>
      )}

      {view && villain && (
        <>
          <Heading>
            Where {seatName(villain.seat)}'s range sat on the ladder, at the end
          </Heading>
          <div className="space-y-1.5" data-testid="bucket-weights">
            {Array.from({ length: BUCKET_COUNT }, (_, b) => b).map((b) => (
              <Meter
                key={b}
                label={
                  <span className="text-ivory/70">
                    {b}. {bucketName(b)}
                    <span className="ml-2 text-ivory/35">{tierFromBucket(b as HandBucket)}</span>
                  </span>
                }
                value={view.buckets[b] / Math.max(1e-9, Math.max(...view.buckets))}
                text={pct(view.buckets[b], 1)}
                color={b >= 6 ? "#7fd3a8" : b >= 3 ? "#e2c563" : "rgba(244,237,228,0.35)"}
              />
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            This is the range the sampler drew that seat's cards from, weighed by
            class rather than by chart cell, the same numbers the Ranges tab
            paints, read along the strength axis instead of the 13×13 one.
          </p>
        </>
      )}

      <Heading>Two results that contradict the obvious guess</Heading>
      <Lead>
        The order of the ladder is load-bearing: downstream code aggregates
        "belief mass at or above class k", which only means anything if the index
        is monotone in strength. The cut points were placed by measurement, every
        combo rolled out on forty random boards per street, and two of the
        answers are not what intuition says.
      </Lead>
      <Calc>
        <div>
          Strong Draw sits <span className="text-gold-soft">below</span> Weak Pair.
        </div>
        <div className="mt-1 text-ivory/60">
          A bare flush draw or open-ender with no pair measures 0.514 on the flop
          and 0.392 on the turn against a random hand; bottom pair measures 0.571
          and 0.550. Draws feel stronger than that because they are usually held
          alongside something, and this class is what is left once that something
          has been classified on its own.
        </div>
        <div className="mt-3">
          Top Pair and Overpair are the <span className="text-gold-soft">same rung</span>.
        </div>
        <div className="mt-1 text-ivory/60">
          0.776 / 0.796 on the flop, 0.773 / 0.756 on the turn, 0.783 / 0.791 on
          the river, the sign of the gap flips with the boards drawn, so the test
          asserts they are close rather than pretending the ladder is sharper than
          the game is.
        </div>
      </Calc>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        Both figures are quoted from{" "}
        <span className="font-mono">poker/model/buckets.ts</span>, where{" "}
        <span className="font-mono">buckets.test.ts</span> measures them on every run.
      </p>

      <HowCalculated label="Is Nine Classes The Right Abstraction?">
        <Heading>The objection</Heading>
        <Lead>
          Ordering classes by mean equity is expected hand strength, and EHS is
          the metric the abstraction literature rejects: it "fails to account for
          the entire probability distribution of hand strength" (Ganzfried &
          Sandholm, AAAI-14). So the ladder was re-audited against distributions
          rather than means.
        </Lead>
        <Heading>What the audit found</Heading>
        <Lead>
          Searching all 9! orderings for the one whose Earth Mover's Distance
          matrix is most monotone away from the diagonal returns <em>this</em>{" "}
          order, on every street. The only alternative that ever ties it is the
          one that swaps Top Pair and Overpair, the single adjacency the
          measurement above already declines to order. Hands sharing a class are
          about three times closer in EMD than hands from different ones, and
          roughly 99% of combos have their nearest neighbour inside their own
          class.
        </Lead>
        <Heading>What it does not excuse</Heading>
        <Lead>
          The tails. On Ks-7s-Qc the flop puts a backdoor flush and a gutshot to
          Broadway in the same draw class, 21.1 EMD bins apart, further than Air
          is from Weak Pair. On a four-flush board, Monster holds both a straight
          flush and the same straight losing to every diamond. Nine hand-crafted
          classes have nowhere to put "ace-high with a gutshot". Fixing that means
          more classes, and the class count is frozen by the keys the learned
          model persists, so it is not a change that can be made in one file.
        </Lead>
        <Why>
          Every range chart, every reweighting and every simulated opponent hand
          in this product is built on these nine bins. Knowing where they are
          honest and where they are coarse is knowing how much to trust the
          numbers they produce.
        </Why>
      </HowCalculated>
    </>
  );
}
