import { describe, expect, it } from 'vitest';
import { createLodyThemeCssVariables } from '../src/lib/vscode-theme/vscode-theme-css';

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

// Dark themes hold every text foreground under the reading ceiling (13:1
// against the canvas): on the fixture's #101010, pure white becomes #D5D5D5.
const CEILED_ON_FIXTURE = '0 0% 83.5%';
const PROSE_ON_FIXTURE = '0 0% 88.2%';
// The #FFC799 accent used as selection text is already under the ceiling: unchanged.
const CEILED_ACCENT_ON_FIXTURE = '27.1 100% 80%';

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

  it('holds dark-theme text under the reading ceiling, with one stronger step', () => {
    // A pure-white theme that is not tuned by hand, so everything is derived.
    const variables = createLodyThemeCssVariables(themeFixture);
    const background = variables['--background']!;
    for (const name of ['--foreground', '--popover-foreground', '--sidebar-foreground']) {
      expect({ name, ok: contrastRatio(variables[name]!, background) <= 13 }).toEqual({
        name,
        ok: true,
      });
    }
    // Prose is one step above the interface text; headings one above prose,
    // still below pure white.
    const reading = contrastRatio(variables['--reading-foreground']!, background);
    expect(reading).toBeGreaterThan(13);
    expect(reading).toBeLessThanOrEqual(14.6);
    const strong = contrastRatio(variables['--foreground-strong']!, background);
    expect(strong).toBeGreaterThan(reading);
    expect(strong).toBeLessThanOrEqual(16.3);
    // The active tab reads at the prose level, never above it.
    expect(variables['--tab-active-foreground']).toBe(variables['--reading-foreground']);
    const sidebarRow = contrastRatio(
      variables['--sidebar-row-foreground']!,
      variables['--sidebar-background']!
    );
    expect(sidebarRow).toBeLessThanOrEqual(9.9);
    // The sidebar never outshines the reading column.
    expect(sidebarRow).toBeLessThan(reading);
  });

  it('leaves a theme whose text is already below the cap, and high-contrast themes, alone', () => {
    const soft = createLodyThemeCssVariables({
      ...themeFixture,
      type: 'dark',
      colors: { ...themeFixture.colors, 'editor.background': '#1E1E1E', foreground: '#C8C8C8' },
    });
    expect(soft['--reading-foreground']).toBeUndefined();

    const highContrast = createLodyThemeCssVariables({
      ...themeFixture,
      type: 'hcDark',
      colors: { ...themeFixture.colors, 'editor.background': '#000000', foreground: '#FFFFFF' },
    });
    expect(highContrast['--reading-foreground']).toBeUndefined();
  });
});
