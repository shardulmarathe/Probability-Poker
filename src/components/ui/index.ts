/**
 * The design system.
 *
 * One definition of each primitive, so a chip, a stat or a tab looks the same
 * on every screen it appears on. Import from here — `import { Stat, Tabs } from
 * "../ui"` — never from the individual files, so a component can be split or
 * merged without touching its callers.
 *
 * Every surface now imports from here; `report/ui.tsx`, which briefly carried a
 * second copy of a dozen of these, is gone. If a primitive is needed in two
 * places, it belongs in this directory rather than being copied — the copies
 * drifted within days last time (`Rail` rendered visibly differently in two
 * adjacent page headers, and three `Stat`s had incompatible props).
 */

export { FeltBackground } from "./FeltBackground";
export {
  EmptyPanel,
  EmptyState,
  Group,
  Panel,
  Section,
  Well,
  type GroupProps,
  type PanelProps,
} from "./Surface";
export { Stat, StatGrid, type StatProps } from "./Stat";
export { Meter, Rail, Scroller, Tag, Tray } from "./Markers";
export { StickyTabs, Tabs, type TabOption, type TabsProps } from "./Tabs";
export {
  ACTION_STYLES,
  ActionButton,
  Button,
  ButtonLink,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from "./Button";
export { Calc, Frac, Heading, HowCalculated, Lead, Note, Why } from "./Prose";
export { CardRow, cardText } from "./CardRow";
export { LINE, RADIUS, SURFACE, TONE, netTone, type Tone } from "./tokens";
