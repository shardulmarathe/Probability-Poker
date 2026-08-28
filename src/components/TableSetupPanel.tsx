/**
 * The table you are about to sit down at.
 *
 * Everything here edits one `TableSetup` and persists it, so the choice
 * survives a reload and the game reads exactly what was chosen. The opponent
 * picker is the point of the screen: a table of five identical maniacs plays
 * nothing like a table of five nits, and being able to *see* the roster before
 * the cards come out is what makes that a lesson rather than a surprise.
 *
 * It is closed by default now. Open, this panel was 943px of form — nineteen
 * controls, nine permanent blurbs and 239 words standing between the landing
 * page and a single card. The overwhelming majority of arrivals want the table
 * they already have, and the ones who do not are not helped by being shown a
 * radiogroup they have to read before they can decline it. So the closed state
 * is a sentence stating the four things that actually change how the hand plays
 * — seats, depth, mode, and who is in the other chairs — and one control that
 * opens the editor. Nothing was removed; every control and every blurb is one
 * click away.
 *
 * The summary names the opponents rather than counting them. "Table
 * configured" would be the useless version: the difference between Wildfire Wes
 * and Nickel Nate is the difference between two games, and a player who cannot
 * see which one they are about to play has not been told anything.
 *
 * Two things that used to be invisible are still on the screen, just not all at
 * once. The mode blurbs ("Nothing revealed. Just poker") and what stack depth
 * *means* both lived only in `title=` attributes or source comments, which no
 * touch device and no player has ever seen. They are now the `Tabs` hints,
 * shown on hover and on keyboard focus over the option they describe, which
 * keeps them attached to their control instead of stacking four permanent
 * italic sentences down the left column.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  MAX_SEATS,
  MIN_SEATS,
  STACK_DEPTHS,
  TABLE_MODES,
  botsNeeded,
  saveSetup,
  startingStack,
  type StackDepth,
  type TableSetup,
} from "../lib/tableOptions";
import {
  BOT_ARCHETYPES,
  BOT_PROFILES,
  type BuiltArchetype,
} from "../poker/model/profiles";
import { money } from "../lib/format";
import type { TableSetupHandle } from "./setup/useTableSetup";
import { Button, LINE, Panel, RADIUS, Rail, Reveal, Tabs } from "./ui";

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

/**
 * "Textbook Tara" → "Tara".
 *
 * The epithet is the personality and the given name is what you would call
 * them at the table. Six of these have to sit on one line at 390px, and
 * "Textbook Tara, Callin' Carla, Wildfire Wes, Riverboat Rey" does not; the
 * given names do, and they are still unambiguous across the seven archetypes.
 */
function shortName(id: BuiltArchetype): string {
  const full = BOT_PROFILES[id].name;
  return full.slice(full.lastIndexOf(" ") + 1);
}

/**
 * The closed panel's one sentence.
 *
 * Only the settings that change how the hand plays, in the order a player would
 * ask about them: how many of us, how deep, how much is the interface telling
 * me, and who am I up against.
 */
function describeSetup(setup: TableSetup): string {
  const mode = TABLE_MODES.find((m) => m.id === setup.mode);
  return [
    `${setup.seatCount} seats`,
    `${setup.stackBb}bb`,
    mode?.name ?? setup.mode,
    // Only when true: an observer table has no seat for you, and that is not
    // something to discover after pressing the button that says "deal".
    ...(setup.observer ? ["you sit out"] : []),
    setup.lineup.map(shortName).join(", "),
  ].join(" · ");
}

export default function TableSetupPanel({ table }: { table: TableSetupHandle }) {
  const navigate = useNavigate();
  const { setup, update, setBot, randomise } = table;
  const [editing, setEditing] = useState(false);

  const stack = startingStack(setup);
  const bots = botsNeeded(setup);

  return (
    <Panel id="setup" testId="setup">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-wide text-gold-soft sm:text-xl">
            {editing ? "Choose your table" : "Your table"}
          </h2>
          {editing ? (
            <p className="mt-1 text-sm leading-relaxed text-ivory/55">
              Four choices, and each one changes how the hand plays. Nothing
              here is a preference.
            </p>
          ) : (
            <p
              data-testid="setup-summary"
              className="mt-1 font-mono text-[0.72rem] leading-relaxed text-ivory/65 sm:text-[0.78rem]"
            >
              {describeSetup(setup)}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {editing && <Rail>{money(stack)} stacks</Rail>}
          <Button
            size="sm"
            variant="quiet"
            data-testid="setup-change"
            aria-expanded={editing}
            aria-controls="setup-editor"
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? "Done" : "Change"}
          </Button>
        </div>
      </div>

      {editing && (
        <div id="setup-editor" className="mt-6">
          <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
            <div className="flex flex-col gap-6">
              <Field label="Seats">
                <Tabs
                  label="Number of seats"
                  as="options"
                  layout="wrap"
                  showHint
                  hintAs="tooltip"
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
                  hintAs="tooltip"
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
                  hintAs="tooltip"
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
                  {/* The consequence, printed the moment it becomes a
                      consequence. Unchecked, this was two lines describing a
                      table nobody had asked for; checked, it is the one thing
                      the reader needs to know about the table they now have,
                      which is the rule the rest of the app follows for a
                      warning about *this* state. */}
                  {setup.observer && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-ivory/55">
                      No seat for you. The bots play each other with every hand
                      face up — the fastest way to watch a style get punished.
                    </span>
                  )}
                </span>
              </label>
            </div>

            {/* ------------------------- The roster ------------------------- */}
            <div className="flex flex-col">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <p className="min-w-0 font-display text-sm font-semibold tracking-wide text-ivory">
                  Who you're playing
                  <span className="ml-2 font-mono text-[0.68rem] font-normal text-ivory/45">
                    {bots} opponent{bots === 1 ? "" : "s"}
                  </span>
                </p>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={randomise}
                  data-testid="randomise"
                >
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

              {/* The blurbs under each pick stay on screen — reading them IS
                  choosing an opponent. What does not is the paragraph above
                  them promising the numbers are real, which is a claim about
                  the engine rather than about this table. */}
              <Reveal tone="quiet" label="How literal are these descriptions?">
                Each plays a fixed, measurable style — the percentages in their
                descriptions are the ones they actually hit.
              </Reveal>
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
              Your table is remembered on this device.
            </p>
          </div>
        </div>
      )}
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
