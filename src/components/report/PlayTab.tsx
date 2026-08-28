/**
 * Tab 3, your decisions, and what each one cost.
 *
 * The one rule this tab exists to enforce: model EV and hindsight EV are never
 * shown as the same number, never averaged, and never placed in the same
 * column. They answer different questions and they disagree constantly, and a
 * review that blurs them teaches the opposite of the lesson, that a call was
 * bad because the river bricked, or good because it hit.
 *
 *   Model EV     what the line was worth given what was *knowable* then, priced
 *                against the range inferred from the public action. It judges
 *                the decision, and it is the only number worth coaching from.
 *   Hindsight EV what the line turned out to be worth with every hole card face
 *                up. It judges the deal. Its long-run average over correct
 *                decisions is zero by construction.
 *
 * Both come from `poker/coach/evLoss.ts`, which rebuilds the read itself and so
 * works for a human seat, one that has no `BotDecision` and recorded no equity
 * of its own, exactly as it does for a bot. That analysis is a few thousand
 * simulations per decision, so it runs off the first paint rather than in
 * render, and every panel that depends on it degrades to a stated absence
 * rather than to an approximation made out of numbers that mean something else.
 *
 * ## The three derivations at the foot of the two sections
 *
 * All collapsed. The EV columns raise two questions this tab used to answer on
 * a different tab fifteen screens away — how a number in a column called "Model
 * loss" was arrived at, and what a bet is worth beyond the α it has to clear —
 * so `ExpectedValue` and `FoldEquityAlphaMdf` hang off the per-move section
 * that prints them. `RiverEquilibrium` hangs off the EV Loss section, under the
 * costliest-decision callout: that callout names the line that priced better
 * against a read, and equilibrium is the other yardstick, the one that holds
 * against an opponent who knew the strategy in advance.
 */

import { useEffect, useState } from "react";
import { money, pct } from "../../lib/format";
import type {
  DecisionEvLoss,
  HandEvLoss,
} from "../../poker/coach/evLoss";
import { analyzeHand } from "../../poker/coach/evLoss";
import type {
  ActionRecord,
  BotDecision,
  TableHandReport,
} from "../../poker/table/contract";
import { STREET_LABEL, readsAfter, requiredEquity, seatResult } from "./derive";
import {
  ExpectedValue,
  FoldEquityAlphaMdf,
  RiverEquilibrium,
} from "./derivations";
import {
  Calc,
  EmptyPanel,
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
} from "../ui";

interface Props {
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
  isHero: boolean;
}

interface Move {
  index: number;
  record: ActionRecord;
  decision: BotDecision | null;
  before: { weak: number; medium: number; strong: number };
  after: { weak: number; medium: number; strong: number };
}

function buildMoves(report: TableHandReport, focus: number): Move[] {
  const decisions = report.decisions.filter((d) => d.seat === focus);
  const moves: Move[] = [];
  let taken = 0;
  report.actions.forEach((record, index) => {
    if (record.seat !== focus) return;
    // Decisions and actions are pushed in lockstep for a seat the engine
    // priced, so the nth action by this seat is the nth decision. A human seat
    // has none, and a street mismatch means the pairing drifted, in either
    // case the move carries no engine EV rather than the wrong engine EV.
    const candidate = decisions[taken] ?? null;
    const decision =
      candidate && candidate.street === record.street ? candidate : null;
    moves.push({
      index,
      record,
      decision,
      before: readsAfter(report.actions, index, report.seatCount)[focus],
      after: readsAfter(report.actions, index + 1, report.seatCount)[focus],
    });
    taken += 1;
  });
  return moves;
}

type LossState =
  | { status: "working" }
  | { status: "ready"; value: HandEvLoss }
  | { status: "failed"; reason: string };

/**
 * Score the seat's hand off the first paint.
 *
 * `analyzeHand` is synchronous and runs a Monte Carlo per decision, so calling
 * it during render would stall the tab switch behind a few hundred milliseconds
 * of simulation. A timeout of zero is enough: the panels above paint, then the
 * work happens, then the numbers arrive.
 */
function useEvLoss(report: TableHandReport, focus: number): LossState {
  const [state, setState] = useState<LossState>({ status: "working" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "working" });
    const id = window.setTimeout(() => {
      try {
        const value = analyzeHand(report, focus);
        if (!cancelled) setState({ status: "ready", value });
      } catch (err) {
        if (!cancelled) {
          setState({ status: "failed", reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [report, focus]);

  return state;
}

export function PlayTab({ report, focus, seatName, isHero }: Props) {
  const you = seatResult(report, focus);
  const moves = buildMoves(report, focus);
  const priced = moves.filter((m) => m.decision !== null);
  const loss = useEvLoss(report, focus);
  const who = isHero ? "You" : seatName(focus);

  const byIndex = new Map<number, DecisionEvLoss>();
  if (loss.status === "ready") {
    for (const d of loss.value.decisions) byIndex.set(d.index, d);
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* ------------------------------------------------------------------ */}
      {/* "The ledger" was a label for four stat tiles reading Moves made,
          Chips in, Chips back, Net. It named the thing rather than adding to
          it. */}
      <Section title={isHero ? "Your Hand" : `${seatName(focus)}'s Hand`}>
        <StatGrid columns={4}>
          <Stat label="Moves made" value={moves.length} />
          <Stat label="Chips in" value={money(you?.invested ?? 0)} />
          <Stat label="Chips back" value={money(you?.won ?? 0)} />
          {/* Signed, so the tone carries the sign rather than a flat gold. */}
          <Stat
            label="Net"
            value={you ? signed(you.net) : "—"}
            tone={!you || you.net === 0 ? "neutral" : you.net > 0 ? "good" : "bad"}
          />
        </StatGrid>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* The subtitle promised two lenses kept apart. The two cards directly
          under it are the lenses, headed "Model EV loss · judges the decision"
          and "Hindsight EV loss · judges the deal", and they are apart. The
          reason they are apart is the disclosure at the foot of the section. */}
      <Section title="EV Loss">
        {loss.status === "working" && (
          <div className="flex h-[7rem] flex-col items-center justify-center gap-3 text-sm text-ivory/55">
            <span className="h-2 w-2 animate-pulse rounded-full bg-gold-soft" />
            Re-pricing every decision…
          </div>
        )}

        {loss.status === "failed" && (
          <EmptyPanel title="This hand could not be scored">
            <p>
              The coach could not re-price these decisions:{" "}
              <span className="font-mono text-[0.75rem] text-ivory/50">
                {loss.reason}
              </span>
            </p>
            <p className="mt-2">
              Everything else on this tab comes straight out of the hand record
              and is unaffected.
            </p>
          </EmptyPanel>
        )}

        {loss.status === "ready" && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LensCard
                tone="gold"
                title="Model EV loss"
                subtitle="Judges the decision"
                value={loss.value.totalModelEvLoss}
                blurb="Priced against the range the public action implied — only what was knowable at the time. This is the coaching number."
              />
              <LensCard
                tone="red"
                title="Hindsight EV loss"
                subtitle="Judges the deal"
                value={loss.value.totalHindsightEvLoss}
                blurb="Priced against the cards that were actually out. Results-oriented by design: a correct call that got outdrawn shows a loss here and none above."
              />
            </div>

            {loss.value.decisions.length === 0 ? (
              <p className="mt-4 text-sm text-ivory/55">
                {who} took no scorable action this hand.
              </p>
            ) : (
              <>
                {loss.value.worst && loss.value.worst.modelEvLoss < -0.01 ? (
                  <div
                    className="mt-4 rounded-xl border-l-2 px-3 py-2.5"
                    style={{ borderColor: "#c9a227", background: "rgba(201,162,39,0.08)" }}
                  >
                    <p className="font-display text-xs font-semibold uppercase tracking-wider text-gold-soft">
                      Costliest decision
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-ivory/75">
                      {STREET_LABEL[loss.value.worst.street]} —{" "}
                      {who.toLowerCase() === "you" ? "you" : who} chose{" "}
                      <strong className="uppercase text-ivory">
                        {loss.value.worst.action}
                      </strong>{" "}
                      where{" "}
                      <strong className="uppercase text-gold-soft">
                        {loss.value.worst.modelBestAction}
                      </strong>{" "}
                      priced better, at a model cost of{" "}
                      <span className="font-mono text-gold-soft">
                        {money(Math.abs(loss.value.worst.modelEvLoss))}
                      </span>
                      .
                    </p>
                  </div>
                ) : (
                  <div
                    className="mt-4 rounded-xl border-l-2 px-3 py-2.5"
                    style={{ borderColor: "#5fb98f", background: "rgba(95,185,143,0.08)" }}
                  >
                    <p className="font-display text-xs font-semibold uppercase tracking-wider text-[#7fd3a8]">
                      Clean hand
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-ivory/75">
                      Every decision took the highest-EV line available against
                      the range. Whatever the chips did, none of it was a
                      decision error.
                    </p>
                  </div>
                )}

                <Scroller>
                  <table className="mt-4 w-full text-sm">
                    <thead>
                      <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
                        <th className="py-2 pr-3">Street</th>
                        <th className="py-2 pr-3">Took</th>
                        <th className="py-2 pr-3 text-right">Model eq</th>
                        <th className="py-2 pr-3">Model best</th>
                        <th className="py-2 pr-3 text-right">Model loss</th>
                        <th className="py-2 pr-3 text-right">True eq</th>
                        <th className="py-2 pr-3 text-right">Hindsight loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loss.value.decisions.map((d) => (
                        <tr
                          key={d.index}
                          className="border-t"
                          style={{ borderColor: "rgba(244,237,228,0.1)" }}
                        >
                          <td className="py-2 pr-3 text-ivory/80">
                            {STREET_LABEL[d.street]}
                          </td>
                          <td className="py-2 pr-3">
                            <Tag tone={d.action === "fold" ? "bad" : "neutral"}>
                              {d.action}
                            </Tag>
                          </td>
                          <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/75">
                            {pct(d.modelEquity)}
                          </td>
                          <td className="py-2 pr-3">
                            <Tag tone={d.modelEvLoss < -0.01 ? "gold" : "neutral"}>
                              {d.modelBestAction}
                            </Tag>
                          </td>
                          <td
                            className="py-2 pr-3 text-right font-mono text-xs"
                            style={{ color: d.modelEvLoss < -0.01 ? "#e2c563" : "rgba(127,211,168,0.9)" }}
                          >
                            {d.modelEvLoss < -0.01 ? `−${money(-d.modelEvLoss)}` : "0"}
                          </td>
                          <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/55">
                            {pct(d.hindsightEquity)}
                            {!d.hindsightExact && (
                              <span className="ml-1 text-ivory/30">~</span>
                            )}
                          </td>
                          <td
                            className="py-2 pr-3 text-right font-mono text-xs"
                            style={{ color: d.hindsightEvLoss < -0.01 ? "#e58a8a" : "rgba(244,237,228,0.35)" }}
                          >
                            {d.hindsightEvLoss < -0.01 ? `−${money(-d.hindsightEvLoss)}` : "0"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
                <p className="mt-3 text-[0.7rem] leading-relaxed text-ivory/45">
                  The two loss columns are never added together. A tilde on the
                  true equity means the runout was sampled rather than
                  enumerated — only possible when the hand ended with cards still
                  to come.
                </p>
              </>
            )}
          </>
        )}

        <HowCalculated label="Why There Are Two Numbers">
          <Heading>Two questions that look like one</Heading>
          <Lead>
            "Was that a good call?" splits into "was it good given what I knew?"
            and "did it work?". Only the first is a skill question, and only the
            first is repeatable. Conflating them produces the two classic errors
            in equal measure: results-oriented despair after a correct call
            loses, and unearned confidence after a reckless one spikes.
          </Lead>
          <Heading>The definition</Heading>
          <Calc>
            EV loss = EV(line taken) − EV(best line available) ≤ 0
            <div className="mt-2 text-ivory/60">
              zero exactly when the best line was taken; it cannot be positive,
              because the chosen line is one of the lines the best is taken over.
            </div>
          </Calc>
          <Heading>What changes between the lenses</Heading>
          <Lead>
            Only the equity. Model EV uses the pot share against the{" "}
            <em>inferred range</em> — the same three-tier read the Ranges tab
            draws — while hindsight EV uses the pot share against the{" "}
            <em>actual cards</em>, with the real board enumerated where it can
            be. The pricing formula is identical either way:
          </Lead>
          <Calc>
            <div>fold: 0</div>
            <div>check: equity × pot</div>
            <div>call: equity × pot − (1 − equity) × cost</div>
            <div>bet/raise: equity × (pot + extra) − (1 − equity) × cost</div>
          </Calc>
          <Heading>What each is worth measuring for</Heading>
          <Lead>
            Model EV loss adds up over a session into something meaningful — it
            is roughly the price of the mistakes. Hindsight EV loss adds up into
            variance, and averages to zero over correct decisions. Both are worth
            seeing; neither is worth seeing in the same column.
          </Lead>
          <Why>
            A review that only shows hindsight teaches you to fear the river. One
            that only shows model EV never tells you what the deal actually cost.
            Two panels, two labels, no arithmetic between them.
          </Why>
        </HowCalculated>

        {/* The costliest-decision callout above names the line that priced
            better against the read. This is the other yardstick for the same
            move, and it is the one a read cannot flatter. */}
        <HowCalculated label="Equilibrium, And What It Would Have Done">
          <RiverEquilibrium report={report} focus={focus} seatName={seatName} />
        </HowCalculated>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Every card below opens with the street, the action and the pot, and
          then says in a sentence what the move had to be worth. The subtitle
          was that sentence's table of contents. */}
      <Section title="Every Move">
        {moves.length === 0 ? (
          <p className="text-sm text-ivory/55">{who} never acted this hand.</p>
        ) : (
          <div className="space-y-3">
            {moves.map((m) => {
              const need = requiredEquity(m.record.potBefore, m.record.toCall);
              const scored = byIndex.get(m.index) ?? null;
              return (
                <div
                  key={m.index}
                  className="rounded-xl border p-3"
                  style={{
                    borderColor: "rgba(201,162,39,0.22)",
                    background: "rgba(0,0,0,0.26)",
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="font-display text-sm font-semibold tracking-wide text-gold-soft">
                        {STREET_LABEL[m.record.street]}
                      </span>
                      <Tag tone={m.record.action === "fold" ? "bad" : "gold"}>
                        {m.record.action}
                      </Tag>
                    </span>
                    <span className="font-mono text-xs text-ivory/60">
                      pot {money(m.record.potBefore)}
                      {m.record.cost > 0 && ` · paid ${money(m.record.cost)}`}
                    </span>
                  </div>

                  {m.record.toCall > 0 ? (
                    <p className="mt-2 text-xs leading-relaxed text-ivory/70">
                      Facing {money(m.record.toCall)} into{" "}
                      {money(m.record.potBefore)}: a call had to be good{" "}
                      <span className="font-mono text-gold-soft">{pct(need)}</span>{" "}
                      of the time to break even —{" "}
                      {(m.record.potBefore / m.record.toCall).toFixed(1)} to 1 on
                      the money.
                    </p>
                  ) : (
                    <p className="mt-2 text-xs leading-relaxed text-ivory/70">
                      Nothing to call, so the move was free — any equity at all is
                      profit.
                    </p>
                  )}

                  <BluffPrice move={m} isHero={isHero} />

                  <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-1.5 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
                        The table's read on {isHero ? "you" : "this seat"}
                      </p>
                      <div className="space-y-1">
                        <ReadShift label="weak" before={m.before.weak} after={m.after.weak} />
                        <ReadShift label="medium" before={m.before.medium} after={m.after.medium} />
                        <ReadShift label="strong" before={m.before.strong} after={m.after.strong} />
                      </div>
                      {m.decision && (
                        <>
                          <p className="mb-1.5 mt-3 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
                            The engine's own pricing
                          </p>
                          <EngineEv decision={m.decision} />
                        </>
                      )}
                    </div>

                    <div>
                      <p className="mb-1.5 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-gold-soft/70">
                        Model EV — the lines available
                      </p>
                      {scored ? (
                        <>
                          <Alternatives d={scored} lens="model" />
                          <p className="mb-1.5 mt-3 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-[#e58a8a]/70">
                            Hindsight EV — with the cards face up
                          </p>
                          <Alternatives d={scored} lens="hindsight" />
                        </>
                      ) : (
                        <p className="text-xs leading-relaxed text-ivory/45">
                          {loss.status === "working"
                            ? "Scoring…"
                            : "This move was not scored."}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <HowCalculated label="How Expected Value Is Priced">
          <Heading>Break-even, without a simulation</Heading>
          <Lead>
            Set EV(call) to zero and solve, and the price of a call tells you the
            equity it needs with no Monte Carlo involved at all:
          </Lead>
          <Calc>
            <div className="flex flex-wrap items-center gap-1">
              required equity =
              <Frac n={<>cost</>} d={<>pot + cost</>} />
            </div>
          </Calc>
          <Lead>
            That is the number printed against every call above. It is exact
            arithmetic, not an estimate — the only open question is whether the
            hand clears it, and that is what the two EV panels answer from their
            two different vantage points.
          </Lead>
          <Heading>The same trick, from the other side of the bet</Heading>
          <Lead>
            Set the EV of a <em>bluff</em> to zero instead and the same algebra
            gives the frequency it has to work. A bet of s into a pot of P risks s
            to win P, so with no equity at all it breaks even at:
          </Lead>
          <Calc>
            <div className="flex flex-wrap items-center gap-1">
              α =
              <Frac n={<>s</>} d={<>P + s</>} />
              &nbsp;&nbsp; MDF = 1 − α =
              <Frac n={<>P</>} d={<>P + s</>} />
            </div>
            <div className="mt-2 text-ivory/60">
              half pot 33.3% / 66.7 · three-quarter pot 42.9 / 57.1 · pot 50 / 50
              · twice pot 66.7 / 33.3. An opponent folding more often than α can
              be beaten by betting any two cards; MDF is the share of range they
              have to keep playing to stop that.
            </div>
          </Calc>
          <Lead>
            Both numbers are printed against every bet and raise above, worked at
            that move's own pot. They need no simulation and no read — like pot
            odds, they are the half of the decision that is pure arithmetic. What
            the bet is actually <em>worth</em> needs one more thing, the equity
            against the hands that do not fold, and that is the next panel down.
          </Lead>
          <Why>
            Pot odds are the half of the decision that never needs a computer.
            Getting 3 to 1 means 25%; everything else is working out whether the
            hand is better than that.
          </Why>
        </HowCalculated>

        {/* Against the EV columns in every card above. The first works the
            general form on this hand's own pot and pot share; the second is the
            half of a bet the showdown formula never counts, which is exactly
            the thing the α line printed against each bet stops short of. */}
        <HowCalculated label="Expected Value, Worked On This Hand">
          <ExpectedValue report={report} focus={focus} seatName={seatName} />
        </HowCalculated>

        <HowCalculated label="Fold Equity, α and MDF">
          <FoldEquityAlphaMdf report={report} focus={focus} seatName={seatName} />
        </HowCalculated>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {priced.length > 0 && (
        <Section
          title="Decision Table"
          subtitle="What the engine recorded at the table"
          wide
        >
          <Scroller>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[0.62rem] uppercase tracking-wider text-ivory/45">
                  <th className="py-2 pr-3">Street</th>
                  <th className="py-2 pr-3 text-right">Equity</th>
                  <th className="py-2 pr-3 text-right">Pot</th>
                  <th className="py-2 pr-3 text-right">To call</th>
                  <th className="py-2 pr-3 text-right">Need</th>
                  <th className="py-2 pr-3">Chosen</th>
                </tr>
              </thead>
              <tbody>
                {priced.map((m) => {
                  const d = m.decision!;
                  const need = requiredEquity(d.potBefore, d.toCall);
                  return (
                    <tr
                      key={m.index}
                      className="border-t"
                      style={{ borderColor: "rgba(244,237,228,0.1)" }}
                    >
                      <td className="py-2 pr-3 text-ivory/80">{STREET_LABEL[d.street]}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-ivory">
                        {pct(d.equity.equity)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                        {money(d.potBefore)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                        {d.toCall > 0 ? money(d.toCall) : "—"}
                      </td>
                      <td
                        className={`py-2 pr-3 text-right font-mono text-xs ${
                          d.toCall > 0 && d.equity.equity >= need
                            ? "text-[#7fd3a8]"
                            : d.toCall > 0
                              ? "text-[#e58a8a]"
                              : "text-ivory/40"
                        }`}
                      >
                        {d.toCall > 0 ? pct(need) : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        <Tag tone="gold">{d.action.label}</Tag>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroller>
          {/* Two tables on one tab print an equity column each and the two do
              not match to the last point. That is worth explaining once, to the
              reader who noticed, and it is not worth a permanent paragraph
              under a table nobody has cross-checked yet — the mismatch is the
              question, so the answer waits for it. */}
          <Reveal
            tone="quiet"
            label="Why this equity column differs from the one above"
            summary="live budget vs fixed budget"
          >
            These are the engine's live numbers, at the sample budget the table
            actually used. The EV-loss panel re-prices the same spots on a fixed
            budget so every decision is compared on equal terms, which is why the
            two equity columns are close but not identical.
          </Reveal>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function signed(v: number): string {
  return v >= 0 ? `+${money(v)}` : `−${money(-v)}`;
}

/**
 * What a bet had to buy, priced with no simulation at all.
 *
 * `s` is the increment risked beyond any call and `P` the pot as it stands once
 * that call is in, the same frame `model/decider.ts` sizes bets in (`extra`
 * against `pot + toCall`), so this number and the engine's sizing ladder are
 * talking about the same fraction. `poker/ev.ts` derives both: a bluff with no
 * equity breaks even at α = s/(P+s), and its complement is the minimum defence
 * frequency.
 *
 * Where the seat was a bot, the engine's own recorded P(everyone folds) is
 * printed beside it, the estimate against the threshold it has to clear.
 */
function BluffPrice({ move, isHero }: { move: Move; isHero: boolean }) {
  const { record } = move;
  if (record.action !== "bet" && record.action !== "raise") return null;
  const size = record.cost - record.toCall;
  const pot = record.potBefore + record.toCall;
  if (!(size > 0) || !(pot > 0)) return null;

  const alpha = size / (pot + size);
  const breakdown = move.decision?.foldEquity?.[move.decision.action.label] ?? null;
  const who = isHero ? "you" : "this seat";

  return (
    <p className="mt-1.5 text-xs leading-relaxed text-ivory/70">
      Risking {money(size)} to win {money(pot)}: as a pure bluff it only had to
      work{" "}
      <span className="font-mono text-gold-soft">{pct(alpha)}</span> of the time
      to break even, so the other seats had to defend{" "}
      <span className="font-mono">{pct(1 - alpha)}</span> of their range to stop{" "}
      {who} betting any two cards profitably.
      {breakdown && (
        <>
          {" "}
          The engine put the chance everyone folds at{" "}
          <span
            className="font-mono"
            style={{ color: breakdown.pFold >= alpha ? "#7fd3a8" : "#e58a8a" }}
          >
            {pct(breakdown.pFold)}
          </span>
          , {breakdown.pFold >= alpha ? "above" : "below"} that line — and the
          bet had {pct(breakdown.eContinue)} equity against the range that would
          have called.
        </>
      )}
    </p>
  );
}

function LensCard({
  tone,
  title,
  subtitle,
  value,
  blurb,
}: {
  tone: "gold" | "red";
  title: string;
  subtitle: string;
  value: number;
  blurb: string;
}) {
  const gold = tone === "gold";
  return (
    <div
      className="rounded-xl border p-3"
      style={{
        borderColor: gold ? "rgba(226,197,99,0.4)" : "rgba(210,74,74,0.4)",
        background: gold ? "rgba(201,162,39,0.07)" : "rgba(210,74,74,0.07)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p
          className="font-display text-xs font-semibold uppercase tracking-wider"
          style={{ color: gold ? "#e2c563" : "#e58a8a" }}
        >
          {title}
        </p>
        <p className="text-[0.6rem] uppercase tracking-wider text-ivory/40">{subtitle}</p>
      </div>
      <p
        className="mt-1 font-display text-2xl font-semibold"
        style={{ color: value < -0.01 ? (gold ? "#e2c563" : "#e58a8a") : "#7fd3a8" }}
      >
        {value < -0.01 ? `−${money(-value)}` : "0"}
      </p>
      <p className="mt-1.5 text-[0.7rem] leading-relaxed text-ivory/60">{blurb}</p>
    </div>
  );
}

function Alternatives({
  d,
  lens,
}: {
  d: DecisionEvLoss;
  lens: "model" | "hindsight";
}) {
  const values = d.alternatives.map((a) =>
    lens === "model" ? a.modelEv : a.hindsightEv
  );
  const best = Math.max(...values);
  const worst = Math.min(...values, 0);
  const span = best - worst || 1;
  const accent = lens === "model" ? "#e2c563" : "#e58a8a";

  return (
    <div className="space-y-1.5">
      {d.alternatives.map((a, i) => {
        const value = values[i];
        const isBest = Math.abs(value - best) < 1e-9;
        return (
          <Meter
            key={`${a.action}-${i}`}
            label={
              <span className={a.chosen ? "text-ivory" : "text-ivory/60"}>
                {a.action}
                {a.chosen && " ← taken"}
                {isBest && !a.chosen && " ← best"}
              </span>
            }
            value={(value - worst) / span}
            text={`${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`}
            color={a.chosen ? accent : "rgba(244,237,228,0.3)"}
          />
        );
      })}
    </div>
  );
}

function EngineEv({ decision }: { decision: BotDecision }) {
  const entries = Object.entries(decision.evByAction);
  if (entries.length === 0) {
    return <p className="text-xs text-ivory/45">No EV was recorded for this move.</p>;
  }
  const best = Math.max(...entries.map(([, v]) => v));
  const worst = Math.min(...entries.map(([, v]) => v), 0);
  const span = best - worst || 1;
  return (
    <div className="space-y-1.5">
      {entries.map(([label, value]) => (
        <Meter
          key={label}
          label={
            <span className={label === decision.action.label ? "text-gold-soft" : undefined}>
              {label}
              {label === decision.action.label && " ← taken"}
            </span>
          }
          value={(value - worst) / span}
          text={`${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`}
          color={label === decision.action.label ? "#e2c563" : "rgba(244,237,228,0.3)"}
        />
      ))}
    </div>
  );
}

function ReadShift({
  label,
  before,
  after,
}: {
  label: string;
  before: number;
  after: number;
}) {
  const delta = after - before;
  return (
    <div className="flex items-center gap-2 text-[0.68rem]">
      <span className="w-12 shrink-0 capitalize text-ivory/50">{label}</span>
      <span className="font-mono text-ivory/60">{pct(before, 0)}</span>
      <span className="text-ivory/30">→</span>
      <span className="font-mono text-ivory/85">{pct(after, 0)}</span>
      <span
        className="font-mono"
        style={{
          color:
            delta > 0.005 ? "#e58a8a" : delta < -0.005 ? "#7fd3a8" : "rgba(244,237,228,0.3)",
        }}
      >
        {Math.abs(delta) < 0.005
          ? "—"
          : `${delta > 0 ? "+" : "−"}${pct(Math.abs(delta), 0)}`}
      </span>
    </div>
  );
}
