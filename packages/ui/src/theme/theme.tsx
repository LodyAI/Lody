import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { buttonPaletteTheme } from '../button/button.tokens.stylex';
import { fieldPaletteTheme } from '../field/field.tokens.stylex';
import { darkShadowTheme, darkTheme, lightShadowTheme, lightTheme } from '../tokens/colors.stylex';

export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * Every component token group that points at a semantic colour. These are
 * re-declared on the element carrying a forced palette so they resolve against
 * it; a group declared only at the document root keeps the root palette.
 */
const componentPaletteThemes = [buttonPaletteTheme, fieldPaletteTheme];

const styles = stylex.create({
  system: { colorScheme: 'light dark' },
  light: { colorScheme: 'light' },
  dark: { colorScheme: 'dark' },
});

export function forcedThemeClassNames(mode: ThemeMode): string[] {
  if (mode === 'system') return [];
  const palette = mode === 'dark' ? [darkTheme, darkShadowTheme] : [lightTheme, lightShadowTheme];
  return (stylex.props(...palette, ...componentPaletteThemes).className ?? '')
    .split(' ')
    .filter(Boolean);
}

export function ThemeRoot({ mode, children }: { mode: ThemeMode; children: ReactNode }) {
  return (
    <div
      {...stylex.props(
        mode === 'dark' && darkTheme,
        mode === 'dark' && darkShadowTheme,
        mode === 'light' && lightTheme,
        mode === 'light' && lightShadowTheme,
        mode !== 'system' && componentPaletteThemes,
        styles[mode]
      )}
    >
      {children}
    </div>
  );
}
