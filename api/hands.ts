import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  methodNotAllowed,
  requireUser,
  sendError,
  HttpError,
} from "./_lib/auth.js";
import { getSql } from "./_lib/db.js";

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
    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
      : 20;
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.length > 0
        ? req.query.cursor
        : null;

    const sql = getSql();

    // Cursor is created_at ISO + id for stable pagination.
    const rows = cursor
      ? await sql`
          select
            h.id::text as id,
            h.session_id::text as "sessionId",
            h.hand_number as "handNumber",
            h.end_street as "endStreet",
            h.went_to_showdown as "wentToShowdown",
            h.created_at as "createdAt",
            h.board,
            h.button
          from hands h
          where h.user_id = ${user.id}::uuid
            and (h.created_at, h.id) < (
              select created_at, id from hands
              where id = ${cursor}::uuid and user_id = ${user.id}::uuid
            )
          order by h.created_at desc, h.id desc
          limit ${limit}
        `
      : await sql`
          select
            h.id::text as id,
            h.session_id::text as "sessionId",
            h.hand_number as "handNumber",
            h.end_street as "endStreet",
            h.went_to_showdown as "wentToShowdown",
            h.created_at as "createdAt",
            h.board,
            h.button
          from hands h
          where h.user_id = ${user.id}::uuid
          order by h.created_at desc, h.id desc
          limit ${limit}
        `;

    const nextCursor =
      rows.length === limit ? (rows[rows.length - 1].id as string) : null;

    res.status(200).json({
      items: rows,
      nextCursor,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err);
      return;
    }
    sendError(res, err);
  }
}
