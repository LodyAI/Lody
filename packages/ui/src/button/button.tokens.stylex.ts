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
  // The 28 / 32 / 36 ladder is one control step, so one token carries it: a
  // per-size token whose values happen to match is an invitation to drift.
  // `mini` is not on that ladder, so it keeps its own.
  textMini: text.footnoteSize,
  text: text.subheadlineSize,
  gap: '6px',
  // What an icon-only button holds. The button is square at the size's height
  // and the glyph inside it is not: 16 is the size every other holder in this
  // package gives a glyph — a menu row's leading box, a Select's chevron, a
  // message's mark — so an icon button is the same mark in a pressable box.
  iconSize: '16px',
  primaryBackground: colors.label,
  primaryLabel: colors.background,
  primaryEdge: shadow.inkEdge,
  secondaryBackground: colors.raisedBackground,
  secondaryShadow: shadow.raised,
  ghostLabel: colors.secondaryLabel,
  ghostHover: colors.hoverFill,
  ring: colors.accent,
  ringWidth: '2px',
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
  ring: colors.accent,
});
