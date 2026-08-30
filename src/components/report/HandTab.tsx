/**
 * Tab 1, what happened.
 *
 * The factual layer: the board, who sat where and what it cost them, how the
 * pot was cut up and why, the order the chips went in, and how the equity moved
 * street by street. Nothing here is advice. Everything on the other tabs is
 * derived from what this one shows.
 *
 * ## Why there are derivations on a factual tab
 *
 * Four of them, all collapsed, each hanging off the figure that raises it: the
 * `±` and the field-versus-pairwise gap on the head-to-head panel, the runout
 * distribution under the "Final hand" column. Collecting them into a tab of
 * their own would mean a reader who wondered what the `±` was doing there had to
 * leave the bar, find the tab, and scroll past unrelated sections to reach the
 * answer.
 */

import { useMemo } from "react";
import { money, pct } from "../../lib/format";
import { positionOf } from "../../poker/table/position";
import type { TableHandReport } from "../../poker/table/contract";
import {
  STREET_LABEL,
  actionsByStreet,
  potViews,
  seatResult,
  streetEquities,
} from "./derive";
import {
  EquityLadder,
  MadeHandDistribution,
  MonteCarloPrecision,
  MultiwayCompounding,
} from "./derivations";
import {
  CardRow,
  Calc,
  Frac,
  Heading,
  HowCalculated,
  Lead,
  Meter,
  Reveal,
  Scroller,
  Section,
  Stat,
  StatGrid,
  Tag,
  Why,
  cardText,
  type Tone,
} from "../ui";

interface Props {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
  isHero: boolean;
}

/** Mirrors `netTone`, in the vocabulary `Stat` speaks. */
function resultTone(net: number | undefined): Tone {
  if (net === undefined || net === 0) return "neutral";
  return net > 0 ? "good" : "bad";
}

const ACTION_TONE: Record<string, Tone> = {
  fold: "bad",
  check: "neutral",
  call: "neutral",
  bet: "gold",
  raise: "gold",
};

export function HandTab({ report, focus, seatName, isHero }: Props) {
  const you = seatResult(report, focus);
  const pots = potViews(report);
  // Every head-to-head runs the two hands out; preflop that is a sampled loop,
  // so it must not be redone on an unrelated re-render.
  const equities = useMemo(() => streetEquities(report, focus), [report, focus]);
  const streets = actionsByStreet(report.actions);
  const totalPot = report.pots.reduce((s, p) => s + p.amount, 0);
  const winners = report.seats.filter((s) => s.won > 0);

  return (
    // `items-start` so the short panel in a row keeps its own height. Stretched,
    // "Pots" grew to match "Action" and left a third of a screen of empty felt
    // inside a bordered box.
    <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2 lg:items-start">
      {/* ------------------------------------------------------------------ */}
      <Section title="The Board" subtitle={`Hand #${report.handNumber} · seed ${report.seed}`} wide>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <CardRow
            label={`Community · ${STREET_LABEL[report.endStreet]}`}
            cards={report.board}
            size="md"
            empty="No flop was dealt"
          />
          <div className="sm:w-[22rem]">
            <StatGrid columns={2}>
              {/* The old `highlight` made this gold whatever it said. A result
                  has a sign, and the sign is the thing worth colouring. */}
              <Stat
                label={isHero ? "Your result" : `${seatName(focus)} result`}
                value={you ? (you.net >= 0 ? `+${money(you.net)}` : `−${money(-you.net)}`) : "-"}
                tone={resultTone(you?.net)}
              />
              <Stat label="Total pot" value={money(totalPot)} />
              <Stat label="Ended on" value={STREET_LABEL[report.endStreet]} />
              <Stat label="Showdown" value={report.wentToShowdown ? "Yes" : "Folded out"} />
            </StatGrid>
          </div>
        </div>

        {you && you.hole.length > 0 && (
          <div className="mt-5 border-t pt-4" style={{ borderColor: "rgba(244,237,228,0.1)" }}>
            <CardRow label={isHero ? "Your hole cards" : `${seatName(focus)}'s hole cards`} cards={you.hole} />
          </div>
        )}

        <HowCalculated label="What Is On This Page">
          <Heading>The record, not a replay</Heading>
          <Lead>
            A hand is written down the moment it ends: the cards, every chip
            movement, and the equity estimate behind each bot's move. The seed,{" "}
            <span className="font-mono text-gold-soft">{report.seed}</span>, is
            enough to deal this hand again card for card, which is what makes the
            numbers on the other tabs checkable rather than merely plausible.
          </Lead>
          <Heading>This hand</Heading>
          <Lead>
            {report.seatCount} seats, button on {seatName(report.button)}.{" "}
            {report.board.length > 0
              ? `The board ran ${cardText(report.board)}.`
              : "Everyone folded before a flop."}{" "}
            {winners.length > 0
              ? `${winners.map((w) => `${seatName(w.seat)} collected ${money(w.won)}`).join(", ")}.`
              : "No chips changed hands."}
          </Lead>
        </HowCalculated>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* No subtitle: the seven column headings a line below it are "Cards,
          chips and how each one finished", spelled out and each attached to the
          column it names. */}
      <Section title="Seats" wide>
        <Scroller>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[0.62rem] uppercase tracking-wider text-ivory/45">
                <th className="py-2 pr-3">Seat</th>
                <th className="py-2 pr-3">Pos</th>
                <th className="py-2 pr-3">Cards</th>
                <th className="py-2 pr-3">Final hand</th>
                <th className="py-2 pr-3 text-right">In</th>
                <th className="py-2 pr-3 text-right">Won</th>
                <th className="py-2 pr-3 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {report.seats.map((s) => {
                const mine = s.seat === focus;
                return (
                  <tr
                    key={s.seat}
                    className="border-t"
                    style={{
                      borderColor: "rgba(244,237,228,0.1)",
                      background: mine ? "rgba(201,162,39,0.07)" : undefined,
                    }}
                  >
                    <td className="py-2 pr-3">
                      <span className={mine ? "font-semibold text-gold-soft" : "text-ivory/85"}>
                        {seatName(s.seat)}
                      </span>
                      {s.status === "folded" && (
                        <span className="ml-2">
                          <Tag tone="bad">folded</Tag>
                        </span>
                      )}
                      {s.status === "allin" && (
                        <span className="ml-2">
                          <Tag tone="gold">all-in</Tag>
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-ivory/60">
                      {positionOf(s.seat, report.button, report.seatCount)}
                    </td>
                    {/* Glyph cards, not `cardText`. The same two cards are drawn
                        as cards 300px above this row, and printing them here as
                        "Ah Kd" made the reader translate between two notations
                        for one fact. `xs` is a fixed 1.55rem chip, small enough
                        that it does not set the row height. */}
                    <td className="py-2 pr-3">
                      <CardRow cards={s.hole} size="xs" empty="not shown" />
                    </td>
                    <td className="py-2 pr-3 text-xs text-ivory/70">
                      {s.final?.name ?? (s.status === "folded" ? "mucked" : "-")}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                      {money(s.invested)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                      {s.won > 0 ? money(s.won) : "-"}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-mono text-xs ${
                        s.net > 0 ? "text-[#7fd3a8]" : s.net < 0 ? "text-[#e58a8a]" : "text-ivory/50"
                      }`}
                    >
                      {s.net > 0 ? `+${money(s.net)}` : s.net < 0 ? `−${money(-s.net)}` : "0"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Scroller>
        {/* Face-up mucked cards are the one thing on this table a poker player
            may read as a bug rather than a feature, so the answer stays on the
            page - but it is an answer, and an answer belongs behind the
            question. Nobody scanning a results table has asked it yet. */}
        <Reveal tone="quiet" label="Why mucked hands are face up here">
          Every seat's cards are shown, including the ones that mucked. A review
          is the one place where hindsight is the point. At the table those hands
          stay face down.
        </Reveal>

        {/* The "Final hand" column reports the one category the deck produced.
            This is the distribution it was drawn from, which is the question
            that column raises and never answers. */}
        <HowCalculated label="What This Hand Could Become">
          <MadeHandDistribution report={report} focus={focus} seatName={seatName} />
        </HowCalculated>
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Pots"
        subtitle={pots.length > 1 ? `Main pot plus ${pots.length - 1} side` : "Single pot"}
      >
        <div className="space-y-3">
          {pots.length === 0 && (
            <p className="text-sm text-ivory/55">No chips reached a pot this hand.</p>
          )}
          {pots.map((p) => (
            <div
              key={p.index}
              className="rounded-xl border p-3"
              style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.25)" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-sm font-semibold text-gold-soft">
                  {p.index === 0 ? "Main pot" : `Side pot ${p.index}`}
                </span>
                <span className="font-mono text-base text-ivory">{money(p.amount)}</span>
              </div>
              <div className="mt-2 space-y-1 text-xs text-ivory/70">
                <p>
                  <span className="text-ivory/45">Eligible · </span>
                  {p.eligible.map(seatName).join(", ") || "nobody"}
                </p>
                <p>
                  <span className="text-ivory/45">Won by · </span>
                  <span className="text-gold-soft">
                    {p.winners.map(seatName).join(", ") || "-"}
                  </span>
                </p>
                <p className="leading-relaxed text-ivory/55">
                  {p.cap > p.floor ? (
                    <>
                      Cut at {money(p.cap)} a seat: the most the shortest live
                      seat in it could put up. The layer takes every chip each
                      seat committed between {money(p.floor)} and {money(p.cap)};{" "}
                      {p.contributors.length} seat
                      {p.contributors.length === 1 ? "" : "s"} paid into it, folded
                      ones included, and the {p.eligible.length} still live can win
                      it.
                      {p.index > 0 &&
                        " Anyone all-in for less was already paid out of the layer below."}
                    </>
                  ) : (
                    <>Settled at {money(p.cap)} a seat.</>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>

        <HowCalculated label="Why Side Pots Exist">
          <Heading>The rule</Heading>
          <Lead>
            A seat can only win what it could have lost. Contributions are sliced
            into layers at each distinct all-in level; within a layer every seat
            that reached it paid the same amount, and only the seats that are
            still live can win it. A layer exactly one seat reached is an uncalled
            bet and comes straight back.
          </Lead>
          <Calc>
            most a seat all-in for X can win = Σ&#8202;ⱼ min(X, investedⱼ)
          </Calc>
          <Why>
            Without the layering, a short stack that got all-in for {money(20)}{" "}
            could take down a pot swollen by two deeper seats betting {money(200)}{" "}
            at each other afterwards, chips it never had the option to match.
          </Why>
        </HowCalculated>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* No subtitle. A list of streets in order, each holding a row per move
          with the chips on the right, is not improved by "Every chip, in
          order" printed above it. */}
      <Section title="Action">
        {streets.length === 0 ? (
          <p className="text-sm text-ivory/55">No actions were recorded.</p>
        ) : (
          <div className="space-y-4">
            {streets.map((s, i) => (
              <div key={`${s.street}-${i}`}>
                <p className="mb-1.5 font-display text-[0.65rem] uppercase tracking-[0.22em] text-gold-soft/80">
                  {s.label}
                </p>
                <div className="space-y-1">
                  {s.actions.map((a, j) => (
                    <div
                      key={j}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs"
                      style={{
                        background:
                          a.seat === focus ? "rgba(201,162,39,0.1)" : "rgba(0,0,0,0.22)",
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={`truncate ${
                            a.seat === focus ? "font-semibold text-gold-soft" : "text-ivory/80"
                          }`}
                        >
                          {seatName(a.seat)}
                        </span>
                        <Tag tone={ACTION_TONE[a.action] ?? "neutral"}>{a.action}</Tag>
                      </span>
                      <span className="shrink-0 font-mono text-[0.68rem] text-ivory/55">
                        {a.cost > 0 ? money(a.cost) : "-"}
                        <span className="ml-2 text-ivory/35">pot {money(a.potBefore)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title={isHero ? "Who Was Drawing At You" : `Who Was Drawing At ${seatName(focus)}`}
        subtitle="Head-to-head equity, street by street"
        wide
      >
        {equities.length === 0 ? (
          // Two different absences, and saying the wrong one is a lie the page
          // disproves three panels up: a hand read back from the archive has a
          // full action list and no simulation records, because storage drops
          // them. Only a hand with no actions at all was really uncontested.
          <p className="text-sm text-ivory/55">
            {report.decisions.length === 0 && report.actions.length > 0
              ? "These bars are built from the simulation records the table kept, and this hand was restored from the archive, which does not store them. The action list above is complete."
              : "No seat ran an equity estimate this hand. The pot was uncontested before anyone had to price a decision."}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {equities.map((e) => (
              <div
                key={e.street}
                className="rounded-xl border p-3"
                style={{ borderColor: "rgba(244,237,228,0.12)", background: "rgba(0,0,0,0.25)" }}
              >
                <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-display text-sm font-semibold tracking-wide text-gold-soft">
                    {e.label}
                  </span>
                  {e.own && (
                    <span className="font-mono text-xs text-ivory/70">
                      vs field{" "}
                      <span className="text-ivory">{pct(e.own.equity)}</span>
                    </span>
                  )}
                </div>

                <div className="space-y-2.5">
                  {e.vs.length === 0 && (
                    <p className="text-xs text-ivory/45">No matchup was recorded here.</p>
                  )}
                  {e.vs.map((h) => (
                    <Meter
                      key={h.seat}
                      label={
                        <span className="flex items-center gap-1.5">
                          <span className="truncate">vs {seatName(h.seat)}</span>
                          {h.seat === e.threat?.seat && <Tag tone="bad">biggest threat</Tag>}
                        </span>
                      }
                      value={h.equity}
                      text={`${pct(h.equity)}${h.source === "estimate" ? " ·est" : h.exact ? "" : " ±"}`}
                      color={h.equity < 0.5 ? "#d24a4a" : "#e2c563"}
                    />
                  ))}
                </div>

                {e.threat && (
                  <p className="mt-3 text-[0.7rem] leading-relaxed text-ivory/55">
                    {seatName(e.threat.seat)} held the most equity against{" "}
                    {isHero ? "you" : seatName(focus)} here,{" "}
                    <span className="font-mono text-ivory/80">
                      {pct(1 - e.threat.equity)}
                    </span>{" "}
                    head-to-head
                    {e.threat.source === "estimate"
                      ? `, by ${isHero ? "your" : "that"} seat's own estimate: its cards are not on the record.`
                      : "."}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <HowCalculated label="Where These Numbers Come From">
          <Heading>Field equity is not the sum of its parts</Heading>
          <Lead>
            Every multiway estimate records two different things: the share of
            the pot the hand expects against <em>everyone at once</em>, and its
            equity against each opponent taken <em>alone</em>. They come apart
            fast. A hand can be a 60% favourite over every seat individually and
            still be an underdog to the field, because beating all of them at
            once is a conjunction, not an average. The "vs field" figure here is
            the estimate the seat acted on at the time, against ranges; the bars
            below are settled after the fact from the cards everyone actually
            had, so the two are answers to different questions.
          </Lead>
          <Calc>
            P(beat all) ≠ min&#8202;ᵢ P(beat i) &nbsp;&nbsp; and &nbsp;&nbsp; P(beat
            all) ≤ min&#8202;ᵢ P(beat i)
          </Calc>
          <Heading>Read this panel as a threat list</Heading>
          <Lead>
            The bars are head-to-head, so the lowest bar is the seat you were
            least happy to see. That is the seat whose cards were actually
            driving your equity down; the rest were along for the ride.
          </Lead>
          <Why>
            Multiway, the question that matters is never "am I ahead?". It is
            "who exactly am I behind?". One seat with a live draw sets the price
            of the whole pot.
          </Why>
          <Heading>These bars are the real numbers, not estimates</Heading>
          <Lead>
            At the table an equity figure is always a guess about cards you
            cannot see: a bot runs a simulation against the <em>range</em> it has
            you on. Once the hand is over that guesswork is unnecessary: every
            hole card is on the record, so each bar here is settled by dealing
            the two actual hands against each other over the actual board, and
            counting. A chop splits, so a bar is pot share, not win rate.
          </Lead>
          <Calc>
            <div className="flex flex-wrap items-center gap-1">
              your equity vs seat i =
              <Frac
                n={<>runouts you win + ½ (runouts you chop)</>}
                d={<>runouts</>}
              />
            </div>
          </Calc>
          <Lead>
            From the flop on, "runouts" means all of them: 1081 boards on the
            flop, 44 on the turn, one on the river, so the number is exact.
            Preflop there are 1.7 million, so it is sampled 20,000 times from the
            hand's own seed and marked{" "}
            <span className="font-mono text-gold-soft">±</span>; it is
            reproducible and accurate to about a quarter of a point.{" "}
            <span className="font-mono text-gold-soft">·est</span> would mark a
            seat whose cards the record does not hold, falling back to the
            estimate. You should not normally see one.
          </Lead>
          <Why>
            The tempting shortcut is to take the opponent's stored equity against
            you and subtract it from one. It is wrong, and quietly: that number
            is <em>its</em> hand against the range it put <em>you</em> on, so
            your real cards never enter it and it comes out the same whether you
            held aces or 7-2.
          </Why>
        </HowCalculated>

        {/* Three derivations, all shut, all anchored to something printed a few
            hundred pixels up: the `±` suffix on a sampled bar, the line the
            bars would trace if you drew one street after another, and the gap
            between "vs field" and every pairwise number beside it. */}
        <HowCalculated label="Monte Carlo Precision, And The ± On Every Estimate">
          <MonteCarloPrecision report={report} focus={focus} seatName={seatName} />
        </HowCalculated>

        <HowCalculated label="Equity As Information Arrives">
          <EquityLadder report={report} focus={focus} seatName={seatName} />
        </HowCalculated>

        <HowCalculated label="Multiway Is Not Heads-Up">
          <MultiwayCompounding report={report} focus={focus} seatName={seatName} />
        </HowCalculated>
      </Section>
    </div>
  );
}
