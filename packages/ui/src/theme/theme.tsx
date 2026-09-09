import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { buttonPaletteTheme } from '../button/button.tokens.stylex';
import { darkShadowTheme, darkTheme, lightShadowTheme, lightTheme } from '../tokens/colors.stylex';

export type ThemeMode = 'system' | 'light' | 'dark';

const styles = stylex.create({
  system: { colorScheme: 'light dark' },
  light: { colorScheme: 'light' },
  dark: { colorScheme: 'dark' },
});

export function forcedThemeClassNames(mode: ThemeMode): string[] {
  if (mode === 'system') return [];
  const palette = mode === 'dark' ? [darkTheme, darkShadowTheme] : [lightTheme, lightShadowTheme];
  return (stylex.props(...palette, buttonPaletteTheme).className ?? '').split(' ').filter(Boolean);
}

export function ThemeRoot({ mode, children }: { mode: ThemeMode; children: ReactNode }) {
  return (
    <div
      {...stylex.props(
        mode === 'dark' && darkTheme,
        mode === 'dark' && darkShadowTheme,
        mode === 'light' && lightTheme,
        mode === 'light' && lightShadowTheme,
        mode !== 'system' && buttonPaletteTheme,
        styles[mode]
      )}
    >
      {children}
    </div>
  );
}
