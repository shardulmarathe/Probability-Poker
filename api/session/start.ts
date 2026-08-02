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
import type { LineupSeat } from "../_lib/types.js";

type StartBody = {
  seatCount: number;
  stackBb: number;
  smallBlind: number;
  bigBlind: number;
  lineup: LineupSeat[];
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
    const body = readBody<StartBody>(req);
    const { seatCount, stackBb, smallBlind, bigBlind, lineup } = body;

    if (
      typeof seatCount !== "number" ||
      seatCount < 2 ||
      seatCount > 6 ||
      typeof stackBb !== "number" ||
      typeof smallBlind !== "number" ||
      typeof bigBlind !== "number" ||
      !Array.isArray(lineup)
    ) {
      throw new HttpError(400, "Invalid session start payload");
    }

    const sql = getSql();
    await ensureProfile(user, sql);

    const rows = await sql`
      insert into sessions (user_id, seat_count, stack_bb, small_blind, big_blind, lineup)
      values (
        ${user.id}::uuid,
        ${seatCount},
        ${stackBb},
        ${smallBlind},
        ${bigBlind},
        ${JSON.stringify(lineup)}::jsonb
      )
      returning id::text as id
    `;

    res.status(200).json({ sessionId: rows[0].id });
  } catch (err) {
    sendError(res, err);
  }
}
