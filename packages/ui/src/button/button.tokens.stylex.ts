import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { control, radius, text } from '../tokens/scales.stylex';

export const button = stylex.defineVars({
  heightMini: '24px',
  heightSmall: control.small,
  heightMedium: control.medium,
  heightLarge: control.large,
  paddingXMini: '8px',
  paddingXSmall: '10px',
  paddingXMedium: '12px',
  paddingXLarge: '14px',
  radiusMini: '6px',
  radiusSmall: radius.small,
  radiusMedium: radius.medium,
  textMini: text.footnoteSize,
  textSmall: text.footnoteSize,
  textMedium: text.subheadlineSize,
  gap: '6px',
  primaryBackground: colors.label,
  primaryLabel: colors.background,
  primaryEdge: shadow.inkEdge,
  secondaryBackground: colors.raisedBackground,
  secondaryShadow: shadow.raised,
  ghostLabel: colors.secondaryLabel,
  ghostHover: colors.hoverFill,
});

/**
 * The colour-valued tokens above are declared once at the document root, so a
 * custom property that points at a semantic token resolves against the palette
 * in force there and inherits that resolved value. A theme applied to a subtree
 * would leave a button carrying the root palette. This theme re-declares those
 * tokens on the element that carries the palette, where they resolve again.
 * `ThemeRoot` applies it with every forced palette.
 */
export const buttonPaletteTheme = stylex.createTheme(button, {
  primaryBackground: colors.label,
  primaryLabel: colors.background,
  primaryEdge: shadow.inkEdge,
  secondaryBackground: colors.raisedBackground,
  secondaryShadow: shadow.raised,
  ghostLabel: colors.secondaryLabel,
  ghostHover: colors.hoverFill,
});
