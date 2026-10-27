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

/**
 * The composer soft wide lift.
 *
 * The dark theme drops it, and StyleX cannot select a `.dark` ancestor, so the
 * reset stays a Tailwind class beside the style. It clears the lift through a
 * custom property rather than through `shadow-none`, so a ring composed with
 * the lift — the image-drop ring of the composer — survives the dark step.
 */

/** The lift, as a `box-shadow` value: the theme's dark step clears it. */
export const COMPOSER_ELEVATION_SHADOW =
  'var(--composer-elevation, 0 10px 28px -14px lch(0% 0 0/0.16), 0 1px 2px lch(0% 0 0/0.05))';

/** The dark step that clears the lift. */
const CLEAR_ELEVATION = 'dark:[--composer-elevation:0_0_#0000]';

export const composerSurfaceStyles = stylex.create({
  /**
   * The composer soft wide lift. The dark theme drops it, and StyleX cannot
   * select a `.dark` ancestor, so `CLEAR_ELEVATION` stays a Tailwind class on
   * the element — it outranks this style from the `utilities` layer.
   */
  composerElevation: { boxShadow: COMPOSER_ELEVATION_SHADOW },
  /** The hairline lift of the session info bar, dropped in the dark theme too. */
  infoBarElevation: {
    boxShadow: 'var(--composer-elevation, 0 0.5px 1px 1px rgba(0,0,0,0.04))',
  },
  /**
   * The resting box of the session composer. The dark fill and edge are the
   * `dark:` variants of the theme's own colours; StyleX cannot select a
   * `.dark` ancestor, so they stay Tailwind classes beside this style.
   */
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

/** The composer's lift, as a class name other modules can place on their own box. */
export const COMPOSER_ELEVATION_CLASS = `${stylex.props(composerSurfaceStyles.composerElevation).className} ${CLEAR_ELEVATION}`;

/** The info bar lift, as a class name other modules can place. */
export const INFO_BAR_ELEVATION_CLASS = `${stylex.props(composerSurfaceStyles.infoBarElevation).className} ${CLEAR_ELEVATION}`;

/**
 * The resting box of the session composer, as a class name. It carries the dark
 * theme's own fill and edge, which StyleX cannot express.
 */
export const COMPOSER_SESSION_SURFACE_CLASS = `${stylex.props(composerSurfaceStyles.sessionSurface).className} ${COMPOSER_ELEVATION_CLASS} dark:border-input-border/70 dark:bg-input/90`;
