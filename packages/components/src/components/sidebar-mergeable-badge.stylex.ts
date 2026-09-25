import * as stylex from '@stylexjs/stylex';
import { badge } from '@lody/ui/badge/badge.tokens.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';

/**
 * The sidebar's `Mergeable` badge is the one status in a conversation row meant
 * to be noticed, so its word is the success colour itself rather than the
 * package's half-way mix toward the ink. Only that token changes; the tint and
 * every other tone stay the package's.
 */
export const mergeableBadgeTheme = stylex.createTheme(badge, {
  successLabel: colors.success,
});
