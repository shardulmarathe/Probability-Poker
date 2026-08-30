/**
 * The table's own controls, hung in the application's header.
 *
 * A second header row of the table's own (a compact `PageHeader`, the mode
 * switch, a blurb and a "Change table" link) would cost 114px of the ~240px that
 * pushes Fold and Call below the fold at 1440x760, on a page whose entire
 * purpose is the moment one of them is pressed. The 52px app bar is already paid
 * for on every route and has a free half, so these controls live in it.
 *
 * A portal rather than a prop, because `AppShell` sits outside `TableProvider`
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
import { Link } from "react-router-dom";
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
   * A tooltip rather than either obvious alternative: a `title=` attribute is
   * invisible on every touch device, and an always-on paragraph under the switch
   * costs a permanent line of page height to say something needed once.
   * `role="tooltip"` with a real `aria-describedby` is what makes it reach a
   * screen reader, which `title=` never reliably does.
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

  /*
   * Choosing a mode shows you what you just chose, for a few seconds.
   *
   * Hover and focus alone are a pointer-only affordance, and this row is on
   * screen at 1024px and up, which includes every tablet in landscape. There, a
   * tap fires `focusin` and commits the change in the same gesture, so the
   * blurb could only ever be read after switching to the mode it describes,
   * which is the same "invisible on touch" failure that got `title=` removed
   * from this codebase in the first place. Showing the new mode's own blurb on
   * commit turns that from a trap into a confirmation, and it costs the layout
   * nothing because the tooltip is absolutely positioned.
   */
  const choose = (next: TableMode) => {
    onMode(next);
    setHinted(next);
  };
  useEffect(() => {
    if (hinted === null || hinted !== mode) return;
    const id = window.setTimeout(() => setHinted(null), 4000);
    return () => window.clearTimeout(id);
  }, [hinted, mode]);

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
          onChange={choose}
          /* First word only. Four modes share 17.5rem in a bar that also
             carries the wordmark, four nav links and the account control, and a
             truncated "Fair Pl..." reads worse than a short label with the full
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

      {/*
       * The rails thin out rather than overflowing.
       *
       * At exactly 1024px the bar is carrying the wordmark, four nav links, a
       * 17.5rem mode switch and the account control, and neither a `Rail` (it
       * is `whitespace-nowrap`) nor the switch can shrink. Observer mode adds a
       * second rail on top of that and pushed the row past the viewport, taking
       * the sticky header sideways with the page. "Watching" and the seat count
       * are both context rather than controls, so they wait for the width that
       * exists at `xl` and the hand number, which is the one thing here that
       * changes every deal, is always shown.
       */}
      {observer && (
        <span className="hidden xl:inline-flex">
          <Rail>Watching</Rail>
        </span>
      )}
      {/*
       * The seat count doubles as the way back to table setup.
       *
       * Moving this row into the app bar dropped `TopBar`'s "Change table"
       * link, and at 1024px and up that left no labelled route to seat count,
       * stack depth or the opponent roster at all: only the wordmark, whose
       * accessible name is "Probability Poker - home". Rather than put the
       * button back, which is the opposite of what this round is for, the rail
       * that already states the table becomes the link that changes it.
       */}
      <Link
        to="/"
        data-testid="change-table"
        /* Both facts. A bare "Change the table" would have replaced the
           accessible name rather than added to it, and at `lg` this rail is the
           only place the hand number appears at all, so a screen reader would
           have lost it entirely while a sighted user kept reading it. */
        aria-label={`Hand #${handNumber}, ${seatCount}-handed. Change the table`}
        className="shrink-0 rounded-full outline-none transition hover:opacity-100 focus-visible:ring-2 focus-visible:ring-gold/60 [&>span]:transition-colors [&>span]:hover:border-gold/60 [&>span]:hover:text-ivory"
      >
        <Rail>
          <span className="hidden xl:inline">{seatCount}-handed · </span>Hand #
          {handNumber}
        </Rail>
      </Link>
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
