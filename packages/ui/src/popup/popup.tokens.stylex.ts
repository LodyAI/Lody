import * as stylex from '@stylexjs/stylex';
import { control, radius, space, text } from '../tokens/scales.stylex';

/**
 * One token group for every list that floats over the page — the Select popup,
 * the Combobox popup, and the menus that follow. It is deliberately not part of
 * the `field` group: a trigger is a control on the well rung and reads `field`,
 * while the list it opens is on the floating rung and shares its dimensions with
 * a menu rather than with an input. Colours stay in the semantic group and are
 * referenced directly by `surface.ts`, so a forced subtree theme needs no second
 * component-variable theme to relay them.
 */
export const popup = stylex.defineVars({
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
});
