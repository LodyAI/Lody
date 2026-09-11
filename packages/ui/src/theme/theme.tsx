import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { buttonPaletteTheme } from '../button/button.tokens.stylex';
import { fieldPaletteTheme } from '../field/field.tokens.stylex';
import { popupPaletteTheme } from '../popup/popup.tokens.stylex';
import { darkShadowTheme, darkTheme, lightShadowTheme, lightTheme } from '../tokens/colors.stylex';

export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * Every component token group that points at a semantic colour. These are
 * re-declared on the element carrying a forced palette so they resolve against
 * it; a group declared only at the document root keeps the root palette.
 */
const componentPaletteThemes = [buttonPaletteTheme, fieldPaletteTheme, popupPaletteTheme];

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

/**
 * The palette in force here, for content that will not be rendered here.
 *
 * A forced theme works by cascade: `ThemeRoot` declares the palette on its own
 * element and everything under it inherits. A popup breaks that, because it is
 * portalled out to the document and inherits the root palette instead — so a
 * light panel on a dark page opens a dark list. The subtree publishes which
 * palette it is under, and the parts that portal re-declare it on the element
 * they mount, which is the same fix the component token groups already make for
 * a custom property declared only at the root.
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
          mode !== 'system' && componentPaletteThemes,
          styles[mode]
        )}
      >
        {children}
      </div>
    </ForcedTheme.Provider>
  );
}
