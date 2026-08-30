/**
 * The table a player configures before sitting down.
 *
 * Kept separate from the engine's `TableConfig` (blinds) because these are
 * choices rather than rules: how many seats, how deep, who to play against,
 * and how much the interface is allowed to tell you. It persists to
 * localStorage so a reload drops you back at the same table rather than a
 * default one.
 */

import {
  BOT_PROFILES,
  randomLineup,
  type BuiltArchetype,
} from "../poker/model/profiles";
import { MAX_SEATS, MIN_SEATS } from "../poker/table/position";

/**
 * How much the interface reveals while a hand is live.
 *
 * This gates rendering only, never the engine. The bots' information set is
 * identical in every mode, so switching to Study cannot change how they play,
 * and a hand studied is the same hand as a hand played.
 *
 * The four are a ladder of how much help you are taking, quietest first, so
 * moving one step right is always a step toward more information and never a
 * sideways preference. Drill is the one that says nothing until you are wrong:
 * the equity behind it is computed either way, it is simply not printed unless
 * the action you took cost you more than `DRILL_THRESHOLD_BB` big blinds
 * against the model. That distinction is the whole mode - a trainer that
 * narrates every hand teaches you to read the narration, not the spot.
 *
 * Drill judges folds, checks and calls only, and the blurb says so rather than
 * promising a verdict on every move. The forward-looking pricer it uses has no
 * fold equity, so it cannot value a bet without being biased against it; see
 * `priceDrill` in `store/TableContext.tsx` for why silence is the right answer
 * there rather than a confident and backwards one.
 */
export type TableMode = "fair" | "drill" | "coach" | "study";

export const TABLE_MODES: { id: TableMode; name: string; blurb: string }[] = [
  {
    id: "fair",
    name: "Fair Play",
    blurb: "Nothing revealed. Just poker, can you beat the math?",
  },
  {
    id: "drill",
    name: "Drill",
    blurb: "Says nothing until a fold, check or call costs you chips.",
  },
  {
    id: "coach",
    name: "Coach",
    blurb: "Your equity, the price, and the verdict, while you decide.",
  },
  {
    id: "study",
    name: "Study",
    blurb: "Everything: all hole cards, every read, live EV.",
  },
];

/**
 * How wrong an action has to be before Drill breaks its silence, in big blinds.
 *
 * In big blinds rather than chips because the same mistake at $5/$10 and at
 * $50/$100 is the same mistake, and a threshold in chips would make Drill
 * chatty at one stake and mute at another. Half a big blind is roughly the
 * width of the Monte Carlo interval on a marginal spot, so anything under it
 * is inside the noise and interrupting for it would be teaching sampling error.
 */
export const DRILL_THRESHOLD_BB = 0.5;

/** Stack depths in big blinds. Depth changes correct strategy more than
 *  almost anything else, 20bb is nearly all preflop, 200bb is all postflop. */
export const STACK_DEPTHS = [20, 50, 100, 200] as const;
export type StackDepth = (typeof STACK_DEPTHS)[number];

// Re-exported rather than redeclared: if these drifted from the engine's limits
// we would produce a "legal" seat count that `createTable` throws on, which is
// a white screen rather than a clamped value.
export { MIN_SEATS, MAX_SEATS } from "../poker/table/position";

export interface TableSetup {
  /** Total seats including the human, unless `observer`. */
  seatCount: number;
  stackBb: StackDepth;
  smallBlind: number;
  bigBlind: number;
  /** Bot archetypes filling every seat except the human's. */
  lineup: BuiltArchetype[];
  mode: TableMode;
  /** No human seat, watch the bots play each other with cards face up. */
  observer: boolean;
}

export const DEFAULT_SETUP: TableSetup = {
  seatCount: 4,
  stackBb: 100,
  smallBlind: 5,
  bigBlind: 10,
  lineup: ["tag", "station", "maniac"],
  mode: "coach",
  observer: false,
};

/** Bots needed to fill a table: every seat but the human's, or all of them. */
export function botsNeeded(setup: {
  seatCount: number;
  observer: boolean;
}): number {
  return setup.observer ? setup.seatCount : setup.seatCount - 1;
}

/**
 * Resize a lineup to fit the seat count, keeping existing picks where possible
 * so changing seat count does not silently discard a chosen table.
 */
export function fitLineup(
  lineup: BuiltArchetype[],
  needed: number,
  seed: number
): BuiltArchetype[] {
  if (lineup.length === needed) return lineup;
  if (lineup.length > needed) return lineup.slice(0, needed);

  // Fill with bots not already seated. Duplicates are the thing to avoid: a
  // table of three identical maniacs teaches nothing, which is the same reason
  // `randomLineup` returns distinct profiles. There are more archetypes than
  // MAX_SEATS, so this always finds enough.
  const out = [...lineup];
  for (const profile of randomLineup(needed, seed)) {
    if (out.length >= needed) break;
    const id = profile.id as BuiltArchetype;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function startingStack(setup: TableSetup): number {
  return setup.stackBb * setup.bigBlind;
}

const STORAGE_KEY = "pp.tableOptions";

export function loadSetup(): TableSetup {
  if (typeof window === "undefined") return DEFAULT_SETUP;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETUP;
    return normalizeSetup({ ...DEFAULT_SETUP, ...JSON.parse(raw) });
  } catch {
    // Corrupt or unavailable storage must never block sitting down.
    return DEFAULT_SETUP;
  }
}

export function saveSetup(setup: TableSetup): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
  } catch {
    /* private browsing / quota, the setup just will not persist */
  }
}

/**
 * Clamp a setup back into legal shape. Anything read from storage is untrusted:
 * it may predate a change to the archetype roster or the seat limits.
 */
export function normalizeSetup(setup: TableSetup): TableSetup {
  const seatCount = Math.min(MAX_SEATS, Math.max(MIN_SEATS, chips(setup.seatCount, 0)));
  const stackBb = (STACK_DEPTHS as readonly number[]).includes(setup.stackBb)
    ? setup.stackBb
    : DEFAULT_SETUP.stackBb;
  const mode = TABLE_MODES.some((m) => m.id === setup.mode)
    ? setup.mode
    : DEFAULT_SETUP.mode;
  const observer = Boolean(setup.observer);

  // The engine assumes whole chips and requires bigBlind >= smallBlind; a stored
  // value violating either throws inside createTable, and because the bad value
  // persists, reloading would not clear it. Clamp both together.
  const smallBlind = chips(setup.smallBlind, DEFAULT_SETUP.smallBlind);
  const bigBlind = Math.max(smallBlind, chips(setup.bigBlind, DEFAULT_SETUP.bigBlind));

  // `hasOwn`, not `in`: `in` walks the prototype chain, so storage could name
  // "toString" and seat a bot whose parameters are all undefined.
  const lineup = Array.isArray(setup.lineup) ? setup.lineup : [];
  const known = lineup.filter((id): id is BuiltArchetype =>
    Object.hasOwn(BOT_PROFILES, id)
  );

  return {
    seatCount,
    stackBb: stackBb as StackDepth,
    smallBlind,
    bigBlind,
    lineup: fitLineup(known, botsNeeded({ seatCount, observer }), seatCount),
    mode,
    observer,
  };
}

/**
 * Largest blind accepted. An upper bound is needed as well as a lower one:
 * 1e308 is perfectly finite, but `stackBb × bigBlind` then overflows to
 * Infinity and the whole table is built with an infinite stack.
 */
const MAX_BLIND = 1_000_000;

/**
 * Coerce an untrusted value to a whole number of chips within sane bounds.
 *
 * Storage is JSON, so a value can arrive as a string, a fraction, or something
 * astronomically large. Strings are the nastiest: `"10" < "5"` compares
 * lexicographically, so the engine's own blind validation would reject a
 * perfectly good 5/10 table for the wrong reason.
 */
function chips(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 && n <= MAX_BLIND ? n : fallback;
}
