import * as stylex from '@stylexjs/stylex';

/**
 * The app theme's spacing, radius, type and motion scales, mirrored from the
 * Tailwind preset the app still ships (`packages/configs/tailwind-preset.cjs`).
 *
 * A migrated surface keeps the size it had: every step here is the same
 * expression Tailwind's utility resolved to, so nothing moves by a pixel.
 * Spacing aliases read `--spacing` where their group is declared. A surface
 * that overrides that unit locally also applies `scopedThemeSpace` there, so
 * its descendants resolve the local scale. Type sizes keep Tailwind's rem
 * scale and its paired line height — `text-sm` sets both, and a surface that
 * kept only the size would re-wrap.
 */

/** Tailwind's spacing scale: `--spacing` times the step. */
const themeSpaceDefaults = {
  0: '0px',
  0.5: 'calc(var(--spacing) * 0.5)',
  1: 'calc(var(--spacing) * 1)',
  1.5: 'calc(var(--spacing) * 1.5)',
  2: 'calc(var(--spacing) * 2)',
  2.5: 'calc(var(--spacing) * 2.5)',
  3: 'calc(var(--spacing) * 3)',
  3.5: 'calc(var(--spacing) * 3.5)',
  4: 'calc(var(--spacing) * 4)',
  5: 'calc(var(--spacing) * 5)',
  6: 'calc(var(--spacing) * 6)',
  7: 'calc(var(--spacing) * 7)',
  8: 'calc(var(--spacing) * 8)',
  9: 'calc(var(--spacing) * 9)',
  10: 'calc(var(--spacing) * 10)',
  11: 'calc(var(--spacing) * 11)',
  12: 'calc(var(--spacing) * 12)',
  14: 'calc(var(--spacing) * 14)',
  16: 'calc(var(--spacing) * 16)',
  20: 'calc(var(--spacing) * 20)',
  24: 'calc(var(--spacing) * 24)',
};

export const themeSpace = stylex.defineVars(themeSpaceDefaults);

/** Re-evaluate spacing aliases at a surface with its own spacing unit. */
export const scopedThemeSpace = stylex.createTheme(themeSpace, themeSpaceDefaults);

/**
 * Corner radii. `sm`, `md` and `lg` read the theme's radius variables because
 * the preset overrides them; the rest are Tailwind's own steps.
 */
export const themeRadius = stylex.defineVars({
  none: '0px',
  xs: '0.125rem',
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  xl: '0.75rem',
  '2xl': '1rem',
  '3xl': '1.5rem',
  full: '9999px',
});

/** Type sizes, with the line height Tailwind pairs them with. */
export const themeFontSize = stylex.defineVars({
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.25rem',
  '2xl': '1.5rem',
  '3xl': '1.875rem',
});

export const themeLineHeight = stylex.defineVars({
  xs: 'calc(1 / 0.75)',
  sm: 'calc(1.25 / 0.875)',
  base: 'calc(1.5 / 1)',
  lg: 'calc(1.75 / 1.125)',
  xl: 'calc(1.75 / 1.25)',
  '2xl': 'calc(2 / 1.5)',
  '3xl': 'calc(2.25 / 1.875)',
});

/** Font weights. */
export const themeFontWeight = stylex.defineVars({
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
});

/**
 * Motion. The theme's own durations (`--dur-1`, `--dur-2`) and easing
 * (`--ease`) are the preset's `duration-1`, `duration-2` and `ease-pro`;
 * Tailwind's remaining steps are listed beside them.
 */
export const themeDuration = stylex.defineVars({
  1: 'var(--dur-1)',
  2: 'var(--dur-2)',
  100: '100ms',
  150: '150ms',
  200: '200ms',
  300: '300ms',
  500: '500ms',
  700: '700ms',
  1000: '1000ms',
});

export const themeEasing = stylex.defineVars({
  pro: 'var(--ease)',
  linear: 'linear',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  out: 'cubic-bezier(0, 0, 0.2, 1)',
  'in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
});

/** The theme's shadows: the preset's `shadow-panel` and `shadow-popover`. */
export const themeShadow = stylex.defineVars({
  panel: 'var(--shadow-panel)',
  popover: 'var(--shadow-popover)',
  '2xs': '0 1px rgb(0 0 0 / 0.05)',
  xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  sm: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  default: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  none: 'none',
});

/**
 * The stacking scale. The theme's `--z-*` variables are the values Tailwind's
 * arbitrary z-index classes resolved to.
 */
export const themeZ = stylex.defineVars({
  editorDiffGutter: 'var(--z-editor-diff-gutter)',
  editorSelection: 'var(--z-editor-selection)',
  editorCursor: 'var(--z-editor-cursor)',
  editorCursorLabel: 'var(--z-editor-cursor-label)',
  editorHover: 'var(--z-editor-hover)',
  dialogOverlay: 'var(--z-dialog-overlay)',
  dialog: 'var(--z-dialog)',
  popover: 'var(--z-popover)',
  commandPalette: 'var(--z-command-palette)',
  tooltip: 'var(--z-tooltip)',
  imageViewer: 'var(--z-image-viewer)',
  toast: 'var(--z-toast)',
});
