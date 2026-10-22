import type { BundledLanguage } from 'shiki';
import type { Highlighter, Theme } from '@pierre/highlights';

/**
 * The Highlights token adapter shared by the markdown code-block worker and its
 * main-thread fallback, so both produce the same tokens for the same input.
 */

export const MARKDOWN_CODE_THEME_NAME = 'lody-css-variables';

/** Languages enabled without the extension setting. Shiki fallback preloads this set. */
export const MARKDOWN_CORE_CODE_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'bash',
  'shellscript',
  'markdown',
  'python',
  'rust',
  'go',
  'yaml',
  'html',
  'css',
  'c',
  'cpp',
  'csharp',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'sql',
  'graphql',
  'toml',
  'xml',
  'dockerfile',
] as const satisfies readonly BundledLanguage[];

/**
 * Languages gated by the extension setting. Highlights bundles its lexers;
 * the Shiki fallback loads these grammars on first use.
 */
export const MARKDOWN_EXTENDED_CODE_LANGUAGES = [
  'dart',
  'mdx',
  'lua',
  'objective-c',
  'perl',
  'powershell',
  'bat',
  'fish',
  'scss',
  'less',
  'hcl',
  'protobuf',
  'vue',
  'svelte',
  'astro',
  'elixir',
  'erlang',
  'clojure',
  'scala',
  'haskell',
  'ocaml',
  'fsharp',
  'julia',
  'r',
  'solidity',
  'zig',
  'wgsl',
  'glsl',
  'latex',
  'cmake',
  'nginx',
  'make',
  'lean',
  'coq',
] as const satisfies readonly BundledLanguage[];

/** Backwards-compatible name for callers that only need the always-loaded set. */
export const MARKDOWN_CODE_LANGUAGES = MARKDOWN_CORE_CODE_LANGUAGES;

const EXTENDED_LANGUAGE_SET = new Set<string>(MARKDOWN_EXTENDED_CODE_LANGUAGES);

type ShikiHighlighter = Awaited<ReturnType<(typeof import('shiki/core'))['createHighlighterCore']>>;

/** Tokens for one code block (Shiki's `TokensResult`, structured-clone safe). */
export type MarkdownTokens = Pick<ReturnType<Highlighter['codeToTokens']>, 'tokens' | 'fg' | 'bg'>;

export type MarkdownHighlighter =
  | {
      backend: 'highlights';
      highlighter: Highlighter;
      theme: Theme;
      supportsLanguage: (language: string) => boolean;
      fallback?: ShikiHighlighter;
      fallbackLoading?: Promise<ShikiHighlighter>;
    }
  | { backend: 'shiki-js'; highlighter: ShikiHighlighter };

export async function createMarkdownHighlighter(): Promise<MarkdownHighlighter> {
  const { canUseWASM, createCSSVariablesTheme } = await import('@pierre/diffs');
  if (canUseWASM()) {
    const { createHighlighter, isSupportedLanguage } = await import('@pierre/highlights');
    const theme = createCSSVariablesTheme({
      name: MARKDOWN_CODE_THEME_NAME,
      variablePrefix: '--lody-shiki-',
    }).zed;
    if (!theme) throw new Error('Markdown Highlights palette is missing');
    return {
      backend: 'highlights',
      highlighter: createHighlighter(),
      theme,
      supportsLanguage: isSupportedLanguage,
    };
  }
  return { backend: 'shiki-js', highlighter: await createMarkdownShikiHighlighter() };
}

async function createMarkdownShikiHighlighter(
  languages: readonly BundledLanguage[] = MARKDOWN_CORE_CODE_LANGUAGES
): Promise<ShikiHighlighter> {
  // @pierre/diffs already imports shiki's bundledLanguages catalog. Reuse it
  // instead of a second shiki/langs/*.mjs graph (duplicate grammar chunks).
  const [
    { createCssVariablesTheme, createHighlighterCore },
    { createJavaScriptRegexEngine },
    shiki,
  ] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki')]);
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: languages.map((id) => {
      const language = shiki.bundledLanguages[id];
      if (!language) {
        throw new Error(`Missing bundled shiki language: ${id}`);
      }
      return language;
    }),
    themes: [
      createCssVariablesTheme({
        name: MARKDOWN_CODE_THEME_NAME,
        variablePrefix: '--lody-shiki-',
      }),
    ],
  });
}

const loadedExtendedLanguages = new WeakMap<ShikiHighlighter, Map<string, Promise<void>>>();

/** Load one optional grammar into an existing highlighter just before use. */
export async function ensureMarkdownCodeLanguage(
  adapter: MarkdownHighlighter,
  language: BundledLanguage,
  extendedLanguagesEnabled: boolean
): Promise<void> {
  if (!extendedLanguagesEnabled || !EXTENDED_LANGUAGE_SET.has(language)) return;
  let highlighter: ShikiHighlighter;
  if (adapter.backend === 'highlights') {
    if (adapter.supportsLanguage(language)) return;
    adapter.fallbackLoading ??= createMarkdownShikiHighlighter([]).then(
      (fallback) => (adapter.fallback = fallback),
      (error: unknown) => {
        adapter.fallbackLoading = undefined;
        throw error;
      }
    );
    highlighter = await adapter.fallbackLoading;
  } else {
    highlighter = adapter.highlighter;
  }

  let languageLoads = loadedExtendedLanguages.get(highlighter);
  if (!languageLoads) {
    languageLoads = new Map<string, Promise<void>>();
    loadedExtendedLanguages.set(highlighter, languageLoads);
  }
  const existing = languageLoads.get(language);
  if (existing) return existing;

  const load = (async () => {
    const shiki = await import('shiki');
    const grammar = shiki.bundledLanguages[language];
    if (!grammar) throw new Error(`Missing bundled shiki language: ${language}`);
    await highlighter.loadLanguage(grammar);
  })();
  const trackedLoad = load.then(
    () => undefined,
    (error: unknown) => {
      languageLoads?.delete(language);
      throw error;
    }
  );
  languageLoads.set(language, trackedLoad);
  await trackedLoad;
}

/**
 * Tokenize with the CSS-variables theme for both color schemes: the tokens
 * carry `var(--lody-shiki-*)` colors and do not depend on the app theme.
 */
export function tokenizeMarkdownCode(
  adapter: MarkdownHighlighter,
  code: string,
  language: BundledLanguage
): MarkdownTokens {
  if (adapter.backend === 'highlights' && adapter.supportsLanguage(language)) {
    return adapter.highlighter.codeToTokens(code, {
      lang: language as import('@pierre/highlights').Lang,
      themes: { light: adapter.theme, dark: adapter.theme },
    });
  }
  const highlighter = adapter.backend === 'shiki-js' ? adapter.highlighter : adapter.fallback;
  if (!highlighter) throw new Error(`Markdown language was not prepared: ${language}`);
  return highlighter.codeToTokens(code, {
    lang: language,
    themes: { light: MARKDOWN_CODE_THEME_NAME, dark: MARKDOWN_CODE_THEME_NAME },
  });
}
