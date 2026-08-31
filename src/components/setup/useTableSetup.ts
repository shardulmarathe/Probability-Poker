/**
 * The one copy of "what table am I sitting at", shared by the hero and the
 * setup panel.
 *
 * Two components start a hand: the setup panel, and the single `Deal me in` in
 * the landing hero above the summary of the table it will deal. Keeping the
 * state inside `TableSetupPanel` would leave the hero unable to read the setup,
 * so ticking "sit out and watch" would produce a hero promising to deal cards it
 * was never going to deal. One hook, two readers, no way for the label to
 * disagree with the table.
 *
 * Every mutation persists immediately rather than on some later "save", because
 * the hero's link is a plain `<Link to="/table">`: it does not run through this
 * file, and `/table` reads `loadSetup()` from storage. An edit that had not been
 * written yet would simply be lost on the way to the felt.
 */

import { useCallback, useState } from "react";
import type { BotArchetype } from "../../poker/table/contract";
import {
  botsNeeded,
  fitLineup,
  loadSetup,
  saveSetup,
  type TableSetup,
} from "../../lib/tableOptions";
import { randomLineup, type BuiltArchetype } from "../../poker/model/profiles";

export interface TableSetupHandle {
  setup: TableSetup;
  /** Merge a patch, re-fit the lineup to the seat count, persist. */
  update: (patch: Partial<TableSetup>) => void;
  setBot: (index: number, id: BotArchetype) => void;
  randomise: () => void;
}

export function useTableSetup(): TableSetupHandle {
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

  const setBot = useCallback((index: number, id: BotArchetype) => {
    setSetupState((cur) => {
      const lineup = [...cur.lineup];
      lineup[index] = id;
      const next = { ...cur, lineup };
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

  return { setup, update, setBot, randomise };
}
