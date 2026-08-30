import { memo } from "react";
import { SUIT_IS_RED, SUIT_SYMBOL, rankChar } from "../poker/cards";
import type { Card } from "../types";

type Size = "xs" | "sm" | "md" | "lg" | "xl";

// Card dimensions are fluid: they shrink on narrow phones (so rows of cards
// never overflow) and settle at their full size on larger screens. Corner
// pips are sized in `em`, so they scale automatically with the card's font.
const SIZES: Record<Size, string> = {
  // Table-row size: fits inside a line of body text without setting the row
  // height, which is what lets a hand be shown as cards in the same cell that
  // used to print `3s 5s` in mono. Fixed rather than fluid — it sits in a data
  // table, and a card that changes height with the viewport reflows the row.
  xs: "h-[1.55rem] w-[1.15rem] text-[0.62rem] rounded-[0.2rem]",
  sm: "h-[clamp(2.75rem,9vw,3rem)] w-[clamp(2rem,6.7vw,2.25rem)] text-[clamp(0.75rem,2.4vw,1rem)] rounded-lg",
  md: "h-[clamp(4.5rem,15vw,6rem)] w-[clamp(3.25rem,10.8vw,4.25rem)] text-[clamp(1.25rem,4.6vw,1.875rem)] rounded-lg sm:rounded-xl",
  lg: "h-[clamp(5rem,17vw,7rem)] w-[clamp(3.5rem,12.2vw,5rem)] text-[clamp(1.4rem,5.2vw,2.25rem)] rounded-xl sm:rounded-2xl",
  xl: "h-[clamp(4.15rem,18vw,9rem)] w-[clamp(3rem,14vw,6.5rem)] text-[clamp(1.5rem,5.6vw,3rem)] rounded-xl sm:rounded-2xl",
};

// Empty slot footprints, kept in sync with the matching `SIZES` row so a
// placeholder and the card that lands in it are the same size.
export const MD_CARD_BOX =
  "h-[clamp(4.5rem,15vw,6rem)] w-[clamp(3.25rem,10.8vw,4.25rem)]";
export const LG_CARD_BOX =
  "h-[clamp(5rem,17vw,7rem)] w-[clamp(3.5rem,12.2vw,5rem)]";

interface PlayingCardProps {
  card?: Card;
  faceDown?: boolean;
  size?: Size;
  /**
   * This card overlaps the one beside it, so it is physically on top of it and
   * carries the heavier shadow. Used by the hero's pair and by a phone's
   * revealed hole cards, which are dealt into the same footprint.
   */
  overlaps?: boolean;
  /**
   * Degrees of tilt. Cards pushed across cloth by a hand never land square, and
   * a pair that is exactly parallel is the quickest way to make a table look
   * printed rather than played. Kept to about a degree, any more reads as a
   * bug.
   */
  tilt?: number;
}

/**
 * The ink of a playing card.
 *
 * Was `#b91c1c`. Tailwind's red-700, which is a UI danger colour and reads
 * orange next to this product's oxblood. Real card stock is printed in a
 * cooler, deeper red, and the black is not black either: it is a very dark
 * warm grey, because a press cannot lay pure black on absorbent stock.
 */
const INK_RED = "#b3122a";
const INK_BLACK = "#171412";

function PlayingCardImpl({
  card,
  faceDown = false,
  size = "md",
  overlaps = false,
  tilt = 0,
}: PlayingCardProps) {
  const shape = `${SIZES[size]} ${overlaps ? "pp-card-over" : ""}`;
  const tilted = tilt ? { transform: `rotate(${tilt}deg)` } : undefined;

  if (faceDown || !card) {
    // One element, not two. The back's border, its inner gold keyline and its
    // lattice are all layers of the same box, a nested div for the keyline
    // meant twelve extra nodes on a six-handed table for a 1px line.
    return <div className={`pp-card-back ${shape}`} style={tilted} />;
  }

  const red = SUIT_IS_RED[card.suit];
  const color = red ? INK_RED : INK_BLACK;
  const rank = rankChar(card.rank);
  const suit = SUIT_SYMBOL[card.suit];

  // Rank over suit, no centre pip and no second corner: at this size the three
  // marks of the full layout collide into a smudge. `xs` is a legible token,
  // not a miniature of the card.
  if (size === "xs" || size === "sm") {
    return (
      <div
        className={`pp-card ${shape} relative flex flex-col items-center justify-center font-semibold`}
        style={{ color, ...tilted }}
      >
        <span className="leading-none">{rank}</span>
        <span className="leading-none">{suit}</span>
      </div>
    );
  }

  return (
    <div
      className={`pp-card ${shape} relative font-semibold`}
      style={{ color, ...tilted }}
    >
      <div className="absolute left-1.5 top-1 flex flex-col items-center leading-none">
        <span className="text-[0.55em]">{rank}</span>
        <span className="text-[0.45em]">{suit}</span>
      </div>
      <div className="absolute inset-0 flex items-center justify-center leading-none">
        <span>{suit}</span>
      </div>
      <div className="absolute bottom-1 right-1.5 flex rotate-180 flex-col items-center leading-none">
        <span className="text-[0.55em]">{rank}</span>
        <span className="text-[0.45em]">{suit}</span>
      </div>
    </div>
  );
}

/**
 * Memoized by card identity (id) rather than object reference, so the engine's
 * per-action state cloning, which produces fresh card objects, does not force
 * every card on the table to re-render.
 */
export const PlayingCard = memo(PlayingCardImpl, (a, b) => {
  return (
    a.card?.id === b.card?.id &&
    a.faceDown === b.faceDown &&
    a.size === b.size &&
    a.overlaps === b.overlaps &&
    a.tilt === b.tilt
  );
});
