/**
 * The human's controls: fold / check / call, and — the part No-Limit actually
 * turns on — choosing how much.
 *
 * Sizing is offered twice over, because the two ways people think about it are
 * genuinely different. The preset rungs come straight from `sizingLadder`, so
 * "½ pot" means the same number the bots price against; the slider covers
 * everything between the minimum legal raise and the whole stack, for the spots
 * where a rung is not what you want.
 *
 * On a phone the whole thing moves into a bottom sheet. Six seats, a board and
 * a slider do not coexist on a 390px screen, and shrinking the desktop layout
 * until they do produces a slider nobody can hit.
 */

import { useEffect, useMemo, useState } from "react";
import { money } from "../../lib/format";
import type { SizingOption, TableAction } from "../../poker/table/rules";

const ACTION_STYLES: Record<string, string> = {
  fold: "border border-ivory/25 bg-black/40 text-ivory/80 hover:border-ivory/50 hover:text-ivory",
  check: "border border-gold/50 bg-gold/15 text-gold-soft hover:bg-gold/25",
  call: "border border-gold/60 bg-gold/20 text-gold-soft hover:bg-gold/30",
  bet: "border border-pkred-light/70 bg-pkred/80 text-ivory hover:bg-pkred-light",
  raise: "border border-pkred-light/70 bg-pkred/80 text-ivory hover:bg-pkred-light",
};

/** Re-label a bet or raise at a chosen size. Mirrors the engine's own wording. */
export function sized(base: TableAction, cost: number): TableAction {
  const streetCommit = base.amount - base.cost;
  const min = base.min ?? base.cost;
  const max = base.max ?? base.cost;
  const clamped = Math.min(Math.max(Math.round(cost), min), max);
  const amount = streetCommit + clamped;
  return {
    ...base,
    cost: clamped,
    amount,
    label:
      clamped >= max
        ? `All-in ${money(clamped)}`
        : base.type === "bet"
          ? `Bet ${money(clamped)}`
          : `Raise to ${money(amount)}`,
  };
}

/** The rung a player most often wants pre-selected. */
function defaultCost(raise: TableAction, sizings: SizingOption[]): number {
  const half = sizings.find((s) => s.label === "½ pot");
  return half?.cost ?? raise.min ?? raise.cost;
}

export interface ActionBarProps {
  actions: TableAction[];
  sizings: SizingOption[];
  /** Identifies the decision point, so the chosen size resets when it moves. */
  decisionKey: string;
  pot: number;
  stack: number;
  narrow: boolean;
  onAct: (action: TableAction) => void;
}

/** Chips owed before any raise — the part of a sizing that is not the raise. */
function toCallOf(actions: TableAction[]): number {
  return actions.find((a) => a.type === "call")?.cost ?? 0;
}

export function ActionBar({
  actions,
  sizings,
  decisionKey,
  pot,
  stack,
  narrow,
  onAct,
}: ActionBarProps) {
  const raise = useMemo(
    () => actions.find((a) => a.type === "bet" || a.type === "raise"),
    [actions]
  );
  const [cost, setCost] = useState(() =>
    raise ? defaultCost(raise, sizings) : 0
  );
  const [sheet, setSheet] = useState(false);

  // A new decision point invalidates the chosen size — the legal range has
  // moved and the old number may not even be legal any more.
  useEffect(() => {
    setSheet(false);
    setCost(raise ? defaultCost(raise, sizings) : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionKey]);

  if (actions.length === 0) return null;

  const simple = actions.filter((a) => a.type !== "bet" && a.type !== "raise");
  const commit = raise ? sized(raise, cost) : null;
  const toCall = toCallOf(actions);

  return (
    <div className="w-full">
      {raise && !narrow && (
        <div className="mx-auto mb-2.5 w-full max-w-2xl">
          <SizingPanel
            raise={raise}
            sizings={sizings}
            cost={cost}
            pot={pot}
            toCall={toCall}
            stack={stack}
            onChange={setCost}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {simple.map((action) => (
          <button
            key={action.type}
            data-testid={`action-${action.type}`}
            onClick={() => onAct(action)}
            className={`min-h-[46px] flex-1 rounded-xl px-4 py-3 font-display text-sm font-semibold tracking-wide shadow-lg transition-all duration-200 ease-out hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:flex-none sm:min-w-[8rem] sm:px-6 ${
              ACTION_STYLES[action.type] ?? "bg-black/30"
            }`}
          >
            {action.label}
          </button>
        ))}

        {commit && (
          <button
            data-testid={`action-${commit.type}`}
            onClick={() => (narrow ? setSheet(true) : onAct(commit))}
            className={`min-h-[46px] flex-1 rounded-xl px-4 py-3 font-display text-sm font-semibold tracking-wide shadow-lg transition-all duration-200 ease-out hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 sm:flex-none sm:min-w-[9rem] sm:px-6 ${
              ACTION_STYLES[commit.type]
            }`}
          >
            {narrow ? (commit.type === "bet" ? "Bet…" : "Raise…") : commit.label}
          </button>
        )}
      </div>

      {raise && narrow && sheet && (
        <Sheet onClose={() => setSheet(false)}>
          <SizingPanel
            raise={raise}
            sizings={sizings}
            cost={cost}
            pot={pot}
            toCall={toCall}
            stack={stack}
            onChange={setCost}
          />
          <button
            data-testid="sheet-confirm"
            onClick={() => {
              setSheet(false);
              onAct(sized(raise, cost));
            }}
            className={`mt-4 min-h-[50px] w-full rounded-xl px-5 py-3 font-display text-base font-semibold tracking-wide shadow-lg ${ACTION_STYLES[raise.type]}`}
          >
            {sized(raise, cost).label}
          </button>
        </Sheet>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SizingPanel({
  raise,
  sizings,
  cost,
  pot,
  toCall,
  stack,
  onChange,
}: {
  raise: TableAction;
  sizings: SizingOption[];
  cost: number;
  pot: number;
  toCall: number;
  stack: number;
  onChange: (cost: number) => void;
}) {
  const min = raise.min ?? raise.cost;
  const max = raise.max ?? raise.cost;
  const preview = sized(raise, cost);
  const fill = max > min ? ((preview.cost - min) / (max - min)) * 100 : 100;
  const behind = stack - preview.cost;
  // Measured exactly as `sizingLadder` measures it: the call is not part of the
  // raise, so the fraction is over the pot *after* calling. Any other formula
  // puts "156% pot" next to a highlighted "½ pot" rung.
  const potAfterCall = pot + toCall;
  const potShare =
    potAfterCall > 0 ? (preview.cost - toCall) / potAfterCall : 0;
  // A bet is named by what it costs; a raise by the level it sets. Showing the
  // wrong one puts a number on screen that no button ever says.
  const headline = raise.type === "bet" ? preview.cost : preview.amount;

  return (
    <div
      className="rounded-2xl border p-3"
      style={{
        borderColor: "rgba(201,162,39,0.3)",
        background: "rgba(0,0,0,0.42)",
      }}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-display text-[0.62rem] uppercase tracking-[0.3em] text-ivory/50">
          {raise.type === "bet" ? "Bet size" : "Raise to"}
        </span>
        <span className="flex items-baseline gap-2">
          <span
            data-testid="sizing-amount"
            className="font-display text-xl font-bold text-gold-soft"
          >
            {money(headline)}
          </span>
          <span className="font-mono text-[0.65rem] text-ivory/45">
            {Math.round(potShare * 100)}% pot · {money(behind)} behind
          </span>
        </span>
      </div>

      <input
        type="range"
        data-testid="sizing-slider"
        aria-label="Bet size"
        className="pp-t-slider"
        min={min}
        max={max}
        step={1}
        value={preview.cost}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(90deg, #c9a227 0%, #c9a227 ${fill}%, rgba(0,0,0,0.5) ${fill}%, rgba(0,0,0,0.5) 100%)`,
        }}
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {sizings.map((option) => {
          const active = option.cost === preview.cost;
          return (
            <button
              key={option.label}
              data-testid={`sizing-${option.label}`}
              onClick={() => onChange(option.cost)}
              className="min-h-[34px] flex-1 rounded-lg border px-2 py-1.5 font-display text-[0.7rem] tracking-wide transition"
              style={{
                borderColor: active
                  ? "rgba(201,162,39,0.85)"
                  : "rgba(244,237,228,0.18)",
                background: active ? "rgba(201,162,39,0.22)" : "rgba(0,0,0,0.35)",
                color: active ? "#e2c563" : "rgba(244,237,228,0.7)",
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Sheet({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end" role="dialog" aria-modal>
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
      />
      <div
        className="pp-t-sheet relative w-full rounded-t-3xl border-t px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3"
        style={{
          borderColor: "rgba(201,162,39,0.4)",
          background:
            "radial-gradient(120% 120% at 50% 0%, #16402c 0%, #0b2218 70%)",
          boxShadow: "0 -20px 50px rgba(0,0,0,0.6)",
        }}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ivory/25" />
        {children}
      </div>
    </div>
  );
}
