import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureProfile,
  methodNotAllowed,
  readBody,
  requireUser,
  sendError,
  HttpError,
} from "./_lib/auth.js";
import { getSql } from "./_lib/db.js";

type PutBody = {
  model: unknown;
  handsSeen: number;
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const user = await requireUser(req);
    const sql = getSql();
    await ensureProfile(user, sql);

    if (req.method === "GET") {
      const rows = await sql`
        select model, hands_seen as "handsSeen"
        from player_models
        where user_id = ${user.id}::uuid
        limit 1
      `;
      if (rows.length === 0) {
        res.status(200).json({ model: {}, handsSeen: 0 });
        return;
      }
      res.status(200).json({
        model: rows[0].model,
        handsSeen: Number(rows[0].handsSeen),
      });
      return;
    }

    if (req.method === "PUT") {
      const body = readBody<PutBody>(req);
      if (body.model == null || typeof body.handsSeen !== "number") {
        throw new HttpError(400, "model and handsSeen are required");
      }
      await sql`
        insert into player_models (user_id, model, hands_seen, updated_at)
        values (
          ${user.id}::uuid,
          ${JSON.stringify(body.model)}::jsonb,
          ${Math.trunc(body.handsSeen)},
          now()
        )
        on conflict (user_id) do update set
          model = excluded.model,
          hands_seen = excluded.hands_seen,
          updated_at = now()
      `;
      res.status(200).json({ ok: true });
      return;
    }

    methodNotAllowed(res, ["GET", "PUT"]);
  } catch (err) {
    sendError(res, err);
  }
}
