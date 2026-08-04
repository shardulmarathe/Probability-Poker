/**
 * Controls that do something.
 *
 * Three variants, and the rule is about commitment rather than importance:
 *
 *   primary    puts chips in the pot or starts a session, red, the felt's
 *              one loud colour. At most one per screen.
 *   secondary  moves you somewhere useful, gold, the product's own colour.
 *   quiet      reverses, clears, or steps back.
 *
 * `ActionButton` is the poker table's own vocabulary: fold, check, call, bet,
 * raise. Its colours were defined twice, `pages/Game.tsx` and `table/Actions.
 * tsx`, and had already drifted on the red's opacity, so a call button looked
 * different depending on which table you were sitting at.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { RADIUS } from "./tokens";

export type ButtonVariant = "primary" | "secondary" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border border-gold/40 bg-pkred text-ivory shadow-[0_10px_30px_-12px_rgba(122,0,25,0.8)] hover:border-gold/70 hover:bg-pkred-light",
  secondary:
    "border border-gold/45 bg-gold/12 text-gold-soft hover:border-gold/70 hover:bg-gold/20",
  quiet:
    "border border-ivory/16 bg-black/30 text-ivory/65 hover:border-ivory/35 hover:text-ivory",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "min-h-[34px] px-3 py-1.5 text-xs",
  md: "min-h-[42px] px-5 py-2.5 text-sm",
  lg: "min-h-[52px] px-8 py-3.5 text-base sm:text-lg",
};

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-display font-semibold tracking-wide transition-all duration-200 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:pointer-events-none disabled:opacity-40";

function skin(variant: ButtonVariant, size: ButtonSize, full?: boolean) {
  return `${BASE} ${RADIUS.action} ${VARIANT[variant]} ${SIZE[size]} ${full ? "w-full" : ""}`;
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  full?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  full,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button {...rest} className={`${skin(variant, size, full)} ${className}`}>
      {children}
    </button>
  );
}

/** The same control when it navigates. Same skin, so the two never diverge. */
export function ButtonLink({
  to,
  variant = "secondary",
  size = "md",
  full,
  className = "",
  children,
  testId,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  full?: boolean;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Link
      to={to}
      data-testid={testId}
      className={`${skin(variant, size, full)} ${className}`}
    >
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// The table's own controls
// ---------------------------------------------------------------------------

/**
 * Fold is the cheapest action and looks it; check and call are gold because
 * they keep you in the hand at the table's price; bet and raise are red
 * because they set one.
 */
export const ACTION_STYLES: Record<string, string> = {
  fold: "border border-ivory/25 bg-black/40 text-ivory/80 hover:border-ivory/50 hover:text-ivory",
  check: "border border-gold/50 bg-gold/15 text-gold-soft hover:bg-gold/25",
  call: "border border-gold/60 bg-gold/20 text-gold-soft hover:bg-gold/30",
  bet: "border border-pkred-light/70 bg-pkred/80 text-ivory hover:bg-pkred-light",
  raise: "border border-pkred-light/70 bg-pkred/80 text-ivory hover:bg-pkred-light",
};

export function ActionButton({
  action,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { action: string }) {
  return (
    <button
      {...rest}
      className={`${BASE} ${RADIUS.action} min-h-[46px] px-4 py-3 text-sm shadow-lg sm:px-6 ${
        ACTION_STYLES[action] ?? ACTION_STYLES.fold
      } ${className}`}
    >
      {children}
    </button>
  );
}
