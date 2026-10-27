import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';

/**
 * The vocabulary the shared surfaces spell their quiet links with.
 *
 * A few of them are the same control in different places: a text link that
 * opens outside the app (the founder call, the pricing page), and the consent
 * line those links sit under. They spell it the same way, so the look lives
 * here, beside the surfaces that use it, the way
 * `components/settings/surface.ts` holds the desktop settings family's shared
 * look.
 *
 * Sizes come from the theme's own scale (`themeSpace`), so a migrated link
 * keeps the rem geometry it had.
 */
export const sharedSurface = stylex.create({
  /**
   * A quiet text link that opens in the system browser: the copy in the
   * muted ink, the external-link glyph beside it.
   */
  externalLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
    textDecorationLine: { default: 'none', ':hover': 'underline' },
  },
  /** The glyph that says the link leaves the app. */
  externalLinkGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  /**
   * The consent line under a checkout: the disclosure copy in the muted ink.
   * Its leading is Tailwind's `leading-relaxed`, not the size's own line
   * height, so the pair is written out.
   */
  consentNotice: {
    fontSize: themeFontSize.xs,
    lineHeight: '1.625',
    color: themeColors.mutedForeground,
  },
  /** The Terms link inside the consent line: underlined, and it steps up on hover. */
  consentLink: {
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
  },
});
