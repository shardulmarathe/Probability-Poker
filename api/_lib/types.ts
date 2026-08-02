/** Request / response shapes matching docs/neon-integration.md */

export type LineupSeat = {
  seat: number;
  archetype: string;
};

export type HandSeat = {
  seat: number;
  archetype?: string;
  hole?: number[];
  invested?: number;
  won?: number;
  status?: string;
  [key: string]: unknown;
};

export type HandDecision = {
  seat: number;
  actor: string;
  street: string;
  position: string;
  pot_before: number;
  to_call: number;
  action: string;
  cost: number;
  equity?: number | null;
  ev_chosen?: number | null;
  ev_best?: number | null;
  ev_loss?: number | null;
};

export type HandPayload = {
  hand_number: number;
  seed: number;
  button: number;
  board: number[];
  seats: HandSeat[];
  pots: unknown;
  end_street: string;
  went_to_showdown: boolean;
  /** Optional client-computed incremental tracker deltas (bb units where noted). */
  statsDelta?: Partial<StatsDelta>;
};

export type StatsDelta = {
  hands: number;
  vpip_n: number;
  vpip_d: number;
  pfr_n: number;
  pfr_d: number;
  threebet_n: number;
  threebet_d: number;
  af_aggressive: number;
  af_passive: number;
  wtsd_n: number;
  wtsd_d: number;
  wsd_n: number;
  wsd_d: number;
  net_bb: number;
  ev_lost_bb: number;
};

export function emptyStatsDelta(): StatsDelta {
  return {
    hands: 0,
    vpip_n: 0,
    vpip_d: 0,
    pfr_n: 0,
    pfr_d: 0,
    threebet_n: 0,
    threebet_d: 0,
    af_aggressive: 0,
    af_passive: 0,
    wtsd_n: 0,
    wtsd_d: 0,
    wsd_n: 0,
    wsd_d: 0,
    net_bb: 0,
    ev_lost_bb: 0,
  };
}

/**
 * Derive incremental player_stats updates from a recorded hand.
 * Prefer an explicit hand.statsDelta from the client when present.
 */
export function deriveStatsDelta(
  hand: HandPayload,
  decisions: HandDecision[],
  bigBlind: number
): StatsDelta {
  const base = emptyStatsDelta();
  base.hands = 1;

  const humanSeat =
    hand.seats.find(
      (s) =>
        s.archetype === "human" ||
        s.archetype === "player" ||
        String(s.archetype ?? "").toLowerCase() === "human"
    ) ?? hand.seats[0];

  const invested = Number(humanSeat?.invested ?? 0);
  const won = Number(humanSeat?.won ?? 0);
  const bb = bigBlind > 0 ? bigBlind : 1;
  base.net_bb = (won - invested) / bb;

  const humanDecisions = decisions.filter(
    (d) => d.actor === "human" || d.actor === "player"
  );
  const preflop = humanDecisions.filter((d) => d.street === "preflop");
  const voluntary = new Set(["call", "bet", "raise", "all-in", "allin"]);
  const aggressive = new Set(["bet", "raise", "all-in", "allin"]);
  const passive = new Set(["call", "check"]);

  base.vpip_d = 1;
  if (preflop.some((d) => voluntary.has(d.action.toLowerCase()) && d.cost > 0)) {
    base.vpip_n = 1;
  }

  base.pfr_d = 1;
  if (preflop.some((d) => d.action.toLowerCase() === "raise" || d.action.toLowerCase() === "bet")) {
    base.pfr_n = 1;
  }

  // Opportunity heuristics — client may refine via statsDelta.
  base.threebet_d = preflop.some((d) => d.to_call > 0) ? 1 : 0;
  if (
    base.threebet_d &&
    preflop.some((d) => d.action.toLowerCase() === "raise" && d.to_call > 0)
  ) {
    base.threebet_n = 1;
  }

  for (const d of humanDecisions) {
    const a = d.action.toLowerCase();
    if (aggressive.has(a)) base.af_aggressive += 1;
    if (passive.has(a)) base.af_passive += 1;
  }

  base.wtsd_d = 1;
  if (hand.went_to_showdown) {
    base.wtsd_n = 1;
    base.wsd_d = 1;
    if (won > invested) base.wsd_n = 1;
  }

  const evLoss = humanDecisions.reduce(
    (sum, d) => sum + Math.min(0, Number(d.ev_loss ?? 0)),
    0
  );
  base.ev_lost_bb = evLoss / bb;

  if (hand.statsDelta) {
    return { ...base, ...hand.statsDelta, hands: hand.statsDelta.hands ?? 1 };
  }
  return base;
}

export function pct(n: number, d: number): number | null {
  if (d <= 0) return null;
  return n / d;
}
