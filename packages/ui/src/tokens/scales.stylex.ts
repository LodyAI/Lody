import * as stylex from '@stylexjs/stylex';

export const space = stylex.defineVars({
  1: '4px',
  1.5: '6px',
  2: '8px',
  3: '12px',
  4: '16px',
  6: '24px',
  8: '32px',
});

export const radius = stylex.defineVars({
  mini: '5px',
  small: '8px',
  medium: '10px',
  large: '14px',
  full: '9999px',
});

export const corner = stylex.defineConsts({
  shape: 'squircle',
});

export const control = stylex.defineVars({
  small: '28px',
  medium: '32px',
  large: '36px',
});

export const text = stylex.defineVars({
  captionSize: '11px',
  captionLeading: '16px',
  footnoteSize: '12px',
  footnoteLeading: '16px',
  subheadlineSize: '13px',
  subheadlineLeading: '18px',
  bodySize: '14px',
  bodyLeading: '20px',
  headlineSize: '16px',
  headlineLeading: '24px',
  titleSize: '18px',
  titleLeading: '24px',
  controlTracking: '-0.01em',
});

export const duration = stylex.defineVars({
  fast: '120ms',
  regular: '180ms',
});

export const ease = stylex.defineConsts({
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
});

export const z = stylex.defineConsts({
  dialogBackdrop: '70',
  dialog: '80',
  popover: '80',
  tooltip: '90',
  toast: '100',
});
