import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { control, radius, space, text } from '../tokens/scales.stylex';

/**
 * One token group for the whole field family — label, control, help and error.
 * Input, Textarea and every control that migrates next read these, so a state
 * has one colour in one place instead of one per component.
 */
export const field = stylex.defineVars({
  heightSmall: control.small,
  heightMedium: control.medium,
  heightLarge: control.large,
  paddingXSmall: space[2],
  // 10px sits between space.2 and space.3; the 32px control needs the half step.
  paddingXMedium: '10px',
  paddingXLarge: space[3],
  paddingBlock: space[2],
  radiusSmall: radius.small,
  radiusMedium: radius.medium,
  // One step for the whole 28 / 32 / 36 ladder. 12 belongs to the label and the
  // help text; a control's own content is never sized like the text about it.
  text: text.subheadlineSize,
  labelSize: text.footnoteSize,
  labelLeading: text.footnoteLeading,
  gap: space[1.5],
  ringWidth: '2px',
  textareaMinHeight: '72px',
  // The rules put disabled at 45% opacity on the control. It is one value for
  // the whole family, so the control and its label cannot drift apart.
  disabledOpacity: '0.45',
  background: colors.wellBackground,
  well: shadow.inset,
  value: colors.label,
  label: colors.label,
  placeholder: colors.tertiaryLabel,
  hint: colors.tertiaryLabel,
  error: colors.destructive,
  ring: colors.accent,
  invalidRing: colors.destructive,
});

/**
 * Re-declares the colour-valued tokens on the element that carries a forced
 * palette; see the note in `button.tokens.stylex.ts` for why a group declared
 * only at the document root keeps the root palette inside a themed subtree.
 */
export const fieldPaletteTheme = stylex.createTheme(field, {
  background: colors.wellBackground,
  well: shadow.inset,
  value: colors.label,
  label: colors.label,
  placeholder: colors.tertiaryLabel,
  hint: colors.tertiaryLabel,
  error: colors.destructive,
  ring: colors.accent,
  invalidRing: colors.destructive,
});
