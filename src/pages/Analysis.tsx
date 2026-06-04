import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useGame } from "../store/GameContext";
import { PlayingCard } from "../components/PlayingCard";
import { streetLabel } from "../poker/gameEngine";
import { money, pct } from "../lib/format";
import {
  ACTION_LIKELIHOODS,
  INITIAL_BELIEF,
  LEARNING_PRIOR_ALPHA,
  LEARNING_PRIOR_DENOM,
  TIMELINE_SIMS,
} from "../data/constants";
import { learnedActionLikelihoods } from "../poker/bayesian";
import {
  HAND_CATEGORY_NAMES,
  HandCategory,
  type BeliefDistribution,
  type BeliefSnapshot,
  type BotDecision,
  type HandReport,
  type MonteCarloResult,
  type OpponentModel,
  type PlayerActionType,
} from "../types";

const COLORS = {
  player: "#e2c563", // gold — the human / player equity
  bot: "#d24a4a", // red — the bot equity
  tie: "#cdbfa6", // muted ivory
  weak: "#5fb98f",
  medium: "#e2c563",
  strong: "#d24a4a",
  grid: "rgba(244,237,228,0.08)",
  axis: "rgba(244,237,228,0.45)",
};

// ===========================================================================
// Small math helpers (display only — never recomputes engine values)
// ===========================================================================

interface Counts {
  wins: number;
  losses: number;
  ties: number;
  sims: number;
}

/** Reconstruct integer win/loss/tie counts from stored probabilities. */
function countsFrom(pWin: number, pLoss: number, pTie: number, sims: number): Counts {
  const wins = Math.round(pWin * sims);
  const losses = Math.round(pLoss * sims);
  const ties = Math.round(pTie * sims);
  return { wins, losses, ties, sims };
}

function mcCounts(mc: MonteCarloResult): Counts {
  return countsFrom(mc.pWin, mc.pLoss, mc.pTie, mc.simulations);
}

/** Win equity using the (wins + ½·ties) / sims convention. */
function equity(c: Counts): number {
  return c.sims > 0 ? (c.wins + 0.5 * c.ties) / c.sims : 0;
}

function num(v: number, digits = 3): string {
  return v.toFixed(digits);
}

// ===========================================================================
// Page
// ===========================================================================

export default function Analysis() {
  const { history, latestReport, reportFor, game } = useGame();
  const params = useParams();
  const navigate = useNavigate();

  const requested = params.handNumber ? Number(params.handNumber) : undefined;
  const report =
    (requested !== undefined ? reportFor(requested) : undefined) ?? latestReport;

  return (
    <main className="relative min-h-[100svh] text-ivory">
      <FeltBackground />
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link
              to="/game"
              className="font-display text-sm tracking-wide text-ivory/70 transition hover:text-ivory"
            >
              ← Back to table
            </Link>
            <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-gold-soft">
              Probability Analysis
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-ivory/55">
              An interactive probability lesson generated from the hand you just
              played — every number traced back to where it came from.
            </p>
          </div>
          {history.length > 0 && (
            <select
              value={report?.handNumber ?? ""}
              onChange={(e) => navigate(`/analysis/${e.target.value}`)}
              className="rounded-xl border px-4 py-2 font-display text-sm text-ivory outline-none"
              style={{ borderColor: "rgba(201,162,39,0.4)", background: "rgba(0,0,0,0.4)" }}
            >
              {history.map((r) => (
                <option key={r.handNumber} value={r.handNumber} className="bg-[#0b2218]">
                  Hand #{r.handNumber}
                </option>
              ))}
            </select>
          )}
        </header>

        {!report ? (
          <EmptyState />
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Section title="Hand Summary" wide>
              <HandSummary report={report} />
              <HowCalculated>
                <HandSummaryExplain report={report} />
              </HowCalculated>
            </Section>

            <Section
              title="Probability Timeline"
              subtitle="Full-knowledge equity by street"
            >
              {report.analysisReady ? (
                <>
                  <TimelineChart report={report} />
                  <HowCalculated label="What Does This Graph Mean?">
                    <TimelineExplain report={report} />
                  </HowCalculated>
                </>
              ) : (
                <Pending />
              )}
            </Section>

            <Section
              title="Monte Carlo Results"
              subtitle={
                report.analysisReady
                  ? `${report.monteCarlo.simulations.toLocaleString()} simulations · preflop`
                  : "Preflop"
              }
            >
              {report.analysisReady ? (
                <>
                  <MonteCarloResults report={report} />
                  <HowCalculated label="How Monte Carlo Simulation Works">
                    <MonteCarloExplain report={report} />
                  </HowCalculated>
                </>
              ) : (
                <Pending />
              )}
            </Section>

            <Section
              title="EV Decision Table"
              subtitle="Bot expected value per action"
              wide
            >
              <EvTable decisions={report.decisions} />
              <HowCalculated label="How Expected Value Was Calculated">
                <EvExplain decisions={report.decisions} />
              </HowCalculated>
            </Section>

            <Section
              title="Hand Distribution"
              subtitle="Player final made hand (Monte Carlo)"
            >
              {report.analysisReady ? (
                <>
                  <DistributionChart report={report} />
                  <HowCalculated>
                    <DistributionExplain report={report} />
                  </HowCalculated>
                </>
              ) : (
                <Pending />
              )}
            </Section>

            <Section
              title="Bayesian Belief Evolution"
              subtitle="Opponent strength belief"
            >
              <BeliefChart evolution={report.beliefEvolution} />
              <HowCalculated label="How Bayesian Updating Works">
                <BayesExplain evolution={report.beliefEvolution} />
              </HowCalculated>
            </Section>

            <Section
              title="Learned Opponent Model"
              subtitle="Likelihoods learned from showdowns"
              wide
            >
              <LearnedOpponentModel model={game.opponentModel} />
              <HowCalculated label="How The Bot Learns Your Style">
                <LearnedModelExplain model={game.opponentModel} />
              </HowCalculated>
            </Section>

            <Section
              title="Why Did The Bot Do This?"
              subtitle="Every decision, made completely transparent"
              wide
            >
              <WhyBot decisions={report.decisions} />
            </Section>

            <Section title="Hand History" wide>
              <HandHistory history={history} current={report.handNumber} />
            </Section>
          </div>
        )}
      </div>
    </main>
  );
}

// ===========================================================================
// Shared chrome
// ===========================================================================

function FeltBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1100px 700px at 50% -10%, #0f3324 0%, transparent 60%), linear-gradient(180deg, #0a1c14 0%, #060f0a 100%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 25% 30%, #f4ede4 0.5px, transparent 0.6px), radial-gradient(circle at 75% 70%, #f4ede4 0.5px, transparent 0.6px)",
          backgroundSize: "26px 26px",
        }}
      />
    </div>
  );
}

function Section({
  title,
  subtitle,
  wide,
  children,
}: {
  title: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border p-6 shadow-xl ${wide ? "lg:col-span-2" : ""}`}
      style={{
        borderColor: "rgba(201,162,39,0.28)",
        background:
          "linear-gradient(180deg, rgba(18,53,36,0.65) 0%, rgba(11,34,24,0.75) 100%)",
        boxShadow: "0 18px 40px rgba(0,0,0,0.4)",
      }}
    >
      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold tracking-wide text-gold-soft">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-xs uppercase tracking-[0.18em] text-ivory/45">
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

/** Collapsible educational accordion, collapsed by default. */
function HowCalculated({
  label = "How Was This Calculated?",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="mt-5 overflow-hidden rounded-xl border"
      style={{ borderColor: "rgba(201,162,39,0.3)", background: "rgba(0,0,0,0.28)" }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]"
      >
        <span className="flex items-center gap-2 font-display text-sm font-semibold tracking-wide text-gold-soft">
          <span className="text-base">📐</span>
          {label}
        </span>
        <span
          className="text-gold-soft transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="border-t px-4 py-4 text-sm leading-relaxed text-ivory/80"
          style={{ borderColor: "rgba(201,162,39,0.2)" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ---- Educational primitives ----------------------------------------------

function Lead({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-ivory/75">{children}</p>;
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 mt-4 font-display text-xs font-semibold uppercase tracking-[0.2em] text-gold-soft/90 first:mt-0">
      {children}
    </p>
  );
}

/** A boxed equation / derivation panel in monospace. */
function Calc({ children }: { children: ReactNode }) {
  return (
    <div
      className="my-3 overflow-x-auto rounded-lg border px-4 py-3 font-mono text-[0.8rem] leading-relaxed text-ivory/90"
      style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.35)" }}
    >
      {children}
    </div>
  );
}

/** A typeset fraction (numerator over denominator). */
function Frac({ n, d }: { n: ReactNode; d: ReactNode }) {
  return (
    <span className="mx-1 inline-flex flex-col items-center align-middle">
      <span className="px-2 pb-0.5">{n}</span>
      <span
        className="w-full px-2 pt-0.5"
        style={{ borderTop: "1px solid rgba(244,237,228,0.5)" }}
      >
        {d}
      </span>
    </span>
  );
}

function Why({ children }: { children: ReactNode }) {
  return (
    <div
      className="mt-3 rounded-lg border-l-2 px-3 py-2 text-ivory/70"
      style={{ borderColor: "#c9a227", background: "rgba(201,162,39,0.08)" }}
    >
      <span className="font-display text-xs font-semibold uppercase tracking-wider text-gold-soft">
        Why it mattered
      </span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Pending() {
  return (
    <div className="flex h-[200px] flex-col items-center justify-center gap-3 text-sm text-ivory/55">
      <span className="h-2 w-2 animate-pulse rounded-full bg-gold-soft" />
      Generating simulations…
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-16 flex flex-col items-center gap-4 text-center">
      <p className="text-ivory/60">
        No completed hands yet. Play a hand to generate a probability report.
      </p>
      <Link
        to="/game"
        className="rounded-xl border border-pkred-light/70 bg-pkred/80 px-6 py-3 font-display font-semibold text-ivory transition hover:-translate-y-0.5 hover:bg-pkred-light"
      >
        Go to table
      </Link>
    </div>
  );
}

// ===========================================================================
// 1. Hand Summary
// ===========================================================================

function HandSummary({ report }: { report: HandReport }) {
  const winnerLabel =
    report.winner === "split" ? "Split pot" : report.winner === "player" ? "You" : "Bot";

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div className="space-y-4">
        <CardRow label="Your cards" cards={report.playerHole} />
        <CardRow label="Bot cards" cards={report.botHole} />
        <CardRow label="Community" cards={report.community} muted />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Winner" value={winnerLabel} highlight />
        <Stat label="Pot" value={money(report.potWon)} />
        <Stat label="Your hand" value={report.playerFinal?.name ?? "—"} />
        <Stat label="Bot hand" value={report.botFinal?.name ?? "—"} />
        <Stat label="Ended on" value={streetLabel(report.endStreet)} />
        <Stat label="Showdown" value={report.wentToShowdown ? "Yes" : "Fold"} />
      </div>
    </div>
  );
}

function HandSummaryExplain({ report }: { report: HandReport }) {
  return (
    <>
      <Heading>What this is</Heading>
      <Lead>
        The factual record of the hand: the two private hole cards each side
        held, the shared community board, and how the pot was settled. Every
        probability elsewhere on this page is derived from these exact cards — no
        outcome is hardcoded.
      </Lead>
      <Heading>This hand</Heading>
      <Lead>
        You held {report.playerHole.map((c) => c.id).join(" ")} and the bot held{" "}
        {report.botHole.length ? report.botHole.map((c) => c.id).join(" ") : "—"}.
        {report.community.length > 0
          ? ` ${report.community.length} community card${
              report.community.length === 1 ? "" : "s"
            } were dealt (${report.community.map((c) => c.id).join(" ")}).`
          : " No community cards were dealt."}{" "}
        The hand ended on the {streetLabel(report.endStreet)}{" "}
        {report.wentToShowdown ? "at showdown" : "when a player folded"}, and{" "}
        {report.winner === "split" ? "the pot was split" : `${report.winner} won ${money(report.potWon)}`}.
      </Lead>
      <Why>
        Knowing both hole hands lets us replay the hand with full information and
        measure exactly how strong each decision really was, in hindsight.
      </Why>
    </>
  );
}

function CardRow({
  label,
  cards,
  muted,
}: {
  label: string;
  cards: HandReport["playerHole"];
  muted?: boolean;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs uppercase tracking-wider text-ivory/50">{label}</p>
      <div className="flex gap-1.5">
        {cards.length === 0 && (
          <span className="text-sm text-ivory/40">No cards dealt</span>
        )}
        {cards.map((c) => (
          <PlayingCard key={c.id} card={c} size="sm" />
        ))}
        {muted && cards.length < 5 && <span />}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-xl border p-3"
      style={{ borderColor: "rgba(244,237,228,0.14)", background: "rgba(0,0,0,0.25)" }}
    >
      <p className="text-xs uppercase tracking-wider text-ivory/45">{label}</p>
      <p
        className={`mt-1 font-display text-lg font-semibold ${
          highlight ? "text-gold-soft" : "text-ivory"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// ===========================================================================
// 2. Probability Timeline
// ===========================================================================

function TimelineChart({ report }: { report: HandReport }) {
  const data = report.timeline.map((t) => ({
    street: t.street,
    Player: +(t.playerWin * 100).toFixed(1),
    Bot: +(t.botWin * 100).toFixed(1),
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
        <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
        <XAxis dataKey="street" stroke={COLORS.axis} fontSize={12} />
        <YAxis
          stroke={COLORS.axis}
          fontSize={12}
          domain={[0, 100]}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
        <Legend />
        <Line type="monotone" dataKey="Player" stroke={COLORS.player} strokeWidth={3} dot={{ r: 4 }} />
        <Line type="monotone" dataKey="Bot" stroke={COLORS.bot} strokeWidth={3} dot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function TimelineExplain({ report }: { report: HandReport }) {
  const last = report.timeline[report.timeline.length - 1];
  const c = last
    ? countsFrom(last.playerWin, last.botWin, last.tie, TIMELINE_SIMS)
    : null;

  return (
    <>
      <Heading>What this is</Heading>
      <Lead>
        Each point is your <em>full-knowledge equity</em> — the probability you
        win the hand if the cards were run out from that street, given both hole
        hands. As more board cards become known, uncertainty collapses and the
        line moves toward 0% or 100%.
      </Lead>
      <Heading>How information changes the odds</Heading>
      <ul className="mb-3 space-y-1.5 text-ivory/75">
        <li>
          <strong className="text-gold-soft">Preflop</strong> — 5 board cards
          unknown. Equity is close to a coin flip for most matchups.
        </li>
        <li>
          <strong className="text-gold-soft">Flop</strong> — 3 of 5 cards
          revealed. Equity swings sharply toward whoever connected.
        </li>
        <li>
          <strong className="text-gold-soft">Turn</strong> — 1 card left to
          come; only a handful of outs can still change the result.
        </li>
        <li>
          <strong className="text-gold-soft">River</strong> — 0 unknown cards.
          The winner is decided, so equity is exactly 100% or 0%.
        </li>
      </ul>
      {c && (
        <>
          <Heading>This hand — {last!.street}</Heading>
          <Lead>
            At the {last!.street}, {TIMELINE_SIMS.toLocaleString()} random
            roll-outs of the remaining board produced:
          </Lead>
          <Calc>
            Wins = {c.wins} &nbsp; Losses = {c.losses} &nbsp; Ties = {c.ties}
            <div className="mt-3 flex flex-wrap items-center gap-1">
              Equity =
              <Frac
                n={<>Wins + 0.5 × Ties</>}
                d={<>Simulations</>}
              />
              =
              <Frac
                n={<>{c.wins} + 0.5 × {c.ties}</>}
                d={<>{c.sims.toLocaleString()}</>}
              />
              = <span className="text-gold-soft">{pct(equity(c))}</span>
            </div>
          </Calc>
        </>
      )}
      <Why>
        Watching equity jump between streets is the clearest picture of how each
        community card transfers information — and value — from one player to the
        other.
      </Why>
    </>
  );
}

// ===========================================================================
// 3. Monte Carlo Results
// ===========================================================================

function MonteCarloResults({ report }: { report: HandReport }) {
  const mc = report.monteCarlo;
  const rows = [
    { label: "Player wins", value: mc.pWin, color: COLORS.player },
    { label: "Bot wins", value: mc.pLoss, color: COLORS.bot },
    { label: "Ties", value: mc.pTie, color: COLORS.tie },
  ];

  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex justify-between text-sm">
            <span className="text-ivory/75">{r.label}</span>
            <span className="font-mono text-ivory">{pct(r.value)}</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(0,0,0,0.4)" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(r.value * 100, 0)}%`, backgroundColor: r.color }}
            />
          </div>
        </div>
      ))}
      <p className="pt-2 text-xs text-ivory/45">
        From {mc.simulations.toLocaleString()} randomized roll-outs of the
        remaining board, both hole hands known.
      </p>
    </div>
  );
}

function MonteCarloExplain({ report }: { report: HandReport }) {
  const mc = report.monteCarlo;
  const c = mcCounts(mc);

  return (
    <>
      <Heading>The idea</Heading>
      <Lead>
        Counting every possible board exactly is expensive, so we{" "}
        <em>estimate</em> the odds by simulating thousands of random futures and
        tallying how often each side wins. This is the Monte Carlo method: trade
        a closed-form count for a large random sample.
      </Lead>
      <Heading>Known vs. unknown information</Heading>
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border p-3" style={{ borderColor: "rgba(95,185,143,0.4)", background: "rgba(95,185,143,0.08)" }}>
          <p className="font-display text-xs font-semibold uppercase tracking-wider text-[#7fd3a8]">Known</p>
          <ul className="mt-1 space-y-0.5 text-ivory/75">
            <li>Player cards: {report.playerHole.map((c) => c.id).join(" ")}</li>
            <li>
              Community: {report.community.length ? report.community.map((c) => c.id).join(" ") : "none yet"}
            </li>
          </ul>
        </div>
        <div className="rounded-lg border p-3" style={{ borderColor: "rgba(210,74,74,0.4)", background: "rgba(210,74,74,0.08)" }}>
          <p className="font-display text-xs font-semibold uppercase tracking-wider text-[#e58a8a]">Unknown</p>
          <ul className="mt-1 space-y-0.5 text-ivory/75">
            <li>Opponent's hole cards</li>
            <li>Future community cards</li>
          </ul>
        </div>
      </div>
      <Lead>
        Each simulation deals random cards into the unknown slots from the
        remaining deck, completes the board, and scores both five-card hands.
        Over {c.sims.toLocaleString()} simulations this hand produced:
      </Lead>
      <Calc>
        Wins = {c.wins} &nbsp; Losses = {c.losses} &nbsp; Ties = {c.ties}
        <div className="mt-3 flex flex-wrap items-center gap-1">
          Est. Win Probability =
          <Frac n={<>Wins + 0.5 × Ties</>} d={<>Simulations</>} />
          =
          <Frac n={<>{c.wins} + 0.5 × {c.ties}</>} d={<>{c.sims.toLocaleString()}</>} />
          = <span className="text-gold-soft">{pct(equity(c))}</span>
        </div>
      </Calc>
      <Why>
        With ~{c.sims.toLocaleString()} samples the estimate is accurate to
        roughly ±{(100 / Math.sqrt(Math.max(c.sims, 1))).toFixed(1)} percentage
        points — precise enough to drive every betting decision while staying
        fast enough to feel instant.
      </Why>
    </>
  );
}

// ===========================================================================
// 4. EV Decision Table
// ===========================================================================

function EvTable({ decisions }: { decisions: BotDecision[] }) {
  if (decisions.length === 0) {
    return <p className="text-sm text-ivory/55">The bot made no decisions this hand.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-ivory/45">
            <th className="py-2 pr-4">Street</th>
            <th className="py-2 pr-4">P(win)</th>
            <th className="py-2 pr-4">EV Fold</th>
            <th className="py-2 pr-4">EV Call</th>
            <th className="py-2 pr-4">EV Bet</th>
            <th className="py-2 pr-4">EV Raise</th>
            <th className="py-2 pr-4">Chosen</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {decisions.map((d, i) => (
            <tr key={i} className="border-t" style={{ borderColor: "rgba(244,237,228,0.1)" }}>
              <td className="py-2.5 pr-4 font-sans text-ivory/80">{streetLabel(d.street)}</td>
              <td className="py-2.5 pr-4 text-ivory">{pct(d.monteCarlo.pWin)}</td>
              <Ev value={d.ev.evFold} chosen={d.chosen === "fold"} />
              <Ev value={d.ev.evCall} chosen={d.chosen === "call"} />
              <Ev value={d.ev.evBet} chosen={d.chosen === "bet"} />
              <Ev value={d.ev.evRaise} chosen={d.chosen === "raise"} />
              <td className="py-2.5 pr-4">
                <span
                  className="rounded-md px-2 py-1 font-sans text-xs font-semibold uppercase text-gold-soft"
                  style={{ background: "rgba(201,162,39,0.15)" }}
                >
                  {d.chosen}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-ivory/45">
        EV in chips. The bot picks the highest. Check is treated as a zero-cost
        call when no bet is faced.
      </p>
    </div>
  );
}

function Ev({ value, chosen }: { value: number | null; chosen: boolean }) {
  if (value === null) {
    return <td className="py-2.5 pr-4 text-ivory/35">—</td>;
  }
  const pos = value >= 0;
  return (
    <td
      className={`py-2.5 pr-4 ${
        chosen ? "font-bold text-gold-soft" : pos ? "text-[#7fd3a8]" : "text-[#e58a8a]"
      }`}
    >
      {pos ? "+" : "−"}${Math.abs(value).toFixed(1)}
    </td>
  );
}

function EvExplain({ decisions }: { decisions: BotDecision[] }) {
  const d = decisions.find((x) => x.toCall > 0) ?? decisions[decisions.length - 1];

  return (
    <>
      <Heading>What expected value means</Heading>
      <Lead>
        Expected value (EV) is the average chips an action wins or loses if the
        situation were repeated forever. The bot computes EV for every legal
        action and plays the largest. In general form:
      </Lead>
      <Calc>
        EV = P(win) × Gain + P(loss) × Loss + P(tie) × TieValue
      </Calc>
      <Lead>
        Folding is the zero baseline (risk nothing, win nothing). For a call you
        win the current pot when ahead and lose only the chips you put in, so
        <strong className="text-ivory"> Gain = pot</strong>,{" "}
        <strong className="text-ivory">Loss = −(chips to call)</strong>, and ties
        are chip-neutral.
      </Lead>

      {d ? (
        <>
          <Heading>This hand — {streetLabel(d.street)} decision</Heading>
          <Calc>
            P(win) = {num(d.monteCarlo.pWin)} &nbsp; P(loss) = {num(d.monteCarlo.pLoss)} &nbsp; P(tie) = {num(d.monteCarlo.pTie)}
            {d.toCall > 0 ? (
              <div className="mt-3">
                EV(Call) = P(win) × pot − P(loss) × call
                <div className="mt-1">
                  = {num(d.monteCarlo.pWin, 2)} × {d.potBefore} − {num(d.monteCarlo.pLoss, 2)} × {d.toCall}
                </div>
                <div className="mt-1">
                  = <span className="text-gold-soft">
                    {d.ev.evCall !== null
                      ? `${d.ev.evCall >= 0 ? "+" : "−"}$${Math.abs(d.ev.evCall).toFixed(1)}`
                      : "—"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-3">
                EV(Check) = P(win) × pot = {num(d.monteCarlo.pWin, 2)} × {d.potBefore}
                <div className="mt-1">
                  = <span className="text-gold-soft">
                    {d.ev.evCheck !== null
                      ? `${d.ev.evCheck >= 0 ? "+" : "−"}$${Math.abs(d.ev.evCheck).toFixed(1)}`
                      : "—"}
                  </span>
                </div>
              </div>
            )}
          </Calc>
          <Heading>Why this action was chosen</Heading>
          <EvCompare d={d} />
          <Why>
            The bot never guesses or bluffs — it simply selects the action with
            the highest expected value given its current win probability.
          </Why>
        </>
      ) : (
        <Lead>The bot made no decisions this hand, so there is no EV to break down.</Lead>
      )}
    </>
  );
}

function EvCompare({ d }: { d: BotDecision }) {
  const rows: { label: string; value: number | null }[] = [
    { label: "EV(Fold)", value: d.ev.evFold },
    { label: "EV(Check)", value: d.ev.evCheck },
    { label: "EV(Call)", value: d.ev.evCall },
    { label: "EV(Bet)", value: d.ev.evBet },
    { label: "EV(Raise)", value: d.ev.evRaise },
  ].filter((r) => r.value !== null);

  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const chosen = r.label.toLowerCase().includes(d.chosen);
        return (
          <div
            key={r.label}
            className="flex items-center justify-between rounded-md px-3 py-1.5 font-mono text-sm"
            style={{
              background: chosen ? "rgba(201,162,39,0.15)" : "rgba(0,0,0,0.25)",
              border: chosen ? "1px solid rgba(201,162,39,0.5)" : "1px solid transparent",
            }}
          >
            <span className={chosen ? "text-gold-soft" : "text-ivory/70"}>{r.label}</span>
            <span className={chosen ? "font-bold text-gold-soft" : "text-ivory/80"}>
              {r.value! >= 0 ? "+" : "−"}${Math.abs(r.value!).toFixed(1)}
              {chosen ? "  ← chosen" : ""}
            </span>
          </div>
        );
      })}
      <p className="pt-1 text-ivory/70">
        The selected action — <strong className="uppercase text-gold-soft">{d.chosen}</strong> —
        had the highest expected value.
      </p>
    </div>
  );
}

// ===========================================================================
// 5. Hand Distribution
// ===========================================================================

const CATEGORY_ORDER: HandCategory[] = [
  HandCategory.HighCard,
  HandCategory.Pair,
  HandCategory.TwoPair,
  HandCategory.ThreeOfAKind,
  HandCategory.Straight,
  HandCategory.Flush,
  HandCategory.FullHouse,
  HandCategory.FourOfAKind,
  HandCategory.StraightFlush,
];

function DistributionChart({ report }: { report: HandReport }) {
  const data = CATEGORY_ORDER.map((cat) => ({
    name: HAND_CATEGORY_NAMES[cat],
    prob: +(report.monteCarlo.categoryFrequencies[cat] * 100).toFixed(2),
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 28 }}>
        <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" stroke={COLORS.axis} fontSize={11} tickFormatter={(v) => `${v}%`} />
        <YAxis type="category" dataKey="name" stroke={COLORS.axis} fontSize={11} width={90} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
        <Bar dataKey="prob" radius={[0, 4, 4, 0]} fill={COLORS.player} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function DistributionExplain({ report }: { report: HandReport }) {
  const mc = report.monteCarlo;
  const top = CATEGORY_ORDER.map((cat) => ({
    name: HAND_CATEGORY_NAMES[cat],
    p: mc.categoryFrequencies[cat],
  }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);

  return (
    <>
      <Heading>What this is</Heading>
      <Lead>
        A <em>conditional probability distribution</em>: given your two hole
        cards, how often does each final five-card category appear once the board
        is complete? It is the same {mc.simulations.toLocaleString()}-simulation
        run, but instead of win/loss we record the <em>category</em> of your best
        hand.
      </Lead>
      <Heading>How it is computed</Heading>
      <Calc>
        P(category) =
        <Frac n={<>times that category occurred</>} d={<>{mc.simulations.toLocaleString()} simulations</>} />
      </Calc>
      {top.length > 0 && (
        <>
          <Heading>This hand — most likely results</Heading>
          <ul className="space-y-1 text-ivory/75">
            {top.map((t) => (
              <li key={t.name} className="flex justify-between">
                <span>{t.name}</span>
                <span className="font-mono text-gold-soft">
                  {pct(t.p)} ≈ {Math.round(t.p * mc.simulations).toLocaleString()} sims
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Why>
        Two players can share the same win probability with very different
        distributions — a hand that makes flushes plays differently from one that
        makes top pair. Shape, not just average, drives strategy.
      </Why>
    </>
  );
}

// ===========================================================================
// 6. Bayesian Belief Evolution
// ===========================================================================

function BeliefChart({ evolution }: { evolution: BeliefSnapshot[] }) {
  const data = evolution.map((s, i) => ({
    stage:
      s.triggerAction === null
        ? "Prior"
        : `${streetLabel(s.street)} ${s.triggerAction}`.slice(0, 16),
    key: i,
    Weak: +(s.after.weak * 100).toFixed(1),
    Medium: +(s.after.medium * 100).toFixed(1),
    Strong: +(s.after.strong * 100).toFixed(1),
  }));

  return (
    <div>
      <ResponsiveContainer width="100%" height={230}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
          <XAxis dataKey="stage" stroke={COLORS.axis} fontSize={10} interval={0} />
          <YAxis stroke={COLORS.axis} fontSize={12} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
          <Legend />
          <Line type="monotone" dataKey="Weak" stroke={COLORS.weak} strokeWidth={2.5} />
          <Line type="monotone" dataKey="Medium" stroke={COLORS.medium} strokeWidth={2.5} />
          <Line type="monotone" dataKey="Strong" stroke={COLORS.strong} strokeWidth={2.5} />
        </LineChart>
      </ResponsiveContainer>
      {evolution.length <= 1 && (
        <p className="mt-2 text-xs text-ivory/45">
          Beliefs start at the prior and update after each of your actions.
        </p>
      )}
    </div>
  );
}

function tierRow(b: BeliefDistribution) {
  return `weak ${pct(b.weak)} · medium ${pct(b.medium)} · strong ${pct(b.strong)}`;
}

function BayesExplain({ evolution }: { evolution: BeliefSnapshot[] }) {
  // First real update (an actual observed player action), else null.
  const update = evolution.find((s) => s.triggerAction !== null);

  return (
    <>
      <Heading>The question</Heading>
      <Lead>
        The bot can't see your cards, so it keeps a probability distribution over
        how strong your hand is — <em>weak</em>, <em>medium</em>, or{" "}
        <em>strong</em>. After every action you take, it revises that belief
        using Bayes' theorem.
      </Lead>

      <Heading>Prior</Heading>
      <Lead>
        Before any action, beliefs start at the model's preflop prior:
      </Lead>
      <Calc>
        P(weak) = {num(INITIAL_BELIEF.weak, 2)} &nbsp; P(medium) ={" "}
        {num(INITIAL_BELIEF.medium, 2)} &nbsp; P(strong) = {num(INITIAL_BELIEF.strong, 2)}
      </Calc>

      <Heading>Bayes' rule</Heading>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(H | A) =
          <Frac
            n={<>P(A | H) · P(H)</>}
            d={<>Σ&#8202;ᵢ P(A | Hᵢ) · P(Hᵢ)</>}
          />
        </div>
        <p className="mt-2 text-ivory/60">
          H = hidden strength tier, A = the action you just took.
        </p>
      </Calc>

      {update ? (
        <BayesWorked snapshot={update} />
      ) : (
        <Lead>
          You took no action that updated the model this hand (e.g. the hand
          ended preflop), so beliefs stayed at the prior.
        </Lead>
      )}

      <Why>
        This is conditional probability in action: the bot literally reasons
        “given that you raised, how likely is each hand strength?” and lets the
        math — not a hunch — reshape its read after every move.
      </Why>
    </>
  );
}

function BayesWorked({ snapshot }: { snapshot: BeliefSnapshot }) {
  const action = snapshot.triggerAction as PlayerActionType;
  const prior = snapshot.before;
  // Use the likelihoods actually applied for this update (the learned values),
  // falling back to the defaults for older snapshots that predate learning.
  const like = snapshot.likelihood ?? ACTION_LIKELIHOODS[action];

  const num_w = like.weak * prior.weak;
  const num_m = like.medium * prior.medium;
  const num_s = like.strong * prior.strong;
  const z = num_w + num_m + num_s;
  const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);

  return (
    <>
      <Heading>Observed action — {streetLabel(snapshot.street)}</Heading>
      <Lead>
        You chose to <strong className="text-gold-soft uppercase">{actionLabel}</strong>.
        The opponent model supplies the likelihood of that action for each tier:
      </Lead>
      <Calc>
        P({actionLabel} | weak) = {num(like.weak, 2)}
        <br />
        P({actionLabel} | medium) = {num(like.medium, 2)}
        <br />
        P({actionLabel} | strong) = {num(like.strong, 2)}
      </Calc>

      <Heading>Posterior (this update)</Heading>
      <Calc>
        <div>Numerators = likelihood × prior:</div>
        <div className="mt-1">
          weak: &nbsp;{num(like.weak, 2)} × {num(prior.weak, 2)} = {num(num_w, 4)}
        </div>
        <div>
          medium: {num(like.medium, 2)} × {num(prior.medium, 2)} = {num(num_m, 4)}
        </div>
        <div>
          strong: {num(like.strong, 2)} × {num(prior.strong, 2)} = {num(num_s, 4)}
        </div>
        <div className="mt-2">
          Normalizer Σ = {num(num_w, 4)} + {num(num_m, 4)} + {num(num_s, 4)} ={" "}
          {num(z, 4)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          P(strong | {actionLabel}) =
          <Frac n={<>{num(num_s, 4)}</>} d={<>{num(z, 4)}</>} />=
          <span className="text-gold-soft">{pct(snapshot.after.strong)}</span>
        </div>
      </Calc>
      <div
        className="grid grid-cols-2 gap-3 rounded-lg border p-3"
        style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.25)" }}
      >
        <div>
          <p className="text-xs uppercase tracking-wider text-ivory/45">Prior</p>
          <p className="mt-1 font-mono text-xs text-ivory/80">{tierRow(prior)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-gold-soft/80">Posterior</p>
          <p className="mt-1 font-mono text-xs text-gold-soft">{tierRow(snapshot.after)}</p>
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// 6b. Learned Opponent Model
// ===========================================================================

const LEARNED_ACTIONS: { action: PlayerActionType; label: string }[] = [
  { action: "raise", label: "Raise" },
  { action: "call", label: "Call" },
  { action: "bet", label: "Bet" },
  { action: "check", label: "Check" },
  { action: "fold", label: "Fold" },
];

const TIERS: { key: keyof OpponentModel; label: string; color: string }[] = [
  { key: "weak", label: "Weak", color: COLORS.weak },
  { key: "medium", label: "Medium", color: COLORS.medium },
  { key: "strong", label: "Strong", color: COLORS.strong },
];

function LearnedOpponentModel({ model }: { model: OpponentModel }) {
  const likelihoods = learnedActionLikelihoods(model);
  const totalObserved = model.weak.total + model.medium.total + model.strong.total;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {TIERS.map((t) => (
          <div
            key={t.key}
            className="rounded-xl border p-3 text-center"
            style={{ borderColor: "rgba(244,237,228,0.14)", background: "rgba(0,0,0,0.25)" }}
          >
            <p className="text-xs uppercase tracking-wider" style={{ color: t.color }}>
              {t.label} hands observed
            </p>
            <p className="mt-1 font-display text-2xl font-semibold text-ivory">
              {model[t.key].total}
            </p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-ivory/45">
              <th className="py-2 pr-4">P(action | tier)</th>
              {TIERS.map((t) => (
                <th key={t.key} className="py-2 pr-4" style={{ color: t.color }}>
                  {t.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {LEARNED_ACTIONS.map(({ action, label }) => (
              <tr key={action} className="border-t" style={{ borderColor: "rgba(244,237,228,0.1)" }}>
                <td className="py-2.5 pr-4 font-sans text-ivory/80">P({label} | ·)</td>
                {TIERS.map((t) => (
                  <td key={t.key} className="py-2.5 pr-4 text-ivory">
                    {pct(likelihoods[action][t.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ivory/55">
        {totalObserved === 0
          ? "No showdowns observed yet — these are the Beta-prior starting values (~20% each). Play hands to the showdown and the bot will start adapting."
          : `Updated from ${totalObserved} revealed hand${
              totalObserved === 1 ? "" : "s"
            }. The bot continuously updates these likelihoods after every showdown and uses them as priors for future Bayesian inference.`}
      </p>
    </div>
  );
}

function LearnedModelExplain({ model }: { model: OpponentModel }) {
  // Pick the tier with the most data to show a concrete worked example.
  const richest = TIERS.reduce((best, t) =>
    model[t.key].total > model[best.key].total ? t : best
  , TIERS[0]);
  const stats = model[richest.key];
  const raiseP = (stats.raises + LEARNING_PRIOR_ALPHA) / (stats.total + LEARNING_PRIOR_DENOM);

  return (
    <>
      <Heading>The idea</Heading>
      <Lead>
        Instead of fixed, hand-coded likelihoods, the bot <em>learns</em> how you
        play. Whenever a hand reaches showdown your real cards are revealed, so it
        can classify your true strength tier — <em>weak</em>, <em>medium</em>, or{" "}
        <em>strong</em> — and record which actions you took. Those tallies persist
        for the whole session and become the likelihoods used in every future
        Bayesian update.
      </Lead>

      <Heading>Beta-prior smoothing</Heading>
      <Lead>
        Raw frequencies would swing wildly after one or two hands, so each
        probability is smoothed with a Beta prior. Before any data, every action
        sits at ~20%; observations pull it gradually toward the truth:
      </Lead>
      <Calc>
        <div className="flex flex-wrap items-center gap-1">
          P(action | tier) =
          <Frac
            n={<>handsWithAction + {LEARNING_PRIOR_ALPHA}</>}
            d={<>handsObserved + {LEARNING_PRIOR_DENOM}</>}
          />
        </div>
      </Calc>

      <Heading>This session — {richest.label.toLowerCase()} hands</Heading>
      {stats.total > 0 ? (
        <Calc>
          <div>
            {richest.label} hands observed = {stats.total} &nbsp; raised in{" "}
            {stats.raises} of them
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            P(Raise | {richest.label.toLowerCase()}) =
            <Frac
              n={<>{stats.raises} + {LEARNING_PRIOR_ALPHA}</>}
              d={<>{stats.total} + {LEARNING_PRIOR_DENOM}</>}
            />
            = <span className="text-gold-soft">{pct(raiseP)}</span>
          </div>
        </Calc>
      ) : (
        <Lead>
          No showdowns yet, so every likelihood is still at its ~20% prior. After
          a few revealed hands these numbers start reflecting your real tendencies.
        </Lead>
      )}

      <Why>
        A raise from a player who keeps showing up with weak hands gets read very
        differently from a raise by a tight player. By feeding observed behavior
        back into P(action | tier), the bot adapts to <em>you</em> rather than
        playing a fixed, generic model.
      </Why>
    </>
  );
}

// ===========================================================================
// 7. Why Did The Bot Do This?
// ===========================================================================

function WhyBot({ decisions }: { decisions: BotDecision[] }) {
  if (decisions.length === 0) {
    return (
      <p className="text-sm text-ivory/55">
        The bot faced no decisions this hand — it was never its turn to act
        against a live bet.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {decisions.map((d, i) => (
        <DecisionCard key={i} d={d} index={i + 1} />
      ))}
    </div>
  );
}

function DecisionCard({ d, index }: { d: BotDecision; index: number }) {
  const rows: { label: string; value: number | null }[] = [
    { label: "EV(Fold)", value: d.ev.evFold },
    { label: "EV(Check)", value: d.ev.evCheck },
    { label: "EV(Call)", value: d.ev.evCall },
    { label: "EV(Bet)", value: d.ev.evBet },
    { label: "EV(Raise)", value: d.ev.evRaise },
  ].filter((r) => r.value !== null);

  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: "rgba(201,162,39,0.25)", background: "rgba(0,0,0,0.25)" }}
    >
      <div className="flex items-center justify-between">
        <span className="font-display text-sm font-semibold tracking-wide text-gold-soft">
          {index}. {streetLabel(d.street)}
        </span>
        <span
          className="rounded-md px-2.5 py-1 text-xs font-semibold uppercase text-ivory"
          style={{ background: "rgba(122,0,25,0.65)", border: "1px solid rgba(163,2,34,0.7)" }}
        >
          {d.chosen}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-ivory/80">
        <span>P(win) = <span className="text-gold-soft">{pct(d.monteCarlo.pWin)}</span></span>
        <span>P(loss) = {pct(d.monteCarlo.pLoss)}</span>
        <span>pot = ${d.potBefore}</span>
        {d.toCall > 0 && <span>to call = ${d.toCall}</span>}
      </div>

      <div className="mt-3 space-y-1">
        {rows.map((r) => {
          const chosen = r.label.toLowerCase().includes(d.chosen);
          return (
            <div
              key={r.label}
              className="flex items-center justify-between rounded px-2 py-1 font-mono text-xs"
              style={{
                background: chosen ? "rgba(201,162,39,0.15)" : "transparent",
              }}
            >
              <span className={chosen ? "text-gold-soft" : "text-ivory/60"}>{r.label}</span>
              <span className={chosen ? "font-bold text-gold-soft" : "text-ivory/75"}>
                {r.value! >= 0 ? "+" : "−"}${Math.abs(r.value!).toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-ivory/60">
        Chosen <strong className="uppercase text-gold-soft">{d.chosen}</strong> —
        the highest expected value among all legal actions.
      </p>
    </div>
  );
}

// ===========================================================================
// 8. Hand History
// ===========================================================================

function HandHistory({ history, current }: { history: HandReport[]; current: number }) {
  if (history.length === 0) {
    return <p className="text-sm text-ivory/55">No hands played yet.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {history
        .slice()
        .reverse()
        .map((r) => {
          const win =
            r.winner === "player" ? "You won" : r.winner === "bot" ? "Bot won" : "Split";
          const active = r.handNumber === current;
          return (
            <Link
              key={r.handNumber}
              to={`/analysis/${r.handNumber}`}
              className="rounded-xl border p-3 transition hover:-translate-y-0.5"
              style={{
                borderColor: active ? "rgba(201,162,39,0.6)" : "rgba(244,237,228,0.14)",
                background: active ? "rgba(201,162,39,0.1)" : "rgba(0,0,0,0.25)",
              }}
            >
              <p className="font-display text-sm font-semibold text-ivory">
                Hand #{r.handNumber}
              </p>
              <p className="text-xs text-ivory/55">{win}</p>
              <p className="mt-1 font-mono text-xs text-gold-soft/80">{money(r.potWon)}</p>
            </Link>
          );
        })}
    </div>
  );
}

const tooltipStyle = {
  background: "#0b2218",
  border: "1px solid rgba(201,162,39,0.35)",
  borderRadius: "0.75rem",
  color: "#f4ede4",
  fontSize: "12px",
} as const;
