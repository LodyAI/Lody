// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { SessionReadonlyContext } from '../src/components/ai-gui/session-readonly-context';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/hooks/use-task-image', () => ({
  useTaskImageUrl: () => {
    throw new Error('Workspace image hook must not mount');
  },
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('anonymous Markdown resource boundary', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (text: string) =>
    act(async () =>
      root.render(
        <SessionReadonlyContext.Provider
          value={{ renderImage: () => null, renderFiles: () => null }}
        >
          <MarkdownRenderer text={text} />
        </SessionReadonlyContext.Provider>
      )
    );

  it('does not load raw remote image URLs or instantiate a workspace image resolver', async () => {
    await render('![Original diagram](https://source.example/signed-image?token=synthetic)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Original diagram');
  });

  it('makes source attachment links inert while retaining ordinary explicit web navigation', async () => {
    await render(
      '[Attachment](https://api.example/api/workspaces/private/session-files/source/file)\n\n[Article](https://example.org/article)'
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.some((link) => link.href.includes('/session-files/'))).toBe(false);
    expect(container.textContent).toContain('Attachment');
    expect(links.some((link) => link.href === 'https://example.org/article')).toBe(true);
  });
});
