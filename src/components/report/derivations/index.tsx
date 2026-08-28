/**
 * The derivations, addressable one at a time.
 *
 * These were one 2,550-line `MathTab`, a single scroll 13,085px tall sitting in
 * the tab bar as though it were a peer of a three-screen tab. The content was
 * never the problem — a reader who wants to know why the interval is Wilson's
 * rather than `p̂ ± 1.96·SE` is exactly the reader this product is for. The
 * problem was that the question and its answer were four clicks and fifteen
 * screens apart.
 *
 * So each derivation is now a component that renders *next to the number it
 * explains*, inside a `HowCalculated` disclosure, on whichever tab already
 * shows that number. Nothing is deleted; everything moves to where the question
 * occurs.
 *
 * ## The contract
 *
 * Every export takes the same props and renders the body of a disclosure — no
 * heading, no `Section` wrapper, no outer surface. The caller owns the label
 * and the disclosure chrome, because the caller knows what question the reader
 * just asked. A derivation that cannot be built from the record must render its
 * own `EmptyPanel` saying which record is missing, never `null` and never a
 * fabricated number: a hand restored from storage has no decision trail, and
 * silence there reads as "there was nothing to compute", which is false.
 */

import type { TableHandReport } from "../../../poker/table/contract";

export interface DerivationProps {
  report: TableHandReport;
  /** The seat the review is written from. */
  focus: number;
  seatName: (seat: number) => string;
}

export { MonteCarloPrecision } from "./MonteCarloPrecision";
export { MadeHandDistribution } from "./MadeHandDistribution";
export { EquityLadder } from "./EquityLadder";
export { MultiwayCompounding } from "./MultiwayCompounding";
export { BayesWorked } from "./BayesWorked";
export { WhatTheTableLearned } from "./WhatTheTableLearned";
export { HandClasses } from "./HandClasses";
export { ExpectedValue } from "./ExpectedValue";
export { FoldEquityAlphaMdf } from "./FoldEquityAlphaMdf";
export { RiverEquilibrium } from "./RiverEquilibrium";
