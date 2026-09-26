import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * The floating rung's material, cut down to a label.
 *
 * The elevation ladder puts a menu, a popover and a list on the floating rung —
 * the raised background under the popover shadow — and a tooltip is on that rung
 * too: the same fill, the same ink and the same shadow, so it is light in a
 * light palette and dark in a dark one like every other floating surface. What
 * sets it apart is size rather than material: a popup is a place you act, a
 * tooltip only names what is already under the pointer, so it keeps its own
 * smaller corner, padding, type step and width. That is why it still reads
 * `tooltip` rather than `popup`: the colours agree today, but the chip's
 * geometry is its own, and a tooltip reaching for `popup.radius` would be
 * naming the wrong thing to get the wrong corner.
 */
export const tooltip = stylex.defineVars({
  background: colors.raisedBackground,
  // The ink on that fill: the popup surface's own `label`, so a tooltip over a
  // menu and the rows inside that menu are written in the same colour.
  label: colors.label,
  shadow: shadow.popover,
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
  background: colors.raisedBackground,
  label: colors.label,
  shadow: shadow.popover,
});
