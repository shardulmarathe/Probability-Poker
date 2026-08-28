/**
 * The table's own controls, hung in the application's header.
 *
 * These used to be a second header row of the table's own: a compact
 * `PageHeader` reading "Your table", the mode switch, an always-visible italic
 * blurb under it, and a "Change table" link. That row and its heading were
 * 114px of the ~240px that pushed Fold and Call below the fold at 1440x760, on
 * a page whose entire purpose is the moment you press one of them. The 52px app
 * bar is already paid for on every route and had a free half, so the controls
 * moved into it and the row went away.
 *
 * A portal rather than a prop, because `AppShell` sits *outside* `TableProvider`
 * (see App.tsx) and so cannot call `useTable()`. The shell owns an empty slot;
 * this is the only thing that ever fills it.
 *
 * Wide screens only. `TableGame` gates the mount on `useWide()` rather than
 * relying on the slot's own `hidden lg:flex`, because a CSS-hidden slot is
 * still in the DOM: portalling into it below `lg` would put two mode switches
 * on the page, both answering to `data-testid="mode-fair"`, and the invisible
 * one would win every query.
 */

import { useEffect, useId, useState, type FocusEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { TABLE_MODES, type TableMode } from "../../lib/tableOptions";
import { HEADER_SLOT_ID } from "../shell";
import { LINE, RADIUS, Rail, SURFACE, Tabs } from "../ui";

export interface TableChromeProps {
  handNumber: number;
  seatCount: number;
  mode: TableMode;
  onMode: (mode: TableMode) => void;
  observer: boolean;
}

export function TableChrome({
  handNumber,
  seatCount,
  mode,
  onMode,
  observer,
}: TableChromeProps) {
  const slot = useHeaderSlot();
  const tipId = useId();
  /*
   * Which mode's blurb is being asked for, by pointer or by keyboard. Held here
   * rather than per-button because `Tabs` renders the buttons and this file
   * does not own that component: the row is one delegated listener instead.
   */
  const [hinted, setHinted] = useState<TableMode | null>(null);
  const hint = TABLE_MODES.find((m) => m.id === hinted);

  /*
   * The blurbs used to be `title=` attributes, then an always-on paragraph
   * under the switch. The first was invisible on every touch device, the second
   * cost a permanent line of the page's height to say something you need once.
   * A tooltip is the honest shape for it, and `role="tooltip"` with a real
   * `aria-describedby` is what makes it reach a screen reader, which `title=`
   * never reliably did.
   *
   * `aria-describedby` is set on the element rather than passed as a prop
   * because `Tabs` has no way to express one yet. React does not manage this
   * attribute, so it survives a re-render and has to be taken off by hand on
   * the way out, which is what `close` is for.
   */
  const open = (event: FocusEvent | MouseEvent) => {
    const tab = tabAt(event.target);
    if (!tab) return;
    tab.el.setAttribute("aria-describedby", tipId);
    setHinted(tab.mode);
  };
  const close = (event: FocusEvent | MouseEvent) => {
    tabAt(event.target)?.el.removeAttribute("aria-describedby");
    setHinted(null);
  };

  if (!slot) return null;

  return createPortal(
    <>
      <div
        className="relative w-[17.5rem] shrink-0"
        onMouseOver={open}
        onMouseOut={close}
        onFocus={open}
        onBlur={close}
      >
        <Tabs
          label="What the table shows you"
          as="options"
          layout="fill"
          size="sm"
          testIdPrefix="mode"
          showHint={false}
          value={mode}
          onChange={onMode}
          /* First word only. Four modes share 17.5rem in a bar that also
             carries the wordmark, four nav links and the account control, and a
             truncated "Fair Pl…" reads worse than a short label with the full
             name one hover away. */
          options={TABLE_MODES.map((m) => ({
            value: m.id,
            label: m.name.split(" ")[0],
          }))}
        />

        {hint && (
          <div
            id={tipId}
            role="tooltip"
            /* Anchored right: the slot is `justify-end`, so a centred tooltip
               on the last tab hangs off the viewport. */
            className={`pointer-events-none absolute right-0 top-full z-50 mt-2 w-max max-w-[18rem] border px-3 py-2 ${RADIUS.surface}`}
            style={{
              borderColor: LINE.gold,
              backgroundColor: "rgba(8,25,18,0.97)",
              backgroundImage: SURFACE.panel,
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            }}
          >
            <span className="font-display text-[0.7rem] font-semibold tracking-wide text-gold-soft">
              {hint.name}
            </span>
            <p className="font-cormorant text-[0.95rem] italic leading-snug text-ivory/70">
              {hint.blurb}
            </p>
          </div>
        )}
      </div>

      {observer && <Rail>Watching</Rail>}
      <Rail>
        {seatCount}-handed · Hand #{handNumber}
      </Rail>
    </>,
    slot
  );
}

// ---------------------------------------------------------------------------

/**
 * The header's slot node, once there is one.
 *
 * A state and an effect rather than a `getElementById` during render. On the
 * first render this component's own tree is still being built, so a synchronous
 * read can miss the node, and having missed it there would be nothing to make
 * the component look again: the switch would silently never appear. The effect
 * runs after the commit, by which point the shell's header is in the document.
 *
 * It also keeps `document` out of the module's render path, so importing this
 * file in the node test environment, which has no DOM at all, cannot throw.
 */
function useHeaderSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(HEADER_SLOT_ID));
  }, []);
  return slot;
}

/** The mode tab an event landed on, if it landed on one at all. */
function tabAt(
  target: EventTarget | null
): { el: Element; mode: TableMode } | null {
  const el =
    target instanceof Element ? target.closest("[data-testid^='mode-']") : null;
  const id = el?.getAttribute("data-testid")?.slice("mode-".length);
  // `mode-hint` shares the prefix. It is not rendered here, but the guard is
  // the difference between a missing tooltip and one describing `undefined`.
  const mode = TABLE_MODES.find((m) => m.id === id);
  return el && mode ? { el, mode: mode.id } : null;
}
