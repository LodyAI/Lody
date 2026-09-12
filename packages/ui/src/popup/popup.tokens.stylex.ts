import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { control, radius, space, text } from '../tokens/scales.stylex';

/**
 * One token group for everything that floats over the page — the Select popup,
 * the Combobox popup, the menus, and the Popover that holds content instead of
 * rows. It is deliberately not part of the `field` group: a trigger is a
 * control on the well rung and reads `field`, while the list it opens is on the
 * floating rung and shares its vocabulary with a menu rather than with an input.
 * A menu that reached for `field.background` would be naming the wrong thing to
 * get the right colour.
 *
 * A Popover is the same surface with prose on it rather than commands, so it
 * reads this group too. Giving it one of its own would mean two floating
 * surfaces that can drift apart — a popover and the menu beside it opening at
 * two radii over two shadows — which is exactly what `menu-styles.ts` was.
 */
export const popup = stylex.defineVars({
  // The floating rung: raised background plus the popover shadow, together.
  background: colors.raisedBackground,
  shadow: shadow.popover,
  // Nested radius is outer minus inset: a 14px surface with a 4px inset holds
  // 10px rows. The row radius is derived from that pair rather than picked.
  radius: radius.large,
  inset: space[1],
  itemRadius: radius.medium,
  // A row is a 28px control that happens to live in a list, so it takes the
  // small step of the control ladder and the control type rule with it.
  itemHeight: control.small,
  itemPaddingX: space[2],
  itemGap: space[2],
  indicatorSize: '16px',
  text: text.subheadlineSize,
  groupLabelSize: text.captionSize,
  groupLabelLeading: text.captionLeading,
  // The rules put popups at 4px below at opacity 0, rising over duration.regular.
  rise: '4px',
  scrollArrowHeight: '20px',
  // A list takes the width of the control it belongs to, because that control
  // shows the value it holds. A menu has no such pair: what opens it is often a
  // 28px icon button, and matching that would produce a column of clipped
  // commands. A menu surface therefore states a width of its own and grows past
  // it for the longest row.
  menuWidth: '200px',
  // A Popover's content is not rows, so the 4px inset that lets a row reach the
  // surface's edge is the wrong padding for it: prose needs room. This pair is
  // what a popover replaces on the shared surface, the way `menuWidth` is what
  // a menu replaces — it also steps the type from the control rule to the prose
  // rule, which is a fact about type rather than a token of its own.
  panelPadding: space[3],
  panelGap: space[2],
  label: colors.label,
  hint: colors.tertiaryLabel,
  groupLabel: colors.secondaryLabel,
  // The sentence under a popover's title. `groupLabel` resolves to the same
  // colour today and means something else — a heading over rows — so the two
  // are named apart rather than shared for the value they happen to agree on.
  description: colors.secondaryLabel,
  separator: colors.separator,
  // Two different facts about a row: `highlighted` is where the keyboard or the
  // pointer is right now, `selected` is the row that holds the value, and the
  // tick keeps saying which is current when the highlight moves onto it.
  //
  // Both are derived from the rung they sit on rather than taken from
  // `hoverFill` and `selectedFill`, which the rules name for a row but which
  // were tuned against the page and card rungs at 100% lightness. On the
  // floating rung they collapse: measured in Chromium, `hoverFill` lands 2/255
  // from `raisedBackground` in Lody Light and `selectedFill` resolves to
  // exactly `raisedBackground` in Vesper, so one state is invisible in each
  // palette. Mixing toward `label` steps away from the surface in both
  // directions at once — darker in a light palette, lighter in a dark one —
  // which is the same derivation `Button` uses for a secondary button's hover.
  highlight: `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 6%)`,
  selected: `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 3%)`,
  indicator: colors.label,
  // The one row that is not `label`: a command that destroys something. Its
  // highlight is mixed toward `destructive` for the same reason `highlight` is
  // mixed toward `label` — on this rung the named fills collapse into the
  // surface — so the row about to delete something stays legible while the
  // keyboard is on it, in both palettes.
  destructive: colors.destructive,
  destructiveHighlight: `color-mix(in oklab, ${colors.raisedBackground}, ${colors.destructive} 12%)`,
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced palette;
 * see `button.tokens.stylex.ts` for why a group declared only at the document
 * root keeps the root palette inside a themed subtree.
 */
export const popupPaletteTheme = stylex.createTheme(popup, {
  background: colors.raisedBackground,
  shadow: shadow.popover,
  label: colors.label,
  hint: colors.tertiaryLabel,
  groupLabel: colors.secondaryLabel,
  description: colors.secondaryLabel,
  separator: colors.separator,
  highlight: `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 6%)`,
  selected: `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 3%)`,
  indicator: colors.label,
  destructive: colors.destructive,
  destructiveHighlight: `color-mix(in oklab, ${colors.raisedBackground}, ${colors.destructive} 12%)`,
});
