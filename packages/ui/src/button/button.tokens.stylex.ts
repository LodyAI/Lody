import * as stylex from '@stylexjs/stylex';
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
  ringWidth: '2px',
});
