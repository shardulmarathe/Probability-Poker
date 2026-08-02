import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureProfile,
  methodNotAllowed,
  readBody,
  requireUser,
  sendError,
  HttpError,
} from "../_lib/auth.js";
import { getSql } from "../_lib/db.js";
import {
  deriveStatsDelta,
  type HandDecision,
  type HandPayload,
  type StatsDelta,
} from "../_lib/types.js";

type RecordBody = {
  sessionId: string;
  hand: HandPayload;
  decisions: HandDecision[];
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  try {
    const user = await requireUser(req);
    const body = readBody<RecordBody>(req);
    const { sessionId, hand, decisions } = body;

    if (!sessionId || !hand || typeof hand.hand_number !== "number") {
      throw new HttpError(400, "Invalid hand/record payload");
    }
    if (!Array.isArray(decisions)) {
      throw new HttpError(400, "decisions must be an array");
    }

    const sql = getSql();
    await ensureProfile(user, sql);

    const sessions = await sql`
      select id, big_blind
      from sessions
      where id = ${sessionId}::uuid
        and user_id = ${user.id}::uuid
      limit 1
    `;
    if (sessions.length === 0) {
      throw new HttpError(404, "Session not found");
    }
    const bigBlind = Number(sessions[0].big_blind);

    const existing = await sql`
      select id::text as id
      from hands
      where session_id = ${sessionId}::uuid
        and hand_number = ${hand.hand_number}
        and user_id = ${user.id}::uuid
      limit 1
    `;
    if (existing.length > 0) {
      // Idempotent retry from the client's write-behind queue.
      res.status(200).json({ handId: existing[0].id });
      return;
    }

    const delta = deriveStatsDelta(hand, decisions, bigBlind);
    const handId = await insertHandWithStats(
      sql,
      user.id,
      sessionId,
      hand,
      decisions,
      delta
    );

    res.status(200).json({ handId });
  } catch (err) {
    if (isUniqueViolation(err)) {
      try {
        const user = await requireUser(req);
        const body = readBody<RecordBody>(req);
        const sql = getSql();
        const rows = await sql`
          select id::text as id from hands
          where session_id = ${body.sessionId}::uuid
            and hand_number = ${body.hand.hand_number}
            and user_id = ${user.id}::uuid
          limit 1
        `;
        if (rows[0]?.id) {
          res.status(200).json({ handId: rows[0].id });
          return;
        }
      } catch {
        /* fall through */
      }
    }
    sendError(res, err);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

async function insertHandWithStats(
  sql: ReturnType<typeof getSql>,
  userId: string,
  sessionId: string,
  hand: HandPayload,
  decisions: HandDecision[],
  delta: StatsDelta
): Promise<string> {
  const inserted = await sql`
    insert into hands (
      session_id, user_id, hand_number, seed, button, board,
      seats, pots, end_street, went_to_showdown
    ) values (
      ${sessionId}::uuid,
      ${userId}::uuid,
      ${hand.hand_number},
      ${hand.seed},
      ${hand.button},
      ${hand.board},
      ${JSON.stringify(hand.seats)}::jsonb,
      ${JSON.stringify(hand.pots)}::jsonb,
      ${hand.end_street},
      ${hand.went_to_showdown}
    )
    on conflict (session_id, hand_number) do nothing
    returning id::text as id
  `;

  if (inserted.length === 0) {
    const rows = await sql`
      select id::text as id from hands
      where session_id = ${sessionId}::uuid and hand_number = ${hand.hand_number}
      limit 1
    `;
    return rows[0].id as string;
  }

  const handId = inserted[0].id as string;

  // Bundle decision inserts + stats upsert in one HTTP transaction.
  const decisionQueries = decisions.map(
    (d) => sql`
      insert into decisions (
        hand_id, user_id, seat, actor, street, position,
        pot_before, to_call, action, cost,
        equity, ev_chosen, ev_best, ev_loss
      ) values (
        ${handId}::uuid,
        ${userId}::uuid,
        ${d.seat},
        ${d.actor},
        ${d.street},
        ${d.position},
        ${d.pot_before},
        ${d.to_call},
        ${d.action},
        ${d.cost},
        ${d.equity ?? null},
        ${d.ev_chosen ?? null},
        ${d.ev_best ?? null},
        ${d.ev_loss ?? null}
      )
    `
  );

  const statsQuery = sql`
    insert into player_stats (
      user_id, hands,
      vpip_n, vpip_d, pfr_n, pfr_d,
      threebet_n, threebet_d,
      af_aggressive, af_passive,
      wtsd_n, wtsd_d, wsd_n, wsd_d,
      net_bb, ev_lost_bb, updated_at
    ) values (
      ${userId}::uuid,
      ${delta.hands},
      ${delta.vpip_n}, ${delta.vpip_d},
      ${delta.pfr_n}, ${delta.pfr_d},
      ${delta.threebet_n}, ${delta.threebet_d},
      ${delta.af_aggressive}, ${delta.af_passive},
      ${delta.wtsd_n}, ${delta.wtsd_d},
      ${delta.wsd_n}, ${delta.wsd_d},
      ${delta.net_bb}, ${delta.ev_lost_bb},
      now()
    )
    on conflict (user_id) do update set
      hands = player_stats.hands + excluded.hands,
      vpip_n = player_stats.vpip_n + excluded.vpip_n,
      vpip_d = player_stats.vpip_d + excluded.vpip_d,
      pfr_n = player_stats.pfr_n + excluded.pfr_n,
      pfr_d = player_stats.pfr_d + excluded.pfr_d,
      threebet_n = player_stats.threebet_n + excluded.threebet_n,
      threebet_d = player_stats.threebet_d + excluded.threebet_d,
      af_aggressive = player_stats.af_aggressive + excluded.af_aggressive,
      af_passive = player_stats.af_passive + excluded.af_passive,
      wtsd_n = player_stats.wtsd_n + excluded.wtsd_n,
      wtsd_d = player_stats.wtsd_d + excluded.wtsd_d,
      wsd_n = player_stats.wsd_n + excluded.wsd_n,
      wsd_d = player_stats.wsd_d + excluded.wsd_d,
      net_bb = player_stats.net_bb + excluded.net_bb,
      ev_lost_bb = player_stats.ev_lost_bb + excluded.ev_lost_bb,
      updated_at = now()
  `;

  await sql.transaction([...decisionQueries, statsQuery]);

  return handId;
}
