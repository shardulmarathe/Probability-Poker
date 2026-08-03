/**
 * The shell's account slot.
 *
 * This was a placeholder that rendered nothing while the account surface was
 * being built elsewhere. `components/account` now owns that surface entirely —
 * unconfigured, signed out and signed in — and takes no required props, so the
 * slot is a re-export rather than a wrapper. The indirection stays because the
 * shell should keep naming the slot it fills, not the module that fills it.
 */

export { AccountMenu, type AccountMenuProps } from "../account";
