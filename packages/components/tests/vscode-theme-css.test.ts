import { describe, expect, it } from 'vitest';
import { createLodyThemeCssVariables } from '../src/lib/vscode-theme/vscode-theme-css';
import {
  compositeHexColors,
  hexColorToHslChannel,
} from '../src/lib/vscode-theme/vscode-theme-color';
import type { LodyResolvedVSCodeTheme } from '../src/lib/vscode-theme/vscode-theme-schemas';
import { getBundledVSCodeThemeByIdSync } from '../src/lib/vscode-theme/bundled/bundled-vscode-themes';

const hslChannelLuminance = (channel: string): number => {
  const [h, s, l] = channel.split(' ').map((part) => Number.parseFloat(part));
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const [r, g, b] = [0, 8, 4].map((n) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrastRatio = (a: string, b: string): number => {
  const [dark, light] = [hslChannelLuminance(a), hslChannelLuminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
};

const themeFixture: LodyResolvedVSCodeTheme = {
  schemaVersion: 1,
  id: 'vesper-like',
  label: 'Vesper-like',
  type: 'dark',
  source: {
    kind: 'test-fixture',
  },
  colors: {
    'editor.background': '#101010',
    'editor.foreground': '#FFFFFF',
    'editorGroupHeader.tabsBackground': '#101010',
    'sideBar.background': '#101010',
    'sideBarTitle.foreground': '#A0A0A0',
    'sideBarSectionHeader.foreground': '#A0A0A0',
    'list.activeSelectionBackground': '#232323',
    'list.activeSelectionForeground': '#FFC799',
    'list.inactiveSelectionBackground': '#232323',
    'list.hoverBackground': '#282828',
    'input.background': '#1C1C1C',
    'tab.activeBackground': '#161616',
    'tab.activeBorder': '#FFC799',
    'tab.inactiveBackground': '#101010',
    'tab.hoverBackground': '#282828',
    'tab.activeForeground': '#FFFFFF',
    'tab.inactiveForeground': '#7E7E7E',
    'tab.border': '#101010',
    'button.background': '#FFC799',
    'button.foreground': '#000000',
    'button.hoverBackground': '#FFCFA8',
    'button.secondaryBackground': '#282A36',
    'button.secondaryForeground': '#F8F8F2',
    'button.secondaryHoverBackground': '#343746',
    'textLink.foreground': '#0000FF',
    'gitDecoration.addedResourceForeground': '#00FF00',
    'gitDecoration.deletedResourceForeground': '#FF0000',
    'gitDecoration.modifiedResourceForeground': '#FF00FF',
    'editorWarning.foreground': '#FFAA00',
    errorForeground: '#FF0000',
    focusBorder: '#FFC799',
    'scrollbarSlider.background': '#79797933',
    'scrollbarSlider.hoverBackground': '#646464B3',
    'scrollbarSlider.activeBackground': '#BFBFBF66',
  },
  tokenColors: [],
};

describe('createLodyThemeCssVariables', () => {
  it('maps sidebar and interaction aliases from VSCode workbench colors', () => {
    const variables = createLodyThemeCssVariables(themeFixture);
    const warmAccent = hexColorToHslChannel('#FFC799');
    const buttonForeground = hexColorToHslChannel('#000000');
    const sidebarForeground = hexColorToHslChannel('#A0A0A0');

    expect(variables['--background']).toBe('0 0% 6.3%');
    expect(variables['--hover']).toBe('0 0% 10.2%');
    expect(variables['--hover-foreground']).toBe('0 0% 100%');
    expect(variables['--highlight']).toBe(warmAccent);
    expect(variables['--highlight-foreground']).toBe(buttonForeground);
    expect(variables['--selection']).toBe('0 0% 13.7%');
    expect(variables['--selection-foreground']).toBe(warmAccent);
    expect(variables['--selection-inactive']).toBe('0 0% 13.7%');
    expect(variables['--selection-inactive-foreground']).toBe(warmAccent);
    expect(variables['--secondary']).toBe('0 0% 13.7%');
    expect(variables['--button-secondary']).toBe(hexColorToHslChannel('#282A36'));
    expect(variables['--button-secondary-foreground']).toBe(hexColorToHslChannel('#F8F8F2'));
    expect(variables['--button-secondary-hover']).toBe(hexColorToHslChannel('#343746'));
    expect(variables['--button-hover']).toBe(hexColorToHslChannel('#FFCFA8'));
    expect(variables['--input']).toBe(hexColorToHslChannel('#1C1C1C'));
    // The field fill keeps a dark theme's raised input.background; only a fill
    // recessed below the page (light themes) is lifted onto the page color.
    expect(variables['--input-field']).toBe(hexColorToHslChannel('#1C1C1C'));
    expect(variables['--tab-bar']).toBe('0 0% 6.3%');
    expect(variables['--tab-active']).toBe('0 0% 8.6%');
    expect(variables['--tab-active-foreground']).toBe('0 0% 100%');
    expect(variables['--tab-inactive']).toBe('0 0% 6.3%');
    expect(variables['--tab-inactive-foreground']).toBe('0 0% 49.4%');
    expect(variables['--tab-hover']).toBe('0 0% 15.7%');
    expect(variables['--tab-hover-foreground']).toBe('0 0% 100%');
    expect(variables['--tab-border']).toBe('0 0% 6.3%');
    expect(variables['--tab-active-accent']).toBe(warmAccent);
    expect(variables['--destructive']).toBe('0 100% 50%');
    expect(variables['--destructive-foreground']).toBe('0 0% 0%');
    expect(variables['--status-info']).toBe('240 100% 50%');
    expect(variables['--status-success']).toBe('120 100% 50%');
    expect(variables['--status-warning']).toBe('40 100% 50%');
    expect(variables['--status-danger']).toBe('0 100% 50%');
    expect(variables['--status-merged']).toBe('300 100% 50%');
    expect(variables['--sidebar-background']).toBe('0 0% 6.3%');
    expect(variables['--sidebar-foreground']).toBe('0 0% 100%');
    expect(variables['--sidebar-foreground-muted']).toBe('0 0% 62.7%');
    expect(variables['--sidebar-hover']).toBe('0 0% 15.7%');
    expect(variables['--sidebar-hover-foreground']).toBe(sidebarForeground);
    expect(variables['--sidebar-highlight']).toBe(warmAccent);
    expect(variables['--sidebar-highlight-foreground']).toBe(buttonForeground);
    expect(variables['--sidebar-primary']).toBe(warmAccent);
    expect(variables['--sidebar-selection']).toBe('0 0% 13.7%');
    expect(variables['--sidebar-selection-foreground']).toBe(warmAccent);
    expect(variables['--sidebar-ring']).toBe(warmAccent);
    expect(variables['--code-added']).toBe('120 100% 50%');
    expect(variables['--code-removed']).toBe('0 100% 50%');
    expect(variables['--modified-file']).toBe('300 100% 50%');
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

  it('falls back to neutral workbench surfaces when the theme does not define secondary button tokens', () => {
    const colorsWithoutSecondaryTokens = { ...themeFixture.colors };
    delete colorsWithoutSecondaryTokens['button.secondaryBackground'];
    delete colorsWithoutSecondaryTokens['button.secondaryForeground'];
    delete colorsWithoutSecondaryTokens['button.secondaryHoverBackground'];
    delete colorsWithoutSecondaryTokens['tab.activeBackground'];
    delete colorsWithoutSecondaryTokens['tab.activeForeground'];
    delete colorsWithoutSecondaryTokens['tab.activeBorder'];
    delete colorsWithoutSecondaryTokens['tab.inactiveBackground'];
    delete colorsWithoutSecondaryTokens['tab.inactiveForeground'];
    delete colorsWithoutSecondaryTokens['tab.hoverBackground'];
    delete colorsWithoutSecondaryTokens['tab.border'];
    delete colorsWithoutSecondaryTokens['scrollbarSlider.background'];
    delete colorsWithoutSecondaryTokens['scrollbarSlider.hoverBackground'];
    delete colorsWithoutSecondaryTokens['scrollbarSlider.activeBackground'];

    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: colorsWithoutSecondaryTokens,
    });

    expect(variables['--button-secondary']).toBe('0 0% 11%');
    expect(variables['--button-secondary-foreground']).toBe('0 0% 100%');
    expect(variables['--button-secondary-hover']).toBe('0 0% 15.7%');
    expect(variables['--tab-active']).toBe('0 0% 6.3%');
    expect(variables['--tab-active-foreground']).toBe('0 0% 100%');
    expect(variables['--tab-inactive']).toBe('0 0% 6.3%');
    expect(variables['--tab-inactive-foreground']).toBe('0 0% 62.7%');
    expect(variables['--tab-hover']).toBe('0 0% 15.7%');
    expect(variables['--tab-border']).toBe('0 0% 6.3%');
    expect(variables['--tab-active-accent']).toBe(hexColorToHslChannel('#FFC799'));
    expect(variables['--scrollbar-thumb']).toBe('0 0% 100%');
    expect(variables['--scrollbar-thumb-hover']).toBe('0 0% 100%');
    expect(variables['--scrollbar-thumb-active']).toBe('0 0% 100%');
  });

  it('uses list foreground for sidebar text before title-only colors', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors: {
        ...themeFixture.colors,
        'list.foreground': '#DDDDDD',
      },
    });

    expect(variables['--sidebar-foreground']).toBe(hexColorToHslChannel('#DDDDDD'));
    expect(variables['--sidebar-foreground-muted']).toBe(hexColorToHslChannel('#A0A0A0'));
  });

  it('uses untracked git decoration for additions when added decoration is missing', () => {
    const colors = { ...themeFixture.colors };
    delete colors['gitDecoration.addedResourceForeground'];
    colors['gitDecoration.untrackedResourceForeground'] = '#22CC66';

    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      colors,
    });

    expect(variables['--status-success']).toBe(hexColorToHslChannel('#22CC66'));
    expect(variables['--code-added']).toBe(hexColorToHslChannel('#22CC66'));
    expect(variables['--code-removed']).toBe(hexColorToHslChannel('#FF0000'));
  });

  it('resolves syntax colors with TextMate selector matching, not raw string prefixes', () => {
    const variables = createLodyThemeCssVariables({
      ...themeFixture,
      tokenColors: [
        { scope: ['comment', 'string.comment'], settings: { foreground: '#888888' } },
        { scope: 'keyword.operator', settings: { foreground: '#999999' } },
        { scope: 'string', settings: { foreground: '#AA3300' } },
        { scope: 'keyword', settings: { foreground: '#5500AA' } },
        { scope: 'constant.numeric.decimal', settings: { foreground: '#0066CC' } },
      ],
    });

    expect(variables['--syntax-comment']).toBe(hexColorToHslChannel('#888888'));
    expect(variables['--syntax-string']).toBe(hexColorToHslChannel('#AA3300'));
    expect(variables['--syntax-keyword']).toBe(hexColorToHslChannel('#5500AA'));
    // No rule for `constant.numeric` itself: fall back to a sub-scope's color.
    expect(variables['--syntax-number']).toBe(hexColorToHslChannel('#0066CC'));
  });

  it('keeps Lody Light code syntax at AA contrast on its code block background', () => {
    const theme = getBundledVSCodeThemeByIdSync('lody-light');
    expect(theme).toBeDefined();
    const variables = createLodyThemeCssVariables(theme!);
    const background = variables['--code-background'];
    expect(background).toBeDefined();

    for (const name of [
      '--syntax-string',
      '--syntax-keyword',
      '--syntax-number',
      '--syntax-function',
      '--syntax-variable',
      '--syntax-title',
      '--syntax-attr',
      '--syntax-builtin',
    ]) {
      expect({ name, ratio: contrastRatio(variables[name]!, background!) >= 4.5 }).toEqual({
        name,
        ratio: true,
      });
    }
    expect(contrastRatio(variables['--syntax-comment']!, background!)).toBeGreaterThanOrEqual(3.5);
  });
});
