import { createConversationViewFromHistory } from '../src/lib/conversation-view';
// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionId } from '@lody/shared';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { buildChatStreamItems as buildFromView } from '../src/components/ai-gui/build-chat-stream-items';
import { initI18n } from '../src/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionForkDestinationPopover,
  getSessionForkDestinationOptions,
} from '../src/components/sessions/session-fork-destination-menu';

vi.mock('virtua', () => ({
  Virtualizer: ({ children }: { children: import('react').ReactNode }) => children,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string, fallback?: string): string => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('getSessionForkDestinationOptions', () => {
  const t = (_key: string, fallback: string) => fallback;

  it('only offers the current workspace when worktree support is hidden', () => {
    expect(getSessionForkDestinationOptions(t, 'hidden').map((option) => option.id)).toEqual([
      'shared',
    ]);
  });

  it('disables the worktree option while Git status is still resolving', () => {
    const worktree = getSessionForkDestinationOptions(t, 'checking').find(
      (option) => option.id === 'new-worktree'
    );
    expect(worktree?.disabled).toBe(true);
    expect(worktree?.hint).toBe('Checking Git status…');
  });
});

describe('SessionForkDestinationPopover', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderPopover = async (
    props: Partial<ComponentProps<typeof SessionForkDestinationPopover>> = {}
  ): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          SessionForkDestinationPopover,
          {
            open: true,
            worktreeAvailability: 'available',
            onSelect: vi.fn(),
            ...props,
          },
          createElement('button', { type: 'button' }, 'Fork')
        )
      );
    });
  };

  it('lists both destinations when a new worktree is available', async () => {
    await renderPopover();
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      'Current workspaceNew tab · shares files and uncommitted changes',
      'New worktreeNew session · from the latest committed HEAD',
    ]);
  });

  it('offers copying when native fork is unavailable', async () => {
    let copied = false;
    await renderPopover({
      nativeForkAvailable: false,
      worktreeAvailability: 'hidden',
      onCopyContext: () => {
        copied = true;
      },
    });
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Copy context as Markdown');
    await act(async () => items[0]?.click());
    expect(copied).toBe(true);
  });

  it('does not leave the first destination focused after opening', async () => {
    await renderPopover();
    const firstItem = document.querySelector('[role="menuitem"]');
    expect(firstItem).toBeInstanceOf(HTMLButtonElement);
    expect(document.activeElement).not.toBe(firstItem);
  });

  it('selects the current workspace from a menu, not a modal dialog', async () => {
    const onSelect = vi.fn();
    await renderPopover({ onSelect });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    const shared = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Current workspace')
    );
    await act(async () => shared?.click());
    expect(onSelect).toHaveBeenCalledWith('shared');
  });
  it.each([false, true])(
    'exposes context copying for a streaming turn (finished=%s)',
    async (finished) => {
      await initI18n('en');
      const sessionId = 'copy-stream' as SessionId;
      const history = [
        {
          id: 'partial',
          role: 'assistant',
          timestamp: '2026-09-10T00:00:00Z',
          items: [{ type: 'text', text: 'Partial answer' }],
          fileDiff: [],
          finished,
        } as never,
      ];
      const view = createConversationViewFromHistory({
        sessionId,
        getHistory: () => history,
        subscribe: () => () => {},
      });
      const { items } = buildFromView(view, sessionId);
      view.dispose();
      let copied: string | undefined;
      await act(async () =>
        root.render(
          createElement(SessionChatStreamView, {
            items,
            sessionId,
            renderMessageRow: () => null,
            onCopyContext: (id) => {
              copied = id;
            },
            onForkLastAssistant: () => undefined,
            lastAssistantMessageId: 'partial',
            lastCompletedAssistantMessageId: finished ? 'partial' : null,
          })
        )
      );
      const fork = container.querySelector<HTMLButtonElement>('[aria-label="Fork session"]');
      expect(fork).toBeTruthy();
      await act(async () => fork!.click());
      const copy = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.includes('Copy context as Markdown')
      );
      expect(copy).toBeTruthy();
      if (!finished) {
        expect(
          [...document.querySelectorAll('[role="menuitem"]')].some((item) =>
            item.textContent?.includes('Current workspace')
          )
        ).toBe(false);
      }
      await act(async () => copy!.click());
      expect(copied).toBe('partial');
    }
  );
});
