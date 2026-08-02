/**
 * The 13x13 hand chart.
 *
 * Standard orientation, and it has to be: ranks run A down to 2 along both
 * axes, pairs on the diagonal, suited hands in the upper-right triangle and
 * offsuit in the lower-left, so AKs sits one step right of AA and AKo one step
 * below it. A poker player recognises that layout without a caption, and any
 * other arrangement of the same numbers is a chart they have to learn to read.
 *
 * Three things this component refuses to do:
 *
 *  - Hold state per cell. 169 cells times an opponent count times a street is
 *    thousands of nodes; the readout is revealed with `:hover` / `:focus` in
 *    CSS, so opening a cell costs a repaint and never a React render. The only
 *    state here is the zoom toggle, which belongs to the grid as a whole.
 *  - Encode magnitude in colour alone. Weight drives *lightness* across a
 *    single hue, which survives greyscale and every common colour deficiency,
 *    and it independently drives the width of a bar along the bottom of each
 *    cell. Either channel alone is enough to rank two cells.
 *  - Shrink below legibility and call it responsive. See `mobile` below.
 *
 * Mobile: the grid fits its container rather than scrolling.
 * -------------------------------------------------------
 * A hand chart's first job on a phone is shape recognition — is the read a
 * tight cluster in the top-left corner or a wash across the whole square? Put
 * it in a horizontal scroller and that read is gone: the viewer never sees the
 * whole chart at once, which is the one thing the chart exists for. So the
 * default is fit-to-width, ~24px cells at 390px, and the cost of that choice —
 * labels too small to read comfortably — is paid back two ways. Touching or
 * hovering a cell pops it to 2.6x with its label, combo count and weight at
 * full size, and a Zoom control switches the whole grid to 35px cells inside
 * its own horizontal scroller for anyone who wants to read it cell by cell.
 * Shape by default, detail on demand, and the page itself never scrolls
 * sideways in either mode.
 */

import { memo, useState } from "react";
import { GRID_LABELS, GRID_SIZE } from "../../poker/model/range";

const RANKS = "AKQJT98765432";

export function RangeGridStyles() {
  return (
    <style>{`
/* A chart wider than about 28rem stops being a chart and becomes wallpaper:
   the cells outgrow their labels and the shape gets harder to read, not
   easier. The cap lets the grid fill a phone and a narrow column alike, and
   keeps it the same size in a 1200px panel. */
.rg-wrap { position: relative; max-width: 28rem; }
.rg-scroll { overflow: visible; }
.rg-scroll--zoom { overflow-x: auto; overflow-y: hidden; padding-bottom: 0.35rem; }
.rg {
  display: grid;
  gap: 1px;
  grid-template-columns: 0.95rem repeat(13, minmax(0, 1fr));
  font-size: clamp(0.4rem, 1.85vw, 0.66rem);
  width: 100%;
  line-height: 1;
}
.rg--zoom {
  grid-template-columns: 1.1rem repeat(13, 2.15rem);
  font-size: 0.6rem;
  width: max-content;
}
.rg-h {
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display), serif;
  font-size: 0.6rem; letter-spacing: 0.02em;
  color: rgba(226,197,99,0.65);
}
.rg-cell {
  position: relative;
  aspect-ratio: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  border: 0; padding: 0; margin: 0;
  border-radius: 2px;
  cursor: pointer;
  background: hsl(43 58% calc(var(--l) * 1%));
  color: var(--fg);
  transition: transform 120ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 120ms ease;
}
.rg-cell::after {
  content: "";
  position: absolute; left: 9%; right: 9%; bottom: 7%;
  height: 9%; min-height: 1px;
  background: currentColor; opacity: 0.5;
  transform: scaleX(var(--w)); transform-origin: left center;
  border-radius: 1px;
}
.rg-cell.is-dead {
  background-image: repeating-linear-gradient(45deg, rgba(244,237,228,0.22) 0 1.5px, transparent 1.5px 4px);
}
.rg-cell.is-dead::after { display: none; }
.rg-t { font-size: 0.85em; font-weight: 600; letter-spacing: -0.03em; }
.rg-v {
  display: none;
  margin-top: 0.2em;
  font-family: var(--font-mono), monospace;
  font-size: 0.7em;
  opacity: 0.9;
  white-space: nowrap;
}
.rg-cell:hover, .rg-cell:focus {
  z-index: 9;
  outline: none;
  transform: scale(2.6);
  box-shadow: 0 8px 22px rgba(0,0,0,0.65), 0 0 0 1px rgba(201,162,39,0.9);
}
.rg-cell:hover .rg-v, .rg-cell:focus .rg-v { display: block; }
.rg--zoom .rg-v { display: block; }
.rg--zoom .rg-cell:hover, .rg--zoom .rg-cell:focus { transform: scale(1.3); }
@media (prefers-reduced-motion: reduce) {
  .rg-cell { transition: none; }
}
`}</style>
  );
}

export interface RangeGridProps {
  /** 169 values in chart order. */
  values: ArrayLike<number>;
  /** Top of the heat scale. Defaults to the largest value present. */
  max?: number;
  /** The line revealed when a cell is opened, e.g. "3 combos · 1.2%". */
  format: (cell: number) => string;
  /** Cells with nothing left in them, drawn hatched rather than shaded. */
  dead?: (cell: number) => boolean;
  legend?: { lo: string; hi: string; caption?: string };
  testId?: string;
  /** Shown next to the zoom control. */
  title?: string;
}

function cellStyle(
  cell: number,
  t: number
): React.CSSProperties & Record<string, string | number> {
  const row = Math.floor(cell / GRID_SIZE);
  const col = cell % GRID_SIZE;
  // A popped cell grows from its own edge when it sits on the chart's edge, so
  // the readout never lands outside the panel.
  const ox = col === 0 ? "left" : col === GRID_SIZE - 1 ? "right" : "center";
  const oy = row === 0 ? "top" : row === GRID_SIZE - 1 ? "bottom" : "center";
  // Gamma below 1 lifts the low end: without it a read concentrated on one
  // tier renders the other two as indistinguishable black.
  const shade = Math.pow(t, 0.62);
  return {
    "--l": (11 + shade * 53).toFixed(1),
    "--w": Math.max(0.02, t).toFixed(3),
    "--fg": shade > 0.6 ? "#10231a" : "rgba(244,237,228,0.86)",
    transformOrigin: `${ox} ${oy}`,
  };
}

function RangeGridImpl({
  values,
  max,
  format,
  dead,
  legend,
  testId,
  title,
}: RangeGridProps) {
  const [zoom, setZoom] = useState(false);

  let top = max ?? 0;
  if (max === undefined) {
    for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
      if (values[i] > top) top = values[i];
    }
  }
  const scale = top > 0 ? top : 1;

  const cells: React.ReactNode[] = [];
  // Header row: a blank corner, then the column ranks.
  cells.push(<div key="corner" className="rg-h" aria-hidden />);
  for (let c = 0; c < GRID_SIZE; c++) {
    cells.push(
      <div key={`ch-${c}`} className="rg-h" aria-hidden>
        {RANKS[c]}
      </div>
    );
  }
  for (let row = 0; row < GRID_SIZE; row++) {
    cells.push(
      <div key={`rh-${row}`} className="rg-h" aria-hidden>
        {RANKS[row]}
      </div>
    );
    for (let col = 0; col < GRID_SIZE; col++) {
      const cell = row * GRID_SIZE + col;
      const isDead = dead?.(cell) ?? false;
      const t = isDead ? 0 : Math.max(0, Math.min(1, values[cell] / scale));
      const readout = format(cell);
      cells.push(
        <button
          key={cell}
          type="button"
          className={`rg-cell${isDead ? " is-dead" : ""}`}
          style={cellStyle(cell, t)}
          aria-label={`${GRID_LABELS[cell]}: ${readout}`}
        >
          <span className="rg-t">{GRID_LABELS[cell]}</span>
          <span className="rg-v">{readout}</span>
        </button>
      );
    }
  }

  return (
    <div className="rg-wrap" data-testid={testId}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ivory/40">
          {title ?? "Suited above · offsuit below · pairs on the diagonal"}
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => !z)}
          aria-pressed={zoom}
          className="min-h-[30px] shrink-0 rounded-md border px-2 py-1 font-display text-[0.6rem] uppercase tracking-wider transition"
          style={{
            borderColor: zoom ? "rgba(201,162,39,0.6)" : "rgba(244,237,228,0.16)",
            background: zoom ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
            color: zoom ? "#e2c563" : "rgba(244,237,228,0.6)",
          }}
        >
          {zoom ? "Fit" : "Zoom"}
        </button>
      </div>

      <div className={zoom ? "rg-scroll rg-scroll--zoom" : "rg-scroll"}>
        <div className={zoom ? "rg rg--zoom" : "rg"} role="img" aria-label={title}>
          {cells}
        </div>
      </div>

      {legend && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[0.58rem] text-ivory/45">{legend.lo}</span>
          <div className="flex h-2.5 flex-1 overflow-hidden rounded-full" style={{ minWidth: "5rem" }}>
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
              <div
                key={t}
                className="h-full flex-1"
                style={{
                  background: `hsl(43 58% ${(11 + Math.pow(t, 0.62) * 53).toFixed(1)}%)`,
                }}
              />
            ))}
          </div>
          <span className="font-mono text-[0.58rem] text-ivory/45">{legend.hi}</span>
          {legend.caption && (
            <span className="w-full text-[0.65rem] leading-snug text-ivory/45">
              {legend.caption}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export const RangeGrid = memo(RangeGridImpl);
