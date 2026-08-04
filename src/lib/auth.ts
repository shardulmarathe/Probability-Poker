import { createAuthClient } from "@neondatabase/neon-js/auth";
import { NeonAuthUIProvider } from "@neondatabase/neon-js/auth/react";
import { setSession, type SessionInfo } from "./api";

/**
 * Neon Auth (Managed Better Auth) for the Vite React app, plus the small store
 * that tells the rest of the interface who is signed in.
 *
 * **Signing in is optional and always has been.** The game is complete without
 * an account: `components/profile/store.ts` keeps the hand archive in
 * localStorage and that remains the source of truth whether or not anyone ever
 * signs in. An account adds one thing, the same archive, reachable from
 * another device, and removes nothing.
 *
 * When `VITE_NEON_AUTH_URL` is unset the client is still constructed against a
 * placeholder so `NeonAuthUIProvider` can mount, but every call below
 * short-circuits before it can reach that address. `configured` is the flag the
 * account UI reads to decide whether to offer sign-in at all, so an
 * unconfigured deploy shows nothing rather than a button that fails.
 */
const authUrl = (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim();

/** Whether this deploy has an auth service at all. */
export const authConfigured = Boolean(authUrl);

export const authClient = createAuthClient(
  authUrl || "http://localhost/neon-auth-not-configured"
);

/** Provider mount target for `src/main.tsx`. */
export { NeonAuthUIProvider };

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export type AuthPhase =
  /** Auth exists but we have not asked it yet. Render nothing decisive. */
  | "loading"
  /** Confirmed signed out, the normal state, not a failure. */
  | "anonymous"
  | "authenticated";

export interface AuthState {
  phase: AuthPhase;
  user: AuthUser | null;
}

let state: AuthState = {
  // Nothing to wait for when there is no auth service.
  phase: authConfigured ? "loading" : "anonymous",
  user: null,
};

const listeners = new Set<(s: AuthState) => void>();

export function getAuthState(): AuthState {
  return state;
}

export function subscribeAuth(fn: (s: AuthState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function publish(next: AuthState, token: string | null): void {
  state = next;
  // The queue is told before the UI is, so a component that re-renders on this
  // change already sees the sync status that matches it.
  setSession(
    next.user
      ? ({
          userId: next.user.id,
          token,
          name: next.user.name,
          email: next.user.email,
        } satisfies SessionInfo)
      : null
  );
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* a broken subscriber must not break sign-in */
    }
  }
}

/**
 * Ask the auth service who we are and publish the answer.
 *
 * Resolves to the user or null; it never rejects. A dead auth service is
 * indistinguishable from being signed out as far as the app is concerned, and
 * both are playable.
 */
export async function refreshSession(): Promise<AuthUser | null> {
  if (!authConfigured) {
    publish({ phase: "anonymous", user: null }, null);
    return null;
  }
  try {
    const { data } = await authClient.getSession();
    if (!data?.user?.id) {
      publish({ phase: "anonymous", user: null }, null);
      return null;
    }
    const user: AuthUser = {
      id: String(data.user.id),
      name: data.user.name || data.user.email || "Player",
      email: data.user.email ?? "",
    };
    publish({ phase: "authenticated", user }, data.session?.token ?? null);
    return user;
  } catch {
    publish({ phase: "anonymous", user: null }, null);
    return null;
  }
}

export interface AuthResult {
  ok: boolean;
  /** Present only on failure, already phrased for a person to read. */
  error?: string;
}

/** Better Auth wraps failures in `{ error }` and also throws on transport. */
function failure(err: unknown): AuthResult {
  if (err && typeof err === "object" && "message" in err) {
    const message = String((err as { message?: unknown }).message ?? "");
    if (message) return { ok: false, error: message };
  }
  return { ok: false, error: "Could not reach the sign-in service." };
}

const NOT_CONFIGURED: AuthResult = {
  ok: false,
  error: "Accounts are not enabled on this deployment.",
};

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!authConfigured) return NOT_CONFIGURED;
  try {
    const { data, error } = await authClient.signIn.email({ email, password });
    if (error || !data) return failure(error);
    await refreshSession();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function signUp(
  name: string,
  email: string,
  password: string
): Promise<AuthResult> {
  if (!authConfigured) return NOT_CONFIGURED;
  try {
    const { data, error } = await authClient.signUp.email({ name, email, password });
    if (error || !data) return failure(error);
    await refreshSession();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Sign out.
 *
 * The local archive is deliberately left alone. Signing out is not a request to
 * forget how you play, it is a request to stop syncing, and wiping the device
 * on the way out would make signing in a destructive thing to try.
 */
export async function signOut(): Promise<AuthResult> {
  if (!authConfigured) return NOT_CONFIGURED;
  try {
    await authClient.signOut();
  } catch {
    /* the local session is dropped either way */
  }
  publish({ phase: "anonymous", user: null }, null);
  return { ok: true };
}
