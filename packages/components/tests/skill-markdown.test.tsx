import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  renderInlineMarkdown,
  SkillMarkdownFallback,
} from '../src/components/settings/skill-markdown';

function inlineHtml(text: string): string {
  return renderToStaticMarkup(<>{renderInlineMarkdown(text, 'k')}</>);
}

describe('renderInlineMarkdown', () => {
  it('renders bold, italic and inline code', () => {
    const html = inlineHtml('a **b** c *d* e `f`');
    expect(html).toContain('<strong');
    expect(html).toContain('>b</strong>');
    expect(html).toContain('<em');
    expect(html).toContain('<code');
    expect(html).toContain('>f</code>');
  });

  it('renders safe links and drops unsafe schemes', () => {
    expect(inlineHtml('[ok](https://x.com)')).toContain('href="https://x.com"');
    const unsafe = inlineHtml('[no](javascript:alert(1))');
    expect(unsafe).not.toContain('href');
    expect(unsafe).toContain('no');
  });

  it('prefers bold over italic at the same position', () => {
    const html = inlineHtml('**x**');
    expect(html).toContain('<strong');
    expect(html).not.toContain('<em');
  });
});

describe('SkillMarkdownFallback', () => {
  it('renders headings, lists and fenced code as elements (not raw text)', () => {
    const html = renderToStaticMarkup(
      <SkillMarkdownFallback content={'# Title\n\n- one\n- two\n\n```\ncode()\n```'} />
    );
    expect(html).toContain('<h1');
    expect(html).toContain('>Title</h1>');
    expect(html).toContain('<ul');
    expect(html).toContain('>one</li>');
    expect(html).toContain('<pre');
    expect(html).toContain('code()');
    // The literal markdown markers should not survive as text.
    expect(html).not.toContain('# Title');
  });
});
