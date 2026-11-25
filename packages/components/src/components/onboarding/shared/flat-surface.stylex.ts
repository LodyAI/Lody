import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';

/**
 * Flat, borderless spatial design language for Onboarding and Lody Agent model setup.
 *
 * Hierarchy comes from generous negative space, typographic scale/contrast, and
 * quiet tonal fills — never from stacked 1px borders or nested card boxes.
 */
export const flatSurface = stylex.create({
  /** Theme-adaptive surface variables so `ConnectModelSheet` works on both the warm light stage and dark Settings. */
  onboardingLightScope: {
    '--flat-ink': '#141413',
    '--flat-ink-secondary': 'rgba(20, 20, 19, 0.60)',
    '--flat-ink-tertiary': 'rgba(20, 20, 19, 0.40)',
    '--flat-fill': 'rgba(20, 20, 19, 0.042)',
    '--flat-fill-hover': 'rgba(20, 20, 19, 0.072)',
    '--flat-fill-strong': 'rgba(20, 20, 19, 0.095)',
    '--flat-input-bg': 'rgba(20, 20, 19, 0.052)',
    '--flat-input-focus': 'rgba(20, 20, 19, 0.078)',
    '--flat-primary-bg': '#141413',
    '--flat-primary-fg': '#FAF9F6',
    '--flat-primary-hover': '#272725',
    '--flat-amber-bg': 'rgba(217, 119, 6, 0.12)',
    '--flat-amber-fg': '#B45309',
    '--flat-ok-fg': '#15803D',
    '--flat-ok-bg': 'rgba(21, 128, 61, 0.10)',
    '--flat-danger-fg': '#B91C1C',
    '--flat-danger-bg': 'rgba(185, 28, 28, 0.08)',
    '--flat-elevated-bg': '#FFFFFF',
    '--flat-elevated-shadow': '0 16px 40px -12px rgba(20, 20, 19, 0.14), 0 2px 8px rgba(20, 20, 19, 0.05)',
  } as Record<string, string>,

  settingsAdaptiveScope: {
    '--flat-ink': colors.label,
    '--flat-ink-secondary': colors.secondaryLabel,
    '--flat-ink-tertiary': colors.tertiaryLabel,
    '--flat-fill': 'color-mix(in srgb, currentColor 5%, transparent)',
    '--flat-fill-hover': 'color-mix(in srgb, currentColor 8.5%, transparent)',
    '--flat-fill-strong': 'color-mix(in srgb, currentColor 12%, transparent)',
    '--flat-input-bg': 'color-mix(in srgb, currentColor 6%, transparent)',
    '--flat-input-focus': 'color-mix(in srgb, currentColor 9.5%, transparent)',
    '--flat-primary-bg': colors.label,
    '--flat-primary-fg': colors.background,
    '--flat-primary-hover': 'color-mix(in srgb, var(--flat-primary-bg) 88%, transparent)',
    '--flat-amber-bg': 'rgba(245, 158, 11, 0.15)',
    '--flat-amber-fg': '#D97706',
    '--flat-ok-fg': '#16A34A',
    '--flat-ok-bg': 'rgba(22, 163, 74, 0.13)',
    '--flat-danger-fg': '#DC2626',
    '--flat-danger-bg': 'rgba(220, 38, 38, 0.10)',
    '--flat-elevated-bg': colors.elevatedBackground,
    '--flat-elevated-shadow': '0 18px 42px -14px rgba(0, 0, 0, 0.28)',
  } as Record<string, string>,

  heading: {
    margin: 0,
    fontSize: 'clamp(1.65rem, 2.4vw, 2.05rem)',
    fontWeight: 600,
    letterSpacing: '-0.028em',
    lineHeight: 1.18,
    color: 'var(--flat-ink)',
  },

  subheading: {
    margin: 0,
    fontSize: '0.9375rem',
    lineHeight: 1.55,
    color: 'var(--flat-ink-secondary)',
  },

  groupStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.75rem',
  },

  groupBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },

  groupLabel: {
    fontSize: '0.75rem',
    fontWeight: 500,
    letterSpacing: '0.01em',
    color: 'var(--flat-ink-tertiary)',
    paddingInline: '0.125rem',
    userSelect: 'none',
  },

  /** Borderless tonal row — space + subtle fill, zero 1px border. */
  flatRow: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '12px',
    backgroundColor: 'var(--flat-fill)',
    transitionProperty: 'background-color, transform',
    transitionDuration: '140ms, 80ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
    overflow: 'hidden',
  },

  flatRowTrigger: {
    appearance: 'none',
    borderWidth: 0,
    backgroundColor: 'transparent',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.9375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--flat-ink)',
    cursor: 'pointer',
    textAlign: 'start',
    transitionProperty: 'background-color, transform',
    transitionDuration: '140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
    },
    ':active': {
      transform: 'scale(0.992)',
    },
    ':focus-visible': {
      outline: '2px solid currentColor',
      outlineOffset: '-2px',
    },
  },

  flatInput: {
    appearance: 'none',
    borderWidth: 0,
    outline: 'none',
    width: '100%',
    borderRadius: '10px',
    backgroundColor: 'var(--flat-input-bg)',
    color: 'var(--flat-ink)',
    fontSize: '0.875rem',
    lineHeight: 1.4,
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    transitionProperty: 'background-color',
    transitionDuration: '140ms',
    '::placeholder': {
      color: 'var(--flat-ink-tertiary)',
    },
    ':focus': {
      backgroundColor: 'var(--flat-input-focus)',
    },
  },

  primaryPill: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '10px',
    backgroundColor: 'var(--flat-primary-bg)',
    color: 'var(--flat-primary-fg)',
    fontSize: '0.8125rem',
    fontWeight: 500,
    lineHeight: 1,
    paddingBlock: '0.5625rem',
    paddingInline: '0.875rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.4375rem',
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'opacity, transform, background-color',
    transitionDuration: '140ms, 80ms, 140ms',
    ':hover': {
      backgroundColor: 'var(--flat-primary-hover)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':disabled': {
      opacity: 0.42,
      cursor: 'not-allowed',
      transform: 'none',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },

  quietButton: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '10px',
    backgroundColor: 'transparent',
    color: 'var(--flat-ink-secondary)',
    fontSize: '0.8125rem',
    fontWeight: 500,
    lineHeight: 1,
    paddingBlock: '0.5rem',
    paddingInline: '0.6875rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'color, background-color, transform',
    transitionDuration: '140ms, 140ms, 80ms',
    ':hover': {
      color: 'var(--flat-ink)',
      backgroundColor: 'var(--flat-fill-hover)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },

  inlineLink: {
    appearance: 'none',
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: 'var(--flat-ink)',
    fontSize: '0.8125rem',
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    cursor: 'pointer',
    transitionProperty: 'opacity, transform',
    transitionDuration: '120ms, 80ms',
    ':hover': {
      opacity: 0.72,
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
      borderRadius: '4px',
    },
  },
});
