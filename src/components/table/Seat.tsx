/**
 * One chair at the table.
 *
 * The same component draws all of them, at three densities: the hero's seat
 * (cards big enough to read at a glance), a full opponent card on a wide
 * screen, and a compact one on a phone, where six seats have to share 390
 * pixels and anything more than an avatar and a stack does not fit.
 *
 * A seat has four states and they are told apart by *elevation*, not by colour
 * alone. Live seats sit slightly proud of the cloth. The seat on the clock is
 * lifted further and lit gold. An all-in seat keeps its height but is ringed in
 * oxblood, because its chips are already in the middle. A folded seat lies flat
 *, no lift, no shadow, no colour in the face, no cards, which is what a
 * player who is out of the hand looks like from across a table.
 */

import type { CSSProperties } from "react";
import { PlayingCard } from "../PlayingCard";
import { LINE } from "../ui";
import { money } from "../../lib/format";
import type { SeatFx } from "../../store/TableContext";
import type { PositionName } from "../../poker/table/position";
import type { TableSeat } from "../../poker/table/state";
import type { BeliefDistribution } from "../../types";
import type { BotProfile } from "../../poker/table/contract";
import {
  Badge,
  BeliefBar,
  ChipStack,
  SpeechBubble,
  bubbleAlign,
  chipStacks,
  useNarrow,
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
  /** What the finished hand was worth to this seat, signed. Null if it broke even. */
  net: number | null;
  /**
   * The hand has been resolved and the chips pushed.
   *
   * Until then an all-in seat prints "ALL IN" in place of its stack, because
   * the number would be a meaningless 0 while the pot is still live. Once it is
   * settled that stops being true and starts being a lie: a seat that shoved
   * and lost sat there reading "ALL IN" with no stack and no result, while the
   * winner beside it showed "+$2010". Settled seats show what they are left
   * with.
   */
  settled: boolean;
  showBlurb: boolean;
  /** The table's big blind, for pricing a bet into chips. */
  bigBlind: number;
}

type SeatState = "idle" | "active" | "allin" | "folded";

function seatState(seat: TableSeat, active: boolean): SeatState {
  if (seat.status === "folded" || seat.status === "out") return "folded";
  if (active) return "active";
  if (seat.status === "allin") return "allin";
  return "idle";
}

export function SeatView(props: SeatViewProps) {
  const { seat, point, hero, compact, active } = props;
  const state = seatState(seat, active);
  const folded = state === "folded";

  // Seat 0 owns the bottom chair, the human's, or in observer mode a bot's -
  // and is centred on its anchor so it cannot hang off the bottom rail. Every
  // other seat hangs from its anchor instead, so a seat that grows (a read, a
  // style tag, a bet chip) grows downward into the felt rather than upward off
  // the edge of the table.
  const atBottom = seat.id === 0;
  const style: CSSProperties = {
    left: `${point.x}%`,
    top: `${point.y}%`,
    transform: atBottom ? "translate(-50%, -50%)" : "translate(-50%, 0)",
    opacity: folded ? 0.34 : 1,
  };

  // The bottom seat speaks upward; the top arc speaks down, toward the pot.
  const side = atBottom ? "top" : "bottom";
  // …and a seat at either end of the arc opens its bubble inward, so a phone
  // never slices one off at the viewport edge.
  const align = bubbleAlign(point.x);
  // The bet pill and the bubble both hang off the same edge of a chair. When
  // both are on screen the bubble has to step past the chips.
  const hasCommit = !hero && seat.streetCommit > 0;

  return (
    <div
      className={`absolute z-10 flex flex-col items-center transition-opacity duration-300 ${
        folded ? "pp-seat-folded" : ""
      }`}
      style={style}
      data-testid="seat"
      data-seat-id={seat.id}
      data-seat-stack={seat.stack}
      data-seat-status={seat.status}
      data-seat-reveal={props.reveal ? "1" : "0"}
    >
      {/*
       * A chair says what it did, and nothing else.
       *
       * It used to carry the whole decision transcript while the bot was
       * thinking, hung off the seat by a `ThoughtPocket`. That kept the
       * narration attached to its player and, on the top arc, printed it
       * straight over the community cards, because a top-arc chair opens
       * downward toward the pot and the transcript is an opaque panel a
       * quarter of the felt tall. `TableGame` docks it on a rail on the cloth
       * now, named, and what is left here is the one-line bubble it always was.
       */}
      {props.fx.bubble && (
        <SpeechBubble
          text={props.fx.bubble}
          side={side}
          align={align}
          clearance={hasCommit}
        />
      )}

      {hero ? (
        <HeroSeat {...props} state={state} />
      ) : compact ? (
        <CompactSeat {...props} state={state} />
      ) : (
        <FullSeat {...props} state={state} />
      )}

      {/* The chips this seat has pushed out, sitting between it and the pot —
          out of the flow, so a seat that grows cannot shove the board down.
          The hero's go inside its own card instead, since its info panel is
          already right there and the space above it is the pot readout's. */}
      {!hero && (
        <Commit
          amount={seat.streetCommit}
          bigBlind={props.bigBlind}
          above={atBottom}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Skinned = SeatViewProps & { state: SeatState };

/** The one thing every plate shares: its material, and which state it is in. */
function plate(state: SeatState, won: number | null): {
  className: string;
  props: { "data-state": SeatState };
} {
  return {
    className: `pp-seat-plate ${won ? "pp-seat-won" : ""}`,
    props: { "data-state": state },
  };
}

function avatarStyle(state: SeatState, won: number | null): CSSProperties {
  const lit = state === "active";
  return {
    borderColor: lit
      ? "#c9a227"
      : won
        ? "#e2c563"
        : state === "allin"
          ? "rgba(163,2,34,0.7)"
          : "rgba(244,237,228,0.18)",
    background: lit ? "rgba(201,162,39,0.14)" : "rgba(0,0,0,0.4)",
    boxShadow: lit
      ? "inset 0 1px 0 rgba(255,240,200,0.25), var(--pp-shadow-contact)"
      : "var(--pp-shadow-contact)",
  };
}

/**
 * Chips pushed out in front of a seat.
 *
 * A bet is chips before it is a number: at a real table you read the size of a
 * commitment from the pile, and the total is something you work out afterwards.
 * So the pile is drawn and the number sits beside it, rather than the number
 * standing in for the pile.
 */
function Commit({
  amount,
  bigBlind,
  above,
}: {
  amount: number;
  bigBlind: number;
  above: boolean;
}) {
  if (amount <= 0) return null;
  const pos = above ? "bottom-full mb-1.5" : "top-full mt-1.5";
  const stacks = chipStacks(amount, bigBlind, 2, 4);
  return (
    <span
      className={`absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-1.5 pr-2 font-mono text-[0.62rem] leading-none text-gold-soft ${pos}`}
      style={{
        background: "rgba(0,0,0,0.6)",
        border: "1px solid rgba(201,162,39,0.4)",
      }}
    >
      <span className="flex items-end gap-[2px]" aria-hidden>
        {stacks.map((s, i) => (
          <ChipStack
            key={i}
            count={s.count}
            body={s.denomination.body}
            spot={s.denomination.spot}
            size={12}
          />
        ))}
      </span>
      {money(amount)}
    </span>
  );
}

/**
 * The signed result of the finished hand. Gold for a profit, muted red for a
 * loss, the same two colours the felt already uses for a win and for an
 * all-in, so it needs no legend.
 *
 * `beside` is the showdown case, where this prints next to the seat's stack.
 * At the same size and weight those two numbers read as one statement, and a
 * seat that rebought showed "Textbook Tara  $1000  \u2212$1000", which looks like
 * arithmetic that does not add up rather than like the two different facts it
 * is: what she has in front of her, and what this hand cost her. A hairline
 * rule and a step down in size separate them without a label, which is the
 * only option, because at 8.5rem wide the chair has room for neither word.
 */
function Net({ net, beside }: { net: number | null; beside?: boolean }) {
  if (net === null || net === 0) return null;
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 font-mono ${
        beside ? "ml-1.5" : ""
      }`}
    >
      {beside && (
        <span
          aria-hidden
          className="h-[0.85em] w-px self-center"
          style={{ background: LINE.gold }}
        />
      )}
      <span
        className={beside ? "text-[0.85em]" : undefined}
        style={{ color: net > 0 ? "#e2c563" : "#e58a8a" }}
      >
        {net > 0 ? "+" : "\u2212"}
        {money(Math.abs(net))}
      </span>
    </span>
  );
}

/**
 * All-in is a state, not a stack size, $0 behind says nothing on its own.
 *
 * `tight` is the phone's six-handed case, where a chair is 3rem wide: at the
 * desktop's tracking "ALL IN" is wider than the seat and two neighbouring
 * all-ins print straight through each other.
 */
function Stack({
  seat,
  tight,
  settled,
}: {
  seat: TableSeat;
  tight?: boolean;
  settled?: boolean;
}) {
  if (seat.status === "allin" && !settled) {
    return (
      <span
        className={tight ? "font-mono text-[0.55rem]" : "font-mono tracking-[0.14em]"}
        style={{ color: "#e58a8a" }}
        data-testid="allin"
      >
        ALL&nbsp;IN
      </span>
    );
  }
  return <>{money(seat.stack)}</>;
}

// ---------------------------------------------------------------------------
// Hero, bottom centre, cards readable
// ---------------------------------------------------------------------------

function HeroSeat({ seat, position, reveal, won, net, profile, state, bigBlind, settled }: Skinned) {
  const skin = plate(state, won);
  const narrow = useNarrow();
  return (
    <div className={`flex items-end ${narrow ? "min-w-0 gap-2" : "gap-3 sm:gap-4"}`}>
      {/* Two cards pushed across cloth by one hand: the near one lands on top
          of the far one, and neither lands square. On a phone, md cards keep
          the plate from eating the pot. */}
      <div className="flex shrink-0 gap-1.5 sm:gap-2">
        <PlayingCard
          card={seat.hole[0]}
          faceDown={!reveal}
          size={narrow ? "md" : "lg"}
          tilt={-1.4}
        />
        <PlayingCard
          card={seat.hole[1]}
          faceDown={!reveal}
          size={narrow ? "md" : "lg"}
          tilt={1.1}
          overlaps
        />
      </div>
      <div
        className={`${skin.className} flex min-w-0 flex-col items-start overflow-hidden rounded-2xl px-3 py-2`}
        {...skin.props}
      >
        <div className="flex min-w-0 flex-nowrap items-center gap-2">
          <span
            className={`pp-avatar leading-none ${narrow ? "text-lg" : "text-xl sm:text-2xl"}`}
          >
            {profile?.avatar ?? "\u{1F9D1}"}
          </span>
          <span className="min-w-0 truncate font-display text-sm tracking-wide text-ivory">
            {seat.name}
          </span>
          <Badge label={position} tone={position === "BTN" ? "dealer" : "blind"} />
          {/* Phone: stack only. The chip pile and "$N in" sat on this row
              and, with ALL IN, grew the plate over the hole cards. */}
          {narrow && (
            <span className="shrink-0 font-mono text-sm text-ivory/80">
              <Stack seat={seat} tight settled={settled} />
              <Net net={net} beside />
            </span>
          )}
        </div>
        {!narrow && (
          <div className="mt-0.5 flex flex-nowrap items-center gap-2 whitespace-nowrap font-mono text-sm text-ivory/80">
            <Stack seat={seat} settled={settled} />
            {seat.streetCommit > 0 && (
              <span className="flex items-center gap-1 text-gold-soft">
                <HeroCommit amount={seat.streetCommit} bigBlind={bigBlind} />
                {money(seat.streetCommit)} in
              </span>
            )}
            <Net net={net} beside />
          </div>
        )}
      </div>
    </div>
  );
}

function HeroCommit({ amount, bigBlind }: { amount: number; bigBlind: number }) {
  return (
    <span className="flex items-end gap-[2px]" aria-hidden>
      {chipStacks(amount, bigBlind, 2, 4).map((s, i) => (
        <ChipStack
          key={i}
          count={s.count}
          body={s.denomination.body}
          spot={s.denomination.spot}
          size={12}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Full opponent, wide screens
// ---------------------------------------------------------------------------

function FullSeat({
  seat,
  position,
  profile,
  reveal,
  read,
  won,
  net,
  settled,
  showBlurb,
  state,
}: Skinned) {
  const skin = plate(state, won);
  const inHand = state !== "folded" && seat.hole.length > 0;
  return (
    <div className="flex w-[8.5rem] flex-col items-center">
      {/* A folded seat has mucked. Leaving two card backs sitting in front of
          it is the single most confusing thing this table used to do. */}
      <div className="mb-1.5 flex h-[clamp(2.75rem,9vw,3rem)] items-end gap-1">
        {inHand && (
          <>
            <PlayingCard card={seat.hole[0]} faceDown={!reveal} size="sm" tilt={-1.2} />
            <PlayingCard
              card={seat.hole[1]}
              faceDown={!reveal}
              size="sm"
              tilt={1}
              overlaps
            />
          </>
        )}
      </div>

      <div
        className={`${skin.className} flex w-full flex-col items-center rounded-2xl px-2 py-2 text-center`}
        {...skin.props}
        title={profile?.blurb}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="pp-avatar flex h-8 w-8 items-center justify-center rounded-full border text-lg"
            style={avatarStyle(state, won)}
          >
            {profile?.avatar ?? "\u{1F464}"}
          </span>
          <Badge label={position} tone={position === "BTN" ? "dealer" : "blind"} />
        </div>
        <div className="mt-1 max-w-full truncate font-display text-[0.72rem] tracking-wide text-ivory">
          {seat.name}
        </div>
        <div className="font-mono text-xs text-ivory/75">
          <Stack seat={seat} settled={settled} />
          <Net net={net} beside />
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
// Compact opponent, phones
//
// Everything below the avatar and the stack is dropped: at six seats on a
// 390px screen the arc gives each chair about 46px, and a name, a blurb, or a
// study read simply does not fit. Cards appear only once they are face up,
// overlapped so a revealed pair stays inside the same footprint.
// ---------------------------------------------------------------------------

function CompactSeat({ seat, position, profile, reveal, won, state, settled }: Skinned) {
  const inHand = state !== "folded" && seat.hole.length > 0;

  return (
    <div className="flex w-[3rem] flex-col items-center" title={profile?.blurb}>
      {reveal && inHand ? (
        <div className="mb-1 flex">
          <PlayingCard card={seat.hole[0]} size="sm" tilt={-1.5} />
          <span className="-ml-2.5">
            <PlayingCard card={seat.hole[1]} size="sm" tilt={1.5} overlaps />
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
        className={`pp-avatar flex h-7 w-7 items-center justify-center rounded-full border text-lg ${
          won ? "pp-seat-won" : ""
        }`}
        style={avatarStyle(state, won)}
      >
        {profile?.avatar ?? "\u{1F9D1}"}
      </span>
      <span className="mt-0.5 flex items-center gap-1">
        <Badge label={position} tone={position === "BTN" ? "dealer" : "quiet"} />
      </span>
      <span className="max-w-full truncate font-mono text-[0.62rem] leading-tight text-ivory/80">
        <Stack seat={seat} tight settled={settled} />
      </span>
    </div>
  );
}

/**
 * A face-down card at 10×14px. Not `.pp-card-back`: that back's keyline rings
 * are 5px in from the edge, which at this size meet in the middle and turn the
 * card into a smudge. Same stock, one ring.
 */
function MiniBack() {
  return (
    <span
      className="inline-block h-3.5 w-2.5 rounded-[2px]"
      style={{
        background: "linear-gradient(160deg, #8d011e 0%, #4a0010 100%)",
        boxShadow:
          "inset 0 0 0 1px rgba(226,197,99,0.6), var(--pp-shadow-contact)",
      }}
    />
  );
}
