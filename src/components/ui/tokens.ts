/**
 * The one place the look of this product is defined.
 *
 * Everything here existed already, deep green felt, gold hairlines, Cinzel
 * display type, ivory text, but five times over, and the five copies had
 * drifted: two felt backgrounds at different texture opacities, two "good"
 * greens (one of them left over from a blue theme that no longer exists), chips
 * that were gold pills on one page and ivory capsules on the next. This module
 * does not introduce a palette. It picks which copy was right.
 *
 * ## Radius grammar
 *
 * Shape carries meaning here, so it follows a rule rather than a mood:
 *
 *   marker    fully round   a thing you read, never press, badges, rails, bars
 *   control   8px           a thing you press, buttons, tabs, inputs
 *   action    12px          the primary commitment on a screen
 *   surface   16px          a panel that groups other things
 *   felt      32px          the table itself, the one physical object on screen
 *
 * A component picks its radius from its role, not from how big it happens to
 * be. That is the whole rule, and it is why there is no `rounded-3xl` here.
 */

export const RADIUS = {
  marker: "rounded-full",
  control: "rounded-lg",
  action: "rounded-xl",
  surface: "rounded-2xl",
  felt: "rounded-[2rem]",
} as const;

/**
 * Hairlines. Gold separates the product's own furniture; ivory separates
 * content from content inside it.
 */
export const LINE = {
  gold: "rgba(201,162,39,0.30)",
  goldStrong: "rgba(201,162,39,0.55)",
  goldFaint: "rgba(201,162,39,0.16)",
  quiet: "rgba(244,237,228,0.14)",
  quietFaint: "rgba(244,237,228,0.08)",
} as const;

/**
 * Backgrounds, in order of depth: `sunk` sits inside a panel, `panel` sits on
 * the felt, `tray` holds a row of controls.
 */
export const SURFACE = {
  sunk: "rgba(0,0,0,0.28)",
  tray: "rgba(0,0,0,0.42)",
  panel:
    "linear-gradient(180deg, rgba(18,53,36,0.65) 0%, rgba(11,34,24,0.75) 100%)",
  goldWash: "rgba(201,162,39,0.12)",
  goldWashStrong: "rgba(201,162,39,0.20)",
} as const;

/**
 * Semantic ink.
 *
 * `good` and `bad` are the warm pair the report already used. The table's coach
 * panel was still printing `#34d399` / `#f87171`. Tailwind's default emerald
 * and rose, inherited from the blue theme this app abandoned. They read as a
 * different product's success colours against felt, which is exactly what a
 * player noticed without being able to name it.
 */
export type Tone = "neutral" | "gold" | "good" | "bad" | "sim";

export const TONE: Record<Tone, string> = {
  neutral: "#f4ede4",
  gold: "#e2c563",
  good: "#7fd3a8",
  bad: "#e58a8a",
  /** Reserved for simulated results. Used nowhere else, deliberately. */
  sim: "#b07fd4",
};

/** Chosen for a number that should read as a number: net won, EV, chips. */
export function netTone(value: number): string {
  return value > 0 ? TONE.good : value < 0 ? TONE.bad : "rgba(244,237,228,0.45)";
}
