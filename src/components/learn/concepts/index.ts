/**
 * The seven concepts, and the order they are taught in.
 *
 * One list, read by both things that need it: the selector at the top of
 * `/learn` and the panel underneath it. When the seven were stacked in a single
 * scroll there were two lists - a `CONTENTS` array of `#` anchors and the JSX
 * that rendered the sections - and nothing checked that they agreed. They
 * cannot disagree now, because the label a chip prints and the component it
 * mounts are the same row.
 *
 * `id` is part of the URL (`/learn?c=bayes`), so these strings are permanent:
 * they are what the old in-page anchors were called, so a link somebody wrote
 * against `#bayes` still names the right thing.
 */

import type { ComponentType } from "react";
import { BayesConcept } from "./Bayes";
import { BucketsConcept } from "./HandClasses";
import { EquilibriumConcept } from "./Equilibrium";
import { EvConcept } from "./Ev";
import { MonteCarloConcept } from "./MonteCarlo";
import { MultiwayConcept } from "./Multiway";
import { RangesConcept } from "./Ranges";

export type ConceptId =
  | "monte-carlo"
  | "bayes"
  | "ev"
  | "ranges"
  | "classes"
  | "multiway"
  | "equilibrium";

export interface Concept {
  id: ConceptId;
  /** What the chip says. Short enough to survive a 390px scroll row. */
  label: string;
  /** The concept, which renders its own heading, lede and demos. */
  Panel: ComponentType;
}

export const CONCEPTS: readonly Concept[] = [
  { id: "monte-carlo", label: "Monte Carlo", Panel: MonteCarloConcept },
  { id: "bayes", label: "Bayesian updating", Panel: BayesConcept },
  { id: "ev", label: "EV, pot odds, fold equity", Panel: EvConcept },
  { id: "ranges", label: "Ranges and blockers", Panel: RangesConcept },
  { id: "classes", label: "Hand classes", Panel: BucketsConcept },
  { id: "multiway", label: "Multiway", Panel: MultiwayConcept },
  { id: "equilibrium", label: "Equilibrium", Panel: EquilibriumConcept },
];
