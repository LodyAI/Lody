import { describe, expect, it, vi } from 'vitest';

vi.mock('@/atoms', () => ({ extendedCodeLanguagesEnabledAtom: {} }));
vi.mock('@pierre/diffs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs')>();
  return { ...actual, canUseWASM: vi.fn(actual.canUseWASM) };
});

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

import { ensureMarkdownCodeLanguage } from '../src/lib/markdown-highlighter';
import { getSharedHighlighter as createDiffsHighlighter } from '@pierre/diffs';
import * as diffsModule from '@pierre/diffs';
import { highlightStandaloneFile } from '../src/lib/standalone-file-highlighter';
import type { LodyResolvedVSCodeTheme } from '../src/lib/vscode-theme';

describe('isolated Shiki compatibility', () => {
  const samples = {
    coq: '(* comment 世界 *)\nDefinition answer : nat := 42.\n',
    lean: '/- comment 世界 -/\ndef answer : Nat := 42\n',
    fish: '# comment 世界\nset answer 42\n',
    nginx: '# comment 世界\nserver { listen 80; }\n',
  } as const;

  it('loads missing Markdown grammars concurrently without replacing Highlights', async () => {
    const adapter = await createMarkdownHighlighter();
    expect(adapter.backend).toBe('highlights');
    if (adapter.backend !== 'highlights') throw new Error('Expected Highlights');
    await ensureMarkdownCodeLanguage(adapter, 'coq', false);
    expect(adapter.fallback).toBeUndefined();
    await ensureMarkdownCodeLanguage(adapter, 'lua', true);
    expect(adapter.fallback).toBeUndefined();
    await Promise.all(
      Object.keys(samples).flatMap((language) => [
        ensureMarkdownCodeLanguage(adapter, language as keyof typeof samples, true),
        ensureMarkdownCodeLanguage(adapter, language as keyof typeof samples, true),
      ])
    );
    for (const [language, source] of Object.entries(samples)) {
      const result = tokenizeMarkdownCode(adapter, source, language as keyof typeof samples);
      expect(
        result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
      ).toBe(source);
      expect(
        result.tokens[0]?.some(
          (token) =>
            token.color?.includes('--lody-shiki-token-comment') ||
            token.htmlStyle?.color?.includes('--lody-shiki-token-comment')
        ),
        JSON.stringify({ language, tokens: result.tokens[0] })
      ).toBe(true);
    }
    expect(
      tokenizeMarkdownCode(adapter, 'const answer = 42;', 'typescript').tokens[0]?.some(
        (token) => token.htmlStyle?.color === 'var(--lody-shiki-token-keyword)'
      )
    ).toBe(true);
    adapter.fallback?.dispose();
  });

  it('retries a failed optional grammar load while other languages remain usable', async () => {
    const adapter = await createMarkdownHighlighter();
    await ensureMarkdownCodeLanguage(adapter, 'coq', true);
    if (adapter.backend !== 'highlights' || !adapter.fallback) throw new Error('Missing fallback');
    const fallback = adapter.fallback;
    const loading = vi.spyOn(fallback, 'loadLanguage');
    loading.mockRejectedValueOnce(new Error('synthetic grammar load failure'));
    await expect(ensureMarkdownCodeLanguage(adapter, 'fish', true)).rejects.toThrow(
      'synthetic grammar load failure'
    );
    expect(tokenizeMarkdownCode(adapter, samples.coq, 'coq').tokens.length).toBe(3);
    await ensureMarkdownCodeLanguage(adapter, 'fish', true);
    expect(
      tokenizeMarkdownCode(adapter, samples.fish, 'fish').tokens[0]?.some((token) =>
        token.htmlStyle?.color?.includes('token-comment')
      )
    ).toBe(true);
    loading.mockRestore();
    fallback.dispose();
  });

  it('keeps core and optional grammars usable when WASM is unavailable', async () => {
    const wasm = vi.spyOn(diffsModule, 'canUseWASM').mockReturnValue(false);
    const adapter = await createMarkdownHighlighter().finally(() => wasm.mockRestore());
    expect(adapter.backend).toBe('shiki-js');
    if (adapter.backend !== 'shiki-js') throw new Error('Expected Shiki');
    try {
      await Promise.all([
        ensureMarkdownCodeLanguage(adapter, 'fish', true),
        ensureMarkdownCodeLanguage(adapter, 'fish', true),
        ensureMarkdownCodeLanguage(adapter, 'coq', true),
      ]);
      // A warmed grammar remains usable without a second registration attempt.
      const loading = vi
        .spyOn(adapter.highlighter, 'loadLanguage')
        .mockRejectedValue(new Error('synthetic later load failure'));
      try {
        await ensureMarkdownCodeLanguage(adapter, 'fish', true);
        for (const language of ['fish', 'coq'] as const) {
          const tokens = tokenizeMarkdownCode(adapter, samples[language], language).tokens;
          expect(tokens.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(
            samples[language]
          );
          expect(
            tokens[0]?.some((token) => token.htmlStyle?.color?.includes('token-comment'))
          ).toBe(true);
        }
        expect(
          tokenizeMarkdownCode(adapter, 'const n = 1;', 'typescript').tokens[0]?.some((token) =>
            token.htmlStyle?.color?.includes('token-keyword')
          )
        ).toBe(true);
      } finally {
        loading.mockRestore();
      }
    } finally {
      adapter.highlighter.dispose();
    }
  });

  it('preserves Coq/Lean theme colors while Diffs Highlights is active', async () => {
    const diffs = await createDiffsHighlighter({
      preferredHighlighter: 'highlights',
      themes: ['github-dark-default'],
      langs: ['typescript'],
    });
    const theme: LodyResolvedVSCodeTheme = {
      schemaVersion: 1,
      id: 'fallback-test',
      label: 'Fallback test',
      type: 'dark',
      source: { kind: 'test-fixture' },
      colors: { 'editor.foreground': '#eeeeee', 'editor.background': '#101010' },
      tokenColors: [
        {
          scope: 'comment',
          settings: { foreground: '#12ab34', fontStyle: 'italic bold underline' },
        },
      ],
    };
    try {
      for (const language of ['coq', 'lean'] as const) {
        const result = await highlightStandaloneFile(samples[language], language, theme, 'dark');
        expect(
          result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
        ).toBe(samples[language]);
        expect(
          result.tokens[0]?.some(
            (token) => token.color?.toLowerCase() === '#12ab34' && Number(token.fontStyle) === 7
          ),
          JSON.stringify({ language, tokens: result.tokens[0] })
        ).toBe(true);
        expect(result.bg).toBe('#101010');
      }
      expect(
        diffs
          .codeToTokens('const answer = 42;', { lang: 'typescript', theme: 'github-dark-default' })
          .tokens.flat()
          .some((token) => token.content.includes('const'))
      ).toBe(true);
    } finally {
      diffs.dispose();
    }
  });
});
