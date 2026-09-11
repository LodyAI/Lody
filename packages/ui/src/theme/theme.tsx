import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
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
  return (stylex.props(...palette).className ?? '').split(' ').filter(Boolean);
}

/**
 * The palette in force here, for content that will not be rendered here.
 *
 * A forced theme works by cascade: `ThemeRoot` declares the palette on its own
 * element and everything under it inherits. A popup breaks that, because it is
 * portalled out to the document and inherits the root palette instead — so a
 * light panel on a dark page opens a dark list. The subtree publishes which
 * palette it is under, and the parts that portal re-declare the same semantic
 * colour and shadow themes on the element they mount.
 */
const ForcedTheme = createContext<ThemeMode>('system');

/**
 * The classes that reproduce the palette in force at this point in the tree,
 * for an element mounted outside it. Empty when nothing is forced, because then
 * the document already carries the palette the popup should use.
 */
export function useForcedThemeClassNames(): string[] {
  const mode = useContext(ForcedTheme);
  return useMemo(
    () => (mode === 'system' ? [] : [...forcedThemeClassNames(mode), colorSchemeClassName(mode)]),
    [mode]
  );
}

/** The `color-scheme` class `ThemeRoot` carries, so a portalled subtree matches. */
function colorSchemeClassName(mode: ThemeMode): string {
  return stylex.props(styles[mode]).className ?? '';
}

export function ThemeRoot({ mode, children }: { mode: ThemeMode; children: ReactNode }) {
  return (
    <ForcedTheme.Provider value={mode}>
      <div
        {...stylex.props(
          mode === 'dark' && darkTheme,
          mode === 'dark' && darkShadowTheme,
          mode === 'light' && lightTheme,
          mode === 'light' && lightShadowTheme,
          styles[mode]
        )}
      >
        {children}
      </div>
    </ForcedTheme.Provider>
  );
}
