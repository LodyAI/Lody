import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

/** Tailwind's `animate-pulse`: the same keyframes, at the same cadence. */
const pulse = stylex.keyframes({
  '50%': { opacity: 0.5 },
});

/**
 * The loading screen's own look: the app's background, the app's ink, the
 * app's primary colour for the progress dot.
 */
export const onboardingLoadingSurface = stylex.create({
  /** The column the whole screen stacks in. */
  stack: {
    position: 'relative',
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: themeSpace[8],
  },
  /** The mark's own box: the halo the logo sits in. */
  markBox: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '7rem',
    width: '7rem',
  },
  /** The soft glow behind the mark. */
  glow: {
    position: 'absolute',
    inset: 0,
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--primary) / 0.3)',
    filter: 'blur(40px)',
  },
  /** The ring that breathes around the mark. */
  pulseRing: {
    position: 'absolute',
    inset: 0,
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--primary) / 0.4)',
  } /** The mark itself. */,
  logo: {
    position: 'relative',
    height: themeSpace[16],
    width: themeSpace[16],
    userSelect: 'none',
    borderRadius: themeRadius['2xl'],
    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.2), 0 4px 6px -4px rgb(0 0 0 / 0.2)',
  },
  /** The headline and its sentence. */
  copy: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1.5],
    textAlign: 'center',
  },
  /** The headline. */
  title: {
    fontSize: themeFontSize.xl,
    lineHeight: themeLineHeight.xl,
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '-0.025em',
    color: themeColors.foreground,
  },
  /** The sentence under the headline. */
  subtitle: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  /** The list of startup stages. */
  stages: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  /** One startup stage. */
  stage: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3],
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** A stage that has been reached. */
  stageReached: { color: themeColors.foreground },
  /** A stage that has not been reached yet. */
  stagePending: { color: 'hsl(var(--muted-foreground) / 0.6)' },
  /** The dot beside a stage. */
  dot: {
    display: 'inline-flex',
    flexShrink: 0,
    height: themeSpace[2],
    width: themeSpace[2],
    borderRadius: themeRadius.full,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The dot of the stage the runtime is on. */
  dotActive: { backgroundColor: themeColors.primary },
  /** The dot of the stage the runtime is on, breathing. */
  dotPulsing: {
    backgroundColor: themeColors.primary,
    animationName: pulse,
    animationDuration: '2s',
    animationTimingFunction: 'cubic-bezier(0.4, 0, 0.6, 1)',
    animationIterationCount: 'infinite',
  },
  /** The dot of a stage that has not been reached. */
  dotPending: { backgroundColor: 'hsl(var(--muted-foreground) / 0.3)' },
  /** The dot of a stage that is done. */
  dotDone: { backgroundColor: themeColors.primary },
});
