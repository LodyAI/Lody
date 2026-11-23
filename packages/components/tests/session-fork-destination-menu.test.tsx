// @vitest-environment jsdom
import { createConversationViewFromHistory } from '../src/lib/conversation-view';

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionId } from '@lody/shared';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { buildChatStreamItems as buildFromView } from '../src/components/ai-gui/build-chat-stream-items';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionForkDestinationMenu } from '../src/components/sessions/session-fork-destination-menu';
import { createTestI18n, withTestI18n } from './test-i18n';

const testI18n = createTestI18n();

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionForkDestinationMenu', () => {
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

  const renderMenu = async (
    props: Partial<ComponentProps<typeof SessionForkDestinationMenu>> = {}
  ): Promise<void> => {
    await act(async () => {
      root.render(
        withTestI18n(
          createElement(
            SessionForkDestinationMenu,
            {
              open: true,
              worktreeAvailability: 'available',
              onSelect: vi.fn(),
              ...props,
            },
            createElement('button', { type: 'button' }, 'Fork')
          ),
          testI18n
        )
      );
      // Base UI defers the portal mount to a frame; jsdom's rAF is a real timer.
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };

  it('keeps the Git status check inline on the disabled worktree row', async () => {
    await renderMenu({ worktreeAvailability: 'checking' });
    const worktree = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.startsWith('Fork to new worktree')
    );
    expect(worktree?.getAttribute('aria-disabled')).toBe('true');
    expect(worktree?.textContent).toContain('Checking Git status…');
  });

  it('offers copying when native fork is unavailable', async () => {
    let copied = false;
    await renderMenu({
      nativeForkAvailable: false,
      worktreeAvailability: 'hidden',
      onCopyContext: () => {
        copied = true;
      },
    });
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Copy context as Markdown');
    await act(async () => items[0]?.click());
    expect(copied).toBe(true);
  });
  it.each([false, true])('exposes context copying for a turn (finished=%s)', async (finished) => {
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
        withTestI18n(
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
            forkingAssistantMessageId: finished ? null : 'partial',
          }),
          testI18n
        )
      )
    );

    const fork = container.querySelector<HTMLElement>('[aria-label="Fork session"]');
    if (finished) {
      expect(fork).toBeTruthy();
      await act(async () => fork!.click());
    } else {
      expect(fork).toBeNull();
      expect(container.querySelector('[aria-label="Copy response"]')).toBeNull();
    }
    const copy = finished
      ? [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
          item.textContent?.includes('Copy context as Markdown')
        )
      : container.querySelector<HTMLElement>('[aria-label="Copy context as Markdown"]');
    expect(copy).toBeTruthy();
    await act(async () => copy!.click());
    expect(copied).toBe('partial');
  });
});
