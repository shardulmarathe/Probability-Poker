/**
 * Tab 2 — what the table thought each opponent held.
 *
 * The centrepiece. Each opponent gets the 13x13 chart of the distribution the
 * equity estimate was actually sampled from, at the street you pick, with the
 * dead cards already taken out of it. The charts are not an illustration of the
 * model; they are the model — `derive.rangeView` rebuilds the same per-combo
 * range `decider.opponentRanges` handed the sampler, and the grid is its
 * projection onto the only 169 classes a poker player thinks in.
 *
 * That claim is load-bearing, so it is worth saying what it costs: the grid can
 * only be a *projection*, never the thing itself. A cell holds up to 12 combos
 * that a board splits — on K-7-2 the 7-2 cell contains twelve two-pair hands,
 * but on K-Q-J it contains twelve pieces of air with different backdoors — so
 * the cell number is their total weight and the chart cannot show the spread
 * inside it. The bucket meters beside each chart are there for exactly that
 * reason: they read the same range through the classifier the engine used.
 */

import { useMemo, useState } from "react";
import { pct } from "../../lib/format";
import { GRID_CELLS, GRID_LABELS } from "../../poker/model/range";
import type { TableHandReport } from "../../poker/table/contract";
import { RangeGrid } from "./RangeGrid";
import {
  BUCKET_COUNT,
  CELL_TOTAL,
  TIER_NAMES,
  aliveAfter,
  blockerView,
  bucketName,
  rangeView,
  readsAfter,
  reviewStreets,
  seatResult,
} from "./derive";
import {
  CardRow,
  Calc,
  ChipRow,
  Heading,
  HowCalculated,
  Lead,
  Meter,
  Section,
  Tag,
  Why,
  cardText,
} from "./ui";

interface Props {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
  isHero: boolean;
}

const TIER_COLOR = ["#5fb98f", "#e2c563", "#d24a4a"];

export function RangesTab({ report, focus, seatName, isHero }: Props) {
  const streets = useMemo(() => reviewStreets(report), [report]);
  const [streetKey, setStreetKey] = useState(streets[streets.length - 1].key);
  const street = streets.find((s) => s.key === streetKey) ?? streets[0];

  const you = seatResult(report, focus);
  const heroHole = useMemo(() => you?.hole ?? [], [you]);
  const board = useMemo(
    () => report.board.slice(0, street.boardLen),
    [report, street.boardLen]
  );

  const opponents = useMemo(
    () => aliveAfter(report, street.actionsUpTo).filter((s) => s !== focus),
    [report, street.actionsUpTo, focus]
  );

  const views = useMemo(
    () => opponents.map((seat) => rangeView(report, street, seat, heroHole)),
    [report, street, opponents, heroHole]
  );

  /** The read on every seat at every street — the narrowing strip. */
  const narrowing = useMemo(
    () =>
      streets.map((s) => ({
        key: s.key,
        label: s.label,
        reads: readsAfter(report.actions, s.actionsUpTo, report.seatCount),
      })),
    [report, streets]
  );

  const blockers = useMemo(() => blockerView(heroHole), [heroHole]);
  const withBoard = useMemo(
    () => blockerView([...heroHole, ...board]),
    [heroHole, board]
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* ------------------------------------------------------------------ */}
      <Section
        title="Opponent Ranges"
        subtitle="13×13 chart · the weights the sampler drew from"
      >
        <ChipRow
          ariaLabel="Street"
          testIdPrefix="range-street"
          options={streets.map((s) => ({ value: s.key, label: s.label }))}
          value={streetKey}
          onChange={setStreetKey}
        />

        <div className="mt-4 flex flex-wrap items-end gap-4">
          <CardRow label="Board" cards={board} empty="Pre-flop — no board yet" />
          {heroHole.length > 0 && (
            <CardRow
              label={isHero ? "Your cards" : `${seatName(focus)}'s cards`}
              cards={heroHole}
            />
          )}
        </div>

        {views.length === 0 ? (
          <p className="mt-5 text-sm text-ivory/55">
            No opponent was still in the pot at this point.
          </p>
        ) : (
          <div className="mt-5 space-y-4">
            {views.map((v) => (
              <div
                key={v.seat}
                data-testid={`range-card-${v.seat}`}
                className="min-w-0 rounded-xl border p-3"
                style={{
                  borderColor: "rgba(201,162,39,0.22)",
                  background: "rgba(0,0,0,0.28)",
                }}
              >
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-display text-sm font-semibold tracking-wide text-gold-soft">
                    {seatName(v.seat)}
                  </span>
                  <span className="font-mono text-[0.65rem] text-ivory/50">
                    {v.liveCombos} of 1326 combos · {pct(v.liveCombos / 1326, 0)} of
                    the deck
                  </span>
                </div>

                {/* Chart on the left at its natural size, the numbers it
                    summarises beside it — one opponent should not leave half
                    the panel empty, and four should not stack four charts of
                    different widths. */}
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
                  <RangeGrid
                    testId={`grid-${v.seat}`}
                    title={`${seatName(v.seat)} — ${street.label}`}
                    values={v.grid}
                    max={v.maxCell}
                    dead={(cell) => v.cellCombos[cell] === 0}
                    format={(cell) =>
                      v.cellCombos[cell] === 0
                        ? "blocked"
                        : `${v.cellCombos[cell]}c · ${(v.grid[cell] * 100).toFixed(2)}%`
                    }
                    legend={{
                      lo: "0%",
                      hi: `${(v.maxCell * 100).toFixed(1)}%`,
                      caption:
                        "Shading and the bar across each cell both carry the same number — the chance this seat holds that exact class. Hatched cells are fully blocked. Tap a cell to read it.",
                    }}
                  />

                  <div className="min-w-0">
                    <div className="space-y-2">
                      {[0, 1, 2].map((t) => (
                        <Meter
                          key={t}
                          label={<span className="capitalize">{TIER_NAMES[t]}</span>}
                          value={v.tierWeight[t]}
                          text={pct(v.tierWeight[t])}
                          color={TIER_COLOR[t]}
                        />
                      ))}
                    </div>

                    <p className="mt-3 text-[0.7rem] leading-relaxed text-ivory/50">
                      Half this read's weight sits in{" "}
                      <span className="font-mono text-gold-soft">{v.half.combos}</span>{" "}
                      combinations — {pct(v.half.fraction, 0)} of what the seat can
                      still hold.
                      {v.half.fraction > 0.42
                        ? " Barely narrower than a coin toss over the deck: this seat has told the table almost nothing yet."
                        : v.half.fraction > 0.2
                          ? " A real lean, but a long way from a pinned range."
                          : " Tight — the actions this seat took carry a lot of information."}
                    </p>

                    {board.length >= 3 && (
                      <div
                        className="mt-4 border-t pt-3"
                        style={{ borderColor: "rgba(244,237,228,0.1)" }}
                      >
                        <p className="mb-2 font-display text-[0.62rem] uppercase tracking-[0.2em] text-gold-soft/75">
                          What that range is, on this board
                        </p>
                        <div className="space-y-1.5">
                          {Array.from({ length: BUCKET_COUNT }, (_, b) => b)
                            .filter((b) => v.buckets[b] > 0.005)
                            .sort((a, b) => v.buckets[b] - v.buckets[a])
                            .slice(0, 6)
                            .map((b) => (
                              <Meter
                                key={b}
                                label={bucketName(b)}
                                value={v.buckets[b]}
                                text={pct(v.buckets[b])}
                              />
                            ))}
                        </div>
                        <p className="mt-2 text-[0.68rem] leading-relaxed text-ivory/45">
                          Every combination in the range, classified against{" "}
                          <span className="font-mono">{cardText(board)}</span> —
                          the nine rungs the engine works in. The three bars
                          above are these same nine collapsed into thirds, not a
                          separate pre-flop judgement, so the two cannot
                          disagree.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <HowCalculated label="How A Read Becomes A Chart">
          <Heading>What the table actually knows</Heading>
          <Lead>
            A read is not a list of hands, and it is not a mood either. It is one
            weight on each of the 1326 two-card combinations a deck can make. No
            seat's hole cards are ever consulted to build it — only the board and
            the bets — so the chart drawn here is exactly the distribution the
            bots' equity estimates were sampled from.
          </Lead>
          <Heading>Where the weights come from</Heading>
          <Lead>
            Every combination starts equal: before anybody acts, "dealt at
            random" is the whole story, and the only thing that has happened is
            card removal. Each action the seat then takes multiplies every
            combination by how likely that action is from a hand of{" "}
            <em>that class on that board</em>:
          </Lead>
          <Calc>
            <div className="flex flex-wrap items-center gap-1">
              w(combo) ← w(combo) × P(action | class of combo, street, position,
              facing)
            </div>
            <div className="mt-2 text-ivory/60">
              renormalised after each action, so the weights are a probability
              distribution at every step rather than only at the end.
            </div>
          </Calc>
          <Lead>
            The class is measured against the board <em>as it stood when the
            action was taken</em> — a flop bet is scored against the flop, never
            against the river the hand later ran out to. That is what makes 7-2
            a hand rather than a joke: on K-7-2 it has flopped two pair, so a bet
            from it is unremarkable and the weight stays. A pre-flop ranking
            would have filed the same combination under trash and folded it out
            of the range the equity was measured against.
          </Lead>
          <Heading>Reading the chart</Heading>
          <Lead>
            Each cell is the total weight of the 6, 4 or 12 combinations it
            holds. Pairs run down the diagonal, suited hands sit above it and
            offsuit below — AKs one step right of AA, AKo one step below. Weight
            is drawn twice over: as lightness, and as the width of the bar along
            the bottom of each cell, so the ranking survives greyscale and colour
            blindness. Hatched cells hold no combinations at all.
          </Lead>
          <Lead>
            The chart is a summary in one specific way, and it is worth knowing
            which: a cell's twelve combinations can be twelve different hands on
            the same board. The bucket bars beside it read the same weights
            through the classifier the engine used, which is where that detail
            survives.
          </Lead>
          <Why>
            This is the honest version of "putting someone on a hand". Nobody
            knows the two cards. What you can know is how the weight is spread —
            and how much narrower it got when they raised.
          </Why>
        </HowCalculated>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Narrowing"
        subtitle="The three-tier summary, street by street"
      >
        {/* Not the charts above in miniature. This is the coarse
            `weak / medium / strong` read the table also keeps, moved by Bayes on
            the flat action table — it is recorded with every decision and read
            by the coach, but it is not what the sampler drew from. Saying so is
            cheaper than letting the two be mistaken for each other. */}
        <p className="mb-4 text-[0.7rem] leading-relaxed text-ivory/45">
          A second, coarser read the table keeps alongside the ranges above:
          three numbers per seat, moved by Bayes after every public action. It
          ignores the board, so it is the one place a hand is still judged the
          way it looked before the flop — useful for watching a seat's story
          tighten, not for pricing a hand.
        </p>
        <div className="space-y-4">
          {opponents.length === 0 && (
            <p className="text-sm text-ivory/55">No opponents to track.</p>
          )}
          {opponents.map((seat) => (
            <div key={seat}>
              <p className="mb-2 font-display text-sm font-semibold text-gold-soft">
                {seatName(seat)}
              </p>
              <div className="space-y-1.5">
                {narrowing.map((n) => {
                  const b = n.reads[seat];
                  const parts: [number, number][] = [
                    [0, b.weak],
                    [1, b.medium],
                    [2, b.strong],
                  ];
                  return (
                    <div key={n.key} className="flex items-center gap-2">
                      <span className="w-14 shrink-0 truncate font-mono text-[0.58rem] uppercase tracking-wider text-ivory/45 sm:w-20">
                        {n.label}
                      </span>
                      <div
                        className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-full"
                        style={{ background: "rgba(0,0,0,0.45)" }}
                      >
                        {parts.map(([t, w]) => (
                          <div
                            key={t}
                            style={{
                              width: `${w * 100}%`,
                              background: TIER_COLOR[t],
                              opacity: 0.85,
                            }}
                          />
                        ))}
                      </div>
                      <span className="w-9 shrink-0 text-right font-mono text-[0.6rem] text-ivory/60">
                        {pct(b.strong, 0)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.68rem] text-ivory/45">
          {TIER_NAMES.map((name, t) => (
            <span key={name} className="flex items-center gap-1.5 capitalize">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: TIER_COLOR[t] }}
              />
              {name}
            </span>
          ))}
          <span className="font-mono">right-hand figure = P(strong)</span>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Blockers"
        subtitle={`${isHero ? "Your" : `${seatName(focus)}'s`} cards, and what they rule out`}
      >
        {heroHole.length === 0 ? (
          <p className="text-sm text-ivory/55">This seat was dealt no cards.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
              <RangeGrid
                testId="grid-blockers"
                title={`Combinations removed by ${cardText(heroHole)}`}
                values={blockers.removedByCell}
                max={12}
                dead={(cell) => blockers.leftByCell[cell] === 0}
                format={(cell) =>
                  blockers.removedByCell[cell] === 0
                    ? "untouched"
                    : `${CELL_TOTAL[cell]}→${blockers.leftByCell[cell]}`
                }
                legend={{
                  lo: "none removed",
                  hi: "12 removed",
                  caption:
                    "Brighter cells lost more combinations to the two cards below. Every class sharing a rank with them is affected; the rest are untouched.",
                }}
              />

              <div className="min-w-0">
                <CardRow cards={heroHole} />
                <p className="mt-3 text-sm leading-relaxed text-ivory/70">
                  <span className="font-mono text-gold-soft">{blockers.removed}</span>{" "}
                  of 1326 combinations —{" "}
                  <span className="font-mono">{pct(blockers.removed / 1326)}</span> of
                  the deck — cannot be in anybody else's hand.
                </p>
                {board.length > 0 && (
                  <p className="mt-1 text-sm text-ivory/50">
                    Counting the {board.length} board card
                    {board.length === 1 ? "" : "s"} too:{" "}
                    <span className="font-mono">{withBoard.removed}</span> gone.
                  </p>
                )}
                <p className="mb-2 mt-4 font-display text-[0.62rem] uppercase tracking-[0.2em] text-gold-soft/75">
                  Hardest hit classes
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {topBlocked(blockers.removedByCell).map((cell) => (
                    <Tag key={cell} tone="gold">
                      {GRID_LABELS[cell]} {CELL_TOTAL[cell]}→
                      {blockers.leftByCell[cell]}
                    </Tag>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        <HowCalculated label="Why Holding One Ace Matters">
          <Heading>Card removal is the whole story</Heading>
          <Lead>
            There is no separate blocker model anywhere in this engine, and there
            does not need to be one. An opponent's range is built out of the
            combinations still available, and a card you are looking at is not
            available. Removing k distinct cards kills exactly:
          </Lead>
          <Calc>
            C(52,2) − C(52−k,2) = 1326 − C(
            {52 - heroHole.length - board.length},2)
            {heroHole.length + board.length > 0 && (
              <span className="text-gold-soft"> = {withBoard.removed} combinations</span>
            )}
          </Calc>
          <Heading>What it does to a specific hand</Heading>
          <Lead>
            Pocket aces come in six combinations. Hold one ace yourself and three
            of those six are impossible — the chance an opponent has aces is
            halved before a single action is considered. The same arithmetic runs
            through every class sharing a rank with your hand, which is what the
            chart above is showing.
          </Lead>
          <Why>
            The ace of hearts in your hand is the reason the nut heart flush is
            not out there. Blockers are not a bluffing trick; they are conditional
            probability applied to a deck you have already seen part of.
          </Why>
        </HowCalculated>
      </Section>
    </div>
  );
}

/** The classes that lost the largest share of their combinations. */
function topBlocked(removed: Uint16Array): number[] {
  const cells: number[] = [];
  for (let i = 0; i < GRID_CELLS; i++) if (removed[i] > 0) cells.push(i);
  cells.sort(
    (a, b) => removed[b] / CELL_TOTAL[b] - removed[a] / CELL_TOTAL[a] || a - b
  );
  return cells.slice(0, 8);
}
