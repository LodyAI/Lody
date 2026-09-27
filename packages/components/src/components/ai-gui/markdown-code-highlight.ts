import { useEffect, useMemo, useState } from 'react';
import type { BundledLanguage, ThemedToken } from 'shiki';
import { getMarkdownHighlightWorker } from '@/lib/markdown-highlight-worker';
import {
  createMarkdownHighlighter,
  MARKDOWN_CODE_LANGUAGES,
  tokenizeMarkdownCode,
  type MarkdownHighlighter,
} from '@/lib/markdown-highlighter';

export type MarkdownCodeToken = Pick<ThemedToken, 'content' | 'color' | 'fontStyle' | 'htmlStyle'>;

const MARKDOWN_CODE_LANGUAGE_ALIASES: Partial<Record<string, BundledLanguage>> = {
  js: 'javascript',
  ts: 'typescript',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sh: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
};

const MARKDOWN_CODE_LANGUAGE_SET = new Set<string>(MARKDOWN_CODE_LANGUAGES);

const normalizeCodeLanguage = (language: string): BundledLanguage | null => {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;

  const alias = MARKDOWN_CODE_LANGUAGE_ALIASES[normalized];
  if (alias) return alias;

  return MARKDOWN_CODE_LANGUAGE_SET.has(normalized) ? (normalized as BundledLanguage) : null;
};

const createPlainTokens = (code: string): MarkdownCodeToken[][] =>
  code.split('\n').map((line) => [{ content: line }]);

// Tokens are pure over (language, code): the CSS-variables theme carries
// `var(--lody-shiki-*)` colors and does not change with the app theme, so a
// remounted transcript reuses them instead of re-tokenizing every block.
// Bounded by entry count and total source length; insertion order gives LRU.
// A block still streaming is never cached: its prefixes would evict the
// finished blocks the cache exists for.
const HIGHLIGHT_CACHE_MAX_ENTRIES = 256;
const HIGHLIGHT_CACHE_MAX_TOTAL_CHARS = 1_000_000;
const HIGHLIGHT_CACHE_MAX_CODE_CHARS = 20_000;

const highlightCache = new Map<string, MarkdownCodeToken[][]>();
let highlightCacheChars = 0;

const readHighlightCache = (key: string): MarkdownCodeToken[][] | undefined => {
  const cached = highlightCache.get(key);
  if (cached === undefined) return undefined;
  highlightCache.delete(key);
  highlightCache.set(key, cached);
  return cached;
};

const writeHighlightCache = (key: string, codeLength: number, tokens: MarkdownCodeToken[][]) => {
  highlightCache.set(key, tokens);
  highlightCacheChars += codeLength;
  while (
    highlightCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES ||
    highlightCacheChars > HIGHLIGHT_CACHE_MAX_TOTAL_CHARS
  ) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey === undefined) break;
    highlightCache.delete(oldestKey);
    // The key is `${language}\0${code}`, so its length bounds the code length
    // it contributed; close enough to keep the budget from drifting upward.
    highlightCacheChars = Math.max(0, highlightCacheChars - oldestKey.length);
  }
};

let mainThreadHighlighter: Promise<MarkdownHighlighter> | null = null;

const highlightOnMainThread = async (code: string, language: BundledLanguage) => {
  mainThreadHighlighter ??= createMarkdownHighlighter();
  return tokenizeMarkdownCode(await mainThreadHighlighter, code, language).tokens;
};

// Tokenizing a large block took 60–80ms of main thread, so it runs in the
// shared worker; without one (tests, a crashed worker) the same highlighter
// runs here.
const requestTokens = async (
  code: string,
  language: BundledLanguage
): Promise<MarkdownCodeToken[][]> => {
  const worker = getMarkdownHighlightWorker();
  if (worker) {
    try {
      return (await worker.highlight(code, language)).tokens;
    } catch {
      return highlightOnMainThread(code, language);
    }
  }
  return highlightOnMainThread(code, language);
};

type ResolvedTokens = { key: string; code: string; tokens: MarkdownCodeToken[][] };

// A streaming block grows by appending, so the previous result stays on screen
// with only the new text plain until the worker answers, instead of the whole
// block flashing back to plain text on every reveal.
const extendTokens = (previous: ResolvedTokens, code: string): MarkdownCodeToken[][] | null => {
  if (!code.startsWith(previous.code)) return null;
  const [sameLine = '', ...newLines] = code.slice(previous.code.length).split('\n');
  const lines = previous.tokens.slice();
  if (sameLine) {
    const lastIndex = Math.max(0, lines.length - 1);
    lines[lastIndex] = [...(lines[lastIndex] ?? []), { content: sameLine }];
  }
  for (const line of newLines) lines.push([{ content: line }]);
  return lines;
};

export function useMarkdownCodeTokens(
  code: string,
  languageId: string,
  isIncomplete: boolean
): MarkdownCodeToken[][] {
  const language = normalizeCodeLanguage(languageId);
  const key = language ? `${language}\0${code}` : null;
  const cacheable = !isIncomplete && code.length <= HIGHLIGHT_CACHE_MAX_CODE_CHARS;
  const [resolved, setResolved] = useState<ResolvedTokens | null>(null);

  useEffect(() => {
    if (!key || !language || highlightCache.has(key)) return undefined;
    let cancelled = false;
    void requestTokens(code, language).then(
      (tokens) => {
        if (cacheable) writeHighlightCache(key, code.length, tokens);
        if (!cancelled) setResolved({ key, code, tokens });
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [cacheable, code, key, language]);

  return useMemo(() => {
    if (!key) return createPlainTokens(code);
    const cached = readHighlightCache(key);
    if (cached) return cached;
    if (resolved?.key === key) return resolved.tokens;
    return (resolved && extendTokens(resolved, code)) ?? createPlainTokens(code);
  }, [code, key, resolved]);
}
