import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  applyBotChoice,
  applyPlayerAction,
  createInitialGame,
  generateAnalysis,
  getLegalActions,
  startHand,
} from "../poker/gameEngine";
import { decideBotAction, type BotChoice } from "../poker/botStrategy";
import { otherSeat } from "../poker/betting";
import { beginAction } from "../lib/latency";
import type { GameState, HandReport, LegalAction, Seat } from "../types";

export interface ChipFx {
  seat: Seat;
  id: number;
}

/** One frame of the bot's visible "computing" sequence. */
export interface ThinkStep {
  /** Monotonic index so the UI can re-trigger its fade on each new message. */
  step: number;
  title: string;
  detail: string | null;
}

/** Presentation state driven by the action choreography (bubbles, chips, deal). */
export interface TableFx {
  /** True while an action sequence is animating — controls hide actions. */
  busy: boolean;
  /** Number of community cards currently revealed (for staggered dealing). */
  dealtCount: number;
  playerBubble: string | null;
  botBubble: string | null;
  /** The bot's current "thinking" frame (null when not computing). */
  thinking: ThinkStep | null;
  chips: ChipFx[];
}

interface GameContextValue {
  game: GameState;
  history: HandReport[];
  legalActions: LegalAction[];
  fx: TableFx;
  playerAct: (action: LegalAction) => void;
  nextHand: () => void;
  newGame: () => void;
  reportFor: (handNumber: number) => HandReport | undefined;
  latestReport: HandReport | undefined;
}

const GameContext = createContext<GameContextValue | null>(null);

function freshGame(): GameState {
  return startHand(createInitialGame());
}

// ---- Choreography timing (ms). Tuned to feel deliberate but never sluggish. -
const T = {
  chip: 600, // chip flight into the pot
  noChip: 360, // a check/fold beat with no chips
  settle: 170, // pause after committing a move before clearing the bubble
  dealStep: 230, // delay between each community card landing
  blindGap: 180, // gap between SB and BB chips
  // The bot's visible reasoning window. Each message lingers thinkStepMin..Max,
  // and the whole sequence targets ~3.5–4.8s so it reads as deliberate work.
  thinkStepMin: 700,
  thinkStepMax: 1000,
  thinkTotalMin: 3600,
  thinkTotalMax: 4800,
};

/**
 * Build the bot's visible reasoning sequence. It narrates each stage of the
 * engine pipeline (Monte Carlo → Bayesian update → EV) so the probability work
 * is legible, but deliberately withholds the bot's *private* estimates — win
 * probability, beliefs, and EV numbers — which would leak information to the
 * player. Only public/config facts (trial count, cards left to come) are shown.
 */
function buildThinkingSteps(choice: BotChoice, unknownBoard: number): ThinkStep[] {
  const sims = choice.decision.monteCarlo.simulations;

  const frames: { title: string; detail: string | null }[] = [
    {
      title: "Running simulations",
      detail: `${sims.toLocaleString()} Monte Carlo trials`,
    },
    {
      title: "Sampling opponent hands",
      detail: "Weighted by current beliefs",
    },
    {
      title: "Completing future boards",
      detail:
        unknownBoard > 0
          ? `${unknownBoard} board card${unknownBoard === 1 ? "" : "s"} per trial`
          : "Board already complete",
    },
    {
      title: "Updating Bayesian beliefs",
      detail: "Posterior probabilities recalculated",
    },
    {
      title: "Estimating win probability",
      detail: "Equity estimate updated",
    },
    {
      title: "Calculating expected value",
      detail: "Comparing action EVs",
    },
    {
      title: "Choosing optimal action",
      detail: null,
    },
  ];

  return frames.map((f, i) => ({ step: i, ...f }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function GameProvider({ children }: { children: ReactNode }) {
  const [game, setGame] = useState<GameState>(freshGame);
  const [history, setHistory] = useState<HandReport[]>([]);

  const [busy, setBusy] = useState(false);
  const [dealtCount, setDealtCount] = useState(0);
  const [playerBubble, setPlayerBubble] = useState<string | null>(null);
  const [botBubble, setBotBubble] = useState<string | null>(null);
  const [thinking, setThinking] = useState<ThinkStep | null>(null);
  const [chips, setChips] = useState<ChipFx[]>([]);

  const gameRef = useRef(game);
  gameRef.current = game;
  const busyRef = useRef(false);
  const chipId = useRef(0);
  const startedRef = useRef(false);

  // ---- Low-level presentation primitives ----------------------------------
  const commit = useCallback((next: GameState) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const spawnChip = useCallback((seat: Seat) => {
    chipId.current += 1;
    const id = chipId.current;
    setChips((cur) => [...cur, { seat, id }]);
    window.setTimeout(
      () => setChips((cur) => cur.filter((c) => c.id !== id)),
      T.chip + 60
    );
  }, []);

  // Reveal community cards one at a time, as if dealt off the deck.
  const dealUpTo = useCallback(async (fromLen: number, toLen: number) => {
    for (let i = fromLen; i < toLen; i++) {
      setDealtCount(i + 1);
      await sleep(T.dealStep);
    }
  }, []);

  // ---- A single committed move with its full animation ---------------------
  const performPlayer = useCallback(
    async (action: LegalAction) => {
      const g = gameRef.current;
      setPlayerBubble(action.label);
      if (action.cost > 0) spawnChip("player");
      await sleep(action.cost > 0 ? T.chip : T.noChip);

      const next = structuredClone(g);
      const before = next.community.length;
      applyPlayerAction(next, action);
      commit(next);

      await sleep(T.settle);
      setPlayerBubble(null);
      await dealUpTo(before, next.community.length);
    },
    [commit, dealUpTo, spawnChip]
  );

  const performBot = useCallback(async () => {
    const g = gameRef.current;

    // Compute the full decision up front. The heavy Monte Carlo work therefore
    // runs *during* the visible thinking animation, and its real outputs feed
    // the messages the player sees.
    const startedAt = performance.now();
    const next = structuredClone(g);
    const before = next.community.length;
    const computeStart = performance.now();
    const choice = decideBotAction(next);
    const compute = performance.now() - computeStart;
    beginAction(startedAt, {
      mc: choice.timings.mc,
      ev: choice.timings.ev,
      compute,
    });

    // Walk the reasoning steps, each lingering long enough to read.
    const steps = buildThinkingSteps(choice, 5 - g.community.length);
    const target =
      T.thinkTotalMin + Math.random() * (T.thinkTotalMax - T.thinkTotalMin);
    const per = Math.min(
      T.thinkStepMax,
      Math.max(T.thinkStepMin, Math.round(target / steps.length))
    );
    for (const s of steps) {
      setThinking(s);
      await sleep(per);
    }
    setThinking(null);

    applyBotChoice(next, choice);
    setBotBubble(choice.action.label);
    if (choice.action.cost > 0) spawnChip("bot");
    await sleep(choice.action.cost > 0 ? T.chip : T.noChip);

    commit(next);
    await sleep(T.settle);
    setBotBubble(null);
    await dealUpTo(before, next.community.length);
  }, [commit, dealUpTo, spawnChip]);

  // Run bot moves until it is the player's turn again or the hand ends.
  const drive = useCallback(async () => {
    for (;;) {
      const g = gameRef.current;
      if (g.status !== "playing" || g.toAct !== "bot") return;
      await performBot();
    }
  }, [performBot]);

  // Post blinds (animated) for an already-started hand, then run any bot turns.
  const beginHand = useCallback(
    async (next: GameState) => {
      commit(next);
      setDealtCount(0);
      setPlayerBubble(null);
      setBotBubble(null);
      setThinking(null);
      if (next.status === "playing") {
        spawnChip(next.dealer);
        await sleep(T.blindGap);
        spawnChip(otherSeat(next.dealer));
        await sleep(T.chip);
      }
      await drive();
    },
    [commit, drive, spawnChip]
  );

  // ---- Public actions ------------------------------------------------------
  const playerAct = useCallback(
    (action: LegalAction) => {
      if (busyRef.current) return;
      const g = gameRef.current;
      if (g.status !== "playing" || g.toAct !== "player") return;
      busyRef.current = true;
      setBusy(true);
      void (async () => {
        await performPlayer(action);
        await drive();
        busyRef.current = false;
        setBusy(false);
      })();
    },
    [drive, performPlayer]
  );

  const nextHand = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      const next = structuredClone(gameRef.current);
      startHand(next);
      await beginHand(next);
      busyRef.current = false;
      setBusy(false);
    })();
  }, [beginHand]);

  const newGame = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setHistory([]);
    void (async () => {
      await beginHand(freshGame());
      busyRef.current = false;
      setBusy(false);
    })();
  }, [beginHand]);

  // ---- Initial hand choreography (blinds + any first bot turn) -------------
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      const g = gameRef.current;
      setDealtCount(0);
      spawnChip(g.dealer);
      await sleep(T.blindGap);
      spawnChip(otherSeat(g.dealer));
      await sleep(T.chip);
      await drive();
      busyRef.current = false;
      setBusy(false);
    })();
  }, [drive, spawnChip]);

  // ---- Archive + lazily enrich the hand report ----------------------------
  useEffect(() => {
    if (
      (game.status !== "hand-over" && game.status !== "game-over") ||
      !game.result
    ) {
      return;
    }
    const cheap = game.result.report;
    setHistory((prev) =>
      prev.some((r) => r.handNumber === cheap.handNumber)
        ? prev
        : [...prev, cheap]
    );

    if (cheap.analysisReady) return;
    const handNumber = cheap.handNumber;
    const id = setTimeout(() => {
      const full = generateAnalysis(cheap);
      setHistory((prev) =>
        prev.map((r) => (r.handNumber === handNumber ? full : r))
      );
    }, 0);
    return () => clearTimeout(id);
  }, [game.status, game.handNumber, game.result]);

  const legalActions = useMemo(
    () =>
      !busy && game.status === "playing" && game.toAct === "player"
        ? getLegalActions(game, "player")
        : [],
    [game, busy]
  );

  const reportFor = useCallback(
    (handNumber: number) => history.find((r) => r.handNumber === handNumber),
    [history]
  );

  const latestReport = history[history.length - 1];

  const fx = useMemo<TableFx>(
    () => ({ busy, dealtCount, playerBubble, botBubble, thinking, chips }),
    [busy, dealtCount, playerBubble, botBubble, thinking, chips]
  );

  const value = useMemo<GameContextValue>(
    () => ({
      game,
      history,
      legalActions,
      fx,
      playerAct,
      nextHand,
      newGame,
      reportFor,
      latestReport,
    }),
    [
      game,
      history,
      legalActions,
      fx,
      playerAct,
      nextHand,
      newGame,
      reportFor,
      latestReport,
    ]
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used within a GameProvider");
  return ctx;
}
