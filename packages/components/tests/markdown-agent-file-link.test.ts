import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import { remarkCodexFileCitations } from '../src/lib/remark-codex-file-citations';
import { describe, expect, it } from 'vitest';
import {
  isMarkdownAgentFileHref,
  normalizeMarkdownAgentFilePath,
} from '../src/lib/markdown-agent-file-link';

describe('Codex file citations through Markdown', () => {
  const renderCitation = (text: string) =>
    renderToStaticMarkup(
      createElement(
        Markdown,
        {
          remarkPlugins: [remarkMath, remarkCodexFileCitations],
          urlTransform: (href) =>
            isMarkdownAgentFileHref(href) ? href : defaultUrlTransform(href),
          components: {
            a: ({ node, href, children }) =>
              createElement(
                'span',
                {
                  'data-card': node?.properties?.['data-codex-file-citation'] === true,
                  'data-path': href ? decodeURIComponent(href) : '',
                },
                children
              ),
          },
        },
        text
      )
    );

  it('preserves surrounding prose and literal path punctuation', () => {
    const html = renderCitation(
      'Before :codex-file-citation{purpose="output" path="\n/tmp/预算 100% #1.xlsx\n" artifact_kind="workbook"} after'
    );
    expect(html).toContain('data-card="true"');
    expect(html).toContain('data-path="/tmp/预算 100% #1.xlsx"');
    expect(html).toContain('Before ');
    expect(html).toContain(' after');
    expect(html).not.toContain('codex-file-citation');
  });

  it.each([
    String.raw`C:\Users\agent\预算 draft.xlsx`,
    'C:/Users/agent/预算 draft.xlsx',
    String.raw`d:\exports\report 100% #1.xlsx`,
  ])('preserves drive-qualified artifact targets: %s', (path) => {
    const normalized = path.replace(/\\/gu, '/');
    const html = renderCitation(`:codex-file-citation{path="${path}" purpose="output"}`);
    expect(html).toContain('data-card="true"');
    expect(html).toContain(`data-path="${normalized}"`);
    expect(html).toContain(`>${normalized.split('/').pop()}</span>`);
    expect(normalizeMarkdownAgentFilePath(normalized, 'C:/workspace', true)).toBe(normalized);
  });

  it('preserves math leaf nodes alongside citation cards', () => {
    const html = renderCitation(
      'Before $x^2$ after.\n\n$$\ny = x + 1\n$$\n\n:codex-file-citation{path="/tmp/report.pdf"}'
    );
    expect(html).toContain('math-inline');
    expect(html).toContain('math-display');
    expect(html).toContain('x^2');
    expect(html).toContain('y = x + 1');
    expect(html).toContain('data-card="true"');
  });

  it.each([
    ':codex-file-citation{path=""}',
    ':codex-file-citation{path="https://example.com/a.xlsx"}',
    ':codex-file-citation{path="javascript:alert(1)"}',
    ':codex-file-citation{path="//example.com/a.xlsx"}',
    ':codex-file-citation{path="/tmp/a\nb.xlsx"}',
    ':codex-file-citation{path="/tmp/a.xlsx" path="/tmp/b.xlsx"}',
    ':codex-file-citation{path="/tmp/a.xlsx"',
    '` :codex-file-citation{path="/tmp/a.xlsx"} `',
    '```text\n:codex-file-citation{path="/tmp/a.xlsx"}\n```',
  ])('does not create a card for %s', (text) => {
    expect(renderCitation(text)).not.toContain('data-card="true"');
  });
});
