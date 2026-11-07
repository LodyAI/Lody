import * as stylex from '@stylexjs/stylex';
import { themeFontWeight, themeSpace } from '../../style/theme-scale.stylex';

/**
 * The onboarding stage: the product's window on one side, the configuration
 * form on the other.
 *
 * The stage's own ink is the printed slate of the ceremony, not the app's
 * palette, so the colours are written as the Tailwind palette expressions they
 * came from.
 */
export const onboardingShellSurface = stylex.create({
  /** The stage the whole flow stands on. */
  stage: {
    position: 'absolute',
    inset: 0,
    isolation: 'isolate',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    color: 'var(--color-slate-950)',
  },
  /**
   * The product's window, behind the form.
   *
   * Below the two-column breakpoint the centred form overlaps the product and
   * the close-up frames an empty patch of the window, so the preview steps out
   * entirely. Opacity (not unmount) is what flips, keeping the camera mounted
   * and letting the existing 700ms fade carry the transition both ways.
   */
  camera: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    overflow: 'clip',
    transitionProperty: 'opacity',
    transitionDuration: '700ms',
    transitionTimingFunction: 'var(--ease-out)',
    /**
     * The step's own dimming. It travels as a custom property, so the
     * compact rule below can still take the camera out of the way.
     */
    opacity: 'var(--onboarding-camera-opacity)',
    '@media (width < 1080px)': { opacity: 0 },
  },
  /** The veil drawn over the product, so the form reads first. */
  veil: { position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' },
  /** The form's own column. */
  form: {
    position: 'absolute',
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    pointerEvents: 'auto',
    willChange: 'transform',
  },
  /**
   * Below the two-column breakpoint the form moves to the centre and the
   * product becomes a quiet full-stage context layer.
   */
  formCompact: {
    '@media (width < 1080px)': {
      left: 'calc(50% - min(310px,43%)) !important',
      top: '9% !important',
      bottom: '7% !important',
      width: 'min(620px,86%) !important',
    },
  },
  /** The scroll region the form's content lives in. */
  scroller: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexGrow: 1,
    overflowY: 'auto',
    marginInline: `-${themeSpace[1]}`,
    paddingInline: themeSpace[1],
  },
  /** The content column inside the scroller. */
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[5],
    marginBlock: 'auto',
    paddingBlock: themeSpace[2],
  },
  /** The step counter above the title. */
  eyebrow: {
    fontSize: '11.5px',
    fontWeight: themeFontWeight.medium,
    letterSpacing: '0.025em',
    color: 'var(--color-slate-500)',
  },
  /** The page's title. */
  title: {
    fontSize: '31px',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1.25,
    letterSpacing: '-0.025em',
    color: 'var(--color-slate-950)',
  },
  /** The sentence under the title. */
  description: {
    maxWidth: '40ch',
    fontSize: '14.5px',
    lineHeight: 1.625,
    color: 'var(--color-slate-600)',
  },
  /** The slot the form's own fields live in. */
  content: { minHeight: 0 },
  /** The action row under the form. */
  actions: {
    display: 'flex',
    flexShrink: 0,
    justifyContent: 'flex-end',
    gap: themeSpace[2.5],
    paddingTop: themeSpace[6],
  },
  /** A glyph at 16px. */
  glyph: { width: themeSpace[4], height: themeSpace[4] },
});
