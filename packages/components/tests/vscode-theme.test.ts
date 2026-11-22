import { describe, expect, it } from 'vitest';
import {
  createLodyThemeCssVariables,
  getBundledVSCodeThemeById,
  hexColorToHslChannel,
  hexColorToRgb,
  isSelectableBundledVSCodeThemeId,
  resolveBundledVSCodeThemes,
  resolveBundledVSCodeThemesFromExtensions,
  resolveVSCodeTheme,
  type VSCodeThemeFileReader,
  createVSCodeTerminalTheme,
  type LodyResolvedVSCodeTheme,
} from '../src/lib/vscode-theme';

describe('vscode-theme', () => {
  const createMapReader =
    (files: Record<string, string>): VSCodeThemeFileReader =>
    (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`Fixture file not found: ${path}`);
      }
      return content;
    };

  const relativeLuminance = (color: string): number => {
    const { r, g, b } = hexColorToRgb(color);
    const linearize = (channel: number) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  };

  const hslChannelToRgb = (channel: string | undefined): { r: number; g: number; b: number } => {
    const match = channel?.match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
    if (!match) throw new Error(`Not an HSL channel: ${channel}`);
    const h = ((Number(match[1]) % 360) + 360) % 360;
    const s = Number(match[2]) / 100;
    const l = Number(match[3]) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60
        ? [c, x, 0]
        : h < 120
          ? [x, c, 0]
          : h < 180
            ? [0, c, x]
            : h < 240
              ? [0, x, c]
              : h < 300
                ? [x, 0, c]
                : [c, 0, x];
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  };

  describe('VSCode theme adapter', () => {
    it('rejects paths that escape the extension root', async () => {
      await expect(
        resolveVSCodeTheme({
          id: 'escape',
          label: 'Escape',
          uiTheme: 'vs-dark',
          path: '../outside.json',
          source: { kind: 'test-fixture' },
          readFile: createMapReader({}),
        })
      ).rejects.toThrow(/escapes extension root/);
    });

    it('exposes only the product theme shortlist in selectors', async () => {
      const themes = await resolveBundledVSCodeThemes();

      expect(
        themes
          .filter((theme) => isSelectableBundledVSCodeThemeId(theme.id))
          .map((theme) => theme.id)
      ).toEqual(['lody-light', 'vesper']);
    });

    it('gives Lody Light legible muted text and recessed panels', async () => {
      const lightnessOf = (channel: string | undefined): number => {
        const match = channel?.match(/^-?[\d.]+\s+[\d.]+%\s+([\d.]+)%$/);
        if (!match) throw new Error(`Not an HSL channel: ${channel}`);
        return Number(match[1]);
      };

      const light = await getBundledVSCodeThemeById('lody-light');
      if (!light) throw new Error('Expected lody-light to be bundled');
      const vars = createLodyThemeCssVariables(light);
      const backgroundL = lightnessOf(vars['--background']);

      // Secondary text clears a readable gap; recessed chips sit below the gray
      // canvas. These come straight from the theme (no runtime floor), so a
      // regression in lody-light.json is caught here.
      expect(backgroundL - lightnessOf(vars['--muted-foreground'])).toBeGreaterThanOrEqual(46);
      expect(backgroundL - lightnessOf(vars['--input'])).toBeGreaterThanOrEqual(2);
      expect(backgroundL - lightnessOf(vars['--muted'])).toBeGreaterThanOrEqual(2);
      expect(backgroundL - lightnessOf(vars['--border'])).toBeGreaterThanOrEqual(4);

      // …but an editable control does NOT recess: a gray field on a light canvas
      // reads as disabled. It sits on the page color and is delimited by
      // `--input-border` instead.
      expect(lightnessOf(vars['--input-field'])).toBe(backgroundL);
      expect(backgroundL - lightnessOf(vars['--input-border'])).toBeGreaterThanOrEqual(6);
    });

    it('never draws a form field darker than the page it sits on', async () => {
      const lightnessOf = (channel: string | undefined): number => {
        const match = channel?.match(/^-?[\d.]+\s+[\d.]+%\s+([\d.]+)%$/);
        if (!match) throw new Error(`Not an HSL channel: ${channel}`);
        return Number(match[1]);
      };

      for (const theme of await resolveBundledVSCodeThemes()) {
        const vars = createLodyThemeCssVariables(theme);
        expect(lightnessOf(vars['--input-field']), theme.id).toBeGreaterThanOrEqual(
          lightnessOf(vars['--background'])
        );
        // Dark themes keep the raised `input.background` they already ship.
        expect(lightnessOf(vars['--input-field']), theme.id).toBeGreaterThanOrEqual(
          lightnessOf(vars['--input'])
        );
      }
    });

    it('keeps selectable sidebars visibly offset from the main background', async () => {
      const themes = (await resolveBundledVSCodeThemes()).filter((theme) =>
        isSelectableBundledVSCodeThemeId(theme.id)
      );

      for (const theme of themes) {
        const editor = hexColorToRgb(theme.colors['editor.background'] ?? '');
        const sidebar = hexColorToRgb(theme.colors['sideBar.background'] ?? '');
        const sidebarBorderColor = theme.colors['sideBar.border'] ?? '';
        const editorBrightness = editor.r + editor.g + editor.b;
        const sidebarBrightness = sidebar.r + sidebar.g + sidebar.b;
        const rgbDistance = Math.hypot(
          sidebar.r - editor.r,
          sidebar.g - editor.g,
          sidebar.b - editor.b
        );
        const sidebarLuminance = relativeLuminance(theme.colors['sideBar.background'] ?? '');
        const borderLuminance = relativeLuminance(sidebarBorderColor);
        const borderContrast =
          (Math.max(sidebarLuminance, borderLuminance) + 0.05) /
          (Math.min(sidebarLuminance, borderLuminance) + 0.05);
        const variables = createLodyThemeCssVariables(theme);

        expect(rgbDistance, theme.id).toBeGreaterThanOrEqual(10);
        expect(borderContrast, theme.id).toBeGreaterThanOrEqual(1.2);
        expect(variables['--sidebar-border'], theme.id).toBe(
          hexColorToHslChannel(sidebarBorderColor)
        );
        if (theme.type === 'light' || theme.type === 'hcLight') {
          // Light conversation canvas is the brighter pane so attention stays
          // there; the sidebar sits a clearly darker step.
          expect(sidebarBrightness, theme.id).toBeLessThan(editorBrightness);
          expect(editorBrightness - sidebarBrightness, theme.id).toBeGreaterThanOrEqual(14);
        } else {
          expect(sidebarBrightness, theme.id).toBeGreaterThan(editorBrightness);
        }
      }
    });

    it('keeps sidebar hover visibly distinct from the sidebar surface', async () => {
      const themes = (await resolveBundledVSCodeThemes()).filter((theme) =>
        isSelectableBundledVSCodeThemeId(theme.id)
      );

      for (const theme of themes) {
        const variables = createLodyThemeCssVariables(theme);
        const background = hslChannelToRgb(variables['--sidebar-background']);
        const hover = hslChannelToRgb(variables['--sidebar-hover']);
        const distance = Math.hypot(
          hover.r - background.r,
          hover.g - background.g,
          hover.b - background.b
        );

        // Chrome like workspace / settings / archive / filter must read as
        // hovered; 20 RGB units matches the selection floor so light mode
        // does not wash the fill into the sidebar.
        expect(distance, theme.id).toBeGreaterThanOrEqual(20);
      }
    });

    it('keeps sidebar selection visibly distinct from the sidebar surface', async () => {
      const themes = (await resolveBundledVSCodeThemes()).filter((theme) =>
        isSelectableBundledVSCodeThemeId(theme.id)
      );

      for (const theme of themes) {
        const variables = createLodyThemeCssVariables(theme);
        const background = hslChannelToRgb(variables['--sidebar-background']);
        const selection = hslChannelToRgb(variables['--sidebar-selection']);
        const distance = Math.hypot(
          selection.r - background.r,
          selection.g - background.g,
          selection.b - background.b
        );

        // The active sidebar row ("New chat", selected task) must read as
        // selected at a glance; 20 RGB units is a visibly distinct step on both
        // light and dark surfaces.
        expect(distance, theme.id).toBeGreaterThanOrEqual(20);
      }
    });

    it('keeps valid bundled themes when one bundled theme fails to parse', () => {
      const warnings: unknown[] = [];
      const themes = resolveBundledVSCodeThemesFromExtensions(
        [
          {
            extensionId: 'publisher.broken-theme',
            extensionVersion: '1.0.0',
            manifest: {
              name: 'broken-theme',
              version: '1.0.0',
              contributes: {
                themes: [
                  {
                    label: 'Broken Theme',
                    uiTheme: 'vs-dark',
                    path: './themes/broken.json',
                  },
                ],
              },
            },
            files: {
              'themes/broken.json': `{
              "colors": {
                "editor.background": "red"
              }
            }`,
            },
          },
          {
            extensionId: 'publisher.valid-theme',
            extensionVersion: '1.0.0',
            manifest: {
              name: 'valid-theme',
              version: '1.0.0',
              contributes: {
                themes: [
                  {
                    label: 'Valid Theme',
                    uiTheme: 'vs-dark',
                    path: './themes/valid.json',
                  },
                ],
              },
            },
            files: {
              'themes/valid.json': `{
              "colors": {
                "editor.background": "#101010",
                "editor.foreground": "#FFFFFF"
              },
              "tokenColors": []
            }`,
            },
            themeIdsByLabel: {
              'Valid Theme': 'valid-theme',
            },
          },
        ],
        (warning) => {
          warnings.push(warning);
        }
      );

      expect(themes).toEqual([
        expect.objectContaining({
          id: 'valid-theme',
          label: 'Valid Theme',
        }),
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        extensionId: 'publisher.broken-theme',
        themeLabel: 'Broken Theme',
        themeId: 'publisher.broken-theme.broken-theme',
      });
    });
  });

  describe('Highlights VS Code theme adaptation', () => {
    it('preserves the active editor palette and keyword/comment styles in actual tokens', async () => {
      const { toHighlightsTheme, registerLodyVSCodeThemeForDiffs } =
        await import('../src/lib/vscode-theme/vscode-theme-shiki');
      const { codeToTokens } = await import('@pierre/highlights');
      const { resolveTheme } = await import('@pierre/diffs');
      const theme = await resolveVSCodeTheme({
        id: 'highlights-test',
        label: 'Highlights test',
        path: 'theme.json',
        uiTheme: 'vs-dark',
        source: { kind: 'test-fixture' },
        readFile: createMapReader({
          'theme.json': JSON.stringify({
            colors: { 'editor.foreground': '#eeeeee', 'editor.background': '#111111' },
            tokenColors: [
              { scope: 'keyword', settings: { foreground: '#ff0000' } },
              { scope: 'comment', settings: { foreground: '#00ff00', fontStyle: 'italic' } },
            ],
          }),
        }),
      });
      const palette = toHighlightsTheme(theme);
      const result = codeToTokens('return 42;\n// comment', { lang: 'typescript', theme: palette });
      expect(result.fg).toBe('#eeeeee');
      expect(result.bg).toBe('#111111');
      expect(result.tokens[0]?.find((token) => token.content.trim() === 'return')?.color).toBe(
        '#ff0000'
      );
      expect(result.tokens[1]?.[0]).toMatchObject({ color: '#00ff00', fontStyle: 1 });
      const name = await registerLodyVSCodeThemeForDiffs(theme);
      expect(name).toBeDefined();
      expect((await resolveTheme(name!, 'highlights')).zed).toEqual(palette);
      expect((await resolveTheme(name!, 'shiki-js')).textmate?.fg?.toLowerCase()).toBe('#eeeeee');
    });
  });
});

describe('vscode-terminal-theme', () => {
  const theme: LodyResolvedVSCodeTheme = {
    schemaVersion: 1,
    id: 'terminal-fixture',
    label: 'Terminal Fixture',
    type: 'dark',
    source: { kind: 'test-fixture' },
    colors: {
      'editor.background': '#101010',
      'editor.foreground': '#FFFFFF',
      'terminal.ansiRed': '#FF8080',
      'terminal.ansiBrightRed': '#FFA198',
      'terminal.background': '#000000',
      'terminal.foreground': '#EEEEEE',
    },
    tokenColors: [],
  };

  const themeWithoutTerminalPalette: LodyResolvedVSCodeTheme = {
    schemaVersion: 1,
    id: 'terminal-fallback-fixture',
    label: 'Terminal Fallback Fixture',
    type: 'dark',
    source: { kind: 'test-fixture' },
    colors: {
      'editor.background': '#101010',
      'editor.foreground': '#FFFFFF',
      'input.background': '#1C1C1C',
    },
    tokenColors: [],
  };

  describe('VSCode terminal theme adapter', () => {
    it('creates terminal container styles and preserves explicit ANSI colors while filling readable fallbacks', () => {
      const terminalTheme = createVSCodeTerminalTheme(theme);

      expect(terminalTheme?.containerStyle).toEqual({
        backgroundColor: '#000000',
        color: '#EEEEEE',
      });
      expect(terminalTheme?.palette['ansi-red']).toBe('#FF8080');
      expect(terminalTheme?.palette['ansi-bright-red']).toBe('#FFA198');
      expect(terminalTheme?.palette['ansi-black']).not.toBe('rgb(0, 0, 0)');
      expect(Object.keys(terminalTheme?.palette ?? {})).toHaveLength(16);
    });

    it('derives readable fallback ANSI colors when a VSCode theme omits terminal palette tokens', () => {
      const terminalTheme = createVSCodeTerminalTheme(themeWithoutTerminalPalette);

      expect(terminalTheme?.containerStyle).toEqual({
        backgroundColor: '#1C1C1C',
        color: '#FFFFFF',
      });
      expect(terminalTheme?.palette['ansi-black']).not.toBe('rgb(0, 0, 0)');
      expect(terminalTheme?.palette['ansi-blue']).not.toBe('rgb(0, 0, 187)');
      expect(terminalTheme?.palette['ansi-white']).toBe('rgb(187, 187, 187)');

      const background = parseRgb('#1C1C1C');
      const blackContrast = getContrastRatio(
        parseRgb(terminalTheme?.palette['ansi-black']),
        background
      );
      const blueContrast = getContrastRatio(
        parseRgb(terminalTheme?.palette['ansi-blue']),
        background
      );

      expect(blackContrast).toBeGreaterThanOrEqual(4.5);
      expect(blueContrast).toBeGreaterThanOrEqual(4.5);
    });
  });

  const parseRgb = (color: string | undefined) => {
    expect(color).toBeTruthy();
    const trimmed = color!.trim();

    if (trimmed.startsWith('#')) {
      const hex = trimmed.slice(1);
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }

    const match = trimmed.match(/^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/);
    expect(match).toBeTruthy();
    return {
      r: Number.parseInt(match![1], 10),
      g: Number.parseInt(match![2], 10),
      b: Number.parseInt(match![3], 10),
    };
  };

  const getContrastRatio = (
    first: { r: number; g: number; b: number },
    second: { r: number; g: number; b: number }
  ) => {
    const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
    const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  };

  const relativeLuminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const [red, green, blue] = [r, g, b].map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
});
