/**
 * "Watch the table learn a bluffer", and the banner that follows it.
 *
 * The profile cannot say anything until it has hands to say it about: the style
 * verdict needs thirty before it will commit to a label, and the likelihood
 * model needs about sixty before it moves at all. That is roughly eight minutes
 * of play, which is a long time to ask of a first-time reader before the page
 * shows them anything.
 *
 * So the empty state offers to play those sixty hands for them, in under three
 * seconds, against the scripted bluffer the README's headline claim is measured
 * on. What lands is not a mock-up: the production engine plays the hands,
 * `recordReport` folds them in exactly as the live table would, and the
 * before-and-after printed here is read out of the real likelihood model.
 *
 * It writes to its own archive (`setArchiveScope`), never the reader's. Sixty
 * hands played by a driver mixed into somebody's real history would make every
 * number on this page a statement about a player who does not exist.
 */

import { useCallback, useState } from "react";
import { pct } from "../../lib/format";
import {
  DEMO_HANDS,
  runBlufferDemo,
  type DemoResult,
} from "../../poker/replay/demoSession";
import { Button, LINE, RADIUS, SURFACE, TONE } from "../ui";
import { saveArchive, setArchiveScope } from "./store";

export interface DemoSessionProps {
  /**
   * Hand the finished session up. The page needs the result for the banner and
   * needs to re-read storage, and both happen at the same moment.
   */
  onLoaded: (result: DemoResult) => void;
  /**
   * Rendered beside an archive that exists but is too small to read, rather than
   * inside the empty state. Same control, quieter framing: the reader has
   * played, so the copy should not talk to them as though they have not.
   */
  thin?: boolean;
}

/** The offer, shown where the profile would otherwise be a dead end. */
export function DemoSessionButton({ onLoaded, thin = false }: DemoSessionProps) {
  const [progress, setProgress] = useState<number | null>(null);

  const run = useCallback(async () => {
    setProgress(0);
    const result = await runBlufferDemo((played, total) =>
      setProgress(played / total)
    );
    // Scope first, then write: `saveArchive` resolves the key at call time, and
    // writing before the switch would put the demo in the reader's own archive.
    setArchiveScope("demo");
    saveArchive({
      hands: result.reports,
      smallBlind: 5,
      bigBlind: 10,
      heroSeat: result.heroSeat,
      updatedAt: 0,
    });
    setProgress(null);
    onLoaded(result);
  }, [onLoaded]);

  const running = progress !== null;

  return (
    <div
      className={
        thin
          ? "mb-6 flex flex-wrap items-center gap-x-4 gap-y-2"
          : "mt-6 flex flex-col items-center gap-2"
      }
    >
      <Button
        variant="quiet"
        size="md"
        data-testid="run-demo"
        disabled={running}
        onClick={run}
      >
        {running
          ? `Dealing ${Math.round(progress * DEMO_HANDS)} of ${DEMO_HANDS}...`
          : thin
            ? `Watch the table learn a bluffer (${DEMO_HANDS} hands)`
            : `Or watch the table learn a bluffer (${DEMO_HANDS} hands)`}
      </Button>
      {/* No promised duration. It is a couple of seconds of arithmetic and
          many more of rendering, and how many depends entirely on the machine,
          so the counter above says where it has got to instead of a number
          here saying where it should have got to by now. */}
      <p
        className={`text-xs leading-relaxed text-ivory/45 ${
          thin ? "min-w-0 flex-1" : "max-w-md text-center"
        }`}
      >
        {running
          ? "Real hands, real engine: the same code the table runs."
          : thin
            ? `Below ${DEMO_HANDS} hands the read on you is still mostly the shared prior. This shows what it looks like once it is not.`
            : "Played for you, into a sandbox that never touches your own archive."}
      </p>
    </div>
  );
}

/**
 * What the demo was for, printed once it has run.
 *
 * The number is the point. Everything else on this page describes a player;
 * this line describes the table's belief about a player, and watching it move
 * is the only direct evidence a reader gets that the learning model does
 * anything at all.
 */
export function DemoBanner({
  result,
  onExit,
}: {
  result: DemoResult | null;
  onExit: () => void;
}) {
  return (
    <div
      data-testid="demo-banner"
      className={`mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border px-4 py-3 ${RADIUS.surface}`}
      style={{ borderColor: LINE.gold, background: SURFACE.sunk }}
    >
      <div className="min-w-0">
        <p className="font-display text-sm font-semibold tracking-wide text-gold-soft">
          A demo session, not your hands
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-ivory/55">
          {DEMO_HANDS} hands against a scripted bluffer. Your own archive is
          untouched and comes back when you leave.
        </p>
        {result && (
          <p className="mt-2 font-mono text-[0.72rem] text-ivory/70">
            the table&apos;s read on this seat ·{" "}
            <span className="text-ivory/45">P(bet | air)</span>{" "}
            <span style={{ color: TONE.neutral }}>{result.before.toFixed(3)}</span>
            {" → "}
            <span style={{ color: TONE.good }}>{result.after.toFixed(3)}</span>
            <span className="text-ivory/45">
              {" "}
              · it now expects a bluff {pct(result.after, 0)} of the time where
              it started at {pct(result.before, 0)}
            </span>
          </p>
        )}
      </div>
      <Button size="sm" variant="quiet" data-testid="exit-demo" onClick={onExit}>
        Leave the demo
      </Button>
    </div>
  );
}
