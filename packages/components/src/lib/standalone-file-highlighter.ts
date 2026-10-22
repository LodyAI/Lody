import type { TokensResult } from 'shiki';
import { toShikiTheme } from './vscode-theme/vscode-theme-shiki';
import type { LodyResolvedVSCodeTheme } from './vscode-theme/vscode-theme-schemas';

async function createFileHighlighter() {
  const [
    { createHighlighterCore },
    { createJavaScriptRegexEngine },
    { bundledLanguages, bundledThemes },
  ] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki')]);
  const { resolveTheme } = await import('@pierre/diffs');
  const lightTheme = (await resolveTheme('pierre-light', 'shiki-js')).textmate;
  if (!lightTheme) throw new Error('Missing Pierre light TextMate theme');
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [bundledLanguages.coq, bundledLanguages.lean],
    themes: [bundledThemes['github-dark-default'], lightTheme],
  });
}

// Independent of Diffs' per-realm backend registry. Shared only by read-only
// Coq/Lean viewers; language and bundled theme caches are bounded.
let fileHighlighter: ReturnType<typeof createFileHighlighter> | undefined;
export async function highlightStandaloneFile(
  source: string,
  language: 'coq' | 'lean',
  theme: LodyResolvedVSCodeTheme | undefined,
  mode: 'light' | 'dark'
): Promise<TokensResult> {
  fileHighlighter ??= createFileHighlighter().catch((error: unknown) => {
    fileHighlighter = undefined;
    throw error;
  });
  const highlighter = await fileHighlighter;
  let themeName = mode === 'dark' ? 'github-dark-default' : 'pierre-light';
  if (theme) {
    const shikiTheme = toShikiTheme(theme);
    await highlighter.loadTheme(shikiTheme);
    themeName = shikiTheme.name;
  }
  return highlighter.codeToTokens(source, {
    lang: language,
    theme: themeName,
    tokenizeMaxLineLength: 20_000,
  });
}
