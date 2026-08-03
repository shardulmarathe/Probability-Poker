/**
 * The design system.
 *
 * One definition of each primitive, so a chip, a stat or a tab looks the same
 * on every screen it appears on. Import from here — `import { Stat, Tabs } from
 * "../ui"` — never from the individual files, so a component can be split or
 * merged without touching its callers.
 *
 * `src/components/report/*` still carries its own copies of `FeltBackground`,
 * `Section`, `Stat`, `Rail`, `Tag`, `Meter`, `Scroller`, `EmptyPanel`,
 * `ChipRow`, `CardRow`, `cardText`, `Lead`, `Heading`, `Calc`, `Frac`, `Why`
 * and `HowCalculated`. Every one of them has an equivalent here under the same
 * name (`ChipRow` becomes `Tabs`), so that migration is an import swap plus a
 * rename of `Stat`'s `highlight`/`sub` props to `tone`/`note`.
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
