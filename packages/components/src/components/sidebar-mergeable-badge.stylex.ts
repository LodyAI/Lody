import * as stylex from '@stylexjs/stylex';
import { badge } from '@lody/ui/badge/badge.tokens.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';

/**
 * The sidebar's `Mergeable` badge is the one status in a conversation row meant
 * to be noticed, so its word is the success colour itself rather than the
 * package's half-way mix toward the ink, and its tint stays at 16% while the
 * package's washes settled at 14% (#976). Every other tone keeps the package's
 * values.
 */
export const mergeableBadgeTheme = stylex.createTheme(badge, {
  successLabel: colors.success,
  successFill: `color-mix(in oklab, ${colors.success} 16%, transparent)`,
});
