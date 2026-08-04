/**
 * The account UI's share of the product's look, kept local on purpose.
 *
 * `components/ui/tokens.ts` is the design system and these values are copied
 * from it rather than imported, because this folder is a drop-in for a slot in
 * a shell owned elsewhere: it has to compile and look right on its own. The
 * palette itself is `index.css`'s `@theme`, deep felt, gold hairlines, ivory
 * ink, so nothing here is a new colour, only a local name for an existing one.
 */

export const TONE = {
  gold: "#e2c563",
  good: "#7fd3a8",
  warn: "#d8a657",
  ivory: "#f4ede4",
} as const;

export const LINE = {
  gold: "rgba(201,162,39,0.30)",
  goldStrong: "rgba(201,162,39,0.55)",
  quiet: "rgba(244,237,228,0.14)",
} as const;

export const SURFACE = {
  sunk: "rgba(0,0,0,0.28)",
  tray: "rgba(0,0,0,0.42)",
  panel: "linear-gradient(180deg, rgba(18,53,36,0.94) 0%, rgba(11,34,24,0.97) 100%)",
} as const;

/** Buttons here follow the same grammar as `ui/Button`: gold moves, red commits. */
export const BUTTON = {
  base: "inline-flex items-center justify-center gap-2 rounded-xl font-display font-semibold tracking-wide transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:pointer-events-none disabled:opacity-40",
  secondary:
    "border border-gold/45 bg-gold/12 text-gold-soft hover:border-gold/70 hover:bg-gold/20",
  primary:
    "border border-gold/40 bg-pkred text-ivory shadow-[0_10px_30px_-12px_rgba(122,0,25,0.8)] hover:border-gold/70 hover:bg-pkred-light",
  quiet:
    "border border-ivory/16 bg-black/30 text-ivory/65 hover:border-ivory/35 hover:text-ivory",
} as const;

export const FIELD =
  "w-full rounded-lg border border-ivory/16 bg-black/40 px-3 py-2.5 text-sm text-ivory placeholder:text-ivory/30 outline-none transition focus:border-gold/55 focus:bg-black/55";

export const LABEL =
  "mb-1.5 block font-display text-[0.62rem] uppercase tracking-[0.22em] text-ivory/45";
