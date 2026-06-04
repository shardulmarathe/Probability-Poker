import { memo } from "react";
import { SUIT_IS_RED, SUIT_SYMBOL, rankChar } from "../poker/cards";
import type { Card } from "../types";

type Size = "sm" | "md" | "lg" | "xl";

const SIZES: Record<Size, string> = {
  sm: "h-12 w-9 text-base rounded-lg",
  md: "h-24 w-[4.25rem] text-3xl rounded-xl",
  lg: "h-28 w-20 text-4xl rounded-2xl",
  xl: "h-36 w-[6.5rem] text-5xl rounded-2xl",
};

interface PlayingCardProps {
  card?: Card;
  faceDown?: boolean;
  size?: Size;
}

function PlayingCardImpl({ card, faceDown = false, size = "md" }: PlayingCardProps) {
  if (faceDown || !card) {
    return (
      <div
        className={`${SIZES[size]} flex items-center justify-center border shadow-md`}
        style={{
          borderColor: "#c9a227",
          background: "linear-gradient(135deg, #7a0019 0%, #4d0010 100%)",
        }}
      >
        <div
          className="h-2/3 w-2/3 rounded-[3px] border"
          style={{
            borderColor: "rgba(201,162,39,0.55)",
            background:
              "repeating-linear-gradient(45deg, rgba(201,162,39,0.18) 0 3px, transparent 3px 7px), repeating-linear-gradient(-45deg, rgba(201,162,39,0.18) 0 3px, transparent 3px 7px)",
          }}
        />
      </div>
    );
  }

  const red = SUIT_IS_RED[card.suit];
  const color = red ? "#b91c1c" : "#1a1a1a";
  const rank = rankChar(card.rank);
  const suit = SUIT_SYMBOL[card.suit];

  if (size === "sm") {
    return (
      <div
        className={`${SIZES[size]} relative flex flex-col items-center justify-center font-semibold shadow-md`}
        style={{ color, background: "#f7f1e6" }}
      >
        <span className="leading-none">{rank}</span>
        <span className="leading-none">{suit}</span>
      </div>
    );
  }

  return (
    <div
      className={`${SIZES[size]} relative font-semibold shadow-lg`}
      style={{
        color,
        background: "linear-gradient(155deg, #fbf7ef 0%, #f1e8d6 100%)",
        boxShadow:
          "0 6px 14px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(0,0,0,0.06)",
      }}
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
 * per-action state cloning — which produces fresh card objects — does not force
 * every card on the table to re-render.
 */
export const PlayingCard = memo(PlayingCardImpl, (a, b) => {
  return (
    a.card?.id === b.card?.id &&
    a.faceDown === b.faceDown &&
    a.size === b.size
  );
});
