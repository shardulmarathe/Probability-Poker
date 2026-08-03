/**
 * The account surface, as one import.
 *
 * `AccountMenu` is the whole public face of this folder: drop it into the
 * shell's account slot and it handles the unconfigured, signed-out and
 * signed-in states on its own. Everything else here is exported for the pages
 * that want to say something about sync in their own words.
 */

export { AccountMenu, type AccountMenuProps } from "./AccountMenu";
export { AccountDialog } from "./AccountDialog";
export { SyncBadge, syncHint } from "./SyncBadge";
export { useAuth, useSync, useAccountBootstrap } from "./useAccount";
export { reconcile, resetReconcile, type ReconcileSummary } from "./sync";
/** Where hands are, in the app's own words. See `storageNotice`. */
export { storageNotice } from "./notice";
