import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';

/**
 * `@lody/ui`'s semantic colours, read from the active VS Code theme.
 *
 * The package ships fixed light and dark palettes; the product instead derives
 * every colour from the theme (`vscode-theme-css.ts`), including the reading
 * brightness ceiling and the Vesper deep-sea surfaces. These themes point the
 * package's semantic tokens at those CSS variables, so a menu, a popover or a
 * settings row uses the same surfaces, ink and accent as the rest of the app.
 * Component token groups (`popup`, `button`, …) derive from `colors`, so they
 * follow without being restated.
 *
 * Only what the theme has no counterpart for keeps the package's value per
 * mode: wells, trays, the modal overlay and the gray ramp.
 */
export const productDarkPalette = stylex.createTheme(colors, {
  background: 'hsl(var(--background))',
  elevatedBackground: 'hsl(var(--card))',
  raisedBackground: 'hsl(var(--popover))',
  secondaryBackground: 'hsl(var(--card))',
  wellBackground: 'hsl(0 0% 0% / 0.28)',
  trayBackground: 'hsl(0 0% 100% / 0.06)',
  trayRaised: 'hsl(0 0% 21%)',
  label: 'hsl(var(--foreground))',
  secondaryLabel: 'hsl(var(--muted-foreground))',
  tertiaryLabel: 'color-mix(in oklab, hsl(var(--muted-foreground)), hsl(var(--background)) 30%)',
  separator: 'hsl(var(--border))',
  // The row fills the settings navigation and the sidebar footer use: a tint of
  // the theme's ink, so the selected row reads against the canvas it shares.
  hoverFill: 'hsl(var(--foreground) / 0.06)',
  selectedFill: 'hsl(var(--foreground) / 0.1)',
  accent: 'hsl(var(--primary))',
  onAccent: 'hsl(var(--primary-foreground))',
  destructive: 'hsl(var(--destructive))',
  onDestructive: 'hsl(var(--destructive-foreground))',
  success: 'hsl(var(--status-success))',
  warning: 'hsl(var(--status-warning))',
  overlay: 'hsl(0 0% 0% / 0.6)',
  gray: 'hsl(0 0% 42%)',
  gray2: 'hsl(0 0% 34%)',
  gray3: 'hsl(0 0% 27%)',
  gray4: 'hsl(0 0% 22%)',
  gray5: 'hsl(0 0% 18%)',
  gray6: 'hsl(0 0% 13.7%)',
});

export const productLightPalette = stylex.createTheme(colors, {
  background: 'hsl(var(--background))',
  elevatedBackground: 'hsl(var(--card))',
  raisedBackground: 'hsl(var(--popover))',
  secondaryBackground: 'hsl(var(--card))',
  wellBackground: 'hsl(225 10% 11% / 0.05)',
  trayBackground: 'hsl(225 10% 11% / 0.06)',
  trayRaised: 'hsl(0 0% 100%)',
  label: 'hsl(var(--foreground))',
  secondaryLabel: 'hsl(var(--muted-foreground))',
  tertiaryLabel: 'color-mix(in oklab, hsl(var(--muted-foreground)), hsl(var(--background)) 30%)',
  separator: 'hsl(var(--border))',
  hoverFill: 'hsl(var(--foreground) / 0.06)',
  selectedFill: 'hsl(var(--foreground) / 0.1)',
  accent: 'hsl(var(--primary))',
  onAccent: 'hsl(var(--primary-foreground))',
  destructive: 'hsl(var(--destructive))',
  onDestructive: 'hsl(var(--destructive-foreground))',
  success: 'hsl(var(--status-success))',
  warning: 'hsl(var(--status-warning))',
  overlay: 'hsl(225 7% 11% / 0.5)',
  gray: 'hsl(220 8% 62%)',
  gray2: 'hsl(220 9% 70%)',
  gray3: 'hsl(220 11% 78%)',
  gray4: 'hsl(222 13% 85%)',
  gray5: 'hsl(223 16% 91.6%)',
  gray6: 'hsl(220 23% 97.5%)',
});
