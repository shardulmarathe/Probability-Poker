import { createAuthClient } from "@neondatabase/neon-js/auth";
import { NeonAuthUIProvider } from "@neondatabase/neon-js/auth/react";

/**
 * Neon Auth (Managed Better Auth) client for the Vite React app.
 *
 * Persistence is additive: if `VITE_NEON_AUTH_URL` is unset the client is still
 * created with a placeholder so the provider can mount, and gameplay continues
 * fully signed-out (api.ts / write-behind will simply no-op without a session).
 */
const authUrl =
  (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim() ||
  "http://localhost/neon-auth-not-configured";

export const authClient = createAuthClient(authUrl);

/** Provider mount target for `src/main.tsx`. */
export { NeonAuthUIProvider };
