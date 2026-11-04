import type { ThemeRegistrationResolved } from 'shiki';
import type { Theme, ThemeSyntaxSettings } from '@pierre/highlights';
import type { LodyResolvedVSCodeTheme, TextMateTokenColorRule } from './vscode-theme-schemas';
import { readWorkbenchColor } from './vscode-theme-color';

// Lazily import @pierre/diffs to avoid pulling in the shiki/regex/oniguruma-to-es chain
// at module load time. Those packages use lookbehind regex assertions that crash Safari < 16.4.
let registerCustomThemePromise: Promise<typeof import('@pierre/diffs')> | undefined;
function getRegisterCustomTheme() {
  if (!registerCustomThemePromise) {
    registerCustomThemePromise = import('@pierre/diffs').catch((error: unknown) => {
      registerCustomThemePromise = undefined;
      throw error;
    });
  }
  return registerCustomThemePromise;
}

// @pierre/diffs exposes registration but not deregistration. With the current bundled-theme
// integration this set remains bounded by the finite built-in theme IDs.
const registeredThemeNames = new Set<string>();
const registeringThemePromises = new Map<string, Promise<string | undefined>>();

export const DEFAULT_VSCODE_DIFF_THEME_FALLBACK = {
  dark: 'github-dark-default',
  light: 'pierre-light',
} as const;

export const createLodyVSCodeShikiThemeName = (theme: LodyResolvedVSCodeTheme): string =>
  `lody-vscode-${theme.id}`;

export const toShikiTheme = (
  theme: LodyResolvedVSCodeTheme,
  name: string = createLodyVSCodeShikiThemeName(theme)
): ThemeRegistrationResolved => {
  const foreground = readWorkbenchColor(theme, ['editor.foreground', 'foreground']) ?? '#CCCCCC';
  const background = readWorkbenchColor(theme, ['editor.background']) ?? '#1E1E1E';
  return {
    name,
    type: theme.type === 'light' || theme.type === 'hcLight' ? 'light' : 'dark',
    fg: foreground,
    bg: background,
    colors: theme.colors,
    settings: [
      {
        settings: {
          foreground,
          background,
        },
      },
      ...theme.tokenColors.map(toShikiSetting),
    ],
  };
};

export const getRegisteredLodyVSCodeThemeForDiffs = (
  theme: LodyResolvedVSCodeTheme,
  name: string = createLodyVSCodeShikiThemeName(theme)
): string | undefined => (registeredThemeNames.has(name) ? name : undefined);

export const registerLodyVSCodeThemeForDiffs = (
  theme: LodyResolvedVSCodeTheme,
  name: string = createLodyVSCodeShikiThemeName(theme)
): Promise<string | undefined> => {
  const registeredName = getRegisteredLodyVSCodeThemeForDiffs(theme, name);
  if (registeredName) {
    return Promise.resolve(registeredName);
  }

  const registeringThemePromise = registeringThemePromises.get(name);
  if (registeringThemePromise) {
    return registeringThemePromise;
  }

  const shikiTheme = toShikiTheme(theme, name);
  const promise = getRegisterCustomTheme()
    .then((m) => {
      m.registerCustomTheme(name, async () => shikiTheme);
      m.registerCustomTheme(name, async () => toHighlightsTheme(theme, name), 'zed');
      registeredThemeNames.add(name);
      return name;
    })
    .catch((error: unknown) => {
      // @pierre/diffs failed to load (e.g. Safari < 16.4 regex compat).
      // Theme registration is non-critical; diff viewer will use fallback themes.
      console.warn('[vscode-theme] Failed to register VSCode theme for diffs', error);
      return undefined;
    })
    .finally(() => {
      registeringThemePromises.delete(name);
    });

  registeringThemePromises.set(name, promise);
  return promise;
};

const toShikiSetting = (tokenColor: TextMateTokenColorRule) => ({
  name: tokenColor.name,
  scope: tokenColor.scope,
  settings: tokenColor.settings,
});

// Highlights classifies syntax rather than matching TextMate scope stacks. Map
// those categories to the active VS Code palette, keeping editor colors intact.
const HIGHLIGHTS_SCOPES: Record<string, string[]> = {
  comment: ['comment'],
  string: ['string'],
  'string.escape': ['constant.character.escape'],
  'string.regex': ['string.regexp'],
  keyword: ['keyword', 'storage.type'],
  operator: ['keyword.operator'],
  preproc: ['meta.preprocessor'],
  boolean: ['constant.language.boolean', 'constant.language'],
  number: ['constant.numeric'],
  constant: ['constant'],
  variable: ['variable'],
  'variable.parameter': ['variable.parameter'],
  'variable.special': ['variable.language'],
  property: ['variable.other.property', 'support.type.property-name'],
  'property.json_key': ['support.type.property-name.json'],
  function: ['entity.name.function', 'support.function'],
  constructor: ['entity.name.function', 'entity.name.type'],
  type: ['entity.name.type', 'entity.name.class', 'support.type'],
  attribute: ['entity.other.attribute-name'],
  tag: ['entity.name.tag'],
  punctuation: ['punctuation'],
  'diff.plus': ['markup.inserted'],
  'diff.minus': ['markup.deleted'],
  title: ['markup.heading'],
  emphasis: ['markup.italic'],
  'emphasis.strong': ['markup.bold'],
  link_text: ['markup.underline.link'],
  link_uri: ['markup.underline.link'],
};

export function toHighlightsTheme(
  theme: LodyResolvedVSCodeTheme,
  name = createLodyVSCodeShikiThemeName(theme)
): Theme {
  const syntax: Record<string, ThemeSyntaxSettings> = {};
  for (const [category, scopes] of Object.entries(HIGHLIGHTS_SCOPES)) {
    const settings: ThemeSyntaxSettings = {};
    // Broad rules first, specific rules last; later equal-specificity rules win.
    const matches = theme.tokenColors.flatMap((rule) => {
      const selectors = (Array.isArray(rule.scope) ? rule.scope : [rule.scope ?? ''])
        .flatMap((scope) => scope.split(','))
        .map((scope) => scope.trim());
      const specificity = Math.max(-1, ...selectors.flatMap((selector) =>
        scopes.filter((scope) => !selector || scope === selector || scope.startsWith(`${selector}.`))
          .map(() => selector.length)));
      return specificity < 0 ? [] : [{ rule, specificity }];
    }).sort((a, b) => a.specificity - b.specificity);
    for (const { rule } of matches) {
      if (rule.settings.foreground) settings.color = rule.settings.foreground;
      if (rule.settings.fontStyle !== undefined) {
        const flags = rule.settings.fontStyle.split(' ');
        settings.font_style = flags.includes('italic') ? 'italic' : 'normal';
        settings.font_weight = flags.includes('bold') ? 700 : 400;
      }
    }
    syntax[category] = settings;
  }
  return {
    name,
    appearance: theme.type === 'light' || theme.type === 'hcLight' ? 'light' : 'dark',
    style: {
      ...theme.colors,
      'editor.foreground': readWorkbenchColor(theme, ['editor.foreground', 'foreground']) ?? '#CCCCCC',
      'editor.background': readWorkbenchColor(theme, ['editor.background']) ?? '#1E1E1E',
      syntax,
    },
  };
}
