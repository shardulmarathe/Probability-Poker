import type { VercelRequest, VercelResponse } from "@vercel/node";

export type AuthedUser = {
  id: string;
  name: string;
  email: string;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function readBody<T>(req: VercelRequest): T {
  if (req.body == null) return {} as T;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body) as T;
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }
  return req.body as T;
}

export function methodNotAllowed(res: VercelResponse, allow: string[]): void {
  res.setHeader("Allow", allow.join(", "));
  res.status(405).json({ error: "Method not allowed" });
}

export function sendError(res: VercelResponse, err: unknown): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Extract Better Auth session token from Cookie or Authorization Bearer. */
export function extractSessionToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  const cookie = req.headers.cookie;
  // Better Auth default cookie names (secure + non-secure variants).
  return (
    cookieValue(cookie, "better-auth.session_token") ??
    cookieValue(cookie, "__Secure-better-auth.session_token")
  );
}

/**
 * Resolve the signed-in user from the Neon Auth session.
 * Prefer the Auth HTTP get-session endpoint; fall back to neon_auth.session lookup.
 */
export async function requireUser(req: VercelRequest): Promise<AuthedUser> {
  const token = extractSessionToken(req);
  const authUrl =
    process.env.NEON_AUTH_URL ?? process.env.VITE_NEON_AUTH_URL ?? "";

  if (authUrl) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (req.headers.cookie) headers.cookie = String(req.headers.cookie);
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      const response = await fetch(`${authUrl.replace(/\/$/, "")}/get-session`, {
        method: "GET",
        headers,
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          session?: { userId?: string } | null;
          user?: { id?: string; name?: string; email?: string } | null;
          data?: {
            session?: { userId?: string } | null;
            user?: { id?: string; name?: string; email?: string } | null;
          };
        } | null;
        const user = payload?.user ?? payload?.data?.user ?? null;
        if (user?.id) {
          return {
            id: String(user.id),
            name: user.name ?? "Player",
            email: user.email ?? "",
          };
        }
      }
    } catch (err) {
      console.warn("Neon Auth get-session failed; trying DB session lookup", err);
    }
  }

  if (!token) {
    throw new HttpError(401, "Unauthorized");
  }

  // DB fallback: session token stored in neon_auth.session
  const { getSql } = await import("./db.js");
  const sql = getSql();
  const rows = await sql`
    select u.id::text as id, u.name, u.email
    from neon_auth.session s
    join neon_auth.user u on u.id = s."userId"
    where s.token = ${token}
      and s."expiresAt" > now()
    limit 1
  `;
  const row = rows[0] as AuthedUser | undefined;
  if (!row?.id) {
    throw new HttpError(401, "Unauthorized");
  }
  return { id: row.id, name: row.name, email: row.email };
}

export async function ensureProfile(
  user: AuthedUser,
  sql: import("./db.js").Sql
): Promise<void> {
  await sql`
    insert into profiles (user_id, display_name)
    values (${user.id}::uuid, ${user.name || user.email || "Player"})
    on conflict (user_id) do nothing
  `;
}
