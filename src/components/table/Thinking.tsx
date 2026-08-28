/**
 * A bot's decision, unfolding.
 *
 * The store (`store/TableContext`) plans the stages and decides how much of each
 * one this mode is allowed to say; this file only draws what it is handed. That
 * split is deliberate and it is the safety property: there is no mode here, no
 * table, no decision and no hole cards, so no future edit to this component can
 * leak something the player should not have. If a number is not in the
 * `ThinkStep`, it cannot be rendered.
 *
 * It is drawn as a transcript rather than a spinner. A spinner says "wait"; the
 * point of this panel is that the waiting *is* the content, five or six named
 * stages, each with the real count it is working on, arriving in the order the
 * decider runs them. Finished stages stay above the current one so the shape of
 * the pipeline accumulates as it runs, which is the thing being taught.
 *
 * Only the last few completed stages are kept on screen. A six-way priced
 * decision has seven stages and the panel has to survive a 390px phone with a
 * seat's worth of felt around it, so the history scrolls off the top with a
 * count of what went with it rather than growing without bound.
 */

import type { ThinkLine, ThinkStep } from "../../store/TableContext";
import { LINE, RADIUS, SURFACE, TONE } from "../ui";

/** Completed stages kept visible above the current one. */
const HISTORY = 3;

/** Completed stages kept on the felt rail, which has ~100px of cloth to use. */
const RAIL_HISTORY = 2;

/**
 * Stage titles that name an algorithm, said as the poker they stand for.
 *
 * The store's titles are written from the decider's side of the fence, which is
 * right for the store, and "Rejection-sampling the field" is a true description
 * of what `equity/pool` does. It is not a description a player recognises,
 * though, and this panel is read by someone waiting to act rather than by
 * someone reading the source. Only titles that would need a computer-science
 * gloss are translated; "Reading the table" and "Pricing every size" are
 * already poker and are left exactly as the store wrote them.
 */
const POKER_TITLES: Record<string, string> = {
  "Rejection-sampling the field": "Simulating the rest of the hand",
};

/**
 * Detail clauses this panel does not print, and the words it renames.
 *
 * The shard split ("4 shards (1,667 + 1,667 + 1,667 + 1,666)") is real and it
 * is worth showing, which is why it is not deleted from the product: it is the
 * one number that proves the estimate is reproducible across machines, and the
 * review's derivations are where a player goes to be shown that. Beside a live
 * decision it is noise, and it was the longest clause on the longest line.
 * Same for "on common random numbers", which explains a variance-reduction
 * trick nobody is asking about while they hold a hand.
 */
const ENGINE_CLAUSE = /\bshards?\b/;

/** The store's stage, said in poker. Titles it does not know pass through. */
function poker(line: ThinkLine): ThinkLine {
  const detail = line.detail
    ?.split(" · ")
    .filter((clause) => !ENGINE_CLAUSE.test(clause))
    .join(" · ")
    .replace(/\btrials\b/g, "runouts")
    .replace(/ on common random numbers/g, "");
  return {
    ...line,
    title: POKER_TITLES[line.title] ?? line.title,
    detail: detail || null,
  };
}

export interface ThinkingProps {
  /**
   * The seat's current frame, straight from `fx.seats[id].thinking`. Null when
   * that seat is not deciding, the component renders nothing.
   */
  step: ThinkStep | null;
  /** Placement, for whatever mounts it. */
  className?: string;
  /**
   * How many finished stages to keep above the running one. Defaults to three,
   * which is the right trade beside a chair on a desktop, where the panel can
   * grow into empty felt.
   *
   * Pass `0` where the panel sits in the page flow rather than floating: there,
   * every finished stage pushes the *running* one further down, and by stage
   * five it is below the fold on a phone, the one line that is actually live
   * is the one you cannot see. Zero holds the height constant instead.
   *
   * Ignored when `compact` is true; that path always keeps history at zero.
   */
  history?: number;
  /**
   * Phone dock under the felt. One truncated title, a `n/total` count, dots,
   * and the progress bar. Header, history, Done rows, facts, and the detail
   * sentence are omitted so the dock stays one line. TableGame decides this;
   * do not infer viewport here.
   */
  compact?: boolean;
  /**
   * The side rail on the wide felt. Three stages at most, one line of detail
   * each, no header and no per-size table: the strip of cloth below the board
   * and beside the hero is about 100px tall at the felt's floor height, and a
   * panel that outgrows it is a panel back on top of the community cards,
   * which is the bug this placement exists to fix. The per-size breakdown is
   * deferred to the review, alongside the shard split, for the same reason.
   *
   * `who` is shown here too: nothing else on the rail says whose decision this
   * is, because the rail is not attached to a chair.
   */
  rail?: boolean;
  /**
   * Who is on the clock. Compact and rail only: the gold ring on a 28px avatar
   * is easy to miss while reading this dock, so the name sits in the same line.
   */
  who?: string;
}

export function Thinking({
  step: raw,
  className,
  history = HISTORY,
  compact = false,
  rail = false,
  who,
}: ThinkingProps) {
  if (!raw) return null;
  // The store's frame, restated in poker, before anything below reads it. Doing
  // it once here rather than at each print site is what keeps a `Done` row and
  // the `Current` row that produced it saying the same words.
  const step: ThinkStep = { ...raw, ...poker(raw), done: raw.done.map(poker) };

  const keep = compact ? 0 : rail ? RAIL_HISTORY : history;
  const hidden = Math.max(0, step.done.length - Math.max(0, keep));
  const shown = step.done.slice(hidden);
  const progress = step.total > 0 ? (step.step + 1) / step.total : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="thinking"
      data-step={step.step}
      data-total={step.total}
      className={`flex w-full min-w-0 flex-col overflow-hidden border ${RADIUS.surface} ${className ?? ""}`}
      style={{
        borderColor: LINE.gold,
        // The panel gradient over a near-opaque base rather than straight on
        // top of it: `SURFACE.panel` is translucent by design, which is right
        // for a panel sitting *in* a page and wrong for one floating over the
        // felt, the cards and chips underneath read straight through the text.
        backgroundColor: "rgba(8,25,18,0.96)",
        backgroundImage: SURFACE.panel,
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
      }}
    >
      {/* The rail carries the count on its live line instead. A 100px panel
          cannot spend a quarter of itself on a title bar. */}
      {!compact && !rail && (
        <header
          className="flex items-baseline justify-between gap-2 border-b px-3 py-1.5"
          style={{ borderColor: LINE.goldFaint }}
        >
          <span className="font-display text-[0.55rem] font-semibold uppercase tracking-[0.22em] text-ivory/55">
            Thinking
          </span>
          <span className="font-mono text-[0.6rem] tabular-nums" style={{ color: TONE.gold }}>
            {step.step + 1}/{step.total}
          </span>
        </header>
      )}

      {/* A seven-stage decision with six priced sizes in it is the tallest this
          gets, and on a 390px phone that is most of the felt. The cap is a
          backstop rather than the usual case: nothing is hidden until the panel
          would otherwise be taller than the screen it is floating over.
          Compact skips the cap: the dock is the live stage only. The rail takes
          its ceiling from whatever cloth its wrapper gives it, `min-h-0` so the
          list is what scrolls and the progress bar stays on the bottom edge. */}
      <div
        className={
          compact
            ? "px-2.5 py-1.5"
            : rail
              ? "min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5"
              : "max-h-[min(60vh,26rem)] overflow-y-auto px-3 py-2"
        }
      >
        {!compact && hidden > 0 && (
          <p className="mb-1 pl-4 font-mono text-[0.55rem] text-ivory/30">
            +{hidden} earlier
          </p>
        )}

        <ol className="min-w-0">
          {!compact &&
            shown.map((line, i) => (
              <Done key={`${hidden + i}-${line.title}`} line={line} rail={rail} />
            ))}
          {/* Re-keyed on the step index so each new stage fades in on arrival
              rather than the text swapping under a static box. */}
          <Current
            key={step.step}
            step={step}
            compact={compact}
            rail={rail}
            who={who}
          />
        </ol>
      </div>

      <div
        className="h-[2px] w-full shrink-0"
        style={{ background: "rgba(0,0,0,0.45)" }}
      >
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{
            width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
            background: TONE.gold,
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A stage that has already run. Its title stays fully legible, it is the shape
 * of the pipeline, while its detail is held to one line, because three past
 * stages at full height would push the current one off a phone.
 */
function Done({ line, rail }: { line: ThinkLine; rail?: boolean }) {
  return (
    <li className={`relative min-w-0 pl-4 ${rail ? "pb-1" : "pb-1.5"}`}>
      <Rail />
      <Bead filled />
      <p className="truncate font-display text-[0.68rem] font-semibold text-ivory/50">
        {line.title}
      </p>
      {/*
       * The detail wraps rather than truncating. These lines are the counts the
       * narration exists to show, and a clipped "1,225 of 1,326 combos surv…"
       * is worse than one that takes a second line.
       *
       * On the rail there is no width for either, so a finished stage drops its
       * detail entirely and keeps its title. That is the same trade the rest of
       * this round makes: a completed stage is context, the live stage is what
       * is being read, and half a number cut off mid-word teaches nothing while
       * still costing the line. `Current` prints its detail in full.
       */}
      {line.detail && !rail && (
        <p className="font-mono text-[0.55rem] leading-snug text-ivory/28">
          {line.detail}
        </p>
      )}
    </li>
  );
}

/** The stage running now. The only thing on screen at full contrast. */
function Current({
  step,
  compact,
  rail,
  who,
}: {
  step: ThinkStep;
  compact?: boolean;
  rail?: boolean;
  who?: string;
}) {
  const short = who?.trim().split(/\s+/).pop();

  if (rail) {
    return (
      <li className="pp-thought relative min-w-0 pl-4">
        <Bead />
        <p className="flex items-baseline gap-1.5 font-display text-[0.72rem] font-semibold leading-snug text-ivory">
          {short && (
            <span className="shrink-0" style={{ color: TONE.gold }}>
              {short}
            </span>
          )}
          <span className="min-w-0 truncate">{step.title}</span>
          <span
            className="ml-auto shrink-0 font-mono text-[0.55rem] tabular-nums"
            style={{ color: TONE.gold }}
          >
            {step.step + 1}/{step.total}
          </span>
        </p>
        {/* Wraps, now that a finished stage above it costs one line instead of
            two. This is the number the reader came for, and it is the only
            detail on the rail, so it gets to finish its sentence. */}
        {step.detail && (
          <p
            className="font-mono text-[0.55rem] leading-snug"
            style={{ color: TONE.gold }}
          >
            {step.detail}
          </p>
        )}
      </li>
    );
  }

  if (compact) {
    return (
      <li className="pp-thought min-w-0">
        <p className="flex items-center gap-1.5 font-display text-[0.8rem] font-semibold leading-none text-ivory">
          {short && (
            <span className="shrink-0" style={{ color: TONE.gold }}>
              {short}
            </span>
          )}
          <span className="min-w-0 truncate">{step.title}</span>
          <span
            className="shrink-0 font-mono text-[0.6rem] tabular-nums"
            style={{ color: TONE.gold }}
          >
            {step.step + 1}/{step.total}
          </span>
          <span aria-hidden className="flex shrink-0 gap-0.5">
            <Dot delay="0s" />
            <Dot delay="0.18s" />
            <Dot delay="0.36s" />
          </span>
        </p>
      </li>
    );
  }

  return (
    <li className="pp-thought relative min-w-0 pl-4">
      <Bead />
      <p className="flex items-center gap-1.5 font-display text-[0.8rem] font-semibold leading-snug text-ivory">
        <span className="min-w-0 break-words">{step.title}</span>
        <span aria-hidden className="flex shrink-0 gap-0.5">
          <Dot delay="0s" />
          <Dot delay="0.18s" />
          <Dot delay="0.36s" />
        </span>
      </p>
      {step.detail && (
        <p
          className="mt-0.5 break-words font-mono text-[0.6rem] leading-snug"
          style={{ color: TONE.gold }}
        >
          {step.detail}
        </p>
      )}
      {!compact && step.facts && step.facts.length > 0 && (
        <dl
          className={`mt-1.5 min-w-0 overflow-hidden border ${RADIUS.control}`}
          style={{ borderColor: LINE.quietFaint, background: SURFACE.sunk }}
        >
          {/* Six sizes is a normal ladder, so a row that wraps costs twelve
              lines rather than six. Small enough to stay on one line at 390px,
              and it wraps rather than truncating if it ever cannot. */}
          {step.facts.map((fact) => (
            <div
              key={fact.label}
              className="flex flex-wrap items-baseline justify-between gap-x-2 px-2 py-[3px] leading-tight"
            >
              <dt className="min-w-0 break-words font-mono text-[0.5rem] text-ivory/60 sm:text-[0.55rem]">
                {fact.label}
              </dt>
              <dd className="min-w-0 break-words text-right font-mono text-[0.5rem] tabular-nums text-ivory/85 sm:text-[0.55rem]">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** The hairline the beads sit on, the pipeline, running top to bottom. */
function Rail() {
  return (
    <span
      aria-hidden
      className="absolute bottom-0 left-[3px] top-[7px] w-px"
      style={{ background: LINE.goldFaint }}
    />
  );
}

function Bead({ filled }: { filled?: boolean }) {
  return (
    <span
      aria-hidden
      className="absolute left-0 top-[4px] h-[7px] w-[7px] rounded-full border"
      style={{
        borderColor: filled ? LINE.gold : TONE.gold,
        background: filled ? "transparent" : TONE.gold,
      }}
    />
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="pp-dot inline-block h-[3px] w-[3px] rounded-full"
      style={{ background: TONE.gold, animationDelay: delay }}
    />
  );
}
