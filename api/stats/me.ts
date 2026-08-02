import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureProfile,
  methodNotAllowed,
  requireUser,
  sendError,
} from "../_lib/auth.js";
import { getSql } from "../_lib/db.js";
import { pct } from "../_lib/types.js";

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
    const sql = getSql();
    await ensureProfile(user, sql);

    const rows = await sql`
      select *
      from player_stats
      where user_id = ${user.id}::uuid
      limit 1
    `;

    if (rows.length === 0) {
      res.status(200).json({
        userId: user.id,
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
        vpip: null,
        pfr: null,
        threebet: null,
        af: null,
        wtsd: null,
        wsd: null,
        updated_at: null,
      });
      return;
    }

    const s = rows[0] as Record<string, number | string>;
    const afAgg = Number(s.af_aggressive);
    const afPas = Number(s.af_passive);

    res.status(200).json({
      ...s,
      userId: user.id,
      vpip: pct(Number(s.vpip_n), Number(s.vpip_d)),
      pfr: pct(Number(s.pfr_n), Number(s.pfr_d)),
      threebet: pct(Number(s.threebet_n), Number(s.threebet_d)),
      af: afPas > 0 ? afAgg / afPas : null,
      wtsd: pct(Number(s.wtsd_n), Number(s.wtsd_d)),
      wsd: pct(Number(s.wsd_n), Number(s.wsd_d)),
    });
  } catch (err) {
    sendError(res, err);
  }
}
