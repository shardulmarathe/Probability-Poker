import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  methodNotAllowed,
  requireUser,
  sendError,
  HttpError,
} from "./_lib/auth.js";
import { getSql } from "./_lib/db.js";

const ALLOWED_METRICS = new Set([
  "net_bb",
  "hands",
  "ev_lost_bb",
  "vpip",
  "pfr",
]);

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  try {
    // Auth required so anonymous scrapers cannot harvest the board; ranking
    // itself is cross-user but only returns display_name + metric.
    await requireUser(req);

    const metricRaw =
      typeof req.query.metric === "string" ? req.query.metric : "net_bb";
    if (!ALLOWED_METRICS.has(metricRaw)) {
      throw new HttpError(400, "Unsupported metric");
    }
    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
      : 20;

    const sql = getSql();

    // Metric expressions, never select user_id into the response.
    let rows: Record<string, unknown>[];
    switch (metricRaw) {
      case "hands":
        rows = await sql`
          select p.display_name as "displayName", s.hands::float as metric
          from player_stats s
          join profiles p on p.user_id = s.user_id
          order by s.hands desc, p.display_name asc
          limit ${limit}
        `;
        break;
      case "ev_lost_bb":
        rows = await sql`
          select p.display_name as "displayName", s.ev_lost_bb::float as metric
          from player_stats s
          join profiles p on p.user_id = s.user_id
          order by s.ev_lost_bb asc, p.display_name asc
          limit ${limit}
        `;
        break;
      case "vpip":
        rows = await sql`
          select
            p.display_name as "displayName",
            case when s.vpip_d > 0 then (s.vpip_n::float / s.vpip_d) else 0 end as metric
          from player_stats s
          join profiles p on p.user_id = s.user_id
          where s.vpip_d > 0
          order by metric desc, p.display_name asc
          limit ${limit}
        `;
        break;
      case "pfr":
        rows = await sql`
          select
            p.display_name as "displayName",
            case when s.pfr_d > 0 then (s.pfr_n::float / s.pfr_d) else 0 end as metric
          from player_stats s
          join profiles p on p.user_id = s.user_id
          where s.pfr_d > 0
          order by metric desc, p.display_name asc
          limit ${limit}
        `;
        break;
      case "net_bb":
      default:
        rows = await sql`
          select p.display_name as "displayName", s.net_bb::float as metric
          from player_stats s
          join profiles p on p.user_id = s.user_id
          order by s.net_bb desc, p.display_name asc
          limit ${limit}
        `;
        break;
    }

    res.status(200).json({
      metric: metricRaw,
      items: rows.map((r, i) => ({
        rank: i + 1,
        displayName: r.displayName,
        metric: Number(r.metric),
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
}
