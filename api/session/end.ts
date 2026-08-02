import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  methodNotAllowed,
  readBody,
  requireUser,
  sendError,
  HttpError,
} from "../_lib/auth.js";
import { getSql } from "../_lib/db.js";

type EndBody = { sessionId: string };

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
    const { sessionId } = readBody<EndBody>(req);
    if (!sessionId) throw new HttpError(400, "sessionId is required");

    const sql = getSql();
    const rows = await sql`
      update sessions
      set ended_at = now()
      where id = ${sessionId}::uuid
        and user_id = ${user.id}::uuid
        and ended_at is null
      returning id
    `;
    if (rows.length === 0) {
      // Idempotent end: already ended or not owned → still ok if owned.
      const owned = await sql`
        select id from sessions
        where id = ${sessionId}::uuid and user_id = ${user.id}::uuid
        limit 1
      `;
      if (owned.length === 0) throw new HttpError(404, "Session not found");
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
}
