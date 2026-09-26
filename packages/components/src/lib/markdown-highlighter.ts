import type { BundledLanguage } from 'shiki';

/**
 * The Shiki highlighter shared by the markdown code-block worker and its
 * main-thread fallback, so both produce the same tokens for the same input.
 */

export const MARKDOWN_CODE_THEME_NAME = 'lody-css-variables';

export const MARKDOWN_CODE_LANGUAGES = [
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
] as const satisfies readonly BundledLanguage[];

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
    langs: MARKDOWN_CODE_LANGUAGES.map((id) => {
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
