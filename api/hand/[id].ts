import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  methodNotAllowed,
  requireUser,
  requireUuid,
  sendError,
  HttpError,
} from "../_lib/auth.js";
import { getSql } from "../_lib/db.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  try {
    const user = await requireUser(req);
    if (!req.query.id) throw new HttpError(400, "Hand id is required");
    const id = requireUuid(req.query.id, "Hand id");

    const sql = getSql();

    // Scope by session user_id, never trust a body user_id.
    const hands = await sql`
      select
        h.id::text as id,
        h.session_id::text as "sessionId",
        h.hand_number as "handNumber",
        h.seed,
        h.button,
        h.board,
        h.seats,
        h.pots,
        h.end_street as "endStreet",
        h.went_to_showdown as "wentToShowdown",
        h.created_at as "createdAt"
      from hands h
      where h.id = ${id}::uuid
        and h.user_id = ${user.id}::uuid
      limit 1
    `;

    if (hands.length === 0) {
      throw new HttpError(404, "Hand not found");
    }

    const decisions = await sql`
      select
        id,
        seat,
        actor,
        street,
        position,
        pot_before as "potBefore",
        to_call as "toCall",
        action,
        cost,
        equity,
        ev_chosen as "evChosen",
        ev_best as "evBest",
        ev_loss as "evLoss",
        created_at as "createdAt"
      from decisions
      where hand_id = ${id}::uuid
        and user_id = ${user.id}::uuid
      order by id asc
    `;

    res.status(200).json({
      hand: hands[0],
      decisions,
    });
  } catch (err) {
    sendError(res, err);
  }
}
