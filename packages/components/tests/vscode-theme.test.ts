import { describe, expect, it } from 'vitest';
import {
  createLodyThemeCssVariables,
  createThemeCssVariables,
  createVSCodeThemeCssVariables,
  getBundledVSCodeThemeByIdSync,
  getCachedBundledVSCodeThemeById,
  getBundledVSCodeThemeById,
  hexColorToHslChannel,
  hexColorToRgb,
  isSelectableBundledVSCodeThemeId,
  parseVSCodeExtensionManifest,
  resolveBundledVSCodeThemes,
  resolveBundledVSCodeThemesFromExtensions,
  resolveVSCodeTheme,
  toShikiTheme,
  type VSCodeThemeFileReader,
} from '../src/lib/vscode-theme';
import { claudeSyntaxTheme } from '../src/lib/claude-syntax-theme';

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
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
};

describe('VSCode theme adapter', () => {
  it('parses manifest theme contributions through a narrow schema', () => {
    const manifest = parseVSCodeExtensionManifest({
      name: 'fixture-theme',
      version: '1.2.3',
      contributes: {
        themes: [
          {
            label: 'Fixture Dark',
            uiTheme: 'vs-dark',
            path: './themes/dark.json',
            unknownExtensionField: true,
          },
        ],
      },
    });

    expect(manifest.contributes?.themes).toEqual([
      expect.objectContaining({
        label: 'Fixture Dark',
        uiTheme: 'vs-dark',
        path: './themes/dark.json',
      }),
    ]);
  });

  it('resolves JSONC themes, includes base themes, and validates the strict runtime model', async () => {
    const theme = await resolveVSCodeTheme({
      id: 'fixture-dark',
      label: 'Fixture Dark',
      uiTheme: 'vs-dark',
      path: './themes/dark.json',
      source: { kind: 'test-fixture', extensionId: 'publisher.fixture-theme' },
      readFile: createMapReader({
        'themes/base.json': `{
          // Comments and trailing commas are valid VSCode theme JSONC.
          "colors": {
            "editor.background": "#000000",
            "editor.foreground": "#EEEEEE",
            "button.background": "#00AAFF",
          },
          "tokenColors": [
            {
              "scope": "comment.line",
              "settings": {
                "foreground": "#777777",
              },
            },
          ],
        }`,
        'themes/dark.json': `{
          "include": "./base.json",
          "colors": {
            "editor.background": "#121314",
            "editor.foreground": "default",
            "terminal.ansiGreen": "#0DBC79",
          },
          "tokenColors": [
            {
              "name": "Strings",
              "scope": ["string.quoted", "constant.character"],
              "settings": {
                "foreground": "#89D185",
                "fontStyle": "italic"
              }
            }
          ],
          "semanticTokenColors": {
            "variable.readonly": "#FFCC00"
          }
        }`,
      }),
    });

    expect(theme).toMatchObject({
      schemaVersion: 1,
      id: 'fixture-dark',
      label: 'Fixture Dark',
      type: 'dark',
      colors: {
        'button.background': '#00AAFF',
        'editor.background': '#121314',
        'terminal.ansiGreen': '#0DBC79',
      },
    });
    expect(theme.colors).not.toHaveProperty('editor.foreground');
    expect(theme.tokenColors).toHaveLength(2);
    expect(theme.semanticTokenColors).toEqual({ 'variable.readonly': '#FFCC00' });
  });

  it('creates raw VSCode variables, Lody HSL aliases, and Prism-compatible syntax aliases', async () => {
    const theme = await resolveVSCodeTheme({
      id: 'fixture-dark',
      label: 'Fixture Dark',
      uiTheme: 'vs-dark',
      path: 'dark.json',
      source: { kind: 'test-fixture' },
      readFile: createMapReader({
        'dark.json': `{
          "colors": {
            "editor.background": "#121314",
            "editor.foreground": "#BBBEBF",
            "focusBorder": "#3994BCB3"
          },
          "tokenColors": [
            {
              "scope": "comment",
              "settings": { "foreground": "#6A9955" }
            }
          ]
        }`,
      }),
    });

    expect(createVSCodeThemeCssVariables(theme)).toMatchObject({
      '--vscode-editor-background': '#121314',
      '--vscode-focusBorder': '#3994BCB3',
    });
    expect(createLodyThemeCssVariables(theme)).toMatchObject({
      '--background': '210 5.3% 7.5%',
      '--foreground': '195 3% 74.1%',
      '--ring': '198.1 50.8% 35.9%',
      '--syntax-comment': '101.5 28.6% 46.7%',
    });
    expect(createThemeCssVariables(theme)['--vscode-editor-foreground']).toBe('#BBBEBF');
  });

  it('bridges markdown Prism token styles through VSCode-derived syntax variables', async () => {
    const theme = await resolveVSCodeTheme({
      id: 'fixture-markdown',
      label: 'Fixture Markdown',
      uiTheme: 'vs-dark',
      path: 'markdown.json',
      source: { kind: 'test-fixture' },
      readFile: createMapReader({
        'markdown.json': `{
          "colors": {
            "editor.background": "#101010",
            "editor.foreground": "#FFFFFF"
          },
          "tokenColors": [
            {
              "scope": "keyword.control",
              "settings": { "foreground": "#FF0000" }
            },
            {
              "scope": "entity.name.function.ts",
              "settings": { "foreground": "#00FF00" }
            }
          ]
        }`,
      }),
    });

    expect(createLodyThemeCssVariables(theme)).toMatchObject({
      '--syntax-keyword': '0 100% 50%',
      '--syntax-function': '120 100% 50%',
    });
    expect(claudeSyntaxTheme.keyword).toMatchObject({
      color: 'hsl(var(--syntax-keyword))',
    });
    expect(claudeSyntaxTheme.function).toMatchObject({
      color: 'hsl(var(--syntax-function))',
    });
  });

  it('converts resolved themes to Shiki theme registrations for @pierre/diffs', async () => {
    const theme = await resolveVSCodeTheme({
      id: 'fixture-dark',
      label: 'Fixture Dark',
      uiTheme: 'vs-dark',
      path: 'dark.json',
      source: { kind: 'test-fixture' },
      readFile: createMapReader({
        'dark.json': `{
          "colors": {
            "editor.background": "#101010",
            "editor.foreground": "#FFFFFF",
            "gitDecoration.addedResourceForeground": "#99FFE4"
          },
          "tokenColors": [
            {
              "scope": "keyword",
              "settings": { "foreground": "#FFC799", "fontStyle": "bold" }
            }
          ]
        }`,
      }),
    });

    expect(toShikiTheme(theme, 'lody-test')).toMatchObject({
      name: 'lody-test',
      type: 'dark',
      fg: '#FFFFFF',
      bg: '#101010',
      colors: {
        'gitDecoration.addedResourceForeground': '#99FFE4',
      },
      settings: [
        {
          settings: {
            foreground: '#FFFFFF',
            background: '#101010',
          },
        },
        {
          scope: 'keyword',
          settings: {
            foreground: '#FFC799',
            fontStyle: 'bold',
          },
        },
      ],
    });
  });

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

  it('detects include cycles', async () => {
    await expect(
      resolveVSCodeTheme({
        id: 'cycle',
        label: 'Cycle',
        uiTheme: 'vs-dark',
        path: 'a.json',
        source: { kind: 'test-fixture' },
        readFile: createMapReader({
          'a.json': `{ "include": "./b.json" }`,
          'b.json': `{ "include": "./a.json" }`,
        }),
      })
    ).rejects.toThrow(/include cycle/);
  });

  it('fails fast for invalid runtime colors and external tokenColors files', async () => {
    await expect(
      resolveVSCodeTheme({
        id: 'bad-color',
        label: 'Bad Color',
        uiTheme: 'vs-dark',
        path: 'bad.json',
        source: { kind: 'test-fixture' },
        readFile: createMapReader({ 'bad.json': `{ "colors": { "editor.background": "red" } }` }),
      })
    ).rejects.toThrow(/Expected hex color/);

    await expect(
      resolveVSCodeTheme({
        id: 'external-tokens',
        label: 'External Tokens',
        uiTheme: 'vs-dark',
        path: 'external.json',
        source: { kind: 'test-fixture' },
        readFile: createMapReader({ 'external.json': `{ "tokenColors": "./theme.tmTheme" }` }),
      })
    ).rejects.toThrow(/not supported yet/);
  });

  it('resolves bundled Vesper from its original JSONC theme asset', async () => {
    const themes = await resolveBundledVSCodeThemes();
    const vesper = themes.find((theme) => theme.id === 'vesper');

    expect(vesper).toMatchObject({
      id: 'vesper',
      label: 'Vesper',
      type: 'dark',
      source: {
        kind: 'builtin',
        extensionId: 'raunofreiberg.vesper',
        extensionVersion: '0.0.40',
      },
      colors: {
        'button.background': '#FFC799',
        'editor.background': '#101010',
        'editor.foreground': '#FFFFFF',
        'sideBar.background': '#161616',
      },
    });
    if (!vesper) {
      throw new Error('Bundled Vesper theme was not resolved.');
    }
    expect(vesper.tokenColors.length).toBeGreaterThan(20);
    expect(toShikiTheme(vesper, 'vesper-test')).toMatchObject({
      name: 'vesper-test',
      fg: '#FFFFFF',
      bg: '#101010',
    });
    await expect(getBundledVSCodeThemeById('vesper')).resolves.toEqual(vesper);
    await expect(getBundledVSCodeThemeById('missing-theme')).resolves.toBeUndefined();
  });

  it('resolves bundled active themes synchronously from local theme assets', () => {
    const vesper = getBundledVSCodeThemeByIdSync('vesper');

    expect(vesper).toMatchObject({
      id: 'vesper',
      label: 'Vesper',
      colors: {
        'editor.background': '#101010',
      },
    });
    expect(getCachedBundledVSCodeThemeById('vesper')).toBe(vesper);
  });

  it('resolves bundled VSCode 2026 defaults through their include chains', async () => {
    const dark = await getBundledVSCodeThemeById('vscode-dark-2026');
    const light = await getBundledVSCodeThemeById('vscode-light-2026');

    expect(dark).toMatchObject({
      id: 'vscode-dark-2026',
      label: 'Dark 2026',
      type: 'dark',
      source: {
        kind: 'builtin',
        extensionId: 'vscode.theme-defaults',
      },
      colors: {
        'editor.background': '#121314',
        'editor.foreground': '#BBBEBF',
        'sideBar.background': '#191A1B',
      },
    });
    expect(light).toMatchObject({
      id: 'vscode-light-2026',
      label: 'Light 2026',
      type: 'light',
      source: {
        kind: 'builtin',
        extensionId: 'vscode.theme-defaults',
      },
    });
    expect(dark?.tokenColors.length).toBeGreaterThan(100);
    expect(light?.tokenColors.length).toBeGreaterThan(100);
  });

  it('resolves the curated permissive bundled theme pack', async () => {
    const themes = await resolveBundledVSCodeThemes();

    expect(themes.map((theme) => theme.id)).toEqual(
      expect.arrayContaining([
        'lody-light',
        'github-light-default',
        'github-dark-default',
        'catppuccin-mocha',
        'tokyo-night',
        'tokyo-night-storm',
        'tokyo-night-light',
        'vitesse-light',
        'vitesse-dark',
        'vitesse-black',
        'vitesse-light-soft',
        'vitesse-dark-soft',
        'one-dark-pro',
        'ayu-light',
        'ayu-mirage',
        'ayu-dark',
      ])
    );

    for (const themeId of [
      'lody-light',
      'github-light-default',
      'github-dark-default',
      'catppuccin-mocha',
      'tokyo-night',
      'tokyo-night-storm',
      'tokyo-night-light',
      'vitesse-light',
      'vitesse-dark',
      'vitesse-black',
      'vitesse-light-soft',
      'vitesse-dark-soft',
      'one-dark-pro',
      'ayu-light',
      'ayu-mirage',
      'ayu-dark',
    ]) {
      const theme = await getBundledVSCodeThemeById(themeId);
      expect(theme, themeId).toEqual(
        expect.objectContaining({
          id: themeId,
          schemaVersion: 1,
        })
      );
      expect(theme?.colors['editor.background'], themeId).toMatch(/^#/);
      expect(theme?.colors['editor.foreground'], themeId).toMatch(/^#/);
      expect(theme?.tokenColors.length, themeId).toBeGreaterThan(10);
    }
  });

  it('exposes only the product theme shortlist in selectors', async () => {
    const themes = await resolveBundledVSCodeThemes();

    expect(
      themes.filter((theme) => isSelectableBundledVSCodeThemeId(theme.id)).map((theme) => theme.id)
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
