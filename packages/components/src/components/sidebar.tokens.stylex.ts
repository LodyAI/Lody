import * as stylex from '@stylexjs/stylex';

/**
 * The sidebar's inks and fills, read from the active theme's `--sidebar-*`
 * variables. The theme derives them (the dark brightness ceiling, Vesper's
 * deep-sea selection), so the tokens point at those variables rather than at
 * `@lody/ui`'s fixed palette: a row's resting ink is `--sidebar-row-foreground`,
 * which sits below the selected row's.
 */
export const sidebar = stylex.defineVars({
  rowText: 'hsl(var(--sidebar-row-foreground))',
  selectedText: 'hsl(var(--sidebar-selection-foreground))',
  mutedText: 'hsl(var(--sidebar-foreground-muted))',
  faintText: 'hsl(var(--sidebar-foreground-muted) / 0.7)',
  hoverFill: 'hsl(var(--sidebar-hover))',
  selectedFill: 'hsl(var(--sidebar-selection))',
});
