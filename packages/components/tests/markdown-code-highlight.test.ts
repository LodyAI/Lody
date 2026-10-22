import { describe, expect, it, vi } from 'vitest';

vi.mock('@/atoms', () => ({ extendedCodeLanguagesEnabledAtom: {} }));

import { resolveMarkdownCodeLanguage } from '../src/components/ai-gui/markdown-code-highlight';

describe('resolveMarkdownCodeLanguage', () => {
  it('keeps optional grammars and dialect aliases behind the extension setting', () => {
    expect(resolveMarkdownCodeLanguage('coq', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('rocq', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('coq', true)).toBe('coq');
    expect(resolveMarkdownCodeLanguage('rocq', true)).toBe('coq');
    expect(resolveMarkdownCodeLanguage('mysql', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('mysql', true)).toBe('sql');
    expect(resolveMarkdownCodeLanguage('postgresql', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('postgresql', true)).toBe('sql');
  });

  it('keeps core grammars available without the extension setting', () => {
    expect(resolveMarkdownCodeLanguage('typescript', false)).toBe('typescript');
    expect(resolveMarkdownCodeLanguage('sql', false)).toBe('sql');
  });
});

import {
  createMarkdownHighlighter,
  tokenizeMarkdownCode,
  MARKDOWN_CORE_CODE_LANGUAGES,
} from '../src/lib/markdown-highlighter';

describe('Markdown Highlights tokens', () => {
  it('uses WASM tokens with the existing palette and preserves Unicode and trailing lines', async () => {
    const highlighter = await createMarkdownHighlighter();
    expect(highlighter.backend).toBe('highlights');
    const source = 'const greeting = "你好 🌙";\n// comment\n';
    const result = tokenizeMarkdownCode(highlighter, source, 'typescript');
    expect(
      result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
    ).toBe(source);
    expect(
      result.tokens[0]?.some(
        (token) =>
          token.content.trim() === 'const' &&
          token.htmlStyle?.color === 'var(--lody-shiki-token-keyword)'
      )
    ).toBe(true);
    expect(result.tokens[1]?.[0]?.htmlStyle?.color).toBe('var(--lody-shiki-token-comment)');
    // Token objects remain valid after the shared WASM memory is reused.
    tokenizeMarkdownCode(highlighter, 'let other = 1;', 'javascript');
    expect(result.tokens[0]?.map((token) => token.content).join('')).toBe(source.split('\n')[0]);
  });

  it('keeps every core language renderable without fetching grammars', async () => {
    const highlighter = await createMarkdownHighlighter();
    for (const language of MARKDOWN_CORE_CODE_LANGUAGES) {
      const result = tokenizeMarkdownCode(highlighter, 'value = 42\n', language);
      expect(
        result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
      ).toBe('value = 42\n');
    }
  });
});
