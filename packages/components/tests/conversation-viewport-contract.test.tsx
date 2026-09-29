// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { initI18n } from '../src/i18n';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';

/**
 * The conversation viewport's layout contract (scroll-engine note, "Extent
 * ownership and layout contract"): the browser must not become a second
 * writer of `scrollTop`, no row may change its own height through
 * `content-visibility: auto`, and the conversation is never hidden. The first
 * two were once broken without any test noticing; these guard them.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'viewport-contract' as SessionId;

const history = [
  {
    id: 'user-turn',
    role: 'user',
    timestamp: '2026-09-27T00:00:00Z',
    items: [{ type: 'text', text: 'Show me a snippet.' }],
  },
  {
    id: 'assistant-turn',
    role: 'assistant',
    timestamp: '2026-09-27T00:00:01Z',
    items: [{ type: 'text', text: 'Here:\n\n```ts\nconst answer = 42;\n```\n' }],
    fileDiff: [],
    finished: true,
  },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await initI18n('en');
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

async function renderStream(initialWindowReady = true) {
  const view = createConversationViewFromHistory({
    sessionId,
    getHistory: () => history as never,
    subscribe: () => () => {},
  });
  const { items } = buildChatStreamItems(view, sessionId);
  view.dispose();
  await act(async () =>
    root.render(
      createElement(SessionChatStreamView, {
        items,
        sessionId,
        renderMessageRow: () => null,
        lastAssistantMessageId: 'assistant-turn',
        initialWindowReady,
      })
    )
  );
  return container.querySelector<HTMLElement>('[data-message-selection-scroll]');
}

describe('conversation viewport', () => {
  it('turns browser scroll anchoring off for the whole scroller', async () => {
    const viewport = await renderStream();
    expect(viewport).not.toBeNull();
    expect(viewport!.style.overflowAnchor).toBe('none');
    expect(viewport!.hasAttribute('data-conversation-scroll-engine')).toBe(true);
  });

  it.each([false, true])(
    'is never hidden, and reports a native window ready only with its window (ready=%s)',
    async (initialWindowReady) => {
      const viewport = await renderStream(initialWindowReady);
      expect(viewport!.style.visibility).not.toBe('hidden');
      // Warm-window reveal waits for this: the hydrated window AND the engine's
      // first placed cycle, so a window is never revealed over placeholders.
      expect(viewport!.getAttribute('data-window-session-stream-ready')).toBe(
        initialWindowReady ? sessionId : null
      );
    }
  );
});

describe('conversation rows', () => {
  it.each([
    ['static', false],
    ['streaming', true],
  ])('render %s code blocks without content-visibility: auto', async (_mode, isStreaming) => {
    await act(async () =>
      root.render(
        createElement(MarkdownRenderer, {
          text: '```ts\nconst answer = 42;\n```\n',
          isStreaming,
        })
      )
    );
    const elements = [container, ...container.querySelectorAll<HTMLElement>('*')];
    expect(container.textContent).toContain('const answer = 42;');
    const auto = elements.filter((element) => element.style.contentVisibility === 'auto');
    expect(auto).toEqual([]);
  });
});
