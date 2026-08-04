/**
 * The table you are about to sit down at, and the only teaching surface the
 * product gets before the cards come out.
 *
 * Everything here edits one `TableSetup` and persists it, so the choice
 * survives a reload and the game reads exactly what was chosen. The opponent
 * picker is the point of the screen: a table of five identical maniacs plays
 * nothing like a table of five nits, and being able to *see* the roster before
 * the cards come out is what makes that a lesson rather than a surprise.
 *
 * Two things that used to be invisible are now on the screen. The mode blurbs
 * ("Nothing revealed. Just poker") lived only in `title=` attributes, which no
 * touch device has ever shown to anyone. And what stack depth *means*, the
 * single choice here that changes correct strategy most, was a comment in
 * `lib/tableOptions.ts` that only a developer could read. Both are printed
 * under the control that sets them, always visible, no modal and no tour.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  MAX_SEATS,
  MIN_SEATS,
  STACK_DEPTHS,
  TABLE_MODES,
  botsNeeded,
  fitLineup,
  loadSetup,
  saveSetup,
  startingStack,
  type StackDepth,
  type TableSetup,
} from "../lib/tableOptions";
import {
  BOT_ARCHETYPES,
  BOT_PROFILES,
  randomLineup,
  type BuiltArchetype,
} from "../poker/model/profiles";
import { money } from "../lib/format";
import { Button, LINE, Panel, RADIUS, Rail, Tabs } from "./ui";

const SEAT_COUNTS = Array.from(
  { length: MAX_SEATS - MIN_SEATS + 1 },
  (_, i) => MIN_SEATS + i
);

/**
 * What a table of this size actually plays like.
 *
 * Table size and stack depth are the two settings a new player has no way to
 * evaluate, both look like preferences and both are strategy decisions.
 */
const SEAT_HINTS: Record<number, string> = {
  2: "Heads-up. Every hand is playable, and you are in the blinds every deal.",
  3: "Three-handed. The blinds come round so fast that folding gets expensive.",
  4: "Four-handed. Enough seats to have position on, few enough to play most pots.",
  5: "Five-handed. Early position starts to matter, and pots go multiway.",
  6: "Six-handed. The standard online table: tight from up front, wide on the button.",
};

/**
 * Stack depth, explained.
 *
 * This is `STACK_DEPTHS`' own comment, promoted to the screen: depth changes
 * correct strategy more than almost anything else, and 20bb and 200bb are
 * close to two different games.
 */
const DEPTH_HINTS: Record<number, string> = {
  20: "Short. Nearly every hand is settled before the flop — this is close to push-or-fold poker.",
  50: "Shallow. A raise and one bet commits the stack, so postflop play is short and sharp.",
  100: "Standard. The depth almost all published strategy assumes. Start here.",
  200: "Deep. Almost every decision is postflop, and an early mistake compounds down three streets.",
};

export default function TableSetupPanel() {
  const navigate = useNavigate();
  const [setup, setSetupState] = useState<TableSetup>(loadSetup);

  /** Every edit re-fits the lineup to the seat count and persists. */
  const update = useCallback((patch: Partial<TableSetup>) => {
    setSetupState((cur) => {
      const merged = { ...cur, ...patch };
      const next: TableSetup = {
        ...merged,
        lineup: fitLineup(
          merged.lineup,
          botsNeeded(merged),
          merged.seatCount * 7919
        ),
      };
      saveSetup(next);
      return next;
    });
  }, []);

  const randomise = useCallback(() => {
    setSetupState((cur) => {
      const next: TableSetup = {
        ...cur,
        lineup: randomLineup(botsNeeded(cur), Date.now() >>> 0).map(
          (p) => p.id as BuiltArchetype
        ),
      };
      saveSetup(next);
      return next;
    });
  }, []);

  const setBot = useCallback((index: number, id: BuiltArchetype) => {
    setSetupState((cur) => {
      const lineup = [...cur.lineup];
      lineup[index] = id;
      const next = { ...cur, lineup };
      saveSetup(next);
      return next;
    });
  }, []);

  const stack = startingStack(setup);
  const bots = botsNeeded(setup);

  return (
    <Panel
      id="setup"
      testId="setup"
      title="Choose your table"
      subtitle="Four choices, and each one changes how the hand plays. Nothing here is a preference."
      actions={
        <Rail>
          {setup.seatCount} seats · {money(stack)} stacks
        </Rail>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
        <div className="flex flex-col gap-6">
          <Field label="Seats">
            <Tabs
              label="Number of seats"
              as="options"
              layout="wrap"
              showHint
              testIdPrefix="seats"
              value={setup.seatCount}
              onChange={(n) => update({ seatCount: n })}
              options={SEAT_COUNTS.map((n) => ({
                value: n,
                label: String(n),
                hint: SEAT_HINTS[n],
              }))}
            />
          </Field>

          <Field
            label="Stack depth"
            aside={`${setup.stackBb} big blinds — ${money(stack)} at ${money(setup.smallBlind)}/${money(setup.bigBlind)}`}
          >
            <Tabs
              label="Stack depth in big blinds"
              as="options"
              layout="wrap"
              showHint
              testIdPrefix="stack"
              value={setup.stackBb}
              onChange={(d) => update({ stackBb: d as StackDepth })}
              options={STACK_DEPTHS.map((d) => ({
                value: d,
                label: `${d}bb`,
                hint: DEPTH_HINTS[d],
              }))}
            />
          </Field>

          <Field label="What the table shows you">
            <Tabs
              label="What the table shows you"
              as="options"
              layout="wrap"
              showHint
              testIdPrefix="mode"
              value={setup.mode}
              onChange={(m) => update({ mode: m })}
              options={TABLE_MODES.map((m) => ({
                value: m.id,
                label: m.name,
                hint: m.blurb,
              }))}
            />
          </Field>

          <label
            data-testid="observer-toggle"
            className={`flex cursor-pointer items-start gap-3 border p-3 transition hover:border-gold/40 ${RADIUS.control}`}
            style={{ borderColor: LINE.quiet, background: "rgba(0,0,0,0.28)" }}
          >
            <input
              type="checkbox"
              checked={setup.observer}
              onChange={(e) => update({ observer: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-[#c9a227]"
            />
            <span>
              <span className="font-display text-sm text-ivory">
                Sit out and watch instead
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ivory/55">
                No seat for you. The bots play each other with every hand face
                up — the fastest way to watch a style get punished.
              </span>
            </span>
          </label>
        </div>

        {/* ------------------------- The roster ------------------------- */}
        <div className="flex flex-col">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-sm font-semibold tracking-wide text-ivory">
                Who you're playing
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-ivory/50">
                {bots} opponent{bots === 1 ? "" : "s"}. Each plays a fixed,
                measurable style — the percentages in their descriptions are the
                ones they actually hit.
              </p>
            </div>
            <Button size="sm" variant="quiet" onClick={randomise} data-testid="randomise">
              ⟳ Shuffle
            </Button>
          </div>

          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            {setup.lineup.map((id, i) => (
              <BotPicker
                key={i}
                index={i}
                value={id}
                onChange={(next) => setBot(i, next)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8">
        <Button
          data-testid="deal-me-in"
          variant="primary"
          size="lg"
          full
          onClick={() => {
            saveSetup(setup);
            navigate("/table");
          }}
        >
          {setup.observer ? "Watch the table" : "Deal me in"}
          <span aria-hidden className="text-gold">
            →
          </span>
        </Button>
        <p className="mt-2.5 text-center text-xs text-ivory/40">
          Your table is remembered on this device. Change it any time from the
          landing page.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label,
  aside,
  children,
}: {
  label: string;
  /** A restatement of the current value in concrete terms, chips, not settings. */
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-display text-sm font-semibold tracking-wide text-ivory">
          {label}
        </span>
        {aside && (
          <span className="font-mono text-[0.68rem] text-ivory/45">{aside}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function BotPicker({
  index,
  value,
  onChange,
}: {
  index: number;
  value: BuiltArchetype;
  onChange: (id: BuiltArchetype) => void;
}) {
  const profile = BOT_PROFILES[value];
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center border text-xl ${RADIUS.control}`}
          style={{ borderColor: LINE.gold, background: "rgba(0,0,0,0.4)" }}
        >
          {profile.avatar}
        </span>
        <select
          data-testid={`bot-${index}`}
          aria-label={`Opponent ${index + 1}`}
          value={value}
          onChange={(e) => onChange(e.target.value as BuiltArchetype)}
          className={`min-h-[36px] w-full border px-2 py-1.5 font-display text-sm text-ivory outline-none transition focus:border-gold/60 ${RADIUS.control}`}
          style={{ borderColor: LINE.quiet, background: "rgba(0,0,0,0.5)" }}
        >
          {BOT_ARCHETYPES.map((id) => (
            <option key={id} value={id} style={{ background: "#0b2218" }}>
              {BOT_PROFILES[id].name}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1.5 font-cormorant text-[0.9rem] italic leading-snug text-ivory/55">
        {profile.blurb}
      </p>
    </div>
  );
}
