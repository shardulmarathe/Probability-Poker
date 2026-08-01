/**
 * The table you are about to sit down at.
 *
 * Everything here edits one `TableSetup` and persists it, so the choice
 * survives a reload and the game reads exactly what was chosen. The opponent
 * picker is the point of the screen: a table of five identical maniacs plays
 * nothing like a table of five nits, and being able to *see* the roster before
 * the cards come out is what makes that a lesson rather than a surprise.
 */

import { useCallback, useMemo, useState } from "react";
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

const SEAT_COUNTS = Array.from(
  { length: MAX_SEATS - MIN_SEATS + 1 },
  (_, i) => MIN_SEATS + i
);

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
  const modeBlurb = useMemo(
    () => TABLE_MODES.find((m) => m.id === setup.mode)?.blurb ?? "",
    [setup.mode]
  );

  return (
    <section
      id="setup"
      data-testid="setup"
      className="rounded-3xl border border-gold/20 bg-pkblack/45 p-4 backdrop-blur-sm sm:p-6"
    >
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold tracking-wide text-ivory sm:text-2xl">
          Choose your table
        </h2>
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.25em] text-gold/70">
          {setup.seatCount} seats · {money(stack)} stacks
        </span>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Field label="Seats">
            <Pills
              options={SEAT_COUNTS.map((n) => ({ id: n, label: String(n) }))}
              value={setup.seatCount}
              onChange={(n) => update({ seatCount: n })}
              testPrefix="seats"
            />
          </Field>

          <Field
            label="Stack depth"
            hint={`${setup.stackBb} big blinds — ${money(stack)} at ${money(setup.smallBlind)}/${money(setup.bigBlind)}`}
          >
            <Pills
              options={STACK_DEPTHS.map((d) => ({ id: d, label: `${d}bb` }))}
              value={setup.stackBb}
              onChange={(d) => update({ stackBb: d as StackDepth })}
              testPrefix="stack"
            />
          </Field>

          <Field label="What you're shown" hint={modeBlurb}>
            <Pills
              options={TABLE_MODES.map((m) => ({ id: m.id, label: m.name }))}
              value={setup.mode}
              onChange={(m) => update({ mode: m })}
              testPrefix="mode"
            />
          </Field>

          <label
            data-testid="observer-toggle"
            className="flex cursor-pointer items-start gap-3 rounded-2xl border border-gold/15 bg-black/30 p-3 transition hover:border-gold/35"
          >
            <input
              type="checkbox"
              checked={setup.observer}
              onChange={(e) => update({ observer: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-[#c9a227]"
            />
            <span>
              <span className="font-display text-sm text-ivory">
                Observer mode
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ivory/55">
                No seat for you. The bots play each other with every hand face
                up — the fastest way to watch a style get punished.
              </span>
            </span>
          </label>
        </div>

        <div className="flex flex-col">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.25em] text-ivory/45">
              {botsNeeded(setup)} opponent{botsNeeded(setup) === 1 ? "" : "s"}
            </span>
            <button
              data-testid="randomise"
              onClick={randomise}
              className="rounded-lg border border-gold/40 bg-black/30 px-3 py-1.5 font-display text-[0.7rem] tracking-wide text-gold-soft transition hover:border-gold/70 hover:bg-gold/15"
            >
              ⟳ Randomise
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
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

      <button
        data-testid="deal-me-in"
        onClick={() => {
          saveSetup(setup);
          navigate("/table");
        }}
        className="group mt-6 flex w-full items-center justify-center gap-3 rounded-xl border border-gold/40 bg-pkred px-8 py-4 font-display text-base font-semibold tracking-widest text-ivory shadow-[0_10px_30px_-10px_rgba(122,0,25,0.8)] transition-all duration-200 hover:-translate-y-0.5 hover:border-gold/70 hover:bg-pkred-light sm:text-lg"
      >
        {setup.observer ? "WATCH THE TABLE" : "DEAL ME IN"}
        <span
          aria-hidden
          className="text-gold transition-transform duration-200 group-hover:translate-x-1"
        >
          →
        </span>
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[0.6rem] uppercase tracking-[0.25em] text-ivory/45">
        {label}
      </div>
      {children}
      {hint && (
        <p className="mt-1.5 font-cormorant text-sm italic leading-snug text-ivory/50">
          {hint}
        </p>
      )}
    </div>
  );
}

function Pills<T extends string | number>({
  options,
  value,
  onChange,
  testPrefix,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  testPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={String(option.id)}
            data-testid={`${testPrefix}-${option.id}`}
            onClick={() => onChange(option.id)}
            aria-pressed={active}
            className="min-h-[40px] min-w-[3rem] flex-1 rounded-xl border px-3 py-2 font-display text-sm tracking-wide transition"
            style={{
              borderColor: active
                ? "rgba(201,162,39,0.85)"
                : "rgba(244,237,228,0.16)",
              background: active ? "rgba(201,162,39,0.2)" : "rgba(0,0,0,0.3)",
              color: active ? "#e2c563" : "rgba(244,237,228,0.7)",
            }}
          >
            {option.label}
          </button>
        );
      })}
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
    <div className="rounded-2xl border border-gold/15 bg-black/30 p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gold/25 bg-black/40 text-xl">
          {profile.avatar}
        </span>
        <select
          data-testid={`bot-${index}`}
          value={value}
          onChange={(e) => onChange(e.target.value as BuiltArchetype)}
          className="min-h-[36px] w-full rounded-lg border border-ivory/15 bg-black/50 px-2 py-1.5 font-display text-sm text-ivory outline-none transition focus:border-gold/60"
        >
          {BOT_ARCHETYPES.map((id) => (
            <option key={id} value={id} style={{ background: "#0b2218" }}>
              {BOT_PROFILES[id].name}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1.5 font-cormorant text-[0.82rem] italic leading-snug text-ivory/55">
        {profile.blurb}
      </p>
    </div>
  );
}
