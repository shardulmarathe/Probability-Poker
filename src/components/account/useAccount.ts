/**
 * The two stores the account UI reads: who you are, and whether the queue is
 * caught up. Both live outside React — `lib/auth.ts` and `lib/api.ts` are
 * imported by non-component code — so both are consumed through
 * `useSyncExternalStore` rather than mirrored into state.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  authConfigured,
  getAuthState,
  refreshSession,
  subscribeAuth,
  type AuthState,
} from "../../lib/auth";
import { getSyncState, subscribeSync, type SyncState } from "../../lib/api";
import { reconcile } from "./sync";

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, getAuthState);
}

export function useSync(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
}

/**
 * Resolve the session once on mount, then reconcile whenever a user appears.
 *
 * Mounted by `AccountMenu`, which the shell renders on every route, so this
 * happens once per page load wherever the player lands. Both calls are safe to
 * repeat: `refreshSession` is a read and `reconcile` short-circuits after its
 * first run for a given user.
 */
export function useAccountBootstrap(): AuthState {
  const auth = useAuth();

  useEffect(() => {
    if (!authConfigured) return;
    void refreshSession();
  }, []);

  useEffect(() => {
    if (auth.phase !== "authenticated") return;
    void reconcile();
  }, [auth.phase, auth.user?.id]);

  return auth;
}
