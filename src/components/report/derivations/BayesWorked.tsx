/**
 * One public action, one posterior, with this hand's own numbers in it.
 *
 * Lifted out of `MathTab`'s "Bayes, Worked" section unchanged. It belongs
 * beside the range charts, because the charts are the posterior: the reader
 * looking at a 13×13 grid that just changed shape is the reader asking what
 * changed it.
 *
 * The likelihoods come from `appliedLikelihood` rather than from the constants
 * module: the worked example has to be a readout of what the engine did to this
 * hand, not a second opinion about it.
 */

import { pct } from "../../../lib/format";
import { INITIAL_BELIEF } from "../../../data/constants";
import { updateBelief } from "../../../poker/bayesian";
import { BUCKET_COUNT } from "../../../poker/model/buckets";
import type { PlayerActionType } from "../../../types";
import { Calc, EmptyPanel, Frac, Heading, Lead, Why } from "../../ui";
import {
  appliedLikelihood,
  bucketName,
  readsAfter,
  type AppliedLikelihood,
} from "../derive";
import type { DerivationProps } from "./index";
import { Caption, num } from "./shared";

export function BayesWorked({ report, seatName }: DerivationProps) {
  // First action that actually moved a read, the Bayes example.
  const moveIndex = report.actions.findIndex((a) => a.action !== "fold");
  const applied = moveIndex >= 0 ? appliedLikelihood(report, moveIndex) : null;
  const bayes =
    moveIndex >= 0 && applied
      ? {
          record: report.actions[moveIndex],
          applied,
          prior: readsAfter(report.actions, moveIndex, report.seatCount)[
            report.actions[moveIndex].seat
          ],
        }
      : null;

  return (
    <>
      <Caption>One action, one posterior</Caption>
      {!bayes ? (
        <EmptyPanel title="No action moved a read">
          Every seat folded, so nothing updated. Beliefs stayed at the prior.
        </EmptyPanel>
      ) : (
        <BayesUpdate
          action={bayes.record.action as PlayerActionType}
          street={bayes.record.street}
          seat={bayes.record.seat}
          prior={bayes.prior}
          applied={bayes.applied}
          seatName={seatName}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function BayesUpdate({
  action,
  street,
  seat,
  prior,
  applied,
  seatName,
}: {
  action: PlayerActionType;
  street: string;
  seat: number;
  prior: { weak: number; medium: number; strong: number };
  applied: AppliedLikelihood;
  seatName: (seat: number) => string;
}) {
  const like = applied.tier;
  const nw = like.weak * prior.weak;
  const nm = like.medium * prior.medium;
  const ns = like.strong * prior.strong;
  const z = nw + nm + ns;
  const posterior = updateBelief(prior, action);
  const label = action.charAt(0).toUpperCase() + action.slice(1);

  return (
    <>
      <Heading>The question</Heading>
      <Lead>
        Nobody can see a seat's cards, so the table keeps a probability
        distribution over how strong the hand is — weak, medium or strong — and
        revises it after every public action. Priors start at the model's opening
        read:
      </Lead>
      <Calc>
        P(weak) = {num(INITIAL_BELIEF.weak, 2)} &nbsp; P(medium) ={" "}
        {num(INITIAL_BELIEF.medium, 2)} &nbsp; P(strong) ={" "}
        {num(INITIAL_BELIEF.strong, 2)}
      </Calc>

      <Heading>Bayes' rule</Heading>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(H | A) =
          <Frac n={<>P(A | H) · P(H)</>} d={<>Σ&#8202;ᵢ P(A | Hᵢ) · P(Hᵢ)</>} />
        </div>
        <p className="mt-2 text-ivory/60">
          H = the hidden strength tier, A = the action just observed.
        </p>
      </Calc>

      <Heading>
        This hand — {seatName(seat)} on the {String(street).toLowerCase()}
      </Heading>
      <Lead>
        {seatName(seat)} chose to{" "}
        <strong className="uppercase text-gold-soft">{label}</strong>. These are
        the three numbers this update was multiplied by — the flat table, one row
        per action, the same on every street and in every seat:
      </Lead>
      <Calc>
        P({label} | weak) = {num(like.weak, 2)}
        <br />
        P({label} | medium) = {num(like.medium, 2)}
        <br />
        P({label} | strong) = {num(like.strong, 2)}
      </Calc>

      <Heading>Posterior</Heading>
      <Calc>
        <div>Numerators = likelihood × prior:</div>
        <div className="mt-1">
          weak: &nbsp;{num(like.weak, 2)} × {num(prior.weak, 3)} = {num(nw, 4)}
        </div>
        <div>
          medium: {num(like.medium, 2)} × {num(prior.medium, 3)} = {num(nm, 4)}
        </div>
        <div>
          strong: {num(like.strong, 2)} × {num(prior.strong, 3)} = {num(ns, 4)}
        </div>
        <div className="mt-2">
          Normaliser Σ = {num(nw, 4)} + {num(nm, 4)} + {num(ns, 4)} = {num(z, 4)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          P(strong | {label}) =
          <Frac n={<>{num(ns, 4)}</>} d={<>{num(z, 4)}</>} />=
          <span className="text-gold-soft">{pct(posterior.strong)}</span>
        </div>
      </Calc>

      <div
        className="grid grid-cols-2 gap-3 rounded-lg border p-3"
        style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.25)" }}
      >
        <div>
          <p className="text-[0.6rem] uppercase tracking-wider text-ivory/45">Prior</p>
          <p className="mt-1 font-mono text-[0.68rem] text-ivory/80">
            weak {pct(prior.weak)} · med {pct(prior.medium)} · strong{" "}
            {pct(prior.strong)}
          </p>
        </div>
        <div>
          <p className="text-[0.6rem] uppercase tracking-wider text-gold-soft/80">
            Posterior
          </p>
          <p className="mt-1 font-mono text-[0.68rem] text-gold-soft">
            weak {pct(posterior.weak)} · med {pct(posterior.medium)} · strong{" "}
            {pct(posterior.strong)}
          </p>
        </div>
      </div>

      <Heading>The likelihoods the ranges were actually built from</Heading>
      <Lead>
        The three numbers above move the coarse read, and that is all they do.
        The distribution the sampler drew this seat's hands from was reweighted
        by a different row: the same action conditioned on the{" "}
        <em>class of hand on this board</em>, plus the street, the position and
        what the seat was facing. Same action, same hand, nine answers —{" "}
        {applied.street}, {applied.position}, {applied.facing.replace("-", " ")}:
      </Lead>
      <Calc>
        {Array.from({ length: BUCKET_COUNT }, (_, b) => b).map((b) => (
          <div key={b}>
            P({label} | {bucketName(b)}) = {num(applied.byBucket[b], 3)}
          </div>
        ))}
        <div className="mt-2 text-ivory/60">
          spread from {num(Math.min(...applied.byBucket), 3)} to{" "}
          {num(Math.max(...applied.byBucket), 3)} — a factor of{" "}
          {num(
            Math.max(...applied.byBucket) / Math.max(1e-9, Math.min(...applied.byBucket)),
            2
          )}{" "}
          between the class this action is least likely from and the class it is
          most likely from.
        </div>
      </Calc>
      <Lead>
        The report records no likelihoods, so both rows above are recomputed
        rather than read back — but neither is a guess. The three-tier table is a
        constant, the conditioned model is a fixed prior with no player data in
        it, and the node (street, position, facing) is fully determined by the
        action record. Re-running the lookup returns what ran at the table.
      </Lead>
      <Why>
        Two models over one action, and only one of them prices anything. The
        three tiers are a summary a human can hold in their head; the nine
        classes are what the 13×13 charts on the Ranges tab are made of.
      </Why>
    </>
  );
}
