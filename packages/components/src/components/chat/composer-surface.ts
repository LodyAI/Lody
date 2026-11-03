import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../../style/theme-scale.stylex';

/**
 * The composer's box. Exported so surfaces that cannot mount the real
 * `ChatComposer` — the anonymous share reader, which must stay free of mention,
 * attachment and agent-control machinery — still render the same object the
 * product's composer is, instead of a look-alike that drifts from it.
 *
 * Focus, mention-chip surface colour and every interactive concern stay in
 * `chat-composer.tsx`; this is only the resting surface.
 */

/** The lift, as a `box-shadow` value: the theme's dark step clears it. */
export const COMPOSER_ELEVATION_SHADOW =
  'var(--composer-elevation, 0 10px 28px -14px lch(0% 0 0/0.16), 0 1px 2px lch(0% 0 0/0.05))';

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

export const composerSurfaceStyles = stylex.create({
  darkElevation: { '--composer-elevation': { default: null, [DARK_SCOPE]: '0 0 #0000' } },
  composerElevation: { boxShadow: COMPOSER_ELEVATION_SHADOW },
  /** The hairline lift of the session info bar, dropped in the dark theme too. */
  infoBarElevation: {
    boxShadow: 'var(--composer-elevation, 0 0.5px 1px 1px rgba(0,0,0,0.04))',
  },
  sessionSurface: {
    containerType: 'inline-size',
    containerName: 'composer-box',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1],
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[2],
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    borderColor: 'hsl(var(--foreground) / 0.1)',
    backgroundColor: themeColors.composer,
  },
});
