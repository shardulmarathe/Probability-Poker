/**
 * The human's controls: fold / check / call, and, the part No-Limit actually
 * turns on, choosing how much.
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
 *
 * On a wide screen it now moves into a popover that opens *upward*, over the
 * felt. The sizing panel used to sit in the flow above the buttons on every
 * decision, all 140px of it, and it was the single largest reason Fold and Call
 * were ~240px below the fold at 1440x760. It is also the wrong default: most
 * decisions are taken at the rung already selected, so the common case is now
 * one click on `Raise to $150` and the ladder is one click away for the rest.
 * Nothing was deleted, the slider and all five rungs are the same control in a
 * different place, and they cost the column no height at all.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { money } from "../../lib/format";
import type { SizingOption, TableAction } from "../../poker/table/rules";
import { ActionButton, LINE, RADIUS, Tabs } from "../ui";

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

/** Chips owed before any raise, the part of a sizing that is not the raise. */
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
  const [ladder, setLadder] = useState(false);
  const ladderRef = useRef<HTMLDivElement>(null);

  // A new decision point invalidates the chosen size, the legal range has
  // moved and the old number may not even be legal any more.
  useEffect(() => {
    setSheet(false);
    setLadder(false);
    setCost(raise ? defaultCost(raise, sizings) : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionKey]);

  /*
   * Esc and a click outside close the ladder without betting.
   *
   * The distinction is the whole safety property of a popover that sits over
   * the board: opening it must never be a commitment, so every way out of it
   * that is not a button inside it leaves the chips where they are. Dragging
   * the slider does not commit either, for the same reason.
   */
  useEffect(() => {
    if (!ladder) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLadder(false);
    };
    const onDown = (event: PointerEvent) => {
      if (!ladderRef.current?.contains(event.target as Node)) setLadder(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [ladder]);

  if (actions.length === 0) return null;

  const simple = actions.filter((a) => a.type !== "bet" && a.type !== "raise");
  const commit = raise ? sized(raise, cost) : null;
  const toCall = toCallOf(actions);

  return (
    <div className="w-full">
      <div
        className={
          narrow
            ? "flex w-full min-w-0 flex-nowrap items-center justify-center gap-2 overflow-x-hidden"
            : "flex flex-wrap items-center justify-center gap-2 sm:gap-3"
        }
      >
        {simple.map((action) => (
          <ActionButton
            key={action.type}
            action={action.type}
            data-testid={`action-${action.type}`}
            // Folding or calling with the ladder open is an answer to it, so
            // it closes rather than hanging over the next player's turn.
            onClick={() => {
              setLadder(false);
              onAct(action);
            }}
            className={
              narrow ? "min-w-0 flex-1" : "flex-1 sm:min-w-[8rem] sm:flex-none"
            }
          >
            {action.label}
          </ActionButton>
        ))}

        {commit &&
          (narrow ? (
            <ActionButton
              action={commit.type}
              data-testid={`action-${commit.type}`}
              onClick={() => setSheet(true)}
              className="min-w-0 flex-1"
            >
              {commit.type === "bet" ? "Bet…" : "Raise…"}
            </ActionButton>
          ) : (
            /*
             * The split button. Two controls in one shape because they are two
             * halves of one decision: the left commits at the size already
             * chosen, the right asks for a different one. `group-hover` lifts
             * both halves together, otherwise hovering one opens a visible
             * seam down the middle of what should read as a single button.
             */
            <div ref={ladderRef} className="group relative flex-none">
              {ladder && raise && (
                /*
                 * One surface, not two.
                 *
                 * The panel and its confirm button used to be separate boxes
                 * with a gap between them, and because the popover grows
                 * upward from the split button, that gap landed exactly on the
                 * coach line: the confirm read as a detached button sitting on
                 * top of "calling is −EV". The wrapper carries the border and
                 * the opaque ground now, and `SizingPanel` goes bare inside it.
                 */
                <div
                  className={`absolute bottom-full right-0 z-40 mb-2 w-[21rem] max-w-[calc(100vw-1.5rem)] border p-3 ${RADIUS.surface}`}
                  role="dialog"
                  aria-label="Choose a size"
                  style={{
                    borderColor: LINE.gold,
                    background:
                      "radial-gradient(120% 120% at 50% 0%, #16402c 0%, #0b2218 70%)",
                    boxShadow: "0 18px 45px rgba(0,0,0,0.72)",
                  }}
                >
                  <SizingPanel
                    bare
                    raise={raise}
                    sizings={sizings}
                    cost={cost}
                    pot={pot}
                    toCall={toCall}
                    stack={stack}
                    onChange={setCost}
                    // A rung is a decision, not a setting: clicking "¾ pot"
                    // means bet three quarters, and making the player then
                    // find the confirm button is the third click this popover
                    // exists to remove. The slider is the opposite, it moves
                    // through dozens of values on the way to one.
                    onPick={(next) => {
                      setLadder(false);
                      onAct(sized(raise, next));
                    }}
                  />
                  <ActionButton
                    action={raise.type}
                    data-testid="sizing-confirm"
                    onClick={() => {
                      setLadder(false);
                      onAct(sized(raise, cost));
                    }}
                    className="mt-2 w-full"
                  >
                    {sized(raise, cost).label}
                  </ActionButton>
                </div>
              )}

              <div className="flex items-stretch">
                <ActionButton
                  action={commit.type}
                  data-testid={`action-${commit.type}`}
                  onClick={() => onAct(commit)}
                  className="min-w-[9rem] rounded-r-none border-r-0 group-hover:-translate-y-0.5"
                >
                  {commit.label}
                </ActionButton>
                <ActionButton
                  action={commit.type}
                  data-testid="sizing-open"
                  aria-label="Choose a size"
                  aria-expanded={ladder}
                  onClick={() => setLadder((was) => !was)}
                  className="rounded-l-none group-hover:-translate-y-0.5"
                  // Inline, not `px-3`: `ActionButton` already carries
                  // `px-4 sm:px-6`, and two utilities setting the same property
                  // are resolved by stylesheet order rather than by class
                  // order, so the wider one would silently win.
                  style={{ paddingLeft: "0.7rem", paddingRight: "0.7rem" }}
                >
                  {ladder ? "▾" : "▴"}
                </ActionButton>
              </div>
            </div>
          ))}
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
          <ActionButton
            action={raise.type}
            data-testid="sheet-confirm"
            onClick={() => {
              setSheet(false);
              onAct(sized(raise, cost));
            }}
            className="mt-3 w-full"
          >
            {sized(raise, cost).label}
          </ActionButton>
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
  onPick,
  bare = false,
}: {
  raise: TableAction;
  sizings: SizingOption[];
  cost: number;
  pot: number;
  toCall: number;
  stack: number;
  onChange: (cost: number) => void;
  /**
   * Drop the panel's own border and ground because a parent is already
   * providing them. The desktop popover is one surface with the confirm button
   * inside it; the phone sheet still wants the panel to be its own object.
   */
  bare?: boolean;
  /**
   * Called after `onChange` when a preset rung is chosen, never when the
   * slider moves. Optional, and absent in the phone sheet, where the confirm
   * button is already the only way out and acting on a rung would fire the
   * moment a thumb brushed one.
   */
  onPick?: (cost: number) => void;
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
      className={bare ? "" : `border p-3 ${RADIUS.surface}`}
      style={{
        borderColor: bare ? undefined : LINE.gold,
        /*
         * Near-opaque, and a shadow, because this panel no longer sits in the
         * flow on dark page background: it floats over the felt, and the felt
         * under it is the hero's own hole cards and nameplate. At the old
         * `rgba(0,0,0,0.42)` a king of diamonds read straight through "Raise
         * to" and the rung labels, which made the control look broken rather
         * than transparent. The sheet on a phone has always been opaque for
         * exactly this reason.
         */
        background: bare
          ? undefined
          : "radial-gradient(120% 120% at 50% 0%, #16402c 0%, #0b2218 70%)",
        boxShadow: bare ? undefined : "0 18px 45px rgba(0,0,0,0.72)",
      }}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-display text-sm font-semibold tracking-wide text-ivory/70">
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

      <div className="mt-2">
        <Tabs
          label="Preset sizes"
          as="options"
          layout="wrap"
          size="sm"
          testIdPrefix="sizing"
          value={preview.cost}
          onChange={(next) => {
            onChange(next);
            onPick?.(next);
          }}
          options={sizings.map((option) => ({
            value: option.cost,
            label: option.label,
            // A rung's identity is its label ("½ pot"); its cost moves with the
            // pot, so the hook is pinned to the label it has always used.
            testId: `sizing-${option.label}`,
          }))}
        />
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
      {/* A scrim, not a blur. `backdrop-filter` here covered the whole viewport
          — including the felt, its weave and every card on it — and had to
          re-filter all of it on each frame the sheet animated in. The sheet is
          opaque; nothing behind it needed to be legible in the first place. */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
      />
      <div
        /* `rounded-t-2xl` is `RADIUS.surface` on the two corners that exist: a
           sheet is a panel grouping controls, so it takes the surface radius
           like every other panel. Spelled out rather than derived from the
           token, because Tailwind scans source text and would not emit a class
           assembled at runtime. `rounded-t-3xl` was the product's only 24px
           corner. */
        className="pp-t-sheet relative w-full rounded-t-2xl border-t px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2"
        style={{
          borderColor: "rgba(201,162,39,0.4)",
          background:
            "radial-gradient(120% 120% at 50% 0%, #16402c 0%, #0b2218 70%)",
          boxShadow: "0 -20px 50px rgba(0,0,0,0.6)",
        }}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-ivory/25" />
        {children}
      </div>
    </div>
  );
}
