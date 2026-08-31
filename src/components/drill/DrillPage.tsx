/**
 * The spots you got wrong, asked again.
 *
 * The profile names a leak and prices it. That is a diagnosis, and a diagnosis
 * on its own changes nothing: the leak-finding genre is full of players who can
 * recite what they do wrong and keep doing it. What closes the loop is being put
 * back in the spot with the answer not in front of you.
 *
 * NOTHING HERE IS SIMULATED. The spot is recovered from the archive, and every
 * number shown after an answer is the number `coach/evLoss.ts` already computed
 * for the profile: the same EV per line, against the same inferred range, under
 * the same model lens. A drill that priced the spot a second time could disagree
 * with the page that sent you here, and then one of them would be lying.
 *
 * WHY IT ASKS FOR AN ACTION CLASS AND NOT A SIZE. `evLoss.ts` compares fold,
 * check, call, bet and raise, and it says in its own header why it does not
 * compare sizes: the forward-looking pricer has no fold equity, so a sizing
 * critique from it would be noise dressed as advice. Asking for a size and
 * scoring it against a model that cannot value one would be exactly that.
 *
 * The verdict is the model lens alone. Hindsight is shown beside it, never as
 * the answer, for the reason the whole coach layer exists: a correct call that
 * got outdrawn is not a mistake, and a drill that marked it wrong would be
 * teaching the habit the split was built to break.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ActionType } from "../../types";
import type { DecisionEvLoss } from "../../poker/coach/evLoss";
import { analyzeHands } from "../../poker/coach/evLoss";
import { BOARD_CARDS_AT } from "../../poker/model/decider";
import type { TableHandReport } from "../../poker/table/contract";
import { money, pct } from "../../lib/format";
import {
  dueItems,
  loadQueue,
  nextDrill,
  queueSummary,
  recordAttempt,
  saveQueue,
  type DrillItem,
  type DrillQueue,
} from "../../lib/drillQueue";
import { loadArchive } from "../profile/store";
import { LEAK_COPY } from "../profile/Leaks";
import { PageBody, PageHeader } from "../shell";
import { Button, ButtonLink, CardRow, EmptyState, Group, RADIUS, Rail, Tag } from "../ui";

/**
 * The three classes a drill offers.
 *
 * Check and call are one button because they are one decision: whether to put
 * chips in to continue. Which of the two is legal is a property of the spot, not
 * a choice, and the label follows `toCall`.
 */
type Answer = "fold" | "passive" | "aggressive";

const CLASS_OF: Record<ActionType, Answer> = {
  fold: "fold",
  check: "passive",
  call: "passive",
  bet: "aggressive",
  raise: "aggressive",
};

/** The spot a queued item points at, recovered from the archive. */
interface Spot {
  item: DrillItem;
  report: TableHandReport;
  decision: DecisionEvLoss;
}

/**
 * Recover the spot, or null when it cannot be recovered honestly.
 *
 * The archive is capped at `MAX_STORED_HANDS`, so a queued item can outlive the
 * hand it points at. That is not an error and it is not repaired by guessing: an
 * item whose hand is gone is dropped from the queue by the caller, because the
 * alternative is asking about a spot nobody can be shown.
 */
function recoverSpot(item: DrillItem, reports: TableHandReport[]): Spot | null {
  const report = reports.find((r) => r.seed === item.seed);
  if (!report) return null;
  // Priced one hand at a time on purpose: the queue asks about one spot, and
  // analysing the whole archive to answer that would be a second of arithmetic
  // for a figure already narrowed to a single decision.
  const analysis = analyzeHands([report], item.seat);
  const decision = analysis.hands[0]?.decisions.find((d) => d.index === item.index);
  return decision ? { item, report, decision } : null;
}

function boardAt(report: TableHandReport, decision: DecisionEvLoss): number[] {
  const visible = Math.min(BOARD_CARDS_AT[decision.street], report.board.length);
  return report.board.slice(0, visible);
}

function holeOf(report: TableHandReport, seat: number): number[] {
  return report.seats.find((s) => s.seat === seat)?.hole ?? [];
}

/** Best line under the model lens, as a class. */
function correctAnswer(decision: DecisionEvLoss): Answer {
  return CLASS_OF[decision.modelBestAction];
}

/** The EV of the best line in each class the model priced. */
function evByClass(decision: DecisionEvLoss): Partial<Record<Answer, number>> {
  const out: Partial<Record<Answer, number>> = {};
  for (const alt of decision.alternatives) {
    const cls = CLASS_OF[alt.action];
    const current = out[cls];
    if (current === undefined || alt.modelEv > current) out[cls] = alt.modelEv;
  }
  return out;
}

const chips = (value: number): string => {
  const n = Math.round(Math.abs(value));
  return n === 0 ? "$0" : `${value < 0 ? "−" : "+"}${money(n)}`;
};

export default function DrillPage() {
  const [queue, setQueue] = useState<DrillQueue>(() => loadQueue());
  const [answered, setAnswered] = useState<Answer | null>(null);

  const reports = useMemo(() => loadArchive().hands, []);

  /*
   * The spot currently being asked, and the queue pruned of items whose hand has
   * fallen out of the archive. Both come from one pass: skipping an unrecoverable
   * item without dropping it would ask about it again forever.
   */
  const { spot, stale } = useMemo(() => {
    const stale: DrillItem[] = [];
    for (const candidate of dueItems(queue)) {
      const recovered = recoverSpot(candidate, reports);
      if (recovered) return { spot: recovered, stale };
      stale.push(candidate);
    }
    return { spot: null as Spot | null, stale };
  }, [queue, reports]);

  useEffect(() => {
    if (stale.length === 0) return;
    const keys = new Set(stale.map((i) => `${i.seed}:${i.index}`));
    setQueue((current) =>
      saveQueue({
        ...current,
        items: current.items.filter((i) => !keys.has(`${i.seed}:${i.index}`)),
      })
    );
  }, [stale]);

  const answer = useCallback(
    (choice: Answer) => {
      if (!spot || answered) return;
      setAnswered(choice);
      setQueue((current) =>
        saveQueue(recordAttempt(spot.item, choice === correctAnswer(spot.decision), current))
      );
    },
    [spot, answered]
  );

  const advance = useCallback(() => setAnswered(null), []);

  const summary = queueSummary(queue);
  const decision = spot?.decision;

  return (
    <main className="relative text-ivory" data-testid="drill" data-due={summary.due}>
      <PageBody width="narrow">
        <PageHeader
          title="Drill"
          lede="The spots that cost you, asked again without the answer in front of you."
          meta={
            <Rail>
              {summary.due} due · {summary.total} queued
            </Rail>
          }
        />

        {summary.total === 0 ? (
          <div className="mt-8">
            <EmptyState
              title="Nothing queued yet"
              action={
                <ButtonLink to="/profile" size="sm" testId="drill-to-profile">
                  Open your profile
                </ButtonLink>
              }
            >
              A drill is one of your own decisions, replayed from its deal seed.
              Play some hands and open your profile: every mistake it prices is
              queued here, costliest first.
            </EmptyState>
          </div>
        ) : !spot ? (
          <div className="mt-8">
            <EmptyState
              title="Nothing due"
              action={
                <ButtonLink to="/table" size="sm" testId="drill-to-table">
                  Play a hand
                </ButtonLink>
              }
            >
              All {summary.total} queued spots are waiting. An item comes back
              after other drills have passed rather than after a set time, so
              the way to bring one forward is to answer the others or to play.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-7 flex flex-col gap-5">
            {/* ------------------------- The spot ------------------------- */}
            <Group
              title={`${decision!.street[0].toUpperCase()}${decision!.street.slice(1)}, ${decision!.position}`}
              lede={`${decision!.opponentCount} opponent${
                decision!.opponentCount === 1 ? "" : "s"
              } in the pot. Hand #${decision!.handNumber}, dealt from ${spot.item.seed}.`}
            >
              <div className="flex flex-col gap-3">
                <CardRow
                  label="Board"
                  cards={boardAt(spot.report, decision!)}
                  empty="Pre-flop, no board yet"
                />
                <CardRow label="You hold" cards={holeOf(spot.report, decision!.seat)} />
                <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[0.72rem] text-ivory/55">
                  <span>pot {money(decision!.potBefore)}</span>
                  <span>
                    {decision!.toCall > 0
                      ? `to call ${money(decision!.toCall)}`
                      : "nothing to call"}
                  </span>
                  {decision!.requiredEquity !== null && (
                    <span>needs {pct(decision!.requiredEquity, 1)}</span>
                  )}
                </div>
              </div>
            </Group>

            {/* ------------------------ The question ---------------------- */}
            {!answered ? (
              <Group
                title="What is the best line?"
                lede="Scored on what was knowable at the time, not on how the hand finished."
              >
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => answer("fold")} data-testid="drill-fold">
                    Fold
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => answer("passive")}
                    data-testid="drill-passive"
                  >
                    {decision!.toCall > 0 ? `Call ${money(decision!.toCall)}` : "Check"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => answer("aggressive")}
                    data-testid="drill-aggressive"
                  >
                    {decision!.toCall > 0 ? "Raise" : "Bet"}
                  </Button>
                </div>
              </Group>
            ) : (
              <Verdict
                decision={decision!}
                seed={spot.item.seed}
                chose={answered}
                onNext={advance}
                hasNext={nextDrill(queue) !== null}
              />
            )}
          </div>
        )}
      </PageBody>
    </main>
  );
}

// ---------------------------------------------------------------------------

/**
 * Past tense per action, because English does not append "ed" to a verb ending
 * in one. "raiseed" was on screen before this existed.
 */
const ACTED: Record<ActionType, string> = {
  fold: "folded",
  check: "checked",
  call: "called",
  bet: "bet",
  raise: "raised",
};

const ANSWER_LABEL: Record<Answer, string> = {
  fold: "Folding",
  passive: "Checking or calling",
  aggressive: "Betting or raising",
};

function Verdict({
  decision,
  seed,
  chose,
  onNext,
  hasNext,
}: {
  decision: DecisionEvLoss;
  /** Replays are addressed by deal seed; hand numbers restart per table. */
  seed: number;
  chose: Answer;
  onNext: () => void;
  hasNext: boolean;
}) {
  const right = chose === correctAnswer(decision);
  const evs = evByClass(decision);
  const copy = decision.kind ? LEAK_COPY[decision.kind] : null;

  return (
    <Group
      title={right ? "That was the line" : "Not the line"}
      lede={
        right
          ? "The model priced your answer as the best available."
          : `${ANSWER_LABEL[correctAnswer(decision)]} priced better here.`
      }
    >
      <div className="flex flex-col gap-3">
        <div
          data-testid="drill-verdict"
          className={`border p-3.5 ${RADIUS.surface}`}
          style={{
            borderColor: right ? "rgba(201,162,39,0.4)" : "rgba(163,2,34,0.45)",
            background: right ? "rgba(201,162,39,0.07)" : "rgba(163,2,34,0.07)",
          }}
        >
          <table className="w-full text-left text-[0.78rem]">
            <thead>
              <tr className="text-[0.62rem] uppercase tracking-wider text-ivory/40">
                <th className="pb-1">Line</th>
                <th className="pb-1 text-right">Model EV</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {(["fold", "passive", "aggressive"] as Answer[]).map((cls) => {
                const ev = evs[cls];
                if (ev === undefined) return null;
                const isBest = cls === correctAnswer(decision);
                return (
                  <tr key={cls} className={isBest ? "text-gold-soft" : "text-ivory/70"}>
                    <td className="py-0.5">
                      {ANSWER_LABEL[cls]}
                      {cls === chose && " (you)"}
                      {isBest && " (best)"}
                    </td>
                    <td className="py-0.5 text-right">{chips(ev)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 font-mono text-[0.66rem] text-ivory/45">
            you actually {ACTED[decision.action]}, which cost{" "}
            {chips(decision.modelEvLoss)} against the best line. Equity{" "}
            {pct(decision.modelEquity, 1)} against the range the action implied.
          </p>
        </div>

        {/* What kind of mistake it was, and where the maths for it lives. */}
        {copy && (
          <div
            className={`border p-3.5 ${RADIUS.surface}`}
            style={{ borderColor: "rgba(244,237,228,0.12)" }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-display text-sm text-ivory">{copy.label}</p>
              <Tag tone="neutral">Pattern</Tag>
            </div>
            <p className="mt-1 text-[0.72rem] leading-relaxed text-ivory/55">{copy.why}</p>
            <Link
              to={`/learn?c=${copy.concept}`}
              className="mt-2 inline-block font-mono text-[0.66rem] text-gold-soft underline decoration-gold/30 underline-offset-2 transition-colors hover:text-gold"
            >
              Read the maths
            </Link>
          </div>
        )}

        {/*
         * Hindsight beside the verdict, never as it. A correct call that got
         * outdrawn shows a loss here and is not a mistake, which is the whole
         * reason the two lenses never share a column.
         */}
        <p className="font-mono text-[0.66rem] text-ivory/35">
          with the cards face up, {decision.hindsightBestAction} was best
          {decision.hindsightExact ? "" : " (runout sampled, not enumerated)"}.
          That is not the verdict: it is what only the cards knew.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button onClick={onNext} data-testid="drill-next" variant="primary" size="sm">
            {hasNext ? "Next spot" : "Done for now"}
          </Button>
          <ButtonLink to={`/replay/${seed}`} variant="quiet" size="sm">
            See the whole hand
          </ButtonLink>
        </div>
      </div>
    </Group>
  );
}
