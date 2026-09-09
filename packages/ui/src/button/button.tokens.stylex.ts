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
