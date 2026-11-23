import * as stylex from '@stylexjs/stylex';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

/**
 * The visual vocabulary the mobile settings surfaces share.
 *
 * The mobile settings pages are a family: a project row, a GitHub row and an
 * account row all say "here is a thing, and here is its control". They spell
 * that the same way — a mark in a quiet tile, the name beside it, a chevron at
 * the end — so the vocabulary lives here, beside the pages that use it, the way
 * `components/settings/surface.ts` holds the desktop settings family's shared
 * look.
 *
 * Sizes come from the theme's own scale (`themeSpace`), so a migrated row
 * keeps the rem geometry it had.
 */
export const mobileSurface = stylex.create({
  /**
   * A row's identity: the mark, then the name. The name column takes the
   * remaining width and truncates, so a long name never pushes the row's
   * control off-screen.
   */
  identity: { display: 'flex', alignItems: 'center', gap: themeSpace[3], minWidth: 0 },
  /**
   * The mark's box: a tile in the accent's ink — quiet enough to sit beside a
   * name without competing with it.
   */
  identityTile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[9],
    height: themeSpace[9],
    flexShrink: 0,
    borderRadius: themeRadius.xl,
    backgroundColor: 'hsl(var(--primary) / 0.1)',
    color: themeColors.primary,
  },
  /** The mark's glyph. */
  identityGlyph: { width: '1.05rem', height: '1.05rem' },
  /** The name beside the mark. */
  identityLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
  },
  /** The name set tight, as the project rows set it. */
  identityLabelTight: { lineHeight: 1.25 },
  /** A row's trailing chevron: a hint, in the ink of a glyph at rest. */
  chevron: {
    flexShrink: 0,
    width: themeSpace[4],
    height: themeSpace[4],
    color: 'hsl(var(--muted-foreground) / 0.6)',
  },
  /**
   * A group that is still loading says so in one centred line, in the card's
   * own quiet ink.
   */
  notice: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[6],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  /** A group that has nothing to show says so, centred in the card. */
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[10],
    textAlign: 'center',
  },
  emptyText: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
});
