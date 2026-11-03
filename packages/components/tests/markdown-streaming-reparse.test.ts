// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';

import { inlineMathEnabledAtom } from '../src/atoms/settings';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
const INLINE_DISPLAY_MATH_CONTEXT_MARKDOWN = String.raw`The unrestricted identity is:

\[
F(x) = G(x)+O(1)
\]

An estimate may resemble\[
F^{p(t)}(x)
\le G^t(x)+O(1)
\]

Here \(p\) is a polynomial.`;
const PARENTHESIS_INLINE_MATH_MARKDOWN = String.raw`The variable \(x\) is a parameter.`;
const NORMALIZED_INLINE_MATH_MARKDOWN = 'The variable $$x$$ is a parameter.';

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
    document.getSelection()?.removeAllRanges();
    container?.remove();
    container = undefined;
    localStorage.removeItem('lody-inline-math-enabled');
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

  const renderMarkdownWithStore = async (
    text: string,
    store: ReturnType<typeof createStore>,
    props: Partial<ComponentProps<typeof MarkdownRenderer>> = {}
  ): Promise<void> => {
    if (!root) {
      throw new Error('Expected test root to be initialized');
    }

    await act(async () => {
      root?.render(
        createElement(Provider, { store }, createElement(MarkdownRenderer, { text, ...props }))
      );
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

  it.each([false, true])(
    'renders CJK emphasis next to punctuation and prose while streaming=%s',
    async (isStreaming) => {
      const source =
        '“**示例流程正确。**”\n\n**检查完成。**接着执行下一步。\n\n前文**“重点”**后文\n\n前文*“提示”*后文';
      await renderMarkdown(source, { isStreaming });

      expect(Array.from(container!.querySelectorAll('strong'), (node) => node.textContent)).toEqual(
        ['示例流程正确。', '检查完成。', '“重点”']
      );
      expect(container?.querySelector('em')?.textContent).toBe('“提示”');
      expect(container?.textContent).not.toContain('*');

      await renderMarkdown(source, { isStreaming: false });
      expect(container?.querySelectorAll('strong')).toHaveLength(3);
      expect(container?.textContent).not.toContain('*');
    }
  );

  it.each([false, true])(
    'preserves escaped and code CJK emphasis while streaming=%s',
    async (isStreaming) => {
      const literal = '**检查完成。**接着执行下一步。';
      await renderMarkdown(
        [
          String.raw`\*\*检查完成。\*\*接着执行下一步。`,
          '`' + literal + '`',
          '```text\n' + literal + '\n```',
          '**Done.**Next',
        ].join('\n\n'),
        { isStreaming }
      );
      expect(container?.querySelector('strong')).toBeNull();
      expect(container?.querySelector('em')).toBeNull();
      expect(container?.querySelector('p')?.textContent).toBe(literal);
      expect(container?.querySelector('p code')?.textContent).toBe(literal);
      expect(container?.querySelector('pre code')?.textContent).toBe(literal);
      expect(container?.textContent).toContain('**Done.**Next');
    }
  );

  it.each([false, true])(
    'preserves the rest of a math document after a less-than comparison while streaming=%s',
    async (isStreaming) => {
      await renderMarkdown(
        String.raw`# Synthetic calculation

Inline notation \(p<q\) stays in the document.

\[
 T(e_p\otimes e_q)=c_{pq}(e_q\otimes e_p)\quad(p<q),
\]

## Later section

The entire document remains readable.

\[
\begin{aligned}
 f_0&=b_0-c,\\
 f_1&=b_1-c.
\end{aligned}
\]

## References

End of synthetic document.`,
        { isStreaming }
      );
      if (isStreaming) await waitForElement('.streamdown-animated');

      expect(container?.textContent).toContain('End of synthetic document.');
      expect(container?.querySelectorAll('.katex-display')).toHaveLength(2);
    }
  );

  it.each([false, true])(
    'repairs bold URLs followed by inline code while streaming=%s',
    async (isStreaming) => {
      await renderMarkdown(MALFORMED_BOLD_AUTOLINK_MARKDOWN, { isStreaming });

      const url = 'https://github.com/LodyAI/Lody/pull/262';
      // The link ends exactly at the URL; a bare PR URL renders as its reference label.
      const link = container?.querySelector(`strong a[href="${url}"]`);
      expect(link?.querySelector('[data-github-reference="pull"]')?.textContent).toBe(
        'PR LodyAI/Lody#262'
      );
      expect(container?.querySelector('strong')?.textContent).toBe('PR LodyAI/Lody#262');
      expect(container?.querySelector('code')?.textContent).toBe('fix/some-branch');
      expect(container?.textContent).toContain('fix/some-branch -> main');
      expect(container?.textContent).not.toContain('**');
    }
  );

  it('preserves explicit link destinations', async () => {
    await renderMarkdown(EXPLICIT_BOLD_LINK_MARKDOWN);

    const link = container?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://destination.test');
    expect(link?.textContent).toBe('https://example.com**(`code`)');
    expect(container?.querySelector('code')).toBeNull();
  });

  it('copies a table as Markdown from its copy button', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await renderMarkdown(
      ['| Name | Notes |', '| --- | --- |', '| a | x \\| y |', '| b | plain |'].join('\n')
    );

    const copy = container?.querySelector<HTMLButtonElement>('button[aria-label="Copy table"]');
    expect(copy).not.toBeNull();
    await act(async () => {
      copy?.click();
    });

    // No rich clipboard in the test DOM: the Markdown text is what is copied.
    expect(writeText).toHaveBeenCalledWith(
      ['| Name | Notes |', '| --- | --- |', '| a | x \\| y |', '| b | plain |'].join('\n')
    );
    expect(copy?.getAttribute('aria-label')).toBe('Copied');
  });

  it('renders links that only name a GitHub PR or issue as reference labels', async () => {
    await renderMarkdown(
      [
        'Opened https://github.com/LodyAI/Lody/pull/954 and [#12](https://github.com/acme/app/issues/12).',
        'Also [LodyAI/Lody#7](https://github.com/LodyAI/Lody/pull/7/files).',
        'But [the fix](https://github.com/LodyAI/Lody/pull/955) and [#13](https://github.com/acme/app/issues/99) stay links.',
      ].join('\n\n')
    );

    const reference = (href: string) =>
      container?.querySelector(`a[href="${href}"] [data-github-reference]`) ?? null;
    expect(reference('https://github.com/LodyAI/Lody/pull/954')?.textContent).toBe(
      'PR LodyAI/Lody#954'
    );
    expect(reference('https://github.com/acme/app/issues/12')?.textContent).toBe(
      'Issue acme/app#12'
    );
    expect(reference('https://github.com/LodyAI/Lody/pull/7/files')?.textContent).toBe(
      'PR LodyAI/Lody#7'
    );
    // Descriptive text, or a number that does not match the URL, keeps the plain link.
    expect(reference('https://github.com/LodyAI/Lody/pull/955')).toBeNull();
    expect(
      container?.querySelector('a[href="https://github.com/LodyAI/Lody/pull/955"]')?.textContent
    ).toBe('the fix');
    expect(reference('https://github.com/acme/app/issues/99')).toBeNull();
  });

  it('ends a bold autolink at full-width punctuation instead of swallowing the sentence', async () => {
    await renderMarkdown(BOLD_AUTOLINK_BEFORE_CJK_MARKDOWN);

    const url = 'https://github.com/LodyAI/Lody/pull/317';
    const link = container?.querySelector(`strong a[href="${url}"]`);
    expect(link?.textContent).toBe('PR LodyAI/Lody#317');
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

  it.each([
    ESCAPED_BOLD_AUTOLINK_MARKDOWN,
    ESCAPED_BOLD_OPENER_AUTOLINK_MARKDOWN,
    ESCAPED_BOLD_CLOSER_AUTOLINK_MARKDOWN,
  ])('does not turn escaped bold markers into formatting: %s', async (markdown) => {
    await renderMarkdown(markdown);

    expect(container?.querySelector('strong')).toBeNull();
    expect(container?.textContent).toContain('**');
  });

  it('keeps raw HTML escaped by default', async () => {
    await renderMarkdown('Hello <strong>raw</strong>.');

    expect(container?.querySelector('strong')).toBeNull();
    expect(container?.textContent).toContain('<strong>raw</strong>');
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

  it('reapplies HTML policy to the same parsed text after static remounts', async () => {
    const source =
      'Hello <strong>raw</strong><img src="x" onerror="alert(1)"><script>alert(1)</script>.';
    for (const allowHtml of [true, false, true]) {
      await act(async () => root?.render(null));
      await renderMarkdown(source, { allowHtml });
      expect(container?.querySelector('strong')?.textContent ?? null).toBe(
        allowHtml ? 'raw' : null
      );
      expect(container?.querySelector('script')).toBeNull();
      expect(container?.querySelector('[onerror]')).toBeNull();
    }
  });

  it('keeps inline LaTeX literal while rendering Mermaid blocks', async () => {
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

    expect(container?.querySelector('.katex')).toBeNull();
    expect(container?.textContent).toContain('$E = mc^2$');
    expect(await waitForElement('[data-streamdown="mermaid-block"]')).not.toBeNull();
  });

  it('renders inline dollar and parenthesis math when the preference is enabled', async () => {
    const store = createStore();
    store.set(inlineMathEnabledAtom, true);
    await renderMarkdownWithStore('Inline $E = mc^2$ and \\(t_i\\).', store);

    expect(container?.querySelectorAll('.katex')).toHaveLength(2);
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(0);
  });

  const copyRange = async (range: Range) => {
    await vi.dynamicImportSettled();
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const contents = new Map<string, string>();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (format: string, value: string) => contents.set(format, value) },
    });
    container!.dispatchEvent(event);
    return { event, contents };
  };

  it.each([false, true])(
    'copies inline math with surrounding prose while streaming=%s',
    async (isStreaming) => {
      const store = createStore();
      store.set(inlineMathEnabledAtom, true);
      await renderMarkdownWithStore(String.raw`Before $\frac{a}{b}$ after.`, store, {
        isStreaming,
      });
      if (isStreaming)
        await act(async () => {
          await import('@lobehub/streamdown');
        });

      const range = document.createRange();
      range.selectNodeContents(container!.querySelector('p')!);
      const { event, contents } = await copyRange(range);

      expect(event.defaultPrevented).toBe(true);
      expect(contents.get('text/plain')).toBe(String.raw`Before $\frac{a}{b}$ after.`);
      const html = document.createElement('div');
      html.innerHTML = contents.get('text/html')!;
      expect(html.querySelector('.katex')).not.toBeNull();
      expect(html.textContent).toContain('Before ');
      expect(html.textContent).toContain(' after.');
    }
  );

  it.each([false, true])('copies display math as LaTeX while streaming=%s', async (isStreaming) => {
    await renderMarkdown('$$\nx^2 + y^2 = z^2\n$$', { isStreaming });
    if (isStreaming)
      await act(async () => {
        await import('@lobehub/streamdown');
      });

    const range = document.createRange();
    range.selectNode(container!.querySelector('.katex-display')!);
    const { contents } = await copyRange(range);

    expect(contents.get('text/plain')?.trim()).toBe('$$x^2 + y^2 = z^2$$');
  });

  it('copies the complete formula when only part of its rendered text is selected', async () => {
    const store = createStore();
    store.set(inlineMathEnabledAtom, true);
    await renderMarkdownWithStore('Before $x+y$ after.', store);

    const range = document.createRange();
    range.selectNodeContents(container!.querySelector('.katex-html .mord')!);
    expect(range.toString()).toBe('x');
    expect((await copyRange(range)).contents.get('text/plain')).toBe('$x+y$');
  });

  it('leaves ordinary prose copying to the browser', async () => {
    await renderMarkdown('Plain text and `literal code`.');
    const range = document.createRange();
    range.selectNodeContents(container!.querySelector('p')!);
    const { event, contents } = await copyRange(range);

    expect(event.defaultPrevented).toBe(false);
    expect(contents.size).toBe(0);
  });

  it('updates an existing renderer when the inline math preference changes', async () => {
    const store = createStore();
    await renderMarkdownWithStore(PARENTHESIS_INLINE_MATH_MARKDOWN, store);
    expect(container?.querySelectorAll('.katex')).toHaveLength(0);
    expect(container?.textContent).toContain('(x)');

    await act(async () => {
      store.set(inlineMathEnabledAtom, true);
    });

    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.textContent).not.toContain('$$x$$');
  });

  it('reparses a mounted streaming renderer when inline math is enabled', async () => {
    const store = createStore();
    const text = PARENTHESIS_INLINE_MATH_MARKDOWN;
    await renderMarkdownWithStore(text, store, { isStreaming: true });
    expect(container?.querySelectorAll('.katex')).toHaveLength(0);

    await act(async () => {
      store.set(inlineMathEnabledAtom, true);
    });

    await act(async () => {
      await import('@lobehub/streamdown');
    });
    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.textContent).not.toContain('$$x$$');
  });

  it('renders same-line bracket math after prose with the inline preference off', async () => {
    await renderMarkdown(String.raw`令\[x+y\]。`);

    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(0);
    expect(container?.textContent).toContain('x+y');
  });

  it('keeps code literal when inline math is enabled', async () => {
    const store = createStore();
    store.set(inlineMathEnabledAtom, true);
    await renderMarkdownWithStore(
      [
        '`\\(inline_code\\)`',
        '',
        '```tex',
        '\\[',
        'fenced_code',
        '\\]',
        '```',
        '',
        '\\(x_i\\)',
      ].join('\n'),
      store
    );

    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.querySelector('code')?.textContent).toBe('\\(inline_code\\)');
    expect(container?.textContent).toContain('\\[fenced_code\\]');
  });

  it('keeps inline delimiters in links literal when enabled', async () => {
    const store = createStore();
    store.set(inlineMathEnabledAtom, true);
    await renderMarkdownWithStore('[\\(x_i\\)](https://example.com)', store);

    expect(container?.querySelectorAll('.katex')).toHaveLength(0);
    expect(container?.querySelector('a')?.textContent).toContain('(x_i)');
  });

  it('keeps parenthesis LaTeX literal while rendering bracket display LaTeX', async () => {
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

    expect(container?.querySelectorAll('.katex')).toHaveLength(1);
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container?.textContent).toContain('(t_i)');
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

    expect(container?.querySelectorAll('.katex')).toHaveLength(0);
    expect(container?.textContent).toContain('\\(blockquote_literal\\)');
    expect(container?.textContent).toContain('\\[list_literal\\]');
    expect(container?.textContent).toContain('\\(nested_literal\\)');
    expect(container?.textContent).toContain('\\(ordered_list_literal\\)');
  });

  it('renders multiline Codex citations as file cards and opens their exact target', async () => {
    let opened = '';
    await renderMarkdown(
      'Ready: :codex-file-citation{path="\n/tmp/exports/预算 draft.xlsx\n" purpose="output" artifact_kind="workbook"} Done.',
      {
        onAgentFileLinkClick: (href) => {
          opened = decodeURIComponent(href);
        },
      }
    );
    const button = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="预算 draft.xlsx"]'
    );
    expect(button).not.toBeNull();
    expect(container?.textContent).not.toContain('codex-file-citation');
    expect(container?.textContent).toContain('Ready:');
    expect(container?.textContent).toContain('Done.');
    expect(container?.querySelector('p div')).toBeNull();
    await act(async () => {
      button?.click();
    });
    expect(opened).toBe('/tmp/exports/预算 draft.xlsx');
  });

  it('leaves code examples and incomplete citations as text until completed', async () => {
    const citation = ':codex-file-citation{path="/tmp/report.pdf"}';
    await renderMarkdown('`' + citation + '`\n\n```text\n' + citation + '\n```');
    expect(container?.querySelector('button[aria-label="report.pdf"]')).toBeNull();
    expect(container?.querySelector('code')?.textContent).toBe(citation);
    await renderMarkdown(citation.slice(0, -1));
    expect(container?.querySelector('button[aria-label="report.pdf"]')).toBeNull();
    await renderMarkdown(citation + ' ' + citation);
    expect(container?.querySelectorAll('button[aria-label="report.pdf"]')).toHaveLength(2);
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
});
