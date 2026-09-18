import { describe, expect, it } from 'vitest';
import { createLodyThemeCssVariables } from '../src/lib/vscode-theme/vscode-theme-css';
import {
  compositeHexColors,
  hexColorToHslChannel,
} from '../src/lib/vscode-theme/vscode-theme-color';
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
  it('prefers dedicated scrollbar tokens when the theme defines them', () => {
    const variables = createLodyThemeCssVariables(themeFixture);

    expect(variables['--scrollbar-thumb']).toBe(
      hexColorToHslChannel(compositeHexColors('#79797933', '#101010'))
    );
    expect(variables['--scrollbar-thumb-hover']).toBe(
      hexColorToHslChannel(compositeHexColors('#646464B3', '#101010'))
    );
    expect(variables['--scrollbar-thumb-active']).toBe(
      hexColorToHslChannel(compositeHexColors('#BFBFBF66', '#101010'))
    );
  });

  it('falls back to sidebar foreground when scrollbar tokens are missing', () => {
    const colorsWithoutScrollbarTokens = { ...themeFixture.colors };
    delete colorsWithoutScrollbarTokens['scrollbarSlider.background'];
    delete colorsWithoutScrollbarTokens['scrollbarSlider.hoverBackground'];
    delete colorsWithoutScrollbarTokens['scrollbarSlider.activeBackground'];

    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: colorsWithoutScrollbarTokens,
    });

    expect(variables['--scrollbar-thumb']).toBe('0 0% 62.7%');
    expect(variables['--scrollbar-thumb-hover']).toBe('0 0% 62.7%');
    expect(variables['--scrollbar-thumb-active']).toBe('0 0% 62.7%');
  });

  it('skips fully transparent candidates and composites translucent aliases over their base surface', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      type: 'light',
      colors: {
        ...themeFixture.colors,
        'editor.background': '#FAF4ED',
        'sideBar.background': '#FAF4ED',
        'panel.background': '#FFFAF3',
        'editorWidget.background': '#FFFAF3',
        'sideBarSectionHeader.background': '#0000',
        'sideBarSectionHeader.border': '#6E6A8614',
        'list.activeSelectionBackground': '#6E6A8614',
        'list.hoverBackground': '#6E6A860D',
        'list.inactiveSelectionBackground': '#FFFAF3',
        'tab.activeBackground': '#6E6A860D',
        'tab.hoverBackground': '#6E6A8614',
        'tab.border': '#0000',
        'editorGroup.border': '#0000',
        'panel.border': '#0000',
        'editorWidget.border': '#F2E9E1',
        'dropdown.border': '#6E6A8614',
        'scrollbarSlider.background': '#6E6A8614',
        'scrollbarSlider.hoverBackground': '#6E6A8626',
        'scrollbarSlider.activeBackground': '#28698380',
      },
    });

    expect(variables['--muted']).toBe(hexColorToHslChannel('#FFFAF3'));
    expect(variables['--hover']).toBe('30 28.6% 91.8%');
    expect(variables['--highlight']).toBe(hexColorToHslChannel('#FFC799'));
    expect(variables['--selection']).toBe(
      hexColorToHslChannel(compositeHexColors('#6E6A8614', '#FAF4ED'))
    );
    expect(variables['--tab-active']).toBe(
      hexColorToHslChannel(compositeHexColors('#6E6A860D', '#FAF4ED'))
    );
    expect(variables['--border']).toBe(hexColorToHslChannel('#F2E9E1'));
    expect(variables['--scrollbar-thumb']).toBe(
      hexColorToHslChannel(compositeHexColors('#6E6A8614', '#FAF4ED'))
    );
  });

  it('uses dedicated VS Code input tokens for form control colors', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#101010',
        'input.background': '#1A1A1A',
        'input.foreground': '#EEEEEE',
        'input.placeholderForeground': '#777777',
        'input.border': '#3A3A3A',
        'editorWidget.border': '#444444',
      },
    });

    expect(variables['--input']).toBe(hexColorToHslChannel('#1A1A1A'));
    expect(variables['--input-foreground']).toBe(hexColorToHslChannel('#EEEEEE'));
    expect(variables['--input-placeholder']).toBe(hexColorToHslChannel('#777777'));
    expect(variables['--input-border']).toBe(hexColorToHslChannel('#3A3A3A'));
    expect(variables['--input-field']).toBe(hexColorToHslChannel('#1A1A1A'));
  });

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

  it('falls back to widget backgrounds and borders when input tokens are absent', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editorWidget.background': '#1C1C1C',
        'editorHoverWidget.border': '#282828',
      },
    });

    expect(variables['--input']).toBe(hexColorToHslChannel('#1C1C1C'));
    expect(variables['--input-border']).toBe(hexColorToHslChannel('#282828'));
  });

  it('uses the dedicated sidebar border while keeping shared card borders panel-owned', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      type: 'light',
      colors: {
        ...themeFixture.colors,
        'editor.background': '#FBFBFB',
        'sideBar.background': '#F0F0F0',
        'panel.background': '#F0F0F0',
        'editorWidget.background': '#F0F0F0',
        'sideBar.border': '#F0F0F0',
        'panel.border': '#D9D9D9',
        'editorWidget.border': '#D9D9D9',
        'dropdown.border': '#D9D9D9',
      },
    });

    expect(variables['--border']).toBe(hexColorToHslChannel('#D9D9D9'));
    expect(variables['--sidebar-border']).toBe(hexColorToHslChannel('#F0F0F0'));
  });

  it('falls back to editor hover widget borders for sidebar borders when sidebar border tokens are absent', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editorHoverWidget.border': '#282828',
      },
    });

    expect(variables['--sidebar-border']).toBe(hexColorToHslChannel('#282828'));
  });

  it('maps hover and selection aliases to their matching VSCode list concepts', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#FAF4ED',
        'sideBar.background': '#FAF4ED',
        'list.focusBackground': '#6E6A8626',
        'list.focusForeground': '#575279',
        'list.activeSelectionBackground': '#6E6A8614',
        'list.activeSelectionForeground': '#575279',
        'list.inactiveSelectionBackground': '#FFFAF3',
        'list.hoverBackground': '#6E6A860D',
        'list.hoverForeground': '#6E6A86',
      },
    });

    expect(variables['--hover']).toBe('30 54.5% 95.7%');
    expect(variables['--hover-foreground']).toBe(hexColorToHslChannel('#6E6A86'));
    expect(variables['--highlight']).toBe(hexColorToHslChannel('#FFC799'));
    expect(variables['--highlight-foreground']).toBe(hexColorToHslChannel('#000000'));
    expect(variables['--selection']).toBe(
      hexColorToHslChannel(compositeHexColors('#6E6A8614', '#FAF4ED'))
    );
    expect(variables['--selection-foreground']).toBe(hexColorToHslChannel('#575279'));
    expect(variables['--selection-inactive']).toBe(hexColorToHslChannel('#FFFAF3'));
    expect(variables['--sidebar-hover']).toBe(
      hexColorToHslChannel(compositeHexColors('#6E6A860D', '#FAF4ED'))
    );
    expect(variables['--sidebar-hover-foreground']).toBe(hexColorToHslChannel('#6E6A86'));
    expect(variables['--sidebar-highlight']).toBe(hexColorToHslChannel('#FFC799'));
    expect(variables['--sidebar-highlight-foreground']).toBe(hexColorToHslChannel('#000000'));
    expect(variables['--sidebar-selection']).toBe(
      hexColorToHslChannel(compositeHexColors('#6E6A8614', '#FAF4ED'))
    );
    expect(variables['--sidebar-selection-foreground']).toBe(hexColorToHslChannel('#575279'));
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

  it('uses VS Code text code block and border tokens for markdown code aliases', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#011627',
        'sideBar.background': '#011627',
        'textCodeBlock.background': '#4F4F4F',
        'input.border': '#5F7E97',
      },
    });

    expect(variables['--code-background']).toBe(hexColorToHslChannel('#4F4F4F'));
    expect(variables['--code-border']).toBe(hexColorToHslChannel('#5F7E97'));
  });

  it('falls back to editor hover widget borders for markdown code aliases', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#101010',
        'editorWidget.background': '#101010',
        'editorHoverWidget.border': '#282828',
      },
    });

    expect(variables['--code-border']).toBe(hexColorToHslChannel('#282828'));
  });

  it('does not synthesize markdown code borders when the theme has no border token', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#101010',
      },
    });

    expect(variables['--code-border']).toBeUndefined();
  });

  it('uses VS Code default text code block backgrounds when the theme omits the token', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#011627',
      },
    });

    expect(variables['--code-background']).toBe(
      hexColorToHslChannel(compositeHexColors('#0A0A0A66', '#011627'))
    );
  });

  it('keeps explicit text code block backgrounds even when they match the editor surface', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#121212',
        'textCodeBlock.background': '#121212',
        'input.background': '#181818',
      },
    });

    expect(variables['--code-background']).toBe(hexColorToHslChannel('#121212'));
  });

  it('keeps list active selection ahead of editor selection fallbacks', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'editor.background': '#282C34',
        'sideBar.background': '#282C34',
        'list.focusBackground': '#323842',
        'list.activeSelectionBackground': '#2C313A',
        'list.inactiveSelectionBackground': '#323842',
        'list.hoverBackground': '#2C313A',
        'editor.selectionBackground': '#67769660',
      },
    });

    expect(variables['--selection']).toBe(hexColorToHslChannel('#2C313A'));
    expect(variables['--sidebar-selection']).toBe(hexColorToHslChannel('#2C313A'));
  });

  it('maps destructive actions from VSCode error tokens', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        errorForeground: '#403F53',
        'editorError.foreground': '#FF8080',
      },
    });

    expect(variables['--destructive']).toBe(hexColorToHslChannel('#FF8080'));
    expect(variables['--destructive-foreground']).toBe(hexColorToHslChannel('#000000'));
  });
});
