import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PlayingCard } from "../components/PlayingCard";
import TableSetupPanel from "../components/TableSetupPanel";
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
    suit: "\u2660",
    title: "Bayesian Opponent Modeling",
    eq: "P(H | A)",
    desc: "Beliefs about opponent hand strength update after every action.",
  },
  {
    suit: "\u2665",
    red: true,
    title: "Monte Carlo Simulation",
    eq: "5000 Simulations",
    desc: "Thousands of randomized poker outcomes estimate true win probability.",
  },
  {
    suit: "\u2666",
    red: true,
    title: "Expected Value",
    eq: "EV = \u03a3 p(x)V(x)",
    desc: "Every bot action maximizes long-term expected return.",
  },
];

export default function Home() {
  return (
    <main className="relative min-h-[100svh] overflow-x-hidden bg-pkblack font-sans text-ivory">
      <FeltBackground />

      <div className="relative z-10 mx-auto flex min-h-[100svh] max-w-6xl flex-col px-4 py-[clamp(1rem,2.5vh,1.75rem)] sm:px-6">
        {/* Hero */}
        <div className="grid flex-1 items-center gap-6 sm:gap-8 lg:grid-cols-2 lg:gap-12">
          {/* Left: copy */}
          <div className="text-center lg:text-left">
            <h1
              className="pp-fade-up font-display text-[clamp(3.25rem,7vw,5.25rem)] font-bold leading-[1.0] tracking-tight text-ivory"
              style={{ animationDelay: "80ms" }}
            >
              Probability
              <br />
              <span className="text-gold">Poker</span>
            </h1>

            <p
              className="pp-fade-up mt-5 font-cormorant text-[clamp(1.55rem,2.8vw,2.2rem)] italic text-ivory/85"
              style={{ animationDelay: "160ms" }}
            >
              Can probability outperform human intuition?
            </p>

            <p
              className="pp-fade-up mx-auto mt-4 max-w-lg text-[0.95rem] leading-relaxed text-ivory/60 lg:mx-0"
              style={{ animationDelay: "240ms" }}
            >
              Play Texas Hold'em against a Bayesian poker bot that uses Monte
              Carlo simulation and expected value calculations to make every
              decision.
            </p>

            <div
              className="pp-fade-up mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start"
              style={{ animationDelay: "320ms" }}
            >
              <Link
                to="/table"
                className="group relative inline-flex items-center gap-3 rounded-xl border border-gold/40 bg-pkred px-10 py-4 text-lg font-semibold tracking-wide text-ivory shadow-[0_10px_30px_-10px_rgba(122,0,25,0.8)] transition-all duration-200 hover:-translate-y-0.5 hover:border-gold/70 hover:bg-pkred-light"
              >
                <span className="font-display tracking-widest">TAKE A SEAT</span>
                <span
                  aria-hidden
                  className="text-gold transition-transform duration-200 group-hover:translate-x-1"
                >
                  &rarr;
                </span>
              </Link>
              <a
                href="#setup"
                className="font-display text-sm tracking-widest text-gold/80 underline-offset-4 transition hover:text-gold hover:underline"
              >
                CHOOSE THE TABLE ↓
              </a>
            </div>

            <p
              className="pp-fade-up mt-4 text-xs text-ivory/40"
              style={{ animationDelay: "360ms" }}
            >
              Or play the original{" "}
              <Link to="/game" className="text-gold/70 underline-offset-2 hover:underline">
                heads-up match
              </Link>
              .
            </p>
          </div>

          {/* Right: poker matchup centerpiece */}
          <div
            className="pp-fade-up flex justify-center"
            style={{ animationDelay: "300ms" }}
          >
            <Matchup />
          </div>
        </div>

        {/* Connector → ties the hero to the setup panel */}
        <Divider label="Sit Down" delay={400} />

        <div className="pp-fade-up" style={{ animationDelay: "440ms" }}>
          <TableSetupPanel />
        </div>

        {/* Connector → ties the setup panel to the concept row */}
        <Divider label="The Probability Engine" delay={480} />

        {/* Concept cards */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-5">
          {CONCEPTS.map((c, i) => (
            <ConceptCard key={c.title} concept={c} delay={520 + i * 90} />
          ))}
        </div>
      </div>
    </main>
  );
}

function Divider({ label, delay }: { label: string; delay: number }) {
  return (
    <div
      className="pp-fade-up mb-4 mt-8 flex items-center justify-center gap-3"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="h-px w-12 bg-gradient-to-r from-transparent to-gold/40" />
      <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-gold/70">
        {label}
      </span>
      <span className="h-px w-12 bg-gradient-to-l from-transparent to-gold/40" />
    </div>
  );
}

function Matchup() {
  return (
    <div
      className="relative w-full max-w-lg rounded-3xl border border-gold/20 px-4 py-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:px-7 sm:py-9"
      style={{
        background:
          "radial-gradient(120% 100% at 50% 0%, #1a4a32 0%, #123524 45%, #0b2218 100%)",
      }}
    >
      {/* faint table arc marking */}
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
        <div className="font-display text-base tracking-wide text-ivory">
          {label}
        </div>
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

function ConceptCard({ concept, delay }: { concept: Concept; delay: number }) {
  return (
    <div
      className="pp-fade-up group relative flex min-h-[7.5rem] flex-col overflow-hidden rounded-2xl border border-gold/15 bg-pkblack/40 p-4 backdrop-blur-sm transition-colors duration-200 hover:border-gold/40 sm:min-h-[9.5rem] sm:p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* suit watermark */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-2 -top-3 select-none text-7xl leading-none"
        style={{
          color: concept.red ? "#a30222" : "#c9a227",
          opacity: 0.1,
        }}
      >
        {concept.suit}
      </span>

      <div className="relative flex items-center gap-2.5">
        <span
          aria-hidden
          className="inline-block h-3 w-3 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 30% 30%, #e2c563, #c9a227 55%, #7a0019)",
          }}
        />
        <span className="font-mono text-base font-semibold text-gold">
          {concept.eq}
        </span>
      </div>

      <h3 className="relative mt-3 font-display text-[1.1rem] font-semibold leading-snug text-ivory">
        {concept.title}
      </h3>
      <p className="relative mt-2 text-sm leading-relaxed text-ivory/60">
        {concept.desc}
      </p>
    </div>
  );
}

function FeltBackground() {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      {/* Felt base + lighting */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(130% 95% at 50% 30%, #1a4a32 0%, #123524 42%, #0b2218 80%, #050d09 100%)",
        }}
      />
      {/* Felt micro-texture */}
      <div
        className="absolute inset-0 opacity-[0.06] mix-blend-overlay"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, #ffffff 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, #000000 0 1px, transparent 1px 3px)",
        }}
      />
      {/* Edge vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 100% at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
      {/* Corner suit symbols — fully contained, subtle watermark */}
      <span className="absolute left-4 top-2 select-none text-[clamp(4.5rem,9vw,8rem)] leading-none text-ivory/[0.14]">
        {"\u2660"}
      </span>
      <span className="absolute right-5 top-2 select-none text-[clamp(4.5rem,9vw,8rem)] leading-none text-pkred/[0.22]">
        {"\u2665"}
      </span>
      <span className="absolute bottom-2 left-5 select-none text-[clamp(4.5rem,9vw,8rem)] leading-none text-pkred/[0.22]">
        {"\u2666"}
      </span>
      <span className="absolute bottom-2 right-4 select-none text-[clamp(4.5rem,9vw,8rem)] leading-none text-ivory/[0.14]">
        {"\u2663"}
      </span>
    </div>
  );
}
