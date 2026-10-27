import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

export const pageSurface = stylex.create({
  page: {
    display: 'flex',
    minHeight: '100vh',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: themeColors.background,
    padding: themeSpace[4],
  },
  card: { width: '100%', maxWidth: '28rem' },
  fullWidth: { width: '100%' },
  center: { textAlign: 'center' },
  centeredRow: { display: 'flex', justifyContent: 'center' },
  row: { display: 'flex', alignItems: 'center' },
  field: { display: 'grid', gap: themeSpace[2] },
  form: { display: 'grid', gap: themeSpace[4] },
  stack1: {
    marginBlockStart: { default: null, ':not(:last-child)': 0 },
    marginBlockEnd: { default: null, ':not(:last-child)': themeSpace[1] },
  },
  stack2: {
    marginBlockStart: { default: null, ':not(:last-child)': 0 },
    marginBlockEnd: { default: null, ':not(:last-child)': themeSpace[2] },
  },
  stack4: {
    marginBlockStart: { default: null, ':not(:last-child)': 0 },
    marginBlockEnd: { default: null, ':not(:last-child)': themeSpace[4] },
  },
  iconWell: {
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--primary) / 0.1)',
    padding: themeSpace[3],
  },
  heroIcon: { height: themeSpace[6], width: themeSpace[6], color: themeColors.primary },
  smallIcon: { height: themeSpace[4], width: themeSpace[4] },
  spinnerMargin: { marginRight: themeSpace[2] },
  error: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.destructive,
  },
  hint: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  smallError: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.destructive,
  },
});
