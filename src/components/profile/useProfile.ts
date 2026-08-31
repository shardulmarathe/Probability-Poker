/**
 * Wiring the profile's archive to the live table.
 *
 * Two hooks, split by who needs them. `useHandRecorder` writes and is mounted
 * for the whole table route group, so hands are archived as they finish no
 * matter which page in that group is open, a session played and then reloaded
 * from `/table` has to survive, and it would not if only the profile page
 * persisted what it happened to see. `useProfileArchive` reads.
 *
 * Both go through localStorage on every change rather than holding the archive
 * in React state. It is a few kilobytes of JSON, it happens once per finished
 * hand, and it means the recorder and the page cannot hold two versions of the
 * archive and overwrite each other's.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TableHandReport } from "../../poker/table/contract";
import { useTable } from "../../store/TableContext";
import {
  clearArchive,
  getArchiveScope,
  loadArchive,
  mergeHands,
  saveArchive,
  type ProfileArchive,
} from "./store";
import { clearCalibration } from "../../lib/calibration";

/**
 * This session's finished hands.
 *
 * `history` lags by a render, the store appends to it in an effect, so the
 * hand that just ended is in `lastReport` and not yet in `history`. The review
 * page stitches the same two together for the same reason.
 */
function useLiveHands(): TableHandReport[] {
  const { history, lastReport } = useTable();
  return useMemo(() => {
    if (!lastReport) return history;
    return history.some((r) => r.seed === lastReport.seed)
      ? history
      : [...history, lastReport];
  }, [history, lastReport]);
}

/** Archive finished hands as they arrive. Renders nothing; writes only. */
export function useHandRecorder(): void {
  const { table, heroSeat } = useTable();
  const live = useLiveHands();
  const { smallBlind, bigBlind } = table.config;

  useEffect(() => {
    if (live.length === 0) return;
    /*
     * The demo archive is a sandbox and the recorder must stay out of it.
     * Without this, hands played at the real table while the reader is looking
     * at the demo would be written into the demo's own storage, and the two
     * would stop being separable, which is the entire point of the separation.
     */
    if (getArchiveScope() === "demo") return;
    const archive = loadArchive();
    const hands = mergeHands(archive.hands, live);

    const unchanged =
      hands.length === archive.hands.length &&
      archive.smallBlind === smallBlind &&
      archive.bigBlind === bigBlind &&
      archive.heroSeat === heroSeat;
    if (unchanged) return;

    saveArchive({ hands, smallBlind, bigBlind, heroSeat, updatedAt: 0 });
  }, [live, smallBlind, bigBlind, heroSeat]);
}

export interface ProfileView extends ProfileArchive {
  /**
   * Archived hands this session did not play, the ones that survived a reload.
   * Not the raw stored count: the recorder writes as it goes, so by the time
   * the page reads storage this session's hands are already in it.
   */
  storedCount: number;
  /** Seat the profile is written from. */
  seat: number;
  setSeat: (seat: number) => void;
  /** Widest table in the archive, how many seats the picker offers. */
  seatCount: number;
  /** `handSeatCount` defaults to the archive's widest table. */
  seatName: (seat: number, handSeatCount?: number) => string;
  reset: () => void;
  /** Re-read the archive after something outside this hook wrote to it. */
  refresh: () => void;
}

/** The archive plus this session, ready to hand to the coach modules. */
export function useProfileArchive(): ProfileView {
  const { table, heroSeat } = useTable();
  const live = useLiveHands();
  const [version, setVersion] = useState(0);
  const [seatOverride, setSeatOverride] = useState<number | null>(null);

  const archive = useMemo(() => {
    const stored = loadArchive();
    /*
     * In the demo scope the reader is looking at sixty hands played by a
     * scripted driver, and folding in whatever they happen to have played at
     * the table this session would make the style verdict describe two
     * different players at once.
     */
    if (getArchiveScope() === "demo") {
      return { stored, hands: stored.hands, earlier: stored.hands.length };
    }
    const thisSession = new Set(live.map((h) => h.seed));
    return {
      stored,
      hands: mergeHands(stored.hands, live),
      earlier: stored.hands.filter((h) => !thisSession.has(h.seed)).length,
    };
    // `version` forces a re-read after a reset, which localStorage cannot
    // announce on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, version]);

  // How many seats the picker may offer, and the archive is the only sound
  // source for it. Folding the live table in with `Math.max` would put "Seat 5"
  // and "Seat 6" in the picker as soon as somebody sat at a six-max table, while
  // every archived hand was four-handed: both chairs would profile zero hands
  // and read as a player who never plays, which is a claim about a seat that has
  // never existed. The live table is the fallback only while the archive is
  // empty, and there the page renders its empty state with no picker at all.
  const seatCount = useMemo(() => {
    const widest = archive.hands.reduce((n, hand) => Math.max(n, hand.seatCount), 0);
    return widest > 0 ? widest : table.seats.length;
  }, [archive.hands, table.seats.length]);

  const defaultSeat = heroSeat ?? archive.stored.heroSeat ?? 0;
  // `seatCount` is at least 1 whenever a hand exists, but a first paint with an
  // empty archive and no table yet would otherwise clamp the seat to -1.
  const seat = Math.max(0, Math.min(seatCount - 1, seatOverride ?? defaultSeat));

  const seatName = useCallback(
    (id: number, handSeatCount: number = seatCount) => {
      // Names are a property of the table, not of a hand, so they are only
      // trustworthy for a table of the same size as the one sitting now.
      //
      // Which table to measure against depends on the caller. A page reading
      // one hand should pass that hand's seat count, the way the hand review
      // does; the default is the archive's widest table, which is the only
      // honest answer for the profile's own aggregates because they span every
      // hand at once.
      const live = table.seats[id];
      if (live && table.seats.length === handSeatCount) return live.name;
      return id === (heroSeat ?? 0) ? "You" : `Seat ${id + 1}`;
    },
    [table.seats, seatCount, heroSeat]
  );

  /*
   * Clearing the archive clears the calibration record with it.
   *
   * They are two localStorage keys but one promise: the line beside this
   * button says nothing leaves the device, and a reader who erases what the
   * device holds means all of it. Leaving `pp.calibration.v1` behind would keep
   * telling them they run six points optimistic on the strength of estimates
   * made against hands that no longer exist.
   */
  const reset = useCallback(() => {
    clearArchive();
    clearCalibration();
    setVersion((v) => v + 1);
  }, []);

  /**
   * Re-read storage. Needed because `localStorage` cannot announce a write, so
   * anything that fills the archive from outside this hook, the demo session,
   * has no other way to make the page notice.
   */
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  return {
    hands: archive.hands,
    smallBlind: table.config.smallBlind,
    bigBlind: table.config.bigBlind,
    heroSeat,
    updatedAt: archive.stored.updatedAt,
    storedCount: archive.earlier,
    seat,
    setSeat: setSeatOverride,
    seatCount,
    seatName,
    reset,
    refresh,
  };
}
