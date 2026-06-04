import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useGame } from "../store/GameContext";
import { PlayingCard } from "../components/PlayingCard";
import { streetLabel } from "../poker/gameEngine";
import { money } from "../lib/format";
import type { ChipFx, ThinkStep } from "../store/GameContext";
import type { LegalAction, Seat } from "../types";

const ACTION_STYLES: Record<string, string> = {
  fold: "border border-ivory/25 bg-black/30 text-ivory/80 hover:border-ivory/50 hover:text-ivory",
  check: "border border-gold/50 bg-gold/15 text-gold-soft hover:bg-gold/25",
  call: "border border-gold/60 bg-gold/20 text-gold-soft hover:bg-gold/30",
  bet: "border border-pkred-light/70 bg-pkred/70 text-ivory hover:bg-pkred-light",
  raise: "border border-pkred-light/70 bg-pkred/70 text-ivory hover:bg-pkred-light",
};

export default function Game() {
  const { game, legalActions, fx, playerAct, nextHand, newGame } = useGame();
  const navigate = useNavigate();

  const handOver = game.status === "hand-over" || game.status === "game-over";
  const revealBot = handOver;
  const toCall = Math.max(0, game.currentBet - game.streetCommit.player);
  const playerIsDealer = game.dealer === "player";

  return (
    <main className="relative min-h-[100svh] overflow-hidden text-ivory">
      <FeltBackground />

      <div className="relative z-10 mx-auto flex min-h-[100svh] max-w-5xl flex-col px-4 pb-6 pt-5">
        <TopBar handNumber={game.handNumber} />

        {/* ---------------------------- Table ---------------------------- */}
        <div
          className="relative mt-5 flex flex-1 flex-col justify-between rounded-[2.5rem] border p-6 shadow-2xl"
          style={{
            borderColor: "rgba(201,162,39,0.35)",
            background:
              "radial-gradient(120% 90% at 50% 18%, #1a4a32 0%, #123524 45%, #0b2218 100%)",
            boxShadow:
              "0 30px 70px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(11,34,24,0.6), inset 0 0 120px rgba(0,0,0,0.45)",
          }}
        >
          <Deck />

          {/* Bot seat — top center */}
          <div className="flex justify-center">
            <Seat
              name="Probability Bot"
              avatar={"\u{1F916}"}
              bankroll={game.botBankroll}
              committed={game.streetCommit.bot}
              active={game.toAct === "bot" && game.status === "playing"}
              isDealer={!playerIsDealer}
              bubble={fx.botBubble}
              thought={fx.thinking}
              bubbleSide="bottom"
              cardsAfter
            >
              <PlayingCard card={game.botHole[0]} faceDown={!revealBot} size="md" />
              <PlayingCard card={game.botHole[1]} faceDown={!revealBot} size="md" />
            </Seat>
          </div>

          {/* Center — street, pot, community */}
          <div className="relative my-4 flex flex-col items-center gap-4">
            <div className="flex items-center gap-3">
              <span
                className="rounded-full border px-4 py-1 font-display text-xs font-semibold uppercase tracking-[0.3em]"
                style={{
                  borderColor: "rgba(201,162,39,0.4)",
                  color: "#e2c563",
                  background: "rgba(0,0,0,0.25)",
                }}
              >
                {streetLabel(game.street)}
              </span>
            </div>

            <div
              className="pp-pot-glow rounded-2xl border px-6 py-2 text-center"
              style={{
                borderColor: "rgba(201,162,39,0.45)",
                background: "rgba(0,0,0,0.3)",
              }}
            >
              <div className="text-[0.6rem] uppercase tracking-[0.35em] text-ivory/55">
                Pot
              </div>
              <div className="font-display text-3xl font-bold text-gold-soft">
                {money(game.pot)}
              </div>
            </div>

            <div className="relative flex min-h-[9rem] items-center justify-center gap-3">
              {[0, 1, 2, 3, 4].map((i) => {
                const c = game.community[i];
                const dealt = i < fx.dealtCount && !!c;
                return dealt ? (
                  <div key={`c-${i}`} className="pp-deal">
                    <PlayingCard card={c} size="xl" />
                  </div>
                ) : (
                  <div
                    key={`s-${i}`}
                    className="h-36 w-[6.5rem] rounded-2xl border border-dashed"
                    style={{ borderColor: "rgba(244,237,228,0.14)" }}
                  />
                );
              })}

              <ChipLayer chips={fx.chips} />
            </div>
          </div>

          {/* Player seat — bottom center */}
          <div className="flex justify-center">
            <Seat
              name="You"
              avatar={"\u{1F9D1}"}
              bankroll={game.playerBankroll}
              committed={game.streetCommit.player}
              active={game.toAct === "player" && game.status === "playing"}
              isDealer={playerIsDealer}
              bubble={fx.playerBubble}
              bubbleSide="top"
            >
              <PlayingCard card={game.playerHole[0]} size="lg" />
              <PlayingCard card={game.playerHole[1]} size="lg" />
            </Seat>
          </div>
        </div>

        {/* --------------------------- Actions --------------------------- */}
        <div className="mt-5 flex min-h-[5rem] items-center justify-center">
          {game.status === "playing" && legalActions.length > 0 ? (
            <div className="flex flex-col items-center gap-3">
              {toCall > 0 && (
                <p className="text-sm text-ivory/65">
                  Facing a bet — <span className="text-gold-soft">{money(toCall)}</span> to call
                </p>
              )}
              <div className="flex flex-wrap items-center justify-center gap-3">
                {legalActions.map((a) => (
                  <ActionButton key={a.type} action={a} onClick={() => playerAct(a)} />
                ))}
              </div>
            </div>
          ) : game.status === "playing" ? (
            <p className="text-sm tracking-wide text-ivory/45">
              {fx.busy ? "Watch the table\u2026" : "\u00A0"}
            </p>
          ) : null}
        </div>
      </div>

      {handOver && !fx.busy && game.result && (
        <EndOfHandModal
          winner={game.result.winner}
          potWon={game.result.potWon}
          reason={game.result.reason}
          gameOver={game.status === "game-over"}
          playerBankroll={game.playerBankroll}
          onContinue={game.status === "game-over" ? newGame : nextHand}
          onAnalysis={() => navigate(`/analysis/${game.result!.report.handNumber}`)}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function FeltBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1100px 700px at 50% -10%, #0f3324 0%, transparent 60%), linear-gradient(180deg, #0a1c14 0%, #060f0a 100%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 25% 30%, #f4ede4 0.5px, transparent 0.6px), radial-gradient(circle at 75% 70%, #f4ede4 0.5px, transparent 0.6px)",
          backgroundSize: "26px 26px",
        }}
      />
    </div>
  );
}

function TopBar({ handNumber }: { handNumber: number }) {
  return (
    <div className="flex items-center justify-between">
      <Link
        to="/"
        className="font-display text-sm tracking-wide text-ivory/70 transition hover:text-ivory"
      >
        ← Probability Poker
      </Link>
      <div className="flex items-center gap-3 text-xs">
        <span
          className="rounded-lg border px-3 py-1.5 font-display tracking-widest text-gold-soft"
          style={{ borderColor: "rgba(201,162,39,0.35)", background: "rgba(0,0,0,0.25)" }}
        >
          HAND #{handNumber}
        </span>
        <Link
          to="/analysis"
          className="rounded-lg border px-3 py-1.5 text-ivory/70 transition hover:text-ivory"
          style={{ borderColor: "rgba(244,237,228,0.18)", background: "rgba(0,0,0,0.2)" }}
        >
          Analysis
        </Link>
      </div>
    </div>
  );
}

function Deck() {
  return (
    <div className="pointer-events-none absolute right-6 top-1/2 hidden -translate-y-1/2 sm:block">
      <div className="relative h-[5.5rem] w-[4rem]">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="absolute h-[5.5rem] w-[4rem] rounded-lg border"
            style={{
              left: i * 2,
              top: -i * 2,
              borderColor: "#c9a227",
              background: "linear-gradient(135deg, #7a0019 0%, #4d0010 100%)",
              boxShadow: "0 4px 10px rgba(0,0,0,0.4)",
            }}
          >
            <div
              className="absolute inset-2 rounded-[3px] border"
              style={{
                borderColor: "rgba(201,162,39,0.5)",
                background:
                  "repeating-linear-gradient(45deg, rgba(201,162,39,0.18) 0 3px, transparent 3px 7px)",
              }}
            />
          </div>
        ))}
        <span className="absolute -bottom-5 left-0 right-0 text-center text-[0.6rem] uppercase tracking-[0.25em] text-ivory/40">
          Deck
        </span>
      </div>
    </div>
  );
}

function Seat({
  name,
  avatar,
  bankroll,
  committed,
  active,
  isDealer,
  bubble,
  thought,
  bubbleSide,
  cardsAfter,
  children,
}: {
  name: string;
  avatar: string;
  bankroll: number;
  committed: number;
  active: boolean;
  isDealer: boolean;
  bubble: string | null;
  thought?: ThinkStep | null;
  bubbleSide: "top" | "bottom";
  cardsAfter?: boolean;
  children: ReactNode;
}) {
  const info = (
    <div className="flex items-center gap-3">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-2xl border text-3xl transition"
        style={{
          borderColor: active ? "#c9a227" : "rgba(244,237,228,0.2)",
          background: active ? "rgba(201,162,39,0.14)" : "rgba(0,0,0,0.3)",
          boxShadow: active ? "0 0 22px rgba(201,162,39,0.35)" : "none",
        }}
      >
        {avatar}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-display text-sm tracking-wide text-ivory">{name}</span>
          <Badges isDealer={isDealer} />
        </div>
        <div className="font-mono text-sm text-ivory/70">
          {money(bankroll)}
          {committed > 0 && (
            <span className="ml-2 text-xs text-gold-soft">+{money(committed)}</span>
          )}
        </div>
      </div>
    </div>
  );

  const cards = <div className="flex gap-3">{children}</div>;

  return (
    <div className="relative flex items-center gap-5">
      {thought ? (
        <ThoughtBubble step={thought} side={bubbleSide} />
      ) : (
        bubble && <SpeechBubble text={bubble} side={bubbleSide} />
      )}
      {cardsAfter ? (
        <>
          {info}
          {cards}
        </>
      ) : (
        <>
          {cards}
          {info}
        </>
      )}
    </div>
  );
}

function Badges({ isDealer }: { isDealer: boolean }) {
  return (
    <span className="flex items-center gap-1">
      {isDealer ? (
        <>
          <Badge label="D" tone="dealer" />
          <Badge label="SB" tone="blind" />
        </>
      ) : (
        <Badge label="BB" tone="blind" />
      )}
    </span>
  );
}

function Badge({ label, tone }: { label: string; tone: "dealer" | "blind" }) {
  const style =
    tone === "dealer"
      ? { background: "#c9a227", color: "#0d0d0d" }
      : {
          background: "rgba(0,0,0,0.35)",
          color: "#e2c563",
          border: "1px solid rgba(201,162,39,0.5)",
        };
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-none tracking-wide"
      style={style}
    >
      {label}
    </span>
  );
}

function SpeechBubble({ text, side }: { text: string; side: "top" | "bottom" }) {
  const thinking = text.endsWith("\u2026");
  const label = thinking ? text.slice(0, -1) : text;
  const pos = side === "top" ? "bottom-full mb-3" : "top-full mt-3";
  return (
    <div
      className={`pp-bubble absolute left-1/2 z-20 -translate-x-1/2 whitespace-nowrap ${pos}`}
    >
      <div
        className="rounded-2xl border px-4 py-2 font-display text-sm font-semibold shadow-xl"
        style={{
          borderColor: "rgba(201,162,39,0.5)",
          background: "linear-gradient(180deg, #fbf7ef 0%, #efe6d4 100%)",
          color: "#1a1a1a",
        }}
      >
        {thinking ? (
          <span className="flex items-center gap-1">
            {label}
            <span className="flex gap-0.5">
              <Dot delay="0s" />
              <Dot delay="0.2s" />
              <Dot delay="0.4s" />
            </span>
          </span>
        ) : (
          text
        )}
      </div>
    </div>
  );
}

function ThoughtBubble({ step, side }: { step: ThinkStep; side: "top" | "bottom" }) {
  const pos = side === "top" ? "bottom-full mb-3" : "top-full mt-3";
  return (
    <div className={`pp-bubble absolute left-1/2 z-20 w-[16rem] -translate-x-1/2 ${pos}`}>
      <div
        className="rounded-2xl border px-4 py-3 shadow-xl"
        style={{
          borderColor: "rgba(201,162,39,0.5)",
          background: "linear-gradient(180deg, #fbf7ef 0%, #efe6d4 100%)",
          color: "#1a1a1a",
        }}
      >
        {/* Re-keying on step index re-runs the fade for each new message. */}
        <div key={step.step} className="pp-thought">
          <div className="flex items-center gap-1.5 font-display text-sm font-semibold">
            {step.title}
            <span className="flex gap-0.5">
              <Dot delay="0s" />
              <Dot delay="0.2s" />
              <Dot delay="0.4s" />
            </span>
          </div>
          {step.detail && (
            <div
              className="mt-1 font-mono text-xs"
              style={{ color: "#7a0019" }}
            >
              {step.detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="pp-dot inline-block h-1 w-1 rounded-full"
      style={{ background: "#7a0019", animationDelay: delay }}
    />
  );
}

function ChipLayer({ chips }: { chips: ChipFx[] }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {chips.map((chip) => (
        <FlyingChip key={chip.id} seat={chip.seat} />
      ))}
    </div>
  );
}

function FlyingChip({ seat }: { seat: Seat }) {
  return (
    <div
      className={`absolute left-1/2 top-1/2 -ml-4 -mt-4 h-8 w-8 rounded-full border-2 ${
        seat === "player" ? "pp-chip-bottom" : "pp-chip-top"
      }`}
      style={{
        borderColor: "#e2c563",
        borderStyle: "dashed",
        background: "radial-gradient(circle at 50% 40%, #a30222 0%, #7a0019 70%)",
        boxShadow: "0 4px 10px rgba(0,0,0,0.45)",
      }}
    />
  );
}

function ActionButton({
  action,
  onClick,
}: {
  action: LegalAction;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-w-[7.5rem] rounded-xl px-6 py-3 font-display text-sm font-semibold tracking-wide shadow-lg transition-all duration-200 ease-out hover:-translate-y-1 hover:scale-[1.04] hover:shadow-2xl focus:outline-none ${
        ACTION_STYLES[action.type] ?? "bg-black/30"
      }`}
    >
      {action.label}
    </button>
  );
}

function EndOfHandModal({
  winner,
  potWon,
  reason,
  gameOver,
  playerBankroll,
  onContinue,
  onAnalysis,
}: {
  winner: "player" | "bot" | "split";
  potWon: number;
  reason: "fold" | "showdown";
  gameOver: boolean;
  playerBankroll: number;
  onContinue: () => void;
  onAnalysis: () => void;
}) {
  const title =
    winner === "split" ? "Split Pot" : winner === "player" ? "You Win" : "Bot Wins";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div
        className="pp-bubble w-full max-w-sm rounded-3xl border p-8 text-center shadow-2xl"
        style={{
          borderColor: "rgba(201,162,39,0.4)",
          background:
            "radial-gradient(120% 90% at 50% 0%, #1a4a32 0%, #0b2218 100%)",
        }}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-ivory/50">
          {gameOver ? "Game Over" : "Hand Complete"}
        </p>
        <h2 className="mt-3 font-display text-4xl font-bold text-gold-soft">{title}</h2>
        <p className="mt-2 text-sm text-ivory/70">
          {winner === "split" ? "Pot split" : "Pot won"}: {money(potWon)}
          {reason === "fold" && winner !== "split" ? " (fold)" : ""}
        </p>

        {gameOver && (
          <p
            className="mt-4 rounded-xl p-3 text-sm text-ivory/80"
            style={{ background: "rgba(0,0,0,0.3)" }}
          >
            {playerBankroll <= 0
              ? "You're out of chips."
              : "The bot is out of chips. You win the match!"}
          </p>
        )}

        <div className="mt-7 flex flex-col gap-3">
          <button
            onClick={onContinue}
            className="rounded-xl border border-pkred-light/70 bg-pkred/80 px-5 py-3 font-display font-semibold tracking-wide text-ivory transition hover:-translate-y-0.5 hover:bg-pkred-light"
          >
            {gameOver ? "New Game" : "Continue Playing"}
          </button>
          <button
            onClick={onAnalysis}
            className="rounded-xl border px-5 py-3 font-display font-semibold tracking-wide text-gold-soft transition hover:-translate-y-0.5"
            style={{ borderColor: "rgba(201,162,39,0.5)", background: "rgba(0,0,0,0.25)" }}
          >
            View Probability Analysis
          </button>
        </div>
      </div>
    </div>
  );
}
