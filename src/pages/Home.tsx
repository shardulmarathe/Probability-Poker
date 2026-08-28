import type { ReactNode } from "react";
import { PlayingCard } from "../components/PlayingCard";
import TableSetupPanel from "../components/TableSetupPanel";
import { useTableSetup } from "../components/setup/useTableSetup";
import { ButtonLink } from "../components/ui";
import { makeCard } from "../poker/cards";

const ACE_SPADES = makeCard(14, "s");
const KING_SPADES = makeCard(13, "s");

interface Concept {
  suit: string;
  red?: boolean;
  title: string;
  eq: string;
  desc: string;
}

const CONCEPTS: Concept[] = [
  {
    suit: "♠",
    title: "Bayesian opponent modelling",
    eq: "P(H | A)",
    desc: "Beliefs about what an opponent holds update after every action they take.",
  },
  {
    suit: "♥",
    red: true,
    title: "Monte Carlo simulation",
    eq: "40,000 runouts",
    desc: "Tens of thousands of randomised outcomes estimate your true win probability.",
  },
  {
    suit: "♦",
    red: true,
    title: "Expected value",
    eq: "EV = Σ p(x)V(x)",
    desc: "Every bot action is the one with the highest long-run return, priced live.",
  },
];

/**
 * The landing page, and the one decision it is allowed to ask for.
 *
 * It used to offer three calls to action pointing at two destinations: "Deal me
 * in" in the hero, "Set up the table first ↓" beside it, and a second "Deal me
 * in" at the foot of a 943px setup form. Two of those went to `/table` and the
 * third scrolled 800px down the same page, so the first thing the product asked
 * a new arrival was which of three buttons meant "start". There is one now. The
 * table it will deal is summarised directly underneath it, with a `Change` that
 * opens the full editor — a caption on the decision rather than a second one.
 */
export default function Home() {
  // Shared with the panel below rather than owned by it, so the hero's label
  // cannot promise to deal you in to a table you have set yourself to sit out
  // of. See `setup/useTableSetup.ts`.
  const table = useTableSetup();

  return (
    <main className="relative overflow-x-hidden font-sans text-ivory">
      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-14 pt-6 sm:px-6 sm:pt-10">
        {/* ------------------------------ Hero ------------------------------ */}
        <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <div className="text-center lg:text-left">
            <h1
              className="pp-fade-up font-display text-[clamp(3rem,6.5vw,4.75rem)] font-bold leading-[1.02] tracking-tight text-ivory"
              style={{ animationDelay: "80ms" }}
            >
              Probability
              <br />
              <span className="text-gold">Poker</span>
            </h1>

            <p
              className="pp-fade-up mt-5 font-cormorant text-[clamp(1.5rem,2.6vw,2.1rem)] italic text-ivory/85"
              style={{ animationDelay: "160ms" }}
            >
              Can probability outperform human intuition?
            </p>

            <p
              className="pp-fade-up mx-auto mt-4 max-w-lg text-[0.95rem] leading-relaxed text-ivory/60 lg:mx-0"
              style={{ animationDelay: "240ms" }}
            >
              Play Texas Hold'em against bots that model your range, simulate the
              runout, and take the highest-EV line every time. Then read back
              exactly where your hand differed from theirs.
            </p>

            <div
              className="pp-fade-up mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center lg:justify-start"
              style={{ animationDelay: "320ms" }}
            >
              <ButtonLink to="/table" variant="primary" size="lg" testId="hero-deal">
                {table.setup.observer ? "Watch the table" : "Deal me in"}
                <span aria-hidden className="text-gold">
                  →
                </span>
              </ButtonLink>
            </div>

          </div>

          <div
            className="pp-fade-up flex justify-center"
            style={{ animationDelay: "300ms" }}
          >
            <Matchup />
          </div>
        </div>

        {/* --------------------------- Set up ------------------------------ */}
        {/* Deliberately close to the hero. Closed it is one line of type, and
            at 12rem of clearance it read as a separate section the eye had to
            decide about; at 8 it reads as the caption to the button above it,
            which is the only job it has before someone presses `Change`. */}
        <div className="pp-fade-up mt-8 sm:mt-10" style={{ animationDelay: "420ms" }}>
          <TableSetupPanel table={table} />
        </div>

        {/* -------------------------- The engine --------------------------- */}
        <section className="mt-14 sm:mt-20" aria-labelledby="engine">
          <h2
            id="engine"
            className="font-display text-2xl font-semibold tracking-wide text-ivory sm:text-3xl"
          >
            What the bots are actually doing
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ivory/55">
            No lookup tables and no scripted personalities. Every decision at the
            table is three pieces of arithmetic, run live, and the review pages
            show you each one for the hand you just played.
          </p>

          <div className="mt-7 grid gap-x-8 gap-y-8 sm:grid-cols-3">
            {CONCEPTS.map((c, i) => (
              <Concept key={c.title} concept={c} first={i === 0} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

/**
 * Three peers, separated by a hairline rather than boxed.
 *
 * They were three bordered cards with hover states, which implied they were
 * selectable and grouped things that are already obviously a group. The suit
 * watermark carries the identity; the rule carries the separation.
 */
function Concept({ concept, first }: { concept: Concept; first: boolean }) {
  return (
    <div
      className={`relative min-w-0 sm:pl-8 ${first ? "sm:border-l-0 sm:pl-0" : "sm:border-l"}`}
      style={{ borderColor: "rgba(201,162,39,0.18)" }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-6 right-0 select-none text-7xl leading-none"
        style={{ color: concept.red ? "#a30222" : "#c9a227", opacity: 0.12 }}
      >
        {concept.suit}
      </span>
      <p className="relative font-mono text-base font-semibold text-gold">
        {concept.eq}
      </p>
      <h3 className="relative mt-2 font-display text-[1.05rem] font-semibold leading-snug text-ivory">
        {concept.title}
      </h3>
      <p className="relative mt-2 text-sm leading-relaxed text-ivory/55">
        {concept.desc}
      </p>
    </div>
  );
}

function Matchup() {
  return (
    <div
      className="relative w-full max-w-lg rounded-[2rem] border border-gold/20 px-4 py-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:px-7 sm:py-9"
      style={{
        background:
          "radial-gradient(120% 100% at 50% 0%, #1a4a32 0%, #123524 45%, #0b2218 100%)",
      }}
    >
      <div className="pointer-events-none absolute inset-x-8 bottom-4 top-4 rounded-[50%] border border-gold/10" />

      <div className="relative flex items-center justify-between gap-2">
        <Seat
          avatar={"\u{1F916}"}
          label="The Bot"
          tag="Bayesian"
          cards={
            <>
              <FloatCard delay={0} rotate={-7}>
                <PlayingCard faceDown size="lg" />
              </FloatCard>
              <FloatCard delay={250} rotate={7} shift>
                <PlayingCard faceDown size="lg" />
              </FloatCard>
            </>
          }
        />

        <div className="flex flex-col items-center gap-1.5 px-1">
          <span className="font-display text-3xl font-bold tracking-widest text-gold">
            VS
          </span>
          <span className="h-12 w-px bg-gold/20" />
        </div>

        <Seat
          avatar={"\u{1F9D1}"}
          label="You"
          tag="Intuition"
          cards={
            <>
              <FloatCard delay={120} rotate={-7}>
                <PlayingCard card={ACE_SPADES} size="lg" />
              </FloatCard>
              <FloatCard delay={380} rotate={7} shift>
                <PlayingCard card={KING_SPADES} size="lg" />
              </FloatCard>
            </>
          }
        />
      </div>
    </div>
  );
}

function Seat({
  avatar,
  label,
  tag,
  cards,
}: {
  avatar: string;
  label: string;
  tag: string;
  cards: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2.5 sm:gap-3.5">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-gold/40 bg-felt-deep text-3xl shadow-inner sm:h-16 sm:w-16 sm:text-4xl">
        {avatar}
      </div>
      <div className="text-center leading-tight">
        <div className="font-display text-base tracking-wide text-ivory">{label}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gold/70">
          {tag}
        </div>
      </div>
      <div className="flex">{cards}</div>
    </div>
  );
}

function FloatCard({
  children,
  delay,
  rotate,
  shift,
}: {
  children: ReactNode;
  delay: number;
  rotate: number;
  shift?: boolean;
}) {
  return (
    <div
      className="pp-float drop-shadow-lg"
      style={{
        transform: `rotate(${rotate}deg)`,
        marginLeft: shift ? "-0.75rem" : undefined,
        animationDelay: `${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
