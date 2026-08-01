/**
 * The N-handed table's store.
 *
 * It drives `poker/table/engine` one `applyAction` at a time and wraps each move
 * in the choreography the heads-up store established — a chip flight, a spoken
 * action, a staggered board deal — generalised from two fixed seats to however
 * many are sitting. The engine itself is untouched by any of it: this file
 * decides *when* a move is shown, never *what* the move is.
 *
 * Two invariants are worth stating because breaking either is invisible until
 * it is catastrophic:
 *
 *   1. One animated sequence at a time, released in a `finally`. A rejected
 *      decision or a wedged worker must not leave the table locked forever.
 *   2. Modes gate rendering only. Nothing here consults `mode` before deciding
 *      anything — the bots' information set is identical in Fair, Coach and
 *      Study, so a hand studied is the same hand as a hand played.
 */

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
  loadSetup,
  saveSetup,
  startingStack,
  type TableMode,
  type TableSetup as TableOptions,
} from "../lib/tableOptions";
import { asyncTableDecider, equityRequest, handActions, readsFromActions } from "../poker/model/decider";
import { BOT_PROFILES } from "../poker/model/profiles";
import { runMultiwayEquity } from "../poker/equity/pool";
import type {
  BotDecision,
  MultiwayEquity,
  TableHandReport,
} from "../poker/table/contract";
import {
  applyAction,
  createTable,
  startHand,
  type SeatSetup,
  type Table,
} from "../poker/table/engine";
import { blindSeats } from "../poker/table/position";
import {
  legalActions,
  sizingLadder,
  type SizingOption,
  type TableAction,
} from "../poker/table/rules";
import { toCall as toCallOf } from "../poker/table/state";
import type { BeliefDistribution } from "../types";

// ---------------------------------------------------------------------------
// Presentation state
// ---------------------------------------------------------------------------

/** One frame of a bot's visible "computing" sequence. */
export interface ThinkStep {
  /** Monotonic index so the UI can re-trigger its fade on each new message. */
  step: number;
  title: string;
  detail: string | null;
}

export interface ChipFx {
  id: number;
  seat: number;
}

export interface SeatFx {
  bubble: string | null;
  thinking: ThinkStep | null;
}

export interface TableFx {
  /** True while a sequence is animating — the human's controls are hidden. */
  busy: boolean;
  /** Community cards currently revealed, for the staggered deal. */
  dealtCount: number;
  seats: Record<number, SeatFx>;
  chips: ChipFx[];
}

/**
 * What Coach mode puts in front of the human: the same equity the bots price
 * their own decisions from, against the seats actually still in the pot.
 *
 * Computed only when the human is on the clock and only when a mode asks for
 * it. It is display state and feeds nothing the engine reads.
 */
export interface HeroRead {
  equity: MultiwayEquity;
  /** Chips to call, and the pot they would be called into. */
  toCall: number;
  pot: number;
  /** Share of the final pot a call needs to break even: cost / (pot + cost). */
  required: number;
  /** Pot odds expressed the way they are spoken: "3.5 to 1". */
  odds: number | null;
  opponents: number[];
}

interface TableContextValue {
  table: Table;
  options: TableOptions;
  mode: TableMode;
  /** Seat the human occupies, or null when watching the bots play. */
  heroSeat: number | null;
  legalActions: TableAction[];
  sizings: SizingOption[];
  fx: TableFx;
  /** Public reads, seat-keyed — the bots' information set, not a privileged one. */
  reads: Record<number, BeliefDistribution>;
  heroRead: HeroRead | null;
  history: TableHandReport[];
  lastReport: TableHandReport | null;
  act: (action: TableAction) => void;
  nextHand: () => void;
  newTable: (options: TableOptions) => void;
  setMode: (mode: TableMode) => void;
}

const TableContext = createContext<TableContextValue | null>(null);

// ---------------------------------------------------------------------------
// Building a table from the setup screen's choices
// ---------------------------------------------------------------------------

/**
 * Seat names, deduplicated. The picker allows the same archetype twice, and two
 * seats both called "Wildfire Wes" is unreadable at a glance.
 */
function seatNames(profiles: string[]): string[] {
  const seen = new Map<string, number>();
  return profiles.map((id) => {
    const base = BOT_PROFILES[id as keyof typeof BOT_PROFILES]?.name ?? "Bot";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  });
}

export function buildTable(options: TableOptions, seed?: number): Table {
  const lineup = [...options.lineup];
  // A lineup shorter than the table (corrupt storage, an older saved setup)
  // still has to seat everyone; the pure-EV baseline is the honest filler.
  while (lineup.length < options.seatCount) lineup.push("professor");
  const names = seatNames(lineup);

  const seats: SeatSetup[] = [];
  if (!options.observer) seats.push({ name: "You", kind: "human" });
  for (let i = 0; i < lineup.length && seats.length < options.seatCount; i++) {
    seats.push({ name: names[i], kind: "bot", profile: lineup[i] });
  }

  return createTable({
    seatCount: options.seatCount,
    startingStack: startingStack(options),
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind,
    seed,
    seats,
  });
}

// ---------------------------------------------------------------------------
// Choreography timing (ms)
// ---------------------------------------------------------------------------

const T = {
  chip: 420, // chip flight into the pot
  noChip: 200, // a check/fold beat with no chips
  settle: 100, // pause after committing before the bubble clears
  dealStep: 175, // delay between each community card landing
  blindGap: 150, // gap between the small and big blind chips
  /** Minimum visible thinking window — also covers the Monte Carlo in flight. */
  thinkLead: 220,
  thinkStepMin: 110,
  thinkStepMax: 300,
};

/**
 * How long a bot lingers over a move, by what it decided.
 *
 * A fold is snap; a raise deserves a pause. Beyond looking right, this is what
 * keeps a six-handed table watchable — a preflop round where four seats fold
 * costs a second in total rather than five.
 */
function beatFor(type: TableAction["type"]): number {
  switch (type) {
    case "fold":
      return 300;
    case "check":
      return 360;
    case "call":
      return 520;
    default:
      return 760;
  }
}

/**
 * The bot's visible reasoning, narrating the pipeline it actually runs. It
 * deliberately withholds the private numbers — equity, reads, EV — which would
 * leak information; only public facts (the field size, the sample count) show.
 */
function thinkingSteps(opponents: number, sims: number): ThinkStep[] {
  return [
    {
      step: 0,
      title: "Reading the field",
      detail: `${opponents} opponent${opponents === 1 ? "" : "s"} still live`,
    },
    {
      step: 1,
      title: "Running simulations",
      detail: `${sims.toLocaleString()} multiway trials`,
    },
    { step: 2, title: "Pricing each action", detail: "Comparing expected value" },
  ];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The live decider: Monte Carlo goes to the worker pool, off the main thread. */
const decide = asyncTableDecider();

// ---------------------------------------------------------------------------

export function TableProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<TableOptions>(loadSetup);
  const [table, setTable] = useState<Table>(() => buildTable(loadSetup()));
  const [history, setHistory] = useState<TableHandReport[]>([]);

  const [busy, setBusy] = useState(false);
  const [dealtCount, setDealtCount] = useState(0);
  const [bubbles, setBubbles] = useState<Record<number, string | null>>({});
  const [thinking, setThinking] = useState<Record<number, ThinkStep | null>>({});
  const [chips, setChips] = useState<ChipFx[]>([]);
  const [heroRead, setHeroRead] = useState<HeroRead | null>(null);

  const tableRef = useRef(table);
  tableRef.current = table;
  const busyRef = useRef(false);
  const chipId = useRef(0);
  const startedRef = useRef(false);
  /**
   * Cleared when the provider unmounts. The bot loop is a long-lived async
   * sequence, so leaving the table mid-hand would otherwise keep dealing —
   * running Monte Carlo and setting state on a component nobody is looking at
   * until the hand happened to end.
   */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const heroSeat = options.observer ? null : 0;

  // ---- Low-level presentation primitives ----------------------------------
  const commit = useCallback((next: Table) => {
    tableRef.current = next;
    setTable(next);
  }, []);

  const spawnChip = useCallback((seat: number) => {
    chipId.current += 1;
    const id = chipId.current;
    setChips((cur) => [...cur, { seat, id }]);
    window.setTimeout(
      () => setChips((cur) => cur.filter((c) => c.id !== id)),
      T.chip + 60
    );
  }, []);

  const say = useCallback((seat: number, text: string | null) => {
    setBubbles((cur) => ({ ...cur, [seat]: text }));
  }, []);

  const think = useCallback((seat: number, step: ThinkStep | null) => {
    setThinking((cur) => ({ ...cur, [seat]: step }));
  }, []);

  /** Reveal community cards one at a time, as if dealt off the deck. */
  const dealUpTo = useCallback(async (fromLen: number, toLen: number) => {
    for (let i = fromLen; i < toLen; i++) {
      setDealtCount(i + 1);
      await sleep(T.dealStep);
    }
  }, []);

  // ---- One committed move, with its animation ------------------------------
  const perform = useCallback(
    async (seat: number, action: TableAction, decision?: BotDecision) => {
      const next = structuredClone(tableRef.current);
      const before = next.board.length;
      // Recorded on the clone the move is applied to, so the hand report
      // carries the full audit trail exactly as `playHandHeadless` builds it.
      if (decision) next.decisions.push(decision);

      say(seat, action.label);
      if (action.cost > 0) spawnChip(seat);
      await sleep(action.cost > 0 ? T.chip : T.noChip);

      applyAction(next, seat, action);
      commit(next);

      await sleep(T.settle);
      say(seat, null);
      await dealUpTo(before, next.board.length);
    },
    [commit, dealUpTo, say, spawnChip]
  );

  const performBot = useCallback(
    async (seat: number) => {
      const live = tableRef.current;
      const request = equityRequest(live, seat);
      // Kick the decision off first so the Monte Carlo overlaps the thinking
      // beat rather than preceding it. It runs in the worker pool, so the main
      // thread stays free to animate while it is in flight.
      const pending = decide(live, seat, live.config);

      const frames = thinkingSteps(request.opponents.length, request.simulations);
      think(seat, frames[0]);
      const [decision] = await Promise.all([pending, sleep(T.thinkLead)]);

      const per = Math.min(
        T.thinkStepMax,
        Math.max(T.thinkStepMin, beatFor(decision.action.type) / frames.length)
      );
      for (let i = 1; i < frames.length; i++) {
        think(seat, frames[i]);
        await sleep(per);
      }
      think(seat, null);
      await perform(seat, decision.action, decision);
    },
    [perform, think]
  );

  /**
   * Run bot moves until the human is on the clock or the hand ends. The step
   * cap is a backstop: a cycling turn order would otherwise spin here forever
   * with the lock held, which is the one failure the user cannot recover from.
   */
  const drive = useCallback(async () => {
    for (let steps = 0; steps < 400; steps++) {
      if (!aliveRef.current) return;
      const t = tableRef.current;
      if (t.status !== "playing") return;
      const seat = t.toAct;
      if (seat === null) return;
      if (t.seats[seat].kind === "human") return;
      await performBot(seat);
    }
    throw new Error("table: bot loop exceeded its step budget");
  }, [performBot]);

  /** Post the blinds for an already-dealt hand, then run any bot turns. */
  const beginHand = useCallback(
    async (next: Table) => {
      commit(next);
      setDealtCount(next.board.length);
      setBubbles({});
      setThinking({});
      setHeroRead(null);
      if (next.status === "playing") {
        const { sb, bb } = blindSeats(next.button, next.seats.length);
        spawnChip(sb);
        await sleep(T.blindGap);
        spawnChip(bb);
        await sleep(T.chip);
      }
      await drive();
    },
    [commit, drive, spawnChip]
  );

  // ---- Public actions ------------------------------------------------------
  /**
   * Run one animated sequence at a time, releasing the lock in `finally`. The
   * lock has to survive a throw: anything escaping the sequence — a rejected
   * decision, a worker that never answers — would otherwise leave `busy` true
   * forever, which kills every control on the table for good.
   */
  const runExclusive = useCallback((seq: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      try {
        await seq();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("table: action sequence failed", err);
      } finally {
        setThinking({});
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, []);

  const act = useCallback(
    (action: TableAction) => {
      if (busyRef.current) return;
      const t = tableRef.current;
      if (t.status !== "playing" || t.toAct === null) return;
      if (t.seats[t.toAct].kind !== "human") return;
      const seat = t.toAct;
      setHeroRead(null);
      runExclusive(async () => {
        await perform(seat, action);
        await drive();
      });
    },
    [drive, perform, runExclusive]
  );

  const nextHand = useCallback(() => {
    if (busyRef.current) return;
    runExclusive(async () => {
      const next = structuredClone(tableRef.current);
      startHand(next);
      await beginHand(next);
    });
  }, [beginHand, runExclusive]);

  const newTable = useCallback(
    (next: TableOptions) => {
      if (busyRef.current) return;
      saveSetup(next);
      setOptions(next);
      setHistory([]);
      runExclusive(async () => {
        const fresh = buildTable(next);
        startHand(fresh);
        await beginHand(fresh);
      });
    },
    [beginHand, runExclusive]
  );

  /**
   * Switching mode mid-session is deliberately cheap: it re-renders and nothing
   * else. No hand is re-dealt and no decision is recomputed, because the bots
   * never saw the mode in the first place.
   */
  const setMode = useCallback((mode: TableMode) => {
    setOptions((cur) => {
      const next = { ...cur, mode };
      saveSetup(next);
      return next;
    });
  }, []);

  // ---- First hand ----------------------------------------------------------
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runExclusive(async () => {
      const fresh = structuredClone(tableRef.current);
      startHand(fresh);
      await beginHand(fresh);
    });
  }, [beginHand, runExclusive]);

  // ---- Archive finished hands ---------------------------------------------
  useEffect(() => {
    const report = table.lastReport;
    if (!report) return;
    setHistory((prev) =>
      prev.some((r) => r.handNumber === report.handNumber)
        ? prev
        : [...prev, report]
    );
  }, [table.lastReport]);

  // ---- Observer mode deals itself on ---------------------------------------
  useEffect(() => {
    if (!options.observer || busy || table.status === "playing") return;
    const id = window.setTimeout(nextHand, 2200);
    return () => window.clearTimeout(id);
  }, [options.observer, busy, table.status, table.handNumber, nextHand]);

  // ---- Coach / Study equity for the human ----------------------------------
  //
  // Display only. It runs when the human is on the clock and is thrown away the
  // moment they act, so a stale number can never be shown next to a live board.
  const heroTurn =
    heroSeat !== null && table.status === "playing" && table.toAct === heroSeat;
  const heroKey = heroTurn
    ? `${table.handNumber}:${handActions(table).length}`
    : "";

  useEffect(() => {
    if (!heroTurn || heroSeat === null || options.mode === "fair") {
      setHeroRead(null);
      return;
    }
    let cancelled = false;
    const t = tableRef.current;
    const request = equityRequest(t, heroSeat);
    const pot = t.pot;
    const call = toCallOf(t, heroSeat);
    void runMultiwayEquity(request)
      .then((equity) => {
        if (cancelled) return;
        setHeroRead({
          equity,
          toCall: call,
          pot,
          required: call > 0 ? call / (pot + call) : 0,
          odds: call > 0 ? pot / call : null,
          opponents: request.opponents,
        });
      })
      .catch(() => {
        // A failed estimate must never block the hand; the panel just says so.
        if (!cancelled) setHeroRead(null);
      });
    return () => {
      cancelled = true;
    };
    // `heroKey` identifies the decision point; the table object itself changes
    // identity on every commit and would re-run this for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroKey, heroTurn, heroSeat, options.mode]);

  // ---- Derived -------------------------------------------------------------
  const canAct =
    !busy &&
    table.status === "playing" &&
    table.toAct !== null &&
    table.seats[table.toAct].kind === "human";

  const legal = useMemo(
    () =>
      canAct && table.toAct !== null
        ? legalActions(table, table.toAct, table.config)
        : [],
    [canAct, table]
  );

  const sizings = useMemo(
    () =>
      canAct && table.toAct !== null
        ? sizingLadder(table, table.toAct, table.config)
        : [],
    [canAct, table]
  );

  const reads = useMemo(
    () => readsFromActions(handActions(table), table.seats.length),
    [table]
  );

  const fx = useMemo<TableFx>(() => {
    const seats: Record<number, SeatFx> = {};
    for (const seat of table.seats) {
      seats[seat.id] = {
        bubble: bubbles[seat.id] ?? null,
        thinking: thinking[seat.id] ?? null,
      };
    }
    return { busy, dealtCount, seats, chips };
  }, [busy, dealtCount, bubbles, thinking, chips, table.seats]);

  const value = useMemo<TableContextValue>(
    () => ({
      table,
      options,
      mode: options.mode,
      heroSeat,
      legalActions: legal,
      sizings,
      fx,
      reads,
      heroRead,
      history,
      lastReport: table.lastReport,
      act,
      nextHand,
      newTable,
      setMode,
    }),
    [
      table,
      options,
      heroSeat,
      legal,
      sizings,
      fx,
      reads,
      heroRead,
      history,
      act,
      nextHand,
      newTable,
      setMode,
    ]
  );

  return (
    <TableContext.Provider value={value}>{children}</TableContext.Provider>
  );
}

export function useTable(): TableContextValue {
  const ctx = useContext(TableContext);
  if (!ctx) throw new Error("useTable must be used within a TableProvider");
  return ctx;
}
