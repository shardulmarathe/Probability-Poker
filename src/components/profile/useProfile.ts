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
  loadArchive,
  mergeHands,
  saveArchive,
  type ProfileArchive,
} from "./store";

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
  seatName: (seat: number) => string;
  reset: () => void;
}

/** The archive plus this session, ready to hand to the coach modules. */
export function useProfileArchive(): ProfileView {
  const { table, heroSeat } = useTable();
  const live = useLiveHands();
  const [version, setVersion] = useState(0);
  const [seatOverride, setSeatOverride] = useState<number | null>(null);

  const archive = useMemo(() => {
    const stored = loadArchive();
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

  // How many seats the picker may offer, and the archive is the only honest
  // source for it. The live table used to be folded in with `Math.max`, so
  // sitting down at a six-max table put "Seat 5" and "Seat 6" in the picker
  // while every archived hand was four-handed: both chairs profiled zero hands
  // and read as a player who never plays, which is a claim about a seat that
  // has never existed. The live table is the fallback only while the archive is
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
    (id: number) => {
      // Names are a property of the table, not of a hand, so they are only
      // trustworthy for a table of the same size as the one sitting now.
      const live = table.seats[id];
      if (live && table.seats.length === seatCount) return live.name;
      return id === (heroSeat ?? 0) ? "You" : `Seat ${id + 1}`;
    },
    [table.seats, seatCount, heroSeat]
  );

  const reset = useCallback(() => {
    clearArchive();
    setVersion((v) => v + 1);
  }, []);

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
  };
}
