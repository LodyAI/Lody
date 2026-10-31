// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import {
  SessionChatStreamView,
  type ChatStreamItem,
  type SessionChatStreamHandle,
} from '../src/components/ai-gui/view';
import { createFrameHarness, type FrameHarness } from './support/scroll-frame-harness';
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';
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
let frames: FrameHarness | undefined;
let offsetParentDescriptor: PropertyDescriptor | undefined;

beforeEach(async () => {
  await initI18n('en');
  clearSavedScrollStates();
  offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
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
  frames?.restore();
  frames = undefined;
  if (offsetParentDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
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

it('reports the actual visible turns while touch growth shifts the content origin', async () => {
  vi.stubGlobal('navigator', {
    userAgent: 'iPhone AppleWebKit/605.1.15',
    platform: 'iPhone',
    maxTouchPoints: 5,
  });
  const endDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'onscrollend');
  Object.defineProperty(document.documentElement, 'onscrollend', {
    configurable: true,
    value: null,
  });
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  const px = (value?: string) => parseFloat(value ?? '0') || 0;
  let grown = false;
  let viewportHeight = 400;
  let attached: HTMLElement | null = null;
  const heightOf = (el: HTMLElement) =>
    el.dataset.conversationTurnId === 't35' && grown
      ? 636
      : el.dataset.conversationTurnId
        ? 100
        : 0;
  frames = createFrameHarness({
    viewportHeight: () => viewportHeight,
    sizeOf: (el) =>
      el.hasAttribute('data-message-selection-scroll')
        ? viewportHeight
        : el.hasAttribute('data-virtual-index')
          ? heightOf(el as HTMLElement)
          : undefined,
    scrollHeightOf: (viewport) => {
      const content = viewport.firstElementChild as HTMLElement;
      return 24 + px(content.style.height) + px(content.style.marginTop);
    },
    rectOf: (element, top) => {
      const el = element as HTMLElement;
      const viewport = el.closest<HTMLElement>('[data-message-selection-scroll]');
      if (viewport && viewport !== attached) {
        attached = viewport;
        frames!.attachViewport(viewport);
      }
      if (el.hasAttribute('data-message-selection-scroll'))
        return { top: 0, height: viewportHeight };
      if (
        el.parentElement?.hasAttribute('data-message-selection-scroll') &&
        !el.hasAttribute('data-conversation-reply-room')
      )
        return { top: 24 + px(el.style.marginTop) - top, height: px(el.style.height) };
      if (el.hasAttribute('data-virtual-index'))
        return {
          top: 24 + px(el.parentElement?.style.marginTop) + px(el.style.top) - top,
          height: heightOf(el),
        };
      return undefined;
    },
  });
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      let delivered = false;
      await act(async () => {
        delivered = frames!.frame();
      });
      if (!delivered) return;
    }
    throw Error('Unsettled viewport');
  };
  const ranges: { from: number; to: number }[] = [];
  const handle = createRef<SessionChatStreamHandle>();
  const items: ChatStreamItem[] = Array.from({ length: 80 }, (_, turnIndex) => ({
    type: 'message',
    sessionId,
    turnIndex,
    message: { ...history[0]!, id: `t${turnIndex}` } as never,
  }));
  try {
    await act(async () =>
      root.render(
        <SessionChatStreamView
          ref={handle}
          items={items}
          sessionId={sessionId}
          onVisibleTurnRangeChange={(range) => ranges.push(range)}
          renderMessageRow={({ message }) => <p>{message.id}</p>}
        />
      )
    );
    await settle();
    act(() => handle.current!.scrollToIndex(40));
    await settle();
    const viewport = container.querySelector<HTMLElement>('[data-message-selection-scroll]')!;
    const touch = (type: string, y: number) => {
      const contacts = [{ identifier: 0, clientX: 100, clientY: y }] as Touch[];
      return new TouchEvent(type, {
        bubbles: true,
        touches: type === 'touchend' ? [] : contacts,
        changedTouches: contacts,
      });
    };
    act(() => viewport.dispatchEvent(touch('touchstart', 100)));
    frames.nativeScrollTo(frames.scrollTop - 120);
    await settle();
    act(() => viewport.dispatchEvent(touch('touchend', 160)));
    grown = true;
    await settle();
    const physical = frames.scrollTop;
    expect((viewport.firstElementChild as HTMLElement).style.marginTop).toBe('-536px');
    const actual = () => {
      const visible = [
        ...viewport.querySelectorAll<HTMLElement>('[data-conversation-turn-id]'),
      ].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < viewportHeight;
      });
      return {
        from: Math.min(...visible.map((el) => Number(el.dataset.conversationTurnId!.slice(1)))),
        to: Math.max(...visible.map((el) => Number(el.dataset.conversationTurnId!.slice(1)))) + 1,
      };
    };
    expect(ranges.at(-1)).toEqual(actual());
    // A keyboard/viewport resize while shifted must not sample the negative
    // DOM margin as a new unshifted content origin.
    viewportHeight = 360;
    await settle();
    expect(ranges.at(-1)).toEqual(actual());
    viewportHeight = 400;
    await settle();
    expect(ranges.at(-1)).toEqual(actual());
    const before = ranges.at(-1);
    act(() => viewport.dispatchEvent(new Event('scrollend')));
    await settle();
    expect(frames.scrollTop).toBe(physical + 536);
    expect(ranges.at(-1)).toEqual(before);
    expect(ranges.at(-1)).toEqual(actual());
  } finally {
    if (endDescriptor)
      Object.defineProperty(document.documentElement, 'onscrollend', endDescriptor);
    else delete (document.documentElement as unknown as Record<string, unknown>).onscrollend;
  }
});

describe('conversation rows', () => {
  it.each([0, 8])(
    'anchors local inputs before owner history, then hands off once (%s prior turns)',
    async (count) => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      }));
      const px = (value: string | undefined) => parseFloat(value ?? '0') || 0;
      let attached: HTMLElement | null = null;
      frames = createFrameHarness({
        viewportHeight: () => 400,
        sizeOf: (element) =>
          element.hasAttribute('data-message-selection-scroll')
            ? 400
            : element.hasAttribute('data-virtual-index')
              ? 100
              : undefined,
        scrollHeightOf: (viewport) =>
          px((viewport.firstElementChild as HTMLElement)?.style.height) +
          px(viewport.querySelector<HTMLElement>('[data-conversation-reply-room]')?.style.height),
        rectOf: (element, scrollTop) => {
          const el = element as HTMLElement;
          const viewport = el.closest<HTMLElement>('[data-message-selection-scroll]');
          if (viewport && viewport !== attached) {
            attached = viewport;
            frames!.attachViewport(viewport);
          }
          if (el.hasAttribute('data-message-selection-scroll')) return { top: 0, height: 400 };
          if (
            el.parentElement?.hasAttribute('data-message-selection-scroll') &&
            !el.hasAttribute('data-conversation-reply-room')
          ) {
            return { top: -scrollTop, height: px(el.style.height) };
          }
          if (el.hasAttribute('data-virtual-index'))
            return { top: px(el.style.top) - scrollTop, height: 100 };
          return undefined;
        },
      });
      const settle = async () => {
        for (let i = 0; i < 30; i++) {
          let delivered = false;
          await act(async () => {
            delivered = frames!.frame();
          });
          if (!delivered) return;
        }
        throw new Error('frames did not settle');
      };
      const formal = (id: string, turnIndex: number): ChatStreamItem => ({
        type: 'message',
        sessionId,
        turnIndex,
        message: { ...history[0]!, id } as never,
      });
      const prior = Array.from({ length: count }, (_, i) => formal(`prior-${i}`, i));
      const handle = createRef<SessionChatStreamHandle>();
      const local = [
        { id: 'local-a', content: <p>Local A</p> },
        { id: 'local-b', content: <p>Local B</p> },
      ];
      const ranges: { from: number; to: number }[] = [];
      const render = async (items: ChatStreamItem[], localUserMessages = local) => {
        await act(async () =>
          root.render(
            <SessionChatStreamView
              ref={handle}
              items={items}
              sessionId={sessionId}
              localUserMessages={localUserMessages}
              agentActivityLabel="Sending"
              onVisibleTurnRangeChange={(range) => ranges.push(range)}
              renderMessageRow={({ message }) => <p>{message.id}</p>}
            />
          )
        );
        await settle();
      };
      const row = () =>
        container.querySelector<HTMLElement>('[data-conversation-turn-id="local-b"]');
      await render(prior, []);
      await act(async () => handle.current!.anchorMessage('local-b'));
      await render(prior);
      expect(row()?.textContent).toBe('Local B');
      const sentScreenY = 100;
      expect(row()!.getBoundingClientRect().top).toBe(sentScreenY);
      expect(ranges.every((range) => range.from >= 0 && range.to <= count)).toBe(true);
      if (count === 0) expect(ranges).toEqual([]);
      const anchoredOffset = frames.scrollTop;

      await render([
        ...prior,
        { type: 'placeholder', turnIndex: count, row: { ...history[0]!, id: 'local-a' } as never },
        {
          type: 'placeholder',
          turnIndex: count + 1,
          row: { ...history[0]!, id: 'local-b' } as never,
        },
      ]);
      expect(row()?.textContent).toBe('Local B');
      expect(container.querySelectorAll('[data-conversation-turn-id="local-b"]')).toHaveLength(1);
      expect(frames.scrollTop).toBe(anchoredOffset);

      // History can hydrate before the coordinator removes its projection.
      await render([...prior, formal('local-a', count), formal('local-b', count + 1)]);
      expect(row()?.textContent).toBe('local-b');
      expect(container.querySelectorAll('[data-conversation-turn-id="local-b"]')).toHaveLength(1);
      expect(frames.scrollTop).toBe(anchoredOffset);
      await render([...prior, formal('local-a', count), formal('local-b', count + 1)], []);
      expect(row()!.getBoundingClientRect().top).toBe(sentScreenY);
    }
  );

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
