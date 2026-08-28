/**
 * Cards, from the integer codes the table report stores them as.
 */

import { decodeCard } from "../../poker/core/card";
import { PlayingCard } from "../PlayingCard";

export function CardRow({
  label,
  cards,
  size = "sm",
  empty = "No cards",
}: {
  label?: string;
  cards: number[];
  size?: "xs" | "sm" | "md" | "lg";
  /** What to say when there are none. Name the reason, not the absence. */
  empty?: string;
}) {
  return (
    <div className="min-w-0">
      {label && (
        <p className="mb-1.5 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ivory/50">
          {label}
        </p>
      )}
      <div className="flex flex-wrap gap-1 sm:gap-1.5">
        {cards.length === 0 && <span className="text-sm text-ivory/40">{empty}</span>}
        {cards.map((code, i) => (
          <PlayingCard key={`${code}-${i}`} card={decodeCard(code)} size={size} />
        ))}
      </div>
    </div>
  );
}

/** Card codes as text, for use inside prose. */
export function cardText(codes: number[]): string {
  return codes.map((c) => decodeCard(c).id).join(" ") || "—";
}
