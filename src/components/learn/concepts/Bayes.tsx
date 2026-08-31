/**
 * Concept 2: Bayesian updating.
 *
 * The likelihood model is built in a `useMemo` with an empty dependency list,
 * so selecting this concept generates the prior once and the four pickers below
 * only read from it. Building it per render would regenerate 540 cells on every
 * click of "Street", which is exactly the kind of cost that hides when seven
 * concepts are mounted at once and nobody can attribute the jank.
 */

import { useMemo, useState } from "react";
import { pct } from "../../../lib/format";
import { ACTION_LIKELIHOODS, INITIAL_BELIEF } from "../../../data/constants";
import { updateBelief } from "../../../poker/bayesian";
import {
  BUCKET_COUNT,
  BUCKET_NAMES,
  HandBucket,
} from "../../../poker/model/buckets";
import {
  ACTIONS,
  FACINGS,
  POSITIONS,
  STREETS,
  createLikelihoodModel,
  likelihoodRow,
  type Facing,
  type LearnStreet,
} from "../../../poker/model/likelihood";
import type { PositionName } from "../../../poker/table/position";
import type { PlayerActionType } from "../../../types";
import {
  Calc,
  Frac,
  Group,
  Heading,
  HowCalculated,
  LINE,
  Lead,
  Meter,
  Scroller,
  Why,
} from "../../ui";
import { Choice } from "../controls";

const TIER_KEYS = ["weak", "medium", "strong"] as const;

export function BayesConcept() {
  const [action, setAction] = useState<PlayerActionType>("raise");
  const [street, setStreet] = useState<LearnStreet>("river");
  const [facing, setFacing] = useState<Facing>("facing-bet");
  const [position, setPosition] = useState<PositionName>("BTN");

  const prior = INITIAL_BELIEF;
  const like = ACTION_LIKELIHOODS[action];
  const posterior = updateBelief(prior, action);
  const numerators = {
    weak: like.weak * prior.weak,
    medium: like.medium * prior.medium,
    strong: like.strong * prior.strong,
  };
  const z = numerators.weak + numerators.medium + numerators.strong;

  // The conditioned model, at its data-free prior: what the engine believes
  // about an action before it has met anybody.
  const model = useMemo(() => createLikelihoodModel("poker"), []);
  const rows = useMemo(
    () =>
      Array.from({ length: BUCKET_COUNT }, (_, bucket) =>
        likelihoodRow(model, { bucket, street, position, facing })
      ),
    [model, street, position, facing]
  );
  const spread = rows.map((r) => r[action]);
  const cells = BUCKET_COUNT * STREETS.length * POSITIONS.length * FACINGS.length;

  return (
    <Group
      id="bayes"
      title="Bayesian updating"
      lede="Nobody can see the cards, so the table keeps a probability over them and revises it."
    >
      <Lead>
        A read is not a guess about what somebody has. It is a distribution over
        what they could have, and every public action multiplies it by how likely
        that action would be from each holding. That is Bayes' rule, and it is the
        whole of what the table knows about anyone.
      </Lead>

      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(H | A) =
          <Frac n={<>P(A | H) · P(H)</>} d={<>Σ&#8202;ᵢ P(A | Hᵢ) · P(Hᵢ)</>} />
        </div>
        <div className="mt-2 text-ivory/60">
          H is the hidden strength, A is the action you just watched. The
          denominator is only there to make the answer sum to one.
        </div>
      </Calc>

      <div className="mb-4">
        <Choice
          label="They..."
          value={action}
          onChange={setAction}
          options={ACTIONS.map((a) => ({ value: a, label: a }))}
          testId="bayes-action"
        />
      </div>

      <Scroller>
        <table className="w-full text-sm" data-testid="bayes-table">
          <thead>
            <tr className="text-left text-[0.6rem] uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-3">Tier</th>
              <th className="py-2 pr-3 text-right">Prior</th>
              <th className="py-2 pr-3 text-right">P({action} | tier)</th>
              <th className="py-2 pr-3 text-right">Product</th>
              <th className="py-2 pr-3 text-right">Posterior</th>
            </tr>
          </thead>
          <tbody>
            {TIER_KEYS.map((t) => (
              <tr key={t} className="border-t" style={{ borderColor: LINE.quietFaint }}>
                <td className="py-2 pr-3 capitalize text-ivory/80">{t}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  {prior[t].toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/70">
                  {like[t].toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                  {numerators[t].toFixed(4)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-gold-soft">
                  {pct(posterior[t], 1)}
                </td>
              </tr>
            ))}
            <tr className="border-t" style={{ borderColor: LINE.quiet }}>
              <td className="py-2 pr-3 text-ivory/50">Σ</td>
              <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                1.00
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                {z.toFixed(4)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs text-ivory/50">
                100%
              </td>
            </tr>
          </tbody>
        </table>
      </Scroller>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        The posterior column is the product column divided by its own sum. An
        action nobody plays differently with different hands leaves the read
        exactly where it was, which is why a check on a wet board says almost
        nothing and a river raise says a great deal.
      </p>

      <Heading>The same action at a different node</Heading>
      <Lead>
        Three tiers and one table is a summary. The model the engine actually
        prices with conditions on four things at once: the hand class, the
        street, the position and what the actor is facing. "Raise"
        unopened is a bet, "raise" facing a bet is a raise, and "raise" facing a
        raise is a three-bet, and the three carry wildly different implications.
        Folding is only <em>legal</em> in the last two, so pooling them corrupts
        the fold rate as well.
      </Lead>

      <div className="mb-3 flex flex-wrap gap-4">
        <Choice
          testId="street-choice"
          label="Street"
          value={street}
          onChange={setStreet}
          options={STREETS.map((s) => ({ value: s, label: s }))}
        />
        <Choice
          testId="facing-choice"
          label="Facing"
          value={facing}
          onChange={setFacing}
          options={FACINGS.map((f) => ({ value: f, label: f.replace("-", " ") }))}
        />
        <Choice
          testId="position-choice"
          label="Position"
          value={position}
          onChange={setPosition}
          options={POSITIONS.map((p) => ({ value: p, label: p }))}
        />
      </div>

      <div className="space-y-1.5" data-testid="conditioned-rows">
        {rows.map((row, bucket) => (
          <Meter
            key={bucket}
            label={
              <span className="text-ivory/70">
                {BUCKET_NAMES[bucket as HandBucket]}
              </span>
            }
            value={row[action] / Math.max(...spread)}
            text={pct(row[action], 1)}
            color={bucket >= 6 ? "#7fd3a8" : bucket >= 3 ? "#e2c563" : "rgba(244,237,228,0.35)"}
          />
        ))}
      </div>
      <p className="mt-2 text-[0.7rem] leading-relaxed text-ivory/45">
        P({action}) at this node, by hand class: spread from{" "}
        {pct(Math.min(...spread), 1)} to {pct(Math.max(...spread), 1)}, a factor
        of {(Math.max(...spread) / Math.max(1e-9, Math.min(...spread))).toFixed(1)}.
        Change the street or what they are facing and the whole shape moves. This
        is the row that reweights a range; the three-tier table above only moves
        the coarse read.
      </p>

      <HowCalculated label="What Conditioning Costs, And How It Is Paid For">
        <Heading>The sparsity</Heading>
        <Lead>
          {BUCKET_COUNT} hand classes × {STREETS.length} streets ×{" "}
          {POSITIONS.length} positions × {FACINGS.length} facings is{" "}
          {cells.toLocaleString()} cells, and a couple of hundred hands produce a
          few hundred decisions. Most cells are empty forever. A model that
          answered from the cell alone would either have no answer or a confident
          one built on three observations.
        </Lead>
        <Heading>The backoff</Heading>
        <Lead>
          So six nested estimates are kept, ordered by how fast each fills with
          data: everything, then (street, facing), then the class, then class and
          street, then class, street and facing, then all four. A lookup starts at
          the prior and walks coarse to fine, each level shrinking toward the
          previous one's answer with a Dirichlet prior. A level with no evidence is
          exactly the identity, so an empty cell inherits its parent's estimate
          rather than snapping back to the prior. That property is what decides
          whether a model is useful after fifty hands or only after five thousand.
        </Lead>
        <Heading>Where the numbers above come from</Heading>
        <Lead>
          Nothing has been observed here, so every row is the generated prior: the
          model's opinion about poker in general before it has met anybody. The
          review's Math tab shows the same walk with a real session's counts in
          it, level by level.
        </Lead>
        <Why>
          The prior is generated from six constants rather than hand-typed,
          because nobody can keep 540 hand-written probabilities self-consistent,
          and one of those constants exists purely to stop the prior folding more
          than the minimum defence frequency allows.
        </Why>
      </HowCalculated>
    </Group>
  );
}
