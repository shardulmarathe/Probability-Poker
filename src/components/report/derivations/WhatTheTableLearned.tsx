/**
 * What the same machinery says once it has watched somebody play.
 *
 * Lifted out of `MathTab`'s "What This Table Would Learn" section unchanged. It
 * belongs beside the range charts: every chart on that tab is drawn from a
 * fixed prior, and this is the panel that says what a learned model would put
 * there instead, and how far off the prior this session's play has moved it.
 */

import { useMemo } from "react";
import { pct } from "../../../lib/format";
import {
  LEARNING_PRIOR_ALPHA,
  LEARNING_PRIOR_DENOM,
} from "../../../data/constants";
import {
  classifyHole,
  makeBoardContext,
  tierFromBucket,
  type HandBucket,
} from "../../../poker/model/buckets";
import {
  ACTIONS,
  FACINGS,
  POOLED_STRENGTH,
  POSITIONS,
  PRIOR_STRENGTH,
  STREETS,
  collapsedLikelihoods,
  explainLikelihood,
} from "../../../poker/model/likelihood";
import type { TableHandReport } from "../../../poker/table/contract";
import type { Street } from "../../../types";
import { useTable } from "../../../store/TableContext";
import { learnSeat, type SessionModel } from "../../learn/engine";
import { loadArchive, mergeHands } from "../../profile/store";
import {
  Calc,
  Frac,
  Heading,
  HowCalculated,
  LINE,
  Lead,
  Note,
  Scroller,
  Stat,
  StatGrid,
  Tag,
} from "../../ui";
import { STREET_LABEL, appliedLikelihood, bucketName } from "../derive";
import type { DerivationProps } from "./index";
import { Caption, num, subject } from "./shared";

export function WhatTheTableLearned({ report, focus, seatName }: DerivationProps) {
  // The whole archive, not just this hand: a likelihood model estimated from one
  // hand's four decisions would be a demonstration of the formula rather than a
  // read on anybody. Assembled exactly the way `HandReview` assembles its own
  // list, stored hands, then the live ones on top, so the panel counts the
  // same hands the picker at the top of the page offers, and survives a reload.
  //
  // Restricted to tables of this size, because a seat index is all the record
  // identifies a player by: chair 2 at a six-max table and chair 2 heads-up are
  // not the same opponent, and pooling them would build a read on nobody.
  const { history, lastReport } = useTable();
  const hands = useMemo(() => {
    const live =
      lastReport && !history.some((r) => r.seed === lastReport.seed)
        ? [...history, lastReport]
        : history;
    return mergeHands(loadArchive().hands, live).filter(
      (r) => r.seatCount === report.seatCount
    );
  }, [history, lastReport, report.seatCount]);

  return (
    <>
      <Caption>
        {hands.length} archived hand{hands.length === 1 ? "" : "s"} at this table
        size · seat {focus + 1}
      </Caption>
      <LearnedModel
        hands={hands}
        report={report}
        focus={focus}
        seatName={seatName}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

const TIER_KEYS: ("weak" | "medium" | "strong")[] = ["weak", "medium", "strong"];

function LearnedModel({
  hands,
  report,
  focus,
  seatName,
}: {
  hands: TableHandReport[];
  report: TableHandReport;
  focus: number;
  seatName: (seat: number) => string;
}) {
  const session: SessionModel = useMemo(
    () => learnSeat(hands, focus),
    [hands, focus]
  );
  const who = subject(seatName(focus));

  // The node to quote the model at: this seat's last decision in this hand, so
  // the table below is the row that would have priced the move the review is
  // already looking at.
  const index = useMemo(() => {
    for (let i = report.actions.length - 1; i >= 0; i--) {
      if (report.actions[i].seat === focus) return i;
    }
    return -1;
  }, [report, focus]);
  const node = index >= 0 ? appliedLikelihood(report, index) : null;

  const seat = report.seats.find((s) => s.seat === focus);
  const bucket: HandBucket | null =
    node && seat && seat.hole.length === 2
      ? classifyHole(
          seat.hole[0],
          seat.hole[1],
          makeBoardContext(
            report.board.slice(
              0,
              Math.min(
                node.street === "preflop" ? 0 : node.street === "flop" ? 3 : node.street === "turn" ? 4 : 5,
                report.board.length
              )
            )
          )
        )
      : null;

  const learned = node
    ? collapsedLikelihoods(session.model, node.street, node.position, node.facing)
    : null;
  const untouched = node
    ? collapsedLikelihoods(session.fresh, node.street, node.position, node.facing)
    : null;

  const walk =
    node && bucket !== null
      ? explainLikelihood(session.model, node.action, {
          bucket,
          street: node.street,
          position: node.position,
          facing: node.facing,
        })
      : null;

  return (
    <>
      <Lead>
        Every likelihood elsewhere in this review came from a fixed prior, a model of
        poker in general, not of the seat sitting in that chair. This panel is the
        other half: what the same machinery says once it has watched somebody
        play. Each decision {who} took is one observation, filed by the hand class
        it was taken with, the street, the position and what it was facing.
      </Lead>

      <StatGrid columns={4}>
        <Stat label="Hands with a decision" value={session.hands} />
        <Stat label="Decisions recorded" value={session.observations} tone="gold" />
        <Stat
          label="Revealed at showdown"
          value={session.attributed}
          note="carry a hand class"
        />
        <Stat
          label="Mucked"
          value={session.unattributed}
          note="action only, no class"
        />
      </StatGrid>

      {session.attributed > 0 && (
        <>
          <Heading>The hands {who} showed down</Heading>
          <Scroller>
            <table className="w-full text-sm" data-testid="observed-classes">
              <thead>
                <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
                  <th className="py-2 pr-3">Class held</th>
                  <th className="py-2 pr-3 text-right">Decisions seen</th>
                  <th className="py-2 pr-3 text-right">Share of the revealed</th>
                  <th className="py-2 pr-3">Legacy tier</th>
                </tr>
              </thead>
              <tbody>
                {session.byBucket.map((count, b) =>
                  count === 0 ? null : (
                    <tr
                      key={b}
                      className="border-t"
                      style={{ borderColor: LINE.quietFaint }}
                    >
                      <td className="py-2 pr-3 text-ivory/80">{bucketName(b)}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                        {count}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/60">
                        {pct(count / session.attributed, 1)}
                      </td>
                      <td className="py-2 pr-3 text-xs capitalize text-ivory/45">
                        {tierFromBucket(b as HandBucket)}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </Scroller>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            One row per decision, not per hand, each decision was taken at its
            own node with its own class, so a hand that was air on the flop and a
            monster on the river contributes to both rows. These are the counts
            that make P(action | class) estimable at all; the {session.unattributed}{" "}
            decisions from hands that never got shown are not in this table and
            cannot be.
          </p>
        </>
      )}

      {session.observations === 0 ? (
        <Note label="Nothing observed yet">
          This seat has not taken a decision in the archive this review can see.
          Play a hand out and the counts below start moving.
        </Note>
      ) : (
        <p className="mt-3 text-[0.7rem] leading-relaxed text-ivory/45">
          Counted over every stored hand dealt to a table of this size, because
          the seat index is the only thing the record identifies a player by.
          Across a session at one table that is exactly the player in that chair;
          across two different tables it is two different people, which is why
          hands from other table sizes are left out rather than pooled in.
        </p>
      )}

      {learned && untouched && node && (
        <>
          <Heading>
            P(action | tier) at this seat's last node,{" "}
            {STREET_LABEL[node.street as Street] ?? node.street}, {node.position},{" "}
            {node.facing.replace("-", " ")}
          </Heading>
          <Lead>
            The old model had one such table for the whole game. This one is a
            table per node, which is why the numbers below are not the numbers
            anywhere else in the hand: the same raise unopened on the button and
            facing a three-bet in the big blind are different events, and a model
            that averages them cannot say anything a player did not already know.
          </Lead>
          <Scroller>
            <table className="w-full text-sm" data-testid="learned-table">
              <thead>
                <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
                  <th className="py-2 pr-3">P(action | ·)</th>
                  {TIER_KEYS.map((t) => (
                    <th key={t} className="py-2 pr-3 text-right capitalize">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ACTIONS.map((action) => (
                  <tr
                    key={action}
                    className="border-t"
                    style={{ borderColor: LINE.quietFaint }}
                  >
                    <td className="py-2 pr-3 capitalize text-ivory/80">
                      {action}
                      {action === node.action && (
                        <span className="ml-2">
                          <Tag tone="gold">taken</Tag>
                        </span>
                      )}
                    </td>
                    {TIER_KEYS.map((t) => {
                      const now = learned[action][t];
                      const before = untouched[action][t];
                      const moved = Math.abs(now - before) > 0.0005;
                      return (
                        <td key={t} className="py-2 pr-3 text-right font-mono text-xs">
                          <span className={moved ? "text-gold-soft" : "text-ivory/75"}>
                            {pct(now, 1)}
                          </span>
                          {moved && (
                            <span className="ml-1 text-ivory/35">
                              from {pct(before, 1)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            Gold means this session's play has moved the estimate off the prior;
            the grey figure beside it is where the prior had it. Each column is
            the average over the buckets in that tier, three of the nine rungs
            each, uniformly, because weighting them would need a range this module
            deliberately does not depend on.
          </p>
        </>
      )}

      <Heading>The update, in one line</Heading>
      <Lead>
        Raw frequencies swing wildly on small samples, one raise out of one hand
        is not a 100% raiser, so every probability is a posterior mean with a
        Dirichlet prior behind it.{" "}
        <span className="font-mono">model/likelihood.ts</span> writes it as:
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(action) =
          <Frac
            n={<>count + δ · priorMean</>}
            d={<>total + δ</>}
          />
        </div>
        <div className="mt-3 text-ivory/60">
          with δ = {PRIOR_STRENGTH} pseudo-decisions of prior weight. Substituting
          the flat prior mean α/δ = {LEARNING_PRIOR_ALPHA}/{LEARNING_PRIOR_DENOM}{" "}
          = {num(LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM, 2)} gives back the
          original form exactly:
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          P(action | tier) =
          <Frac
            n={<>handsWithAction + {LEARNING_PRIOR_ALPHA}</>}
            d={<>handsObserved + {LEARNING_PRIOR_DENOM}</>}
          />
        </div>
        <div className="mt-2 text-ivory/60">
          No data returns the prior mean; total → ∞ returns the empirical
          frequency. The only generalisation is that the prior mean is now
          supplied by a coarser estimate instead of being pinned at{" "}
          {num(LEARNING_PRIOR_ALPHA / LEARNING_PRIOR_DENOM, 2)}, which is what
          turns one Beta update into a hierarchy.
        </div>
      </Calc>

      {walk && node && bucket !== null && (
        <>
          <Heading>
            The hierarchy, walked: P({node.action} | {bucketName(bucket)}) here
          </Heading>
          <Lead>
            Nine hand classes × {STREETS.length} streets × {POSITIONS.length}{" "}
            positions × {FACINGS.length} facings is{" "}
            {session.cellSpace.toLocaleString()} cells, and a session produces a
            few hundred decisions. Most cells are empty forever, so the lookup
            starts at the prior and walks coarse to fine, each level using only
            the evidence the finer ones did not see. A level with no data is the
            identity, it hands its parent's estimate straight through, which is
            what decides whether the model is useful after fifty hands or only
            after five thousand.
          </Lead>
          <Scroller>
            <table className="w-full text-sm" data-testid="backoff-table">
              <thead>
                <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
                  <th className="py-2 pr-3">Level</th>
                  <th className="py-2 pr-3">Cell</th>
                  <th className="py-2 pr-3 text-right">Own evidence</th>
                  <th className="py-2 pr-3 text-right">Took it</th>
                  <th className="py-2 pr-3 text-right">Estimate</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t" style={{ borderColor: LINE.quietFaint }}>
                  <td className="py-2 pr-3 text-ivory/80">prior</td>
                  <td className="py-2 pr-3 font-mono text-[0.65rem] text-ivory/40">
                    generated, no data
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/40">-</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/40">-</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/75">
                    {pct(walk.prior, 1)}
                  </td>
                </tr>
                {walk.steps.map((step) => (
                  <tr
                    key={step.key}
                    className="border-t"
                    style={{ borderColor: LINE.quietFaint }}
                  >
                    <td className="py-2 pr-3 text-ivory/80">{step.level}</td>
                    <td className="py-2 pr-3 font-mono text-[0.65rem] text-ivory/40">
                      {step.key}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                      {step.observations}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                      {step.matching}
                    </td>
                    <td
                      className="py-2 pr-3 text-right font-mono text-xs"
                      style={{
                        color: step.observations > 0 ? "#e2c563" : "rgba(244,237,228,0.5)",
                      }}
                    >
                      {pct(step.estimate, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
            "Own evidence" is exclusive: every decision is counted once, at the
            finest level that saw it, by inclusion and exclusion over the six
            cells. Summing that column returns the total number of decisions
            recorded. The two coarsest levels pool over hand classes, so their
            evidence is discounted, prior strength {POOLED_STRENGTH} against{" "}
            {PRIOR_STRENGTH}, i.e. {POOLED_STRENGTH / PRIOR_STRENGTH} pooled
            observations move a bucket about as far as one attributed observation
            does.
          </p>
        </>
      )}

      <Heading>What a fold teaches, and what it does not</Heading>
      <Lead>
        {session.unattributed === 0 ? "None" : session.unattributed} of this
        seat's {session.observations} decisions came from hands that were never
        shown. Those write to the two bucket-free
        levels and stop: how often this player takes this action at this node is
        fully observable, and P(action | hand class) is not, because the cards
        went in the muck. Assigning them a class would launder a guess into a
        number presented as a fact about somebody's play.
      </Lead>
      <Lead>
        That is not a consolation prize. The bucket-free levels are the shrinkage
        target for the bucket-conditioned ones, so unattributed data moves every
        class's estimate <em>together</em>, which compresses the likelihood ratio
        between classes. Learning that a player raises constantly, without ever
        seeing what they raise with, should make a raise mean <em>less</em>, not
        make it mean "strong". That is where a bluffer discount comes from, and it
        works before the first showdown.
      </Lead>

      <Note label="Where this model is, and is not, used">
        The live table does not learn. <span className="font-mono">model/decider.ts</span>{" "}
        prices every hand
        against a fresh prior model that is never written to, and nothing in the
        app calls the accumulator, so the numbers above are what this session's
        own play <em>would</em> teach, rebuilt from the archive after the fact,
        not a read any bot acted on. The machinery is real and tested; the wiring
        from the table into it is the piece that does not exist yet.
      </Note>

      <HowCalculated label="Why Conditioning Needed A Backoff">
        <Heading>The sparsity the axes create</Heading>
        <Lead>
          Conditioning is free to write down and expensive to estimate. Splitting
          one table into {session.cellSpace.toLocaleString()} means each cell sees
          a few hundredths of the data, and a cell with three observations in it
          produces a confident-looking number that is mostly noise. The backoff is
          not a refinement of the conditioning. It is the thing that makes
          conditioning affordable at all.
        </Lead>
        <Heading>Why position is dropped first</Heading>
        <Lead>
          The six levels are ordered by how fast each fills with data. Position
          goes first because it is the weakest signal per unit of sparsity: six
          values, and most of what position does is already visible through what
          the seat is facing. The hand class is introduced late and never dropped
          from the four finest levels, because it is the axis being estimated.
        </Lead>
        <Heading>The honest caveat</Heading>
        <Lead>
          Attributed data is selection-biased. Hands survive to showdown
          disproportionately when they were strong enough to keep calling, so
          P(action | class) estimated from showdowns over-represents hands that
          wanted to see the river. The bucket-free levels are not biased that way,
          which is a second reason to keep them in the chain.
        </Lead>
      </HowCalculated>
    </>
  );
}
