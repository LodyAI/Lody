// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMarkdownMermaidConfig,
  MarkdownRenderer,
} from '../src/components/ai-gui/markdown-renderer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestIntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];

  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
}

(
  globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
).IntersectionObserver = TestIntersectionObserver as typeof IntersectionObserver;

const STREAM_CHUNK_COUNT = 48;
const MALFORMED_BOLD_AUTOLINK_MARKDOWN =
  '**https://github.com/LodyAI/Lody/pull/262**(`fix/some-branch` -> `main`)';
const MALFORMED_BOLD_WWW_AUTOLINK_MARKDOWN = '**www.example.com**(`fix/some-branch` -> `main`)';
const MALFORMED_BOLD_MIXED_CASE_WWW_AUTOLINK_MARKDOWN =
  '**WWW.example.com**(`fix/some-branch` -> `main`)';
const ESCAPED_BOLD_AUTOLINK_MARKDOWN =
  '\\*\\*https://example.com\\*\\*(`fix/some-branch` -> `main`)';
const ESCAPED_BOLD_OPENER_AUTOLINK_MARKDOWN =
  '\\*\\*https://example.com**(`fix/some-branch` -> `main`)';
const ESCAPED_BOLD_CLOSER_AUTOLINK_MARKDOWN =
  '**https://example.com\\*\\*(`fix/some-branch` -> `main`)';
const URL_WITH_DOUBLE_ASTERISK_MARKDOWN = '**https://example.com/path**segment';
const URL_WITH_DOUBLE_ASTERISK_BEFORE_CODE_MARKDOWN = '**https://example.com/path**segment(`code`)';
const URL_WITH_LATER_VALID_CLOSER_MARKDOWN = '**https://example.com/a**b/c**(`code`)';
const LONG_URL_SEGMENTS = Array.from({ length: 64 }, (_, index) => `segment${index}**`).join('');
const LONG_URL_WITH_REPEATED_NON_CLOSERS_MARKDOWN = `**https://example.com/${LONG_URL_SEGMENTS}final**(\`code\`)`;
const LONG_URL_WITH_REPEATED_NON_CLOSERS = `https://example.com/${LONG_URL_SEGMENTS}final`;
const EXPLICIT_BOLD_LINK_MARKDOWN =
  '**[https://example.com**(\\`code\\`)](https://destination.test)**';
const URL_WITH_NON_ASCII_SYMBOL_AFTER_MARKER_MARKDOWN = '**https://example.com/**€(`code`)';
const BOLD_AUTOLINK_BEFORE_CJK_MARKDOWN =
  'PR 已开：**https://github.com/LodyAI/Lody/pull/317**，分支 `fix/mobile-staged-background-sync`。';
const AUTOLINK_BEFORE_CJK_PUNCTUATION_MARKDOWN = '见 https://example.com/a。然后是别的';
const AUTOLINK_WITH_CJK_PATH_MARKDOWN = '见 https://zh.example.com/wiki/中文 页面';
const URL_WITH_ASTRAL_PUNCTUATION_AFTER_MARKER_MARKDOWN = '**https://example.com**𐄀(`code`)';
const TRIPLE_STAR_BOLD_ITALIC_AUTOLINK_MARKDOWN = '***https://example.com***(_branch_)';
const ESCAPED_INTERNAL_DOUBLE_ASTERISK_MARKDOWN = '**https://example.com/\\*\\*path**(`code`)';
const HTML_ENTITY_BOLD_AUTOLINK_MARKDOWN =
  '**https://example.com/?a=1&amp;b=2**(`fix/some-branch` -> `main`)';

const buildStreamingMarkdownChunks = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const id = String(index).padStart(3, '0');
    return [
      `### Streaming section ${id}`,
      `Check agent-${id}@example.com and https://example.com/sessions/${id}?from=stream.`,
      `Also compare www.example.com/docs/${id} while this response keeps growing.`,
    ].join('\n');
  }).map((chunk) => `${chunk}\n\n`);

const countCumulativePrefixChars = (chunks: readonly string[]): number => {
  let prefixLength = 0;
  let total = 0;

  for (const chunk of chunks) {
    prefixLength += chunk.length;
    total += prefixLength;
  }

  return total;
};

describe('MarkdownRenderer streaming rendering', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  const renderMarkdown = async (
    text: string,
    props: Partial<ComponentProps<typeof MarkdownRenderer>> = {}
  ): Promise<void> => {
    if (!root) {
      throw new Error('Expected test root to be initialized');
    }

    await act(async () => {
      root?.render(createElement(MarkdownRenderer, { text, ...props }));
    });
  };

  const waitForElement = async (selector: string): Promise<Element> => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 1000) {
      const element = container?.querySelector(selector);
      if (element) {
        return element;
      }

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      });
    }

    throw new Error(`Expected element matching ${selector}`);
  };

  it('uses the GFM autolink path for email literals', async () => {
    await renderMarkdown('Contact agent-000@example.com before checking https://example.com.');

    expect(container?.querySelector('a[href="mailto:agent-000@example.com"]')).not.toBeNull();
  });

  it.each([false, true])(
    'repairs bold URLs followed by inline code while streaming=%s',
    async (isStreaming) => {
      await renderMarkdown(MALFORMED_BOLD_AUTOLINK_MARKDOWN, { isStreaming });

      const url = 'https://github.com/LodyAI/Lody/pull/262';
      const link = container?.querySelector(`[data-streamdown="strong"] a[href="${url}"]`);
      expect(link?.textContent).toBe(url);
      expect(container?.querySelector('[data-streamdown="strong"]')?.textContent).toBe(url);
      expect(container?.querySelector('code')?.textContent).toBe('fix/some-branch');
      expect(container?.textContent).toContain('fix/some-branch -> main');
      expect(container?.textContent).not.toContain('**');
    }
  );

  it('preserves an absolute destination when repairing a bold www autolink', async () => {
    await renderMarkdown(MALFORMED_BOLD_WWW_AUTOLINK_MARKDOWN);

    const link = container?.querySelector(
      '[data-streamdown="strong"] a[href="http://www.example.com"]'
    );
    expect(link?.textContent).toBe('www.example.com');
    expect(container?.textContent).toContain('fix/some-branch -> main');
  });

  it('adds an absolute scheme for mixed-case www autolinks', async () => {
    await renderMarkdown(MALFORMED_BOLD_MIXED_CASE_WWW_AUTOLINK_MARKDOWN);

    const link = container?.querySelector('[data-streamdown="strong"] a');
    expect(link?.getAttribute('href')).toBe('http://WWW.example.com');
    expect(link?.textContent).toBe('WWW.example.com');
  });

  it('does not split a URL at double asterisks followed by ordinary URL text', async () => {
    await renderMarkdown(URL_WITH_DOUBLE_ASTERISK_MARKDOWN);

    const link = container?.querySelector('a[href="https://example.com/path**segment"]');
    expect(link?.textContent).toBe('https://example.com/path**segment');
    expect(container?.querySelector('[data-streamdown="strong"]')).toBeNull();
  });

  it('does not split a URL when ordinary URL text precedes an inline code suffix', async () => {
    await renderMarkdown(URL_WITH_DOUBLE_ASTERISK_BEFORE_CODE_MARKDOWN);

    const link = container?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/path**segment(%60code%60)');
    expect(link?.textContent).toBe('https://example.com/path**segment(`code`)');
    expect(container?.querySelector('[data-streamdown="strong"]')).toBeNull();
    expect(container?.querySelector('code')).toBeNull();
  });

  it('searches past an invalid asterisk pair for a later valid closer', async () => {
    await renderMarkdown(URL_WITH_LATER_VALID_CLOSER_MARKDOWN);

    const link = container?.querySelector('[data-streamdown="strong"] a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a**b/c');
    expect(link?.textContent).toBe('https://example.com/a**b/c');
    expect(container?.querySelector('code')?.textContent).toBe('code');
  });

  it('handles many non-closing asterisk pairs before a valid closer', async () => {
    await renderMarkdown(LONG_URL_WITH_REPEATED_NON_CLOSERS_MARKDOWN);

    const link = container?.querySelector('[data-streamdown="strong"] a');
    expect(link?.getAttribute('href')).toBe(LONG_URL_WITH_REPEATED_NON_CLOSERS);
    expect(link?.textContent).toBe(LONG_URL_WITH_REPEATED_NON_CLOSERS);
    expect(container?.querySelector('code')?.textContent).toBe('code');
  });

  it('preserves explicit link destinations', async () => {
    await renderMarkdown(EXPLICIT_BOLD_LINK_MARKDOWN);

    const link = container?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://destination.test');
    expect(link?.textContent).toBe('https://example.com**(`code`)');
    expect(container?.querySelector('code')).toBeNull();
  });

  it('ends a bold autolink at full-width punctuation instead of swallowing the sentence', async () => {
    await renderMarkdown(BOLD_AUTOLINK_BEFORE_CJK_MARKDOWN);

    const url = 'https://github.com/LodyAI/Lody/pull/317';
    const link = container?.querySelector(`[data-streamdown="strong"] a[href="${url}"]`);
    expect(link?.textContent).toBe(url);
    expect(container?.querySelector('code')?.textContent).toBe('fix/mobile-staged-background-sync');
    expect(container?.textContent).toContain('，分支');
    expect(container?.textContent).not.toContain('**');
  });

  it('ends a bare autolink at full-width punctuation', async () => {
    await renderMarkdown(AUTOLINK_BEFORE_CJK_PUNCTUATION_MARKDOWN);

    const link = container?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.textContent).toBe('https://example.com/a');
    expect(container?.textContent).toBe('见 https://example.com/a。然后是别的');
  });

  it('keeps non-ASCII letters that belong to the URL path', async () => {
    await renderMarkdown(AUTOLINK_WITH_CJK_PATH_MARKDOWN);

    const link = container?.querySelector('a');
    expect(link?.textContent).toBe('https://zh.example.com/wiki/中文');
  });

  it('does not treat a non-ASCII symbol as Markdown punctuation after the marker', async () => {
    await renderMarkdown(URL_WITH_NON_ASCII_SYMBOL_AFTER_MARKER_MARKDOWN);

    expect(container?.querySelector('[data-streamdown="strong"]')).toBeNull();
    expect(container?.querySelector('code')).toBeNull();
    expect(container?.textContent).toContain('https://example.com/**€(`code`)');
  });

  it('recognizes astral Unicode punctuation after a strong closer', async () => {
    await renderMarkdown(URL_WITH_ASTRAL_PUNCTUATION_AFTER_MARKER_MARKDOWN);

    const link = container?.querySelector('[data-streamdown="strong"] a');
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.textContent).toBe('https://example.com');
    expect(container?.querySelector('code')?.textContent).toBe('code');
  });

  it('does not reduce triple-star emphasis to a strong link', async () => {
    await renderMarkdown(TRIPLE_STAR_BOLD_ITALIC_AUTOLINK_MARKDOWN);

    expect(container?.querySelector('[data-streamdown="strong"]')).toBeNull();
    expect(container?.textContent).toContain('https://example.com');
  });

  it('searches past an escaped URL marker for a later valid closer', async () => {
    await renderMarkdown(ESCAPED_INTERNAL_DOUBLE_ASTERISK_MARKDOWN);

    const link = container?.querySelector('[data-streamdown="strong"] a');
    expect(link?.getAttribute('href')).toBe('https://example.com/%5C*%5C*path');
    expect(link?.textContent).toBe('https://example.com/\\*\\*path');
    expect(container?.querySelector('code')?.textContent).toBe('code');
  });

  it('repairs bold autolinks when the URL contains an HTML entity', async () => {
    await renderMarkdown(HTML_ENTITY_BOLD_AUTOLINK_MARKDOWN);

    const link = container?.querySelector('[data-streamdown="strong"] a');
    expect(link?.getAttribute('href')).toBe('https://example.com/?a=1&amp;b=2');
    expect(link?.textContent).toBe('https://example.com/?a=1&amp;b=2');
    expect(container?.querySelector('code')?.textContent).toBe('fix/some-branch');
    expect(container?.textContent).toContain('fix/some-branch -> main');
  });

  it.each([
    ESCAPED_BOLD_AUTOLINK_MARKDOWN,
    ESCAPED_BOLD_OPENER_AUTOLINK_MARKDOWN,
    ESCAPED_BOLD_CLOSER_AUTOLINK_MARKDOWN,
  ])('does not turn escaped bold markers into formatting: %s', async (markdown) => {
    await renderMarkdown(markdown);

    expect(container?.querySelector('[data-streamdown="strong"]')).toBeNull();
    expect(container?.textContent).toContain('**');
  });

  it('keeps raw HTML escaped by default', async () => {
    await renderMarkdown('Hello <strong>raw</strong>.');

    expect(container?.querySelector('[data-streamdown="strong"]')).toBeNull();
    expect(container?.textContent).toContain('<strong>raw</strong>');
  });

  it('labels the icon-only code copy button', async () => {
    await renderMarkdown('```ts\nconst answer = 42;\n```');

    const copyButton = await waitForElement('[data-streamdown="code-block-copy-button"]');
    expect(copyButton.getAttribute('aria-label')).toBe('Copy code');
  });

  it('renders headerless diff fences with semantic line rows and existing code controls', async () => {
    await renderMarkdown(
      [
        '```diff',
        ' resolveSource(session)',
        '-  return staleProvider',
        '+  return localFiles',
        '@@ -8,1 +8,1 @@',
        '--- a/source.ts',
        '+++ b/source.ts',
        '```',
      ].join('\n')
    );

    const diffBlock = await waitForElement('[data-markdown-diff-block="true"]');
    expect(diffBlock.getAttribute('data-language')).toBe('diff');
    expect(diffBlock.querySelectorAll('[data-markdown-diff-line="context"]')).toHaveLength(1);
    expect(diffBlock.querySelectorAll('[data-markdown-diff-line="deletion"]')).toHaveLength(1);
    expect(diffBlock.querySelectorAll('[data-markdown-diff-line="addition"]')).toHaveLength(1);
    expect(diffBlock.querySelectorAll('[data-markdown-diff-line="hunk"]')).toHaveLength(1);
    expect(diffBlock.querySelectorAll('[data-markdown-diff-line="metadata"]')).toHaveLength(2);
    expect(
      diffBlock
        .querySelector('[data-streamdown="code-block-copy-button"]')
        ?.getAttribute('aria-label')
    ).toBe('Copy code');
  });

  it('keeps an incomplete streaming diff fence in the semantic renderer', async () => {
    await renderMarkdown(['```diff', '-old source', '+new source'].join('\n'), {
      isStreaming: true,
    });

    const diffBlock = await waitForElement('[data-markdown-diff-block="true"]');
    expect(diffBlock.getAttribute('data-incomplete')).toBe('true');
    expect(diffBlock.querySelectorAll('[data-markdown-diff-line="deletion"]')).toHaveLength(1);
    expect(diffBlock.querySelectorAll('[data-markdown-diff-line="addition"]')).toHaveLength(1);
  });

  it('renders sanitized raw HTML when allowHtml is enabled', async () => {
    await renderMarkdown('Hello <strong>raw</strong>.', { allowHtml: true });

    expect(container?.querySelector('[data-streamdown="strong"]')?.textContent).toBe('raw');
  });

  it('renders Streamdown native LaTeX and Mermaid blocks', async () => {
    await renderMarkdown(
      [
        'Inline LaTeX $E = mc^2$ should render.',
        '',
        '```mermaid',
        'graph TD',
        '  A-->B',
        '```',
      ].join('\n')
    );

    expect(container?.querySelector('.katex')).not.toBeNull();
    expect(await waitForElement('[data-streamdown="mermaid-block"]')).not.toBeNull();
  });

  it('renders Codex-style parenthesis and bracket LaTeX delimiters', async () => {
    await renderMarkdown(
      [
        'Let \\(t_i\\) denote the token allocation.',
        '',
        '\\[',
        '\\boxed{DV(t^*)[a]}',
        '=',
        '\\int \\xi_i a_i\\,di',
        '\\]',
        '',
        'where \\(\\xi_i = \\underbrace{V_z / \\Lambda}_{\\text{social value}} r_{i,t}\\).',
      ].join('\n')
    );

    expect(container?.querySelectorAll('.katex')).toHaveLength(3);
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('keeps Codex-style LaTeX delimiters literal inside Markdown code', async () => {
    await renderMarkdown(
      [
        '`\\(inline_code\\)`',
        '',
        '```tex',
        '\\[',
        'fenced_code',
        '\\]',
        '```',
        '',
        'Outside \\(x_i\\) renders.',
      ].join('\n')
    );

    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.querySelector('code')?.textContent).toBe('\\(inline_code\\)');
    expect(container?.textContent).toContain('\\[fenced_code\\]');
  });

  it('keeps LaTeX delimiters literal in indented code blocks', async () => {
    await renderMarkdown(['    \\(literal\\)', '', 'Outside \\(x_i\\) renders.'].join('\n'));

    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.querySelector('pre code')?.textContent).toContain('\\(literal\\)');
  });

  it('keeps LaTeX delimiters literal in container-nested fenced code', async () => {
    await renderMarkdown(
      [
        '> ```tex',
        '> \\(blockquote_literal\\)',
        '> ```',
        '',
        '- ~~~tex',
        '  \\[list_literal\\]',
        '  ~~~',
        '',
        '> - ````tex',
        '>   \\(nested_literal\\)',
        '>   ````',
        '',
        '10. ```tex',
        '    \\(ordered_list_literal\\)',
        '    ```',
        '',
        'Outside \\(x_i\\) renders.',
      ].join('\n')
    );

    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.textContent).toContain('\\(blockquote_literal\\)');
    expect(container?.textContent).toContain('\\[list_literal\\]');
    expect(container?.textContent).toContain('\\(nested_literal\\)');
    expect(container?.textContent).toContain('\\(ordered_list_literal\\)');
  });

  it('does not parse dollars inside code spans or link labels as LaTeX', async () => {
    await renderMarkdown(
      [
        'See [upload.$key.tsx](/home/agent/project/src/routes/api/upload.$key.tsx:9)',
        'and `r2.$.tsx` before checking the next file.',
      ].join(' ')
    );

    expect(container?.querySelector('.katex')).toBeNull();
    expect(container?.textContent).toContain('upload.$key.tsx');
    expect(container?.textContent).toContain('r2.$.tsx');
    const fileLinkButton = container?.querySelector(
      'button[title="/home/agent/project/src/routes/api/upload.$key.tsx:9"]'
    );
    expect(fileLinkButton).not.toBeNull();
  });

  it('uses Mermaid theme variables with readable dark-mode foregrounds and lines', () => {
    const lightConfig = createMarkdownMermaidConfig('light');
    const darkConfig = createMarkdownMermaidConfig('dark');

    expect(lightConfig.theme).toBe('base');
    expect(darkConfig.theme).toBe('base');
    expect(darkConfig.darkMode).toBe(true);
    expect(darkConfig.themeVariables).toMatchObject({
      primaryTextColor: '#f8fafc',
      lineColor: '#cbd5e1',
      textColor: '#e2e8f0',
    });
    expect(darkConfig.themeVariables).not.toBe(lightConfig.themeVariables);
  });

  it('keeps incomplete streaming Markdown rendered without per-word animation spans', async () => {
    await renderMarkdown(
      ['Streaming words are still arriving.', '', '```ts', 'const answer = 42;'].join('\n'),
      { isStreaming: true }
    );

    expect(container?.textContent).toContain('Streaming words are still arriving.');
    expect(await waitForElement('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container?.querySelector('[data-sd-animate]')).toBeNull();
  });

  it('does not render Streamdown caret placeholders while streaming', async () => {
    await renderMarkdown('Streaming text should not reserve a cursor placeholder.', {
      isStreaming: true,
    });

    expect(container?.innerHTML).not.toContain('--streamdown-caret');
    expect(container?.innerHTML).not.toContain('content-[var(--streamdown-caret)]');
  });

  it('keeps GFM autolinks available across streaming renders', async () => {
    const chunks = buildStreamingMarkdownChunks(STREAM_CHUNK_COUNT);
    const finalText = chunks.join('');
    let streamingText = '';
    let cumulativeRenderedInputChars = 0;

    const streamingStartedAt = performance.now();
    for (const chunk of chunks) {
      streamingText += chunk;
      cumulativeRenderedInputChars += streamingText.length;
      await renderMarkdown(streamingText, { isStreaming: true });
    }
    const streamingElapsedMs = performance.now() - streamingStartedAt;

    const amplification = cumulativeRenderedInputChars / finalText.length;
    const finalEmail = `mailto:agent-${String(STREAM_CHUNK_COUNT - 1).padStart(3, '0')}@example.com`;
    const finalOnlyContainer = document.createElement('div');
    document.body.appendChild(finalOnlyContainer);
    const finalOnlyRoot = createRoot(finalOnlyContainer);
    let finalOnlyElapsedMs = 0;

    try {
      const finalOnlyStartedAt = performance.now();
      await act(async () => {
        finalOnlyRoot.render(createElement(MarkdownRenderer, { text: finalText }));
      });
      finalOnlyElapsedMs = performance.now() - finalOnlyStartedAt;
      expect(finalOnlyContainer.querySelector(`a[href="${finalEmail}"]`)).not.toBeNull();
    } finally {
      await act(async () => {
        finalOnlyRoot.unmount();
      });
      finalOnlyContainer.remove();
    }

    expect(streamingText).toBe(finalText);
    expect(cumulativeRenderedInputChars).toBe(countCumulativePrefixChars(chunks));
    expect(amplification).toBeGreaterThan(20);
    expect(container?.querySelector(`a[href="${finalEmail}"]`)).not.toBeNull();

    console.info(
      [
        'markdown streamdown streaming render',
        `finalChars=${finalText.length}`,
        `cumulativeRenderedInputChars=${cumulativeRenderedInputChars}`,
        `amplification=${amplification.toFixed(1)}x`,
        `streamingElapsedMs=${streamingElapsedMs.toFixed(1)}`,
        `finalOnlyElapsedMs=${finalOnlyElapsedMs.toFixed(1)}`,
      ].join(' ')
    );
  });
});
