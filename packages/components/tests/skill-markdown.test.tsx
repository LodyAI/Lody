// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectSkill } from '@lody/shared';
import { SkillDetailContent } from '../src/components/settings/skill-detail';
import { ProjectSkillsView } from '../src/components/settings/project-skills-tab';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { initI18n } from '../src/i18n';
import {
  renderInlineMarkdown,
  SkillMarkdownFallback,
} from '../src/components/settings/skill-markdown';

const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/components/ai-gui/markdown-renderer', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/components/ai-gui/markdown-renderer')>();
  return {
    ...actual,
    MarkdownRenderer: (props: React.ComponentProps<typeof actual.MarkdownRenderer>) => {
      if (failure.enabled) throw new Error('Synthetic highlighter failure');
      return <actual.MarkdownRenderer {...props} />;
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CONTENT = [
  '[Handle rebase conflicts](#handle-rebase-conflicts-agent-workflow)',
  '[中文](#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98) [Repeat](#repeat-1)',
  '[Nested](#nested-heading) [Missing](#absent) [Broken](#%ZZ)',
  '[External](https://example.com/guide#section)',
  '',
  '## Handle rebase conflicts (agent workflow)',
  '## 中文标题',
  '## Repeat',
  '## Repeat',
  '> ### Nested **heading**',
  '###### Deep `code` [link](https://example.com)',
].join('\n');

const SKILL: ProjectSkill = {
  id: 'synthetic-skill',
  name: 'anchor-demo',
  relativePath: '.agents/skills/anchor-demo',
  isSymlink: false,
  content: CONTENT,
};

describe('skill detail fragment navigation', () => {
  let host: HTMLDivElement;
  let root: Root;
  let scrolled: HTMLElement | undefined;
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

  beforeAll(async () => {
    await initI18n('en');
  });
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    scrolled = undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: function (this: HTMLElement) {
        scrolled = this;
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    failure.enabled = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  const click = async (link: HTMLElement) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(event);
    });
    return event;
  };

  for (const fallback of [false, true]) {
    it(`navigates locally with Chinese, duplicate and nested headings (${fallback ? 'fallback' : 'primary'})`, async () => {
      failure.enabled = fallback;
      await act(async () =>
        root.render(
          <>
            <SkillDetailContent skill={SKILL} />
            <SkillDetailContent skill={SKILL} />
          </>
        )
      );
      const details = host.children[1]!;
      const location = window.location.href;
      const ids = Array.from(details.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((node) => node.id);
      expect(ids).toEqual([
        'handle-rebase-conflicts-agent-workflow',
        '中文标题',
        'repeat',
        'repeat-1',
        'nested-heading',
        'deep-code-link',
      ]);
      const links = Array.from(details.querySelectorAll<HTMLAnchorElement>('a'));
      for (const [label, id] of [
        ['Handle rebase conflicts', ids[0]!],
        ['中文', ids[1]!],
        ['Repeat', 'repeat-1'],
        ['Nested', 'nested-heading'],
      ]) {
        const link = links.find((node) => node.textContent === label)!;
        expect(link.hasAttribute('target')).toBe(false);
        expect((await click(link)).defaultPrevented).toBe(true);
        expect(scrolled?.id).toBe(id);
        expect(details.contains(scrolled!)).toBe(true);
        expect(document.activeElement).toBe(scrolled);
        expect(window.location.href).toBe(location);
      }
      const heading = document.activeElement;
      for (const label of ['Missing', 'Broken']) {
        expect(
          (await click(links.find((node) => node.textContent === label)!)).defaultPrevented
        ).toBe(true);
        expect(document.activeElement).toBe(heading);
      }
      const external = links.find((node) => node.textContent === 'External')!;
      expect(external.target).toBe('_blank');
      expect(external.rel).toContain('noopener');
      expect((await click(external)).defaultPrevented).toBe(false);
      expect(SKILL.content).toBe(CONTENT);
    });
  }

  it('numbers headings inside list items with the whole primary document', async () => {
    await act(async () =>
      root.render(
        <SkillDetailContent skill={{ ...SKILL, content: '## Repeat\n\n- Item\n\n  ### Repeat' }} />
      )
    );
    expect(host.querySelector('li h3')?.id).toBe('repeat-1');
  });

  it('leaves ordinary Markdown callers on their existing link behavior', async () => {
    await act(async () =>
      root.render(<MarkdownRenderer text={'[Local](#heading)\n\n## Heading'} />)
    );
    expect(host.querySelector('a')?.target).toBe('_blank');
    expect(host.querySelector('h2')?.id).toBe('');
  });

  it('preserves the Skills query and returns focus after closing details', async () => {
    vi.useFakeTimers();
    await act(async () =>
      root.render(
        <ProjectSkillsView
          status="ready"
          stale={false}
          onRefresh={() => {}}
          groups={[
            {
              scope: 'project',
              dir: '.agents/skills',
              registration: 'registered',
              truncated: false,
              skills: [
                SKILL,
                { ...SKILL, id: 'other', name: 'other', relativePath: '.agents/skills/other' },
              ],
            },
          ]}
        />
      )
    );
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'anchor-demo'
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="View details"]')!;
    open.focus();
    await click(open);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel).not.toBeNull();
    await click(panel.querySelector<HTMLAnchorElement>('a[href^="#"]')!);
    expect(panel.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(search.value).toBe('anchor-demo');
    expect(host.querySelectorAll('button[aria-label="View details"]')).toHaveLength(1);
    expect(document.activeElement).toBe(open);
  });
});

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
