/**
 * One chair at the table.
 *
 * The same component draws all of them, at three densities: the hero's seat
 * (cards big enough to read at a glance), a full opponent card on a wide
 * screen, and a compact one on a phone — where six seats have to share 390
 * pixels and anything more than an avatar and a stack does not fit.
 */

import type { CSSProperties } from "react";
import { PlayingCard } from "../PlayingCard";
import { money } from "../../lib/format";
import type { SeatFx } from "../../store/TableContext";
import type { PositionName } from "../../poker/table/position";
import type { TableSeat } from "../../poker/table/state";
import type { BeliefDistribution } from "../../types";
import type { BotProfile } from "../../poker/table/contract";
import {
  Badge,
  BeliefBar,
  SpeechBubble,
  ThoughtBubble,
  type SeatPoint,
} from "./chrome";

export interface SeatViewProps {
  seat: TableSeat;
  point: SeatPoint;
  position: PositionName;
  profile: BotProfile | null;
  active: boolean;
  /** Face-up: this seat's cards are visible to the viewer. */
  reveal: boolean;
  hero: boolean;
  compact: boolean;
  fx: SeatFx;
  /** Public read on this seat, shown in Study mode only. */
  read: BeliefDistribution | null;
  /** Set when the hand is over and this seat collected chips. */
  won: number | null;
  showBlurb: boolean;
}

export function SeatView(props: SeatViewProps) {
  const { seat, point, hero, compact } = props;
  const folded = seat.status === "folded";

  // Seat 0 owns the bottom chair — the human's, or in observer mode a bot's —
  // and is centred on its anchor so it cannot hang off the bottom rail. Every
  // other seat hangs from its anchor instead, so a seat that grows (a read, a
  // style tag, a bet chip) grows downward into the felt rather than upward off
  // the edge of the table.
  const atBottom = seat.id === 0;
  const style: CSSProperties = {
    left: `${point.x}%`,
    top: `${point.y}%`,
    transform: atBottom ? "translate(-50%, -50%)" : "translate(-50%, 0)",
    opacity: folded ? 0.42 : 1,
  };

  // The bottom seat speaks upward; the top arc speaks down, toward the pot.
  const side = atBottom ? "top" : "bottom";

  return (
    <div
      className="absolute z-10 flex flex-col items-center transition-opacity duration-300"
      style={style}
      data-testid="seat"
      data-seat-id={seat.id}
      data-seat-stack={seat.stack}
      data-seat-status={seat.status}
      data-seat-reveal={props.reveal ? "1" : "0"}
    >
      {props.fx.thinking ? (
        <ThoughtBubble step={props.fx.thinking} side={side} />
      ) : (
        props.fx.bubble && <SpeechBubble text={props.fx.bubble} side={side} />
      )}

      {hero ? <HeroSeat {...props} /> : compact ? <CompactSeat {...props} /> : <FullSeat {...props} />}

      {/* The chips this seat has pushed out, sitting between it and the pot —
          out of the flow, so a seat that grows cannot shove the board down.
          The hero's go inside its own card instead, since its info panel is
          already right there and the space above it is the pot readout's. */}
      {!hero && <Commit amount={seat.streetCommit} above={atBottom} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function avatarStyle(active: boolean, won: number | null): CSSProperties {
  return {
    borderColor: active ? "#c9a227" : won ? "#e2c563" : "rgba(244,237,228,0.2)",
    background: active ? "rgba(201,162,39,0.16)" : "rgba(0,0,0,0.4)",
    boxShadow: active ? "0 0 20px rgba(201,162,39,0.4)" : "none",
  };
}

function Commit({ amount, above }: { amount: number; above: boolean }) {
  if (amount <= 0) return null;
  const pos = above ? "bottom-full mb-1.5" : "top-full mt-1.5";
  return (
    <span
      className={`absolute left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[0.62rem] leading-none text-gold-soft ${pos}`}
      style={{
        background: "rgba(0,0,0,0.65)",
        border: "1px solid rgba(201,162,39,0.45)",
      }}
    >
      {money(amount)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hero — bottom centre, cards readable
// ---------------------------------------------------------------------------

function HeroSeat({ seat, position, active, reveal, won, fx: _fx, profile }: SeatViewProps) {
  return (
    <div className="flex items-end gap-3 sm:gap-4">
      <div className="flex gap-1.5 sm:gap-2">
        <PlayingCard card={seat.hole[0]} faceDown={!reveal} size="lg" />
        <PlayingCard card={seat.hole[1]} faceDown={!reveal} size="lg" />
      </div>
      <div
        className={`flex flex-col items-start rounded-2xl border px-3 py-2 ${won ? "pp-t-win" : ""}`}
        style={{
          borderColor: active ? "#c9a227" : "rgba(244,237,228,0.18)",
          background: "rgba(0,0,0,0.45)",
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-xl leading-none sm:text-2xl">
            {profile?.avatar ?? "\u{1F9D1}"}
          </span>
          <span className="font-display text-sm tracking-wide text-ivory">
            {seat.name}
          </span>
          <Badge label={position} tone={position === "BTN" ? "dealer" : "blind"} />
        </div>
        <div className="mt-0.5 font-mono text-sm text-ivory/80">
          {money(seat.stack)}
          {seat.streetCommit > 0 && (
            <span className="ml-2 text-gold-soft">
              &middot; {money(seat.streetCommit)} in
            </span>
          )}
          {won ? (
            <span className="ml-2 text-gold-soft">+{money(won)}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full opponent — wide screens
// ---------------------------------------------------------------------------

function FullSeat({
  seat,
  position,
  profile,
  active,
  reveal,
  read,
  won,
  showBlurb,
}: SeatViewProps) {
  return (
    <div className="flex w-[8.5rem] flex-col items-center">
      <div className="mb-1.5 flex gap-1">
        <PlayingCard card={seat.hole[0]} faceDown={!reveal} size="sm" />
        <PlayingCard card={seat.hole[1]} faceDown={!reveal} size="sm" />
      </div>

      <div
        className={`flex w-full flex-col items-center rounded-2xl border px-2 py-2 text-center ${won ? "pp-t-win" : ""}`}
        style={{
          borderColor: active ? "#c9a227" : "rgba(244,237,228,0.16)",
          background: "rgba(0,0,0,0.5)",
          backdropFilter: "blur(2px)",
        }}
        title={profile?.blurb}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-xl border text-lg"
            style={avatarStyle(active, won)}
          >
            {profile?.avatar ?? "\u{1F464}"}
          </span>
          <Badge label={position} tone={position === "BTN" ? "dealer" : "blind"} />
        </div>
        <div className="mt-1 max-w-full truncate font-display text-[0.72rem] tracking-wide text-ivory">
          {seat.name}
        </div>
        <div className="font-mono text-xs text-ivory/75">
          {money(seat.stack)}
          {won ? <span className="ml-1 text-gold-soft">+{money(won)}</span> : null}
        </div>
        {/* Study's addition is the *live* read, not the static one. The
            archetype names the style in a line; the full blurb lives on hover
            and on the setup screen, because three lines of prose per seat is
            more vertical space than the top-centre chair has above the board. */}
        {showBlurb && profile && (
          <div className="font-mono text-[0.55rem] uppercase tracking-[0.18em] text-gold/60">
            {profile.id}
          </div>
        )}
        {read && (
          <div className="mt-1.5">
            <BeliefBar belief={read} width="4.5rem" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact opponent — phones
//
// Everything below the avatar and the stack is dropped: at six seats on a
// 390px screen the arc gives each chair about 46px, and a name or a blurb
// simply does not fit. Cards appear only once they are face up, overlapped so
// a revealed pair stays inside the same footprint.
// ---------------------------------------------------------------------------

function CompactSeat({ seat, position, profile, active, reveal, read, won }: SeatViewProps) {
  const inHand = seat.status !== "folded" && seat.hole.length > 0;

  return (
    <div className="flex w-[3.5rem] flex-col items-center" title={profile?.blurb}>
      {reveal && inHand ? (
        <div className="mb-1 flex">
          <PlayingCard card={seat.hole[0]} size="sm" />
          <span className="-ml-2.5">
            <PlayingCard card={seat.hole[1]} size="sm" />
          </span>
        </div>
      ) : (
        <span className="mb-1 flex h-3.5 items-center gap-0.5">
          {inHand ? (
            <>
              <MiniBack />
              <MiniBack />
            </>
          ) : null}
        </span>
      )}

      <span
        className={`flex h-9 w-9 items-center justify-center rounded-xl border text-lg ${won ? "pp-t-win" : ""}`}
        style={avatarStyle(active, won)}
      >
        {profile?.avatar ?? "\u{1F9D1}"}
      </span>
      <span className="mt-0.5 flex items-center gap-1">
        <Badge label={position} tone={position === "BTN" ? "dealer" : "quiet"} />
      </span>
      <span className="font-mono text-[0.62rem] leading-tight text-ivory/80">
        {money(seat.stack)}
      </span>
      {read && (
        <span className="mt-0.5">
          <BeliefBar belief={read} width="2.4rem" />
        </span>
      )}
    </div>
  );
}

function MiniBack() {
  return (
    <span
      className="inline-block h-3.5 w-2.5 rounded-[2px] border"
      style={{
        borderColor: "rgba(201,162,39,0.7)",
        background: "linear-gradient(135deg, #7a0019 0%, #4d0010 100%)",
      }}
    />
  );
}
