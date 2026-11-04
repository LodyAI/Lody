import { describe, expect, it } from 'vitest';
import { createLodyThemeCssVariables } from '../src/lib/vscode-theme/vscode-theme-css';
import { hexColorToHslChannel } from '../src/lib/vscode-theme/vscode-theme-color';
import type { LodyResolvedVSCodeTheme } from '../src/lib/vscode-theme/vscode-theme-schemas';

const themeFixture: LodyResolvedVSCodeTheme = {
  schemaVersion: 1,
  id: 'vscode-scrollbar-fixture',
  label: 'VSCode Scrollbar Fixture',
  type: 'dark',
  source: {
    kind: 'test-fixture',
  },
  colors: {
    'editor.background': '#101010',
    'editor.foreground': '#FFFFFF',
    'sideBar.background': '#101010',
    'sideBar.foreground': '#A0A0A0',
    'button.background': '#FFC799',
    'button.foreground': '#000000',
    'list.activeSelectionBackground': '#232323',
    'list.activeSelectionForeground': '#FFC799',
    'scrollbarSlider.background': '#79797933',
    'scrollbarSlider.hoverBackground': '#646464B3',
    'scrollbarSlider.activeBackground': '#BFBFBF66',
  },
  tokenColors: [],
};

describe('VSCode theme aliases', () => {
  it('lifts a form field fill that the theme recesses below the page', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      type: 'light',
      colors: {
        ...themeFixture.colors,
        'editor.background': '#FFFFFF',
        'input.background': '#E8EAED',
        'input.border': '#D8DBE2',
      },
    });

    // `--input` keeps the theme's recessed slab (composer, muted chips) while
    // the editable field sits on the page so it cannot read as disabled.
    expect(variables['--input']).toBe(hexColorToHslChannel('#E8EAED'));
    expect(variables['--input-field']).toBe(hexColorToHslChannel('#FFFFFF'));
    expect(variables['--input-border']).toBe(hexColorToHslChannel('#D8DBE2'));
  });

  it('skips sidebar hover colors that are indistinguishable from the sidebar background', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#011627',
        'sideBar.background': '#011627',
        'list.hoverBackground': '#011627',
        'list.inactiveSelectionBackground': '#0E293F',
      },
    });

    expect(variables['--sidebar-hover']).toBe(hexColorToHslChannel('#0E293F'));
  });
});
