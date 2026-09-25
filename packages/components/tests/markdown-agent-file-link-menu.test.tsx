// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Copy, ExternalLink, FolderOpen } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentFileLinkContextMenuItemsContext,
  MarkdownRenderer,
} from '../src/components/ai-gui/markdown-renderer';
import type { MarkdownAgentFileLinkMenuItem } from '../src/hooks/use-session-file-actions';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_LINK = '[submit.ts](/Users/dev/project/src/ledger/submit.ts:366)';

describe('agent Markdown file-link context menu', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    document
      .querySelectorAll('[role="menu"]')
      .forEach((node) => node.remove());
  });

  const render = async (
    getItems: (href: string) => readonly MarkdownAgentFileLinkMenuItem[],
    onAgentFileLinkClick = vi.fn()
  ) => {
    await act(async () => {
      root?.render(
        createElement(
          AgentFileLinkContextMenuItemsContext.Provider,
          { value: getItems },
          createElement(MarkdownRenderer, { text: FILE_LINK, onAgentFileLinkClick })
        )
      );
    });
    const link = container?.querySelector('button[title]');
    if (!link) throw new Error('Markdown file link did not render');
    return { link, onAgentFileLinkClick };
  };

  it('keeps left-click navigation and exposes the local menu on right-click', async () => {
    const onCopy = vi.fn();
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    const { link, onAgentFileLinkClick } = await render(() => [
      { kind: 'action', id: 'copy-path', label: 'Copy Path', icon: Copy, run: onCopy },
      { kind: 'action', id: 'open-file', label: 'Open File', icon: ExternalLink, run: onOpen },
      { kind: 'action', id: 'reveal', label: 'Show in Finder', icon: FolderOpen, run: onReveal },
    ]);

    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onAgentFileLinkClick).toHaveBeenCalledWith('/Users/dev/project/src/ledger/submit.ts:366');

    await act(async () => {
      link.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        })
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Copy Path');
    expect(document.body.textContent).toContain('Open File');
    expect(document.body.textContent).toContain('Show in Finder');
  });

  it('renders exactly Copy Path when the supplied capability is remote-only', async () => {
    const { link } = await render(() => [
      { kind: 'action', id: 'copy-path', label: 'Copy Path', icon: Copy, run: vi.fn() },
    ]);
    await act(async () => {
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toBe('Copy Path');
  });
});
