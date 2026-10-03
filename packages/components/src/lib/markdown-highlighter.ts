import type { BundledLanguage } from 'shiki';

/**
 * The Shiki highlighter shared by the markdown code-block worker and its
 * main-thread fallback, so both produce the same tokens for the same input.
 */

export const MARKDOWN_CODE_THEME_NAME = 'lody-css-variables';

/** Languages loaded for every user. Keep this list small enough for the first render. */
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
 * Grammars that are available after the user opts into the extension pack.
 * These are loaded on first use, so enabling the pack does not eagerly parse
 * every grammar in this list.
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

export type MarkdownHighlighter = Awaited<
  ReturnType<(typeof import('shiki/core'))['createHighlighterCore']>
>;

/** Tokens for one code block (Shiki's `TokensResult`, structured-clone safe). */
export type MarkdownTokens = ReturnType<MarkdownHighlighter['codeToTokens']>;

export async function createMarkdownHighlighter(): Promise<MarkdownHighlighter> {
  // @pierre/diffs already imports shiki's bundledLanguages catalog. Reuse it
  // instead of a second shiki/langs/*.mjs graph (duplicate grammar chunks).
  const [
    { createCssVariablesTheme, createHighlighterCore },
    { createJavaScriptRegexEngine },
    shiki,
  ] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki')]);
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: MARKDOWN_CORE_CODE_LANGUAGES.map((id) => {
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

const loadedExtendedLanguages = new WeakMap<MarkdownHighlighter, Map<string, Promise<void>>>();

/** Load one optional grammar into an existing highlighter just before use. */
export async function ensureMarkdownCodeLanguage(
  highlighter: MarkdownHighlighter,
  language: BundledLanguage,
  extendedLanguagesEnabled: boolean
): Promise<void> {
  if (!extendedLanguagesEnabled || !EXTENDED_LANGUAGE_SET.has(language)) return;

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
  highlighter: MarkdownHighlighter,
  code: string,
  language: BundledLanguage
): MarkdownTokens {
  return highlighter.codeToTokens(code, {
    lang: language,
    themes: { light: MARKDOWN_CODE_THEME_NAME, dark: MARKDOWN_CODE_THEME_NAME },
  });
}
