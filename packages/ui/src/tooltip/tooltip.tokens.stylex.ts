import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * The one floating thing that is not the popup surface.
 *
 * The elevation ladder puts a menu, a popover and a list on the floating rung —
 * the raised background under the popover shadow — and then names the tooltip
 * separately: `label` with `shadow.medium`. That is a deliberate inversion. A
 * popup is a place you act; a tooltip only names what is already under the
 * pointer, and it has to read at a glance over whatever it covers without
 * becoming another surface competing for attention. Inverting it says "this is
 * not part of the page" in one step, in both palettes, which is why it reads
 * `tooltip` rather than `popup`: a tooltip reaching for `popup.background`
 * would be naming the wrong thing to get the wrong colour.
 */
export const tooltip = stylex.defineVars({
  background: colors.label,
  // The ink on that fill: the page background, the same pair a primary button
  // and a checked box take. A stored-state fill and an inverted chip are the
  // same two colours in the same order.
  label: colors.background,
  shadow: shadow.medium,
  // The corner rule gives 8 to 28px controls and to tooltips by name.
  radius: radius.small,
  paddingX: space[2],
  paddingY: space[1],
  // A tooltip is a hint about something else, so it takes the footnote step the
  // rules give help text rather than the control step its trigger takes.
  text: text.footnoteSize,
  leading: text.footnoteLeading,
  // Past this it stops being a label and starts being prose, which belongs in
  // the surface rather than over it.
  maxWidth: '260px',
  rise: '4px',
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const tooltipPaletteTheme = stylex.createTheme(tooltip, {
  background: colors.label,
  label: colors.background,
  shadow: shadow.medium,
});
