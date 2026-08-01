/**
 * Side-pot layout for an N-handed table.
 *
 * Heads-up needs none of this: the current engine settles with
 * `matched = min(invested); pot = matched * 2` and refunds the difference. With
 * three or more seats and unequal stacks that breaks down — a short stack that
 * is all-in for less can only win the portion every caller matched, and the
 * remainder forms a side pot contested by the deeper seats alone.
 *
 * The layout is computed by slicing the contributions into layers at each
 * distinct all-in level. Everything here is pure: it takes the chips each seat
 * put in and returns who can win what, so it is exhaustively testable without
 * running a hand.
 */

export interface SeatContribution {
  id: number;
  /** Total chips this seat put in over the whole hand. */
  invested: number;
  /** Folded seats still contribute chips but cannot win any pot. */
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Seat ids that may win this pot, ascending. */
  eligible: number[];
}

export interface PotLayout {
  pots: Pot[];
  /**
   * Chips returned to a seat because nobody matched them — an uncalled bet is
   * never part of a pot. Keyed by seat id.
   */
  refunds: Record<number, number>;
}

/**
 * Slice contributions into a main pot plus side pots.
 *
 * Layers are cut at each distinct investment level. Within a layer every seat
 * that reached it pays the same amount, and only the unfolded ones among them
 * can win it. A layer reached by exactly one seat is an uncalled bet and is
 * refunded rather than turned into a pot.
 */
export function buildPots(contributions: SeatContribution[]): PotLayout {
  const refunds: Record<number, number> = {};
  const pots: Pot[] = [];

  const levels = [
    ...new Set(contributions.filter((c) => c.invested > 0).map((c) => c.invested)),
  ].sort((a, b) => a - b);

  let prev = 0;
  for (const level of levels) {
    const contributors = contributions.filter((c) => c.invested >= level);
    const slice = level - prev;
    prev = level;

    // Only one seat reached this level: nobody matched it, so it comes back.
    if (contributors.length === 1) {
      const only = contributors[0];
      refunds[only.id] = (refunds[only.id] ?? 0) + slice;
      continue;
    }

    const eligible = contributors
      .filter((c) => !c.folded)
      .map((c) => c.id)
      .sort((a, b) => a - b);

    // No live seat reached this level, so no live seat covered it either —
    // eligibility only shrinks as the level rises. Handing these chips to a
    // lower pot would pay a seat more than it could ever win (a seat all-in for
    // X can win at most Σ min(X, invested_j)), so they return to the seats that
    // put them up.
    if (eligible.length === 0) {
      for (const c of contributors) {
        refunds[c.id] = (refunds[c.id] ?? 0) + slice;
      }
      continue;
    }

    pots.push({ amount: slice * contributors.length, eligible });
  }

  return { pots: mergeAdjacent(pots), refunds };
}

/**
 * Consecutive layers contested by exactly the same seats are indistinguishable,
 * so present them as one pot. Purely cosmetic — the totals are unchanged.
 */
function mergeAdjacent(pots: Pot[]): Pot[] {
  const out: Pot[] = [];
  for (const pot of pots) {
    const last = out[out.length - 1];
    if (last && sameSeats(last.eligible, pot.eligible)) {
      last.amount += pot.amount;
    } else {
      out.push({ amount: pot.amount, eligible: [...pot.eligible] });
    }
  }
  return out;
}

function sameSeats(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Award every pot to the best hand(s) among its eligible seats.
 *
 * `score` is the seat's hand strength (higher wins); seats missing from the map
 * cannot win. Split pots divide evenly, and any indivisible remainder goes to
 * the earliest seat in `oddChipOrder` — conventionally the first seat left of
 * the button. Chips are integers here, so dropping the remainder would quietly
 * destroy money and break the conservation invariant the engine tests assert.
 */
export function awardPots(
  pots: Pot[],
  score: Record<number, number>,
  oddChipOrder: number[]
): Record<number, number> {
  const winnings: Record<number, number> = {};

  for (const pot of pots) {
    const contenders = pot.eligible.filter((id) => score[id] !== undefined);
    // Every eligible seat is by construction unfolded, and every unfolded seat
    // is scored at showdown — so this cannot happen unless a caller is wrong.
    // Skipping the pot would silently destroy its chips, so say so instead.
    if (contenders.length === 0) {
      throw new Error(
        `awardPots: pot of ${pot.amount} has no scored contender among seats ${pot.eligible.join(", ")}`
      );
    }

    const best = Math.max(...contenders.map((id) => score[id]));
    const winners = contenders.filter((id) => score[id] === best);

    const share = Math.floor(pot.amount / winners.length);
    for (const id of winners) winnings[id] = (winnings[id] ?? 0) + share;

    // Hand indivisible chips out in `oddChipOrder` (conventionally starting
    // left of the button), then fall back to the winners themselves so an
    // incomplete order can never drop a chip on the floor.
    // Deduped: a seat listed in both must not be handed two chips while
    // another winner gets none.
    let remainder = pot.amount - share * winners.length;
    for (const id of new Set([...oddChipOrder, ...winners])) {
      if (remainder <= 0) break;
      if (!winners.includes(id)) continue;
      winnings[id] = (winnings[id] ?? 0) + 1;
      remainder--;
    }
  }

  return winnings;
}
