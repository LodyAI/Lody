import { describe, expect, it } from 'vitest';
import { createLodyThemeCssVariables } from '../src/lib/vscode-theme/vscode-theme-css';
import type { LodyResolvedVSCodeTheme } from '../src/lib/vscode-theme/vscode-theme-schemas';
import { getBundledVSCodeThemeByIdSync } from '../src/lib/vscode-theme/bundled/bundled-vscode-themes';
import { hexColorToHslChannel } from '../src/lib/vscode-theme/vscode-theme-color';

const CHART_VARIABLES = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

// The `H S% L%` channel form the theme writes, back to RGB for distance checks.
const hslChannelToRgb = (channel: string): { r: number; g: number; b: number } => {
  const [h, s, l] = channel.split(' ').map((part) => Number.parseFloat(part));
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * (s / 100);
  const segment = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r1, g1, b1] =
    segment < 1
      ? [chroma, x, 0]
      : segment < 2
        ? [x, chroma, 0]
        : segment < 3
          ? [0, chroma, x]
          : segment < 4
            ? [0, x, chroma]
            : segment < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = lightness - chroma / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
};

const rgbDistance = (a: string, b: string): number => {
  const x = hslChannelToRgb(a);
  const y = hslChannelToRgb(b);
  return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2);
};

describe('vscode-theme-css', () => {
  const hslChannelLuminance = (channel: string): number => {
    const [h, s, l] = channel.split(' ').map((part) => Number.parseFloat(part));
    const sat = s / 100;
    const light = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const [r, g, b] = [0, 8, 4].map(
      (n) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    );
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
      expect(contrastRatio(variables['--syntax-comment']!, background!)).toBeGreaterThanOrEqual(
        3.5
      );
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

    it('derives five distinct, canvas-visible chart rungs from the active theme', () => {
      // A theme that reuses one accent for link/warning and omits terminal and
      // git colors cannot satisfy the rungs by lookup alone; the derivation
      // must still produce five series that do not collapse onto each other or
      // the page behind them.
      const minimal: LodyResolvedVSCodeTheme = {
        ...themeFixture,
        colors: {
          'editor.background': '#101010',
          'textLink.foreground': '#FFC799',
          'editorWarning.foreground': '#FFC799',
          'editorError.foreground': '#FF8080',
        },
      };
      const variables = createLodyThemeCssVariables(minimal);
      const rungs = CHART_VARIABLES.map((name) => variables[name]);
      expect(rungs.every((rung) => typeof rung === 'string')).toBe(true);

      const background = variables['--background']!;
      for (let i = 0; i < rungs.length; i += 1) {
        for (let j = i + 1; j < rungs.length; j += 1) {
          expect(
            rgbDistance(rungs[i]!, rungs[j]!),
            `rungs ${i + 1} and ${j + 1} collapse onto each other`
          ).toBeGreaterThanOrEqual(30);
        }
        // Every rung reads against the canvas, never sinks into it.
        expect(
          rgbDistance(rungs[i]!, background),
          `rung ${i + 1} blends into the canvas`
        ).toBeGreaterThanOrEqual(40);
      }
    });

    it('tracks the active VS Code theme instead of the stylesheet fallback', () => {
      for (const themeId of ['lody-light', 'vesper'] as const) {
        const theme = getBundledVSCodeThemeByIdSync(themeId);
        const variables = createLodyThemeCssVariables(theme!);
        for (const name of CHART_VARIABLES) {
          expect(variables[name], `${themeId} ${name}`).toBeDefined();
        }
      }
    });
  });
});

describe('vscode-theme-css-aliases', () => {
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
});
