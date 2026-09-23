/**
 * @vitest-environment jsdom
 */

import React, { act, useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import type { CacheSnapshot, VirtualizerHandle } from 'virtua';
import {
  clearAllScrollPositions,
  getScrollPosition,
  saveScrollPosition,
} from '../src/hooks/use-scroll-position-cache';
import { useStickyScroll, type UseStickyScrollResult } from '../src/hooks/use-sticky-scroll';

type ResizeObserverEntryLike = Pick<ResizeObserverEntry, 'contentRect' | 'target'>;

type MockResizeObserverInstance = {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
};

const resizeObserverInstances: MockResizeObserverInstance[] = [];
let rafQueue: FrameRequestCallback[] = [];
let root: Root | null = null;
let renderContainer: HTMLDivElement | null = null;
let latestResult: UseStickyScrollResult | null = null;

class MockResizeObserver {
  private readonly instance: MockResizeObserverInstance;

  constructor(callback: ResizeObserverCallback) {
    this.instance = {
      callback,
      targets: new Set<Element>(),
    };
    resizeObserverInstances.push(this.instance);
  }

  observe = (target: Element) => {
    this.instance.targets.add(target);
  };

  unobserve = (target: Element) => {
    this.instance.targets.delete(target);
  };

  disconnect = () => {
    this.instance.targets.clear();
  };
}

type ScrollFixture = {
  scrollElement: HTMLDivElement;
  contentElement: HTMLDivElement;
  lastRow: HTMLDivElement;
  setScrollTop: (value: number) => void;
  getScrollTop: () => number;
  setContentHeight: (value: number) => void;
  setClientWidth: (value: number) => void;
  setScrollHeight: (value: number) => void;
  setClientHeight: (value: number) => void;
};

type MockVirtualizerHandle = VirtualizerHandle & {
  scrollToIndex: ReturnType<typeof vi.fn>;
  scrollTo: ReturnType<typeof vi.fn>;
};

/** Stand-in for Virtua's opaque row-measurement snapshot; identity is the assertion. */
const measurementsOf = (label: string): CacheSnapshot => [label] as unknown as CacheSnapshot;

type HarnessProps = {
  sessionId: SessionId;
  vlist: MockVirtualizerHandle | null;
  scrollElement: HTMLDivElement | null;
  itemCount: number;
  hasVirtualizedRows?: boolean;
  initialContentReady?: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  skipNextViewportResizeAutoScrollRef?: React.MutableRefObject<boolean>;
  suppressAutoScrollRef?: React.RefObject<boolean>;
};

async function advanceAnimationFrames(): Promise<void> {
  for (let iteration = 0; iteration < 200; iteration += 1) {
    if (rafQueue.length === 0) {
      await Promise.resolve();
      if (rafQueue.length === 0) return;
    }
    const callbacks = [...rafQueue];
    rafQueue = [];
    vi.advanceTimersByTime(17);
    for (const callback of callbacks) {
      callback(performance.now());
    }
    await Promise.resolve();
  }
}

function createScrollFixture(): ScrollFixture {
  const rootElement = document.createElement('div');
  const scrollElement = document.createElement('div');
  const contentElement = document.createElement('div');
  scrollElement.className = 'chat-scrollbar';
  scrollElement.style.paddingBottom = '24px';
  scrollElement.style.overflow = 'auto';
  scrollElement.appendChild(contentElement);
  rootElement.appendChild(scrollElement);
  document.body.appendChild(rootElement);

  let scrollTop = 0;
  let scrollHeight = 640;
  let clientHeight = 400;
  let clientWidth = 320;
  let contentHeight = 616;

  Object.defineProperty(scrollElement, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(scrollElement, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(scrollElement, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  scrollElement.getBoundingClientRect = () =>
    ({
      width: clientWidth,
      height: clientHeight,
      top: 0,
      left: 0,
      right: clientWidth,
      bottom: clientHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  contentElement.getBoundingClientRect = () =>
    ({
      width: clientWidth,
      height: contentHeight,
      top: 0,
      left: 0,
      right: clientWidth,
      bottom: contentHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  const lastRow = document.createElement('div');
  lastRow.dataset.virtualIndex = '3';
  contentElement.append(lastRow);
  lastRow.getBoundingClientRect = () =>
    new DOMRect(0, scrollHeight - 124 - scrollTop, clientWidth, 100);

  return {
    scrollElement,
    contentElement,
    lastRow,
    setScrollTop: (value) => {
      scrollTop = value;
    },
    getScrollTop: () => scrollTop,
    setContentHeight: (value) => {
      contentHeight = value;
    },
    setClientWidth: (value) => {
      clientWidth = value;
    },
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
    setClientHeight: (value) => {
      clientHeight = value;
    },
  };
}

function createMockVirtualizerHandle(
  scrollElement: HTMLElement,
  cache: CacheSnapshot = measurementsOf('default')
): MockVirtualizerHandle {
  const handle = {
    scrollSize: 640,
    viewportSize: 400,
    findItemIndex: () => 3,
    cache,
    scrollToIndex: vi.fn(),
    scrollTo: vi.fn((offset: number) => {
      scrollElement.scrollTop = offset;
    }),
  } as unknown as MockVirtualizerHandle;

  Object.defineProperty(handle, 'scrollOffset', {
    configurable: true,
    get: () => scrollElement.scrollTop,
    set: (value: number) => {
      scrollElement.scrollTop = value;
    },
  });

  return handle;
}

function emitResize(target: Element): void {
  const rect = (target as HTMLElement).getBoundingClientRect();
  const entry = {
    target,
    contentRect: {
      width: rect.width,
      height: rect.height,
      top: 0,
      left: 0,
      right: rect.width,
      bottom: rect.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    },
  } satisfies ResizeObserverEntryLike;

  for (const observer of resizeObserverInstances) {
    if (!observer.targets.has(target)) continue;
    observer.callback([entry as ResizeObserverEntry], {} as ResizeObserver);
  }
}

function HookHarness({
  sessionId,
  vlist,
  scrollElement,
  itemCount,
  hasVirtualizedRows,
  initialContentReady,
  onAtBottomChange,
  skipNextViewportResizeAutoScrollRef,
  suppressAutoScrollRef,
}: HarnessProps) {
  const vlistRef = useRef<VirtualizerHandle | null>(vlist);
  vlistRef.current = vlist;

  const result = useStickyScroll({
    sessionId,
    vlistRef,
    itemCount,
    hasVirtualizedRows,
    initialContentReady,
    onAtBottomChange,
    skipNextViewportResizeAutoScrollRef,
    suppressAutoScrollRef,
  });
  const { scrollRef } = result;

  useLayoutEffect(() => {
    scrollRef(scrollElement);
    return () => scrollRef(null);
  }, [scrollElement, scrollRef]);

  useEffect(() => {
    latestResult = result;
  }, [result]);

  return null;
}

/** Close the conversation, as switching sessions does. */
async function closeHarness(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  renderContainer?.remove();
  renderContainer = null;
  latestResult = null;
}

async function renderHarness(props: HarnessProps): Promise<void> {
  if (!root || !renderContainer) {
    renderContainer = document.createElement('div');
    document.body.appendChild(renderContainer);
    root = createRoot(renderContainer);
  }

  await act(async () => {
    root!.render(React.createElement(HookHarness, props));
  });
}

describe('useStickyScroll Virtua adapter', () => {
  beforeEach(() => {
    resizeObserverInstances.length = 0;
    rafQueue = [];
    latestResult = null;
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', MockResizeObserver as typeof ResizeObserver);
    vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }) as typeof requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', ((id: number) => {
      rafQueue[id - 1] = () => {};
    }) as typeof cancelAnimationFrame);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    renderContainer?.remove();
    renderContainer = null;
    document.body.innerHTML = '';
    latestResult = null;
    resizeObserverInstances.length = 0;
    rafQueue = [];
    clearAllScrollPositions();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reveals an already measured followed session before waiting for an animation frame', async () => {
    const sessionId = 'session-initial-paint' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    saveScrollPosition(sessionId, { type: 'end' });
    await renderHarness({ sessionId, vlist, scrollElement: fixture.scrollElement, itemCount: 4 });
    expect(fixture.getScrollTop()).toBe(240);
    expect(latestResult?.initialScrollRestored).toBe(true);
  });

  it.each(['end', 'offset'] as const)(
    'restores %s only after the first window settles',
    async (type) => {
      const sessionId = 'session-ready-window' as SessionId;
      const fixture = createScrollFixture();
      const vlist = createMockVirtualizerHandle(fixture.scrollElement);
      saveScrollPosition(sessionId, type === 'end' ? { type } : { type, scrollOffset: 96 });
      const props = { sessionId, vlist, scrollElement: fixture.scrollElement, itemCount: 4 };
      await renderHarness({ ...props, initialContentReady: false });
      expect(latestResult?.initialScrollRestored).toBe(false);
      fixture.setScrollHeight(1640);
      await renderHarness({ ...props, initialContentReady: true });
      expect(latestResult?.initialScrollRestored).toBe(true);
      expect(fixture.getScrollTop()).toBe(type === 'end' ? 1240 : 96);
    }
  );

  it('keeps the viewport hidden until the destination row is mounted and measured', async () => {
    const fixture = createScrollFixture();
    fixture.lastRow.remove();
    await renderHarness({
      sessionId: 'session-measurement-gate' as SessionId,
      vlist: createMockVirtualizerHandle(fixture.scrollElement),
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    expect(fixture.getScrollTop()).toBe(240);
    expect(latestResult?.initialScrollRestored).toBe(false);
    await act(async () => {
      fixture.lastRow.style.visibility = 'hidden';
      fixture.contentElement.append(fixture.lastRow);
    });
    expect(latestResult?.initialScrollRestored).toBe(false);
    await act(async () => {
      fixture.setScrollHeight(1640);
      fixture.lastRow.style.visibility = '';
      emitResize(fixture.lastRow);
    });
    expect(fixture.getScrollTop()).toBe(1240);
    expect(latestResult?.initialScrollRestored).toBe(true);
  });

  it('waits for Virtua to observe a restored offset before revealing', async () => {
    const sessionId = 'session-delayed-offset' as SessionId;
    saveScrollPosition(sessionId, { type: 'offset', scrollOffset: 96 });
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    let observedOffset = 0;
    Object.defineProperty(vlist, 'scrollOffset', { get: () => observedOffset });
    await renderHarness({ sessionId, vlist, scrollElement: fixture.scrollElement, itemCount: 4 });
    expect(latestResult?.initialScrollRestored).toBe(false);
    expect(fixture.getScrollTop()).toBe(96);
    expect(getScrollPosition(sessionId)).toEqual({ type: 'offset', scrollOffset: 96 });
    await act(async () => {
      observedOffset = 96;
      latestResult?.handleScroll(96);
    });
    expect(latestResult?.initialScrollRestored).toBe(true);
  });

  it('accepts the subpixel geometry of a measured tail', async () => {
    const fixture = createScrollFixture();
    const originalRect = fixture.lastRow.getBoundingClientRect;
    fixture.lastRow.getBoundingClientRect = () => {
      const rect = originalRect();
      return new DOMRect(rect.x, rect.y + 1.5, rect.width, rect.height);
    };
    await renderHarness({
      sessionId: 'session-fractional-tail' as SessionId,
      vlist: createMockVirtualizerHandle(fixture.scrollElement),
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    expect(latestResult?.initialScrollRestored).toBe(true);
  });

  it('restores a cached offset again when late measurements change the clamped destination', async () => {
    const sessionId = 'session-late-offset-measurement' as SessionId;
    saveScrollPosition(sessionId, { type: 'offset', scrollOffset: 1200 });
    const fixture = createScrollFixture();
    fixture.lastRow.style.visibility = 'hidden';
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    await renderHarness({ sessionId, vlist, scrollElement: fixture.scrollElement, itemCount: 4 });
    expect(fixture.getScrollTop()).toBe(240);
    expect(latestResult?.initialScrollRestored).toBe(false);

    await act(async () => {
      // The virtualizer's initial request has ended; a late row measurement
      // expands the spacer and corrects its anchor to a different offset.
      fixture.setScrollHeight(3000);
      fixture.setScrollTop(1800);
      fixture.lastRow.style.visibility = '';
      emitResize(fixture.lastRow);
    });
    expect(fixture.getScrollTop()).toBe(1200);
    await act(async () => latestResult?.handleScroll(1200));
    expect(latestResult?.initialScrollRestored).toBe(true);
    expect(getScrollPosition(sessionId)).toEqual({ type: 'offset', scrollOffset: 1200 });
  });

  it.each(['latest', 'jump', 'wheel'] as const)(
    'lets %s replace a pending cached restoration',
    async (intent) => {
      const sessionId = 'session-replace-initial-offset' as SessionId;
      saveScrollPosition(sessionId, { type: 'offset', scrollOffset: 96 });
      const fixture = createScrollFixture();
      fixture.lastRow.style.visibility = 'hidden';
      const suppressAutoScrollRef = { current: false };
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(fixture.scrollElement),
        scrollElement: fixture.scrollElement,
        itemCount: 4,
        suppressAutoScrollRef,
      });
      expect(latestResult?.initialScrollRestored).toBe(false);
      await act(async () => {
        if (intent === 'latest') latestResult?.scrollToBottom();
        else {
          if (intent === 'jump') suppressAutoScrollRef.current = true;
          else fixture.scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
          fixture.setScrollTop(40);
        }
        fixture.lastRow.style.visibility = '';
        emitResize(fixture.lastRow);
        latestResult?.handleScroll(fixture.getScrollTop());
      });
      expect(latestResult?.initialScrollRestored).toBe(true);
      expect(fixture.getScrollTop()).toBe(intent === 'latest' ? 240 : 40);
    }
  );

  it('follows row growth before the spacer resize is delivered', async () => {
    const fixture = createScrollFixture();
    await renderHarness({
      sessionId: 'session-row-measurement' as SessionId,
      vlist: createMockVirtualizerHandle(fixture.scrollElement),
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    fixture.setScrollHeight(1640);
    act(() => emitResize(fixture.lastRow));
    expect(fixture.getScrollTop()).toBe(1240);
    // No spacer notification, animation frame or item-count change is needed.
    fixture.setScrollHeight(940);
    act(() => emitResize(fixture.lastRow));
    expect(fixture.getScrollTop()).toBe(540);
    await act(async () => {
      fixture.scrollElement.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(2);
    });
    expect(latestResult?.isSticky).toBe(true);
  });

  it('follows mounted row overflow before Virtua commits the new spacer height', async () => {
    const fixture = createScrollFixture();
    await renderHarness({
      sessionId: 'session-row-overflow' as SessionId,
      vlist: createMockVirtualizerHandle(fixture.scrollElement),
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    fixture.setScrollHeight(1640);
    await act(async () => {
      fixture.contentElement.append(document.createElement('div'));
      await Promise.resolve();
    });
    expect(fixture.getScrollTop()).toBe(1240);
    await act(async () => {
      fixture.scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
    });
    fixture.setScrollTop(96);
    fixture.setScrollHeight(2640);
    await act(async () => {
      fixture.contentElement.replaceChildren(document.createElement('div'));
      await Promise.resolve();
    });
    expect(fixture.getScrollTop()).toBe(96);
  });

  it('keeps a followed session at the end when placeholders expand into more rows', async () => {
    const sessionId = 'session-hydrated-tail' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    const props = { sessionId, vlist, scrollElement: fixture.scrollElement, itemCount: 4 };
    await renderHarness(props);
    await act(async () => {
      await advanceAnimationFrames();
    });
    fixture.setScrollHeight(1640);
    await renderHarness({ ...props, itemCount: 12 });
    expect(fixture.getScrollTop()).toBe(1240);
    expect(latestResult?.isSticky).toBe(true);
  });

  it('anchors each measured height before paint without waiting for an animation frame', async () => {
    const fixture = createScrollFixture();
    await renderHarness({
      sessionId: 'session-measured-tail' as SessionId,
      vlist: createMockVirtualizerHandle(fixture.scrollElement),
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });
    for (const height of [1640, 2640, 1840]) {
      fixture.setScrollHeight(height);
      fixture.setContentHeight(height - 24);
      act(() => {
        emitResize(fixture.contentElement);
      });
      // ResizeObserver runs before paint. No RAF or React rerender here:
      // Virtua can remeasure the same four rows multiple times during opening.
      expect(Math.abs(fixture.getScrollTop() - (height - 400))).toBeLessThanOrEqual(1);
    }
  });

  it('follows a committed Virtua height before a deferred content resize notification', async () => {
    const fixture = createScrollFixture();
    await renderHarness({
      sessionId: 'session-spacer-commit' as SessionId,
      vlist: createMockVirtualizerHandle(fixture.scrollElement),
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });
    for (const height of [1640, 2640, 1840]) {
      await act(async () => {
        fixture.setScrollHeight(height);
        fixture.contentElement.style.height = `${height - 24}px`;
        // Virtua's own correction lands short in this commit. Its spacer
        // resize notification is deferred; no RAF/ResizeObserver is flushed.
        fixture.setScrollTop(height - 800);
        await Promise.resolve();
      });
      expect(fixture.getScrollTop()).toBe(height - 400);
    }
    await act(async () => {
      fixture.scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
      fixture.setScrollTop(96);
      fixture.scrollElement.dispatchEvent(new Event('scroll'));
      fixture.setScrollHeight(3000);
      fixture.contentElement.style.height = '2976px';
      await Promise.resolve();
    });
    expect(fixture.getScrollTop()).toBe(96);
  });

  it('preserves a cached reading position during content measurements', async () => {
    const sessionId = 'session-measured-reading' as SessionId;
    saveScrollPosition(sessionId, { type: 'offset', scrollOffset: 96 });
    const fixture = createScrollFixture();
    await renderHarness({
      sessionId,
      vlist: createMockVirtualizerHandle(fixture.scrollElement),
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    fixture.setScrollHeight(2640);
    fixture.setContentHeight(2616);
    act(() => {
      emitResize(fixture.contentElement);
    });
    expect(fixture.getScrollTop()).toBe(96);
  });

  it('does not follow expanded rows after the reader scrolls up', async () => {
    const sessionId = 'session-reading-old-turn' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    const props = { sessionId, vlist, scrollElement: fixture.scrollElement, itemCount: 4 };
    await renderHarness(props);
    await act(async () => {
      await advanceAnimationFrames();
      fixture.scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
      fixture.setScrollTop(96);
      fixture.scrollElement.dispatchEvent(new Event('scroll'));
    });
    fixture.setScrollHeight(1640);
    await renderHarness({ ...props, itemCount: 12 });
    expect(fixture.getScrollTop()).toBe(96);
    expect(latestResult?.isSticky).toBe(false);
  });

  it('restores a cached offset without forcing the list back to the bottom', async () => {
    const sessionId = 'session-cached-offset' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    saveScrollPosition(sessionId, { type: 'offset', scrollOffset: 96 });

    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    expect(latestResult?.initialScrollRestored).toBe(true);
    await act(async () => {
      await advanceAnimationFrames();
    });

    expect(fixture.getScrollTop()).toBe(96);
    expect(latestResult?.isSticky).toBe(false);
    expect(latestResult?.initialScrollRestored).toBe(true);
  });

  it('unsticks after a real upward user scroll and does not auto-scroll on later content changes', async () => {
    const sessionId = 'session-unstick' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    const atBottomChanges = vi.fn();

    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 4,
      onAtBottomChange: atBottomChanges,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });

    vlist.scrollToIndex.mockClear();
    await act(async () => {
      fixture.scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
      fixture.setScrollTop(140);
      fixture.scrollElement.dispatchEvent(new Event('scroll'));
      latestResult?.handleScroll(0);
    });

    expect(latestResult?.isSticky).toBe(false);
    expect(atBottomChanges).toHaveBeenCalledWith(false);
    expect(getScrollPosition(sessionId)).toEqual({ type: 'offset', scrollOffset: 140 });

    fixture.setContentHeight(696);
    fixture.setScrollHeight(720);
    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 5,
      onAtBottomChange: atBottomChanges,
    });
    await act(async () => {
      emitResize(fixture.contentElement);
      await advanceAnimationFrames();
    });

    expect(vlist.scrollToIndex).not.toHaveBeenCalled();
    expect(fixture.getScrollTop()).toBe(140);

    await act(async () => {
      latestResult?.scrollToBottom();
      await advanceAnimationFrames();
    });

    expect(latestResult?.isSticky).toBe(true);
    expect(getScrollPosition(sessionId)).toEqual({ type: 'end' });
    expect(fixture.getScrollTop()).toBe(320);
  });

  it('keeps the viewport pinned to the real bottom when sticky content grows', async () => {
    const sessionId = 'session-streaming-growth' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);

    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });

    vlist.scrollToIndex.mockClear();
    fixture.setContentHeight(696);
    fixture.setScrollHeight(720);

    await act(async () => {
      emitResize(fixture.contentElement);
      await advanceAnimationFrames();
    });

    expect(vlist.scrollToIndex).not.toHaveBeenCalled();
    expect(Math.abs(fixture.getScrollTop() - 320)).toBeLessThanOrEqual(1);
    expect(latestResult?.isSticky).toBe(true);
  });

  it('follows each committed viewport resize without a transition timer', async () => {
    const sessionId = 'session-viewport-resize' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);

    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });

    expect(fixture.getScrollTop()).toBe(240);
    vlist.scrollToIndex.mockClear();

    fixture.setClientHeight(320);
    await act(async () => {
      emitResize(fixture.scrollElement);
      await advanceAnimationFrames();
    });

    expect(vlist.scrollToIndex).not.toHaveBeenCalled();
    expect(fixture.getScrollTop()).toBe(320);
    expect(latestResult?.isSticky).toBe(true);
  });

  it('does not re-anchor the viewport while a flex sibling changes only its width', async () => {
    const sessionId = 'session-viewport-width-resize' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);

    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });

    vlist.scrollToIndex.mockClear();
    fixture.setScrollTop(236);

    for (const width of [300, 280, 260, 240]) {
      fixture.setClientWidth(width);
      await act(async () => {
        emitResize(fixture.scrollElement);
        await advanceAnimationFrames();
      });
    }

    expect(vlist.scrollToIndex).not.toHaveBeenCalled();
    expect(fixture.getScrollTop()).toBe(236);
    expect(latestResult?.isSticky).toBe(true);
  });

  it('skips one viewport resize caused by the composer changing height', async () => {
    const sessionId = 'session-composer-viewport-resize' as SessionId;
    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    const skipNextViewportResizeAutoScrollRef = { current: true };

    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 4,
      skipNextViewportResizeAutoScrollRef,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });

    vlist.scrollToIndex.mockClear();
    fixture.setClientHeight(320);
    await act(async () => {
      emitResize(fixture.scrollElement);
      await advanceAnimationFrames();
    });

    expect(vlist.scrollToIndex).not.toHaveBeenCalled();
    expect(fixture.getScrollTop()).toBe(240);
    expect(skipNextViewportResizeAutoScrollRef.current).toBe(false);
    expect(latestResult?.isSticky).toBe(true);
  });

  it('attaches when the scroll viewport mounts after the empty state', async () => {
    const sessionId = 'session-late-viewport' as SessionId;
    saveScrollPosition(sessionId, { type: 'offset', scrollOffset: 96 });

    await renderHarness({
      sessionId,
      vlist: null,
      scrollElement: null,
      itemCount: 0,
    });

    const fixture = createScrollFixture();
    const vlist = createMockVirtualizerHandle(fixture.scrollElement);
    await renderHarness({
      sessionId,
      vlist,
      scrollElement: fixture.scrollElement,
      itemCount: 4,
    });
    await act(async () => {
      await advanceAnimationFrames();
    });

    expect(fixture.getScrollTop()).toBe(96);
    expect(latestResult?.initialScrollRestored).toBe(true);
    expect(latestResult?.isSticky).toBe(false);

    await act(async () => {
      fixture.scrollElement.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(2);
    });

    await act(async () => {
      latestResult?.scrollToBottom();
      await advanceAnimationFrames();
    });

    expect(fixture.getScrollTop()).toBe(240);
    expect(latestResult?.isSticky).toBe(true);

    fixture.setContentHeight(696);
    fixture.setScrollHeight(720);
    await act(async () => {
      emitResize(fixture.contentElement);
      await advanceAnimationFrames();
    });

    expect(Math.abs(fixture.getScrollTop() - 320)).toBeLessThanOrEqual(1);
    expect(latestResult?.isSticky).toBe(true);
  });

  /**
   * A cold virtualizer knows no row heights, so it lays a long conversation
   * out at an estimated total height and only corrects once the first rows are
   * measured — the conversation stays hidden across that correction, which is
   * the blank flash when a session is opened or switched to.
   */
  describe('row measurements across a close and reopen', () => {
    it('hands the previous measurements back when a settled session reopens', async () => {
      const sessionId = 'session-measurements-reopen' as SessionId;
      const measured = measurementsOf('settled');
      const first = createScrollFixture();
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(first.scrollElement, measured),
        scrollElement: first.scrollElement,
        itemCount: 4,
      });
      expect(latestResult?.initialScrollRestored).toBe(true);
      // Nothing was stored before this session had ever been laid out.
      expect(latestResult?.initialVirtualizerCache).toBeUndefined();

      await closeHarness();

      const second = createScrollFixture();
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(second.scrollElement, measurementsOf('cold')),
        scrollElement: second.scrollElement,
        itemCount: 4,
      });
      expect(latestResult?.initialVirtualizerCache).toBe(measured);
    });

    it('waits for the real rows when the session opens on its empty state', async () => {
      const sessionId = 'session-measurements-late-rows' as SessionId;
      const measured = measurementsOf('settled');
      const first = createScrollFixture();
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(first.scrollElement, measured),
        scrollElement: first.scrollElement,
        itemCount: 4,
      });
      expect(latestResult?.initialScrollRestored).toBe(true);

      await closeHarness();

      // A session whose document is still being acquired renders the empty
      // sentinel: no virtualized rows, but the non-null leading fragment still
      // counts as one item. Answering then would answer for a one-row list.
      const second = createScrollFixture();
      const props = {
        sessionId,
        vlist: createMockVirtualizerHandle(second.scrollElement, measurementsOf('cold')),
        scrollElement: second.scrollElement,
      };
      await renderHarness({ ...props, itemCount: 1, hasVirtualizedRows: false });
      expect(latestResult?.initialVirtualizerCache).toBeUndefined();

      // The conversation arrives and the virtualizer is about to mount.
      await renderHarness({ ...props, itemCount: 4, hasVirtualizedRows: true });
      expect(latestResult?.initialVirtualizerCache).toBe(measured);
    });

    it('starts cold when the conversation grew while it was closed', async () => {
      const sessionId = 'session-measurements-grown' as SessionId;
      const first = createScrollFixture();
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(first.scrollElement, measurementsOf('settled')),
        scrollElement: first.scrollElement,
        itemCount: 4,
      });
      expect(latestResult?.initialScrollRestored).toBe(true);

      await closeHarness();

      // Virtua's snapshot is positional, so replaying it against shifted
      // indexes would size the wrong rows.
      const second = createScrollFixture();
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(second.scrollElement, measurementsOf('cold')),
        scrollElement: second.scrollElement,
        itemCount: 6,
      });
      expect(latestResult?.initialVirtualizerCache).toBeUndefined();
    });

    it('stores nothing from a session whose layout never settled', async () => {
      const sessionId = 'session-measurements-unsettled' as SessionId;
      const first = createScrollFixture();
      // No mounted tail row means the initial layout never becomes ready, so
      // the handle only holds estimates — storing them would poison the reopen.
      first.lastRow.remove();
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(first.scrollElement, measurementsOf('estimated')),
        scrollElement: first.scrollElement,
        itemCount: 4,
      });
      expect(latestResult?.initialScrollRestored).toBe(false);

      // Scrolling can stop before the initial layout is ready. Those are the
      // estimates the reopen is trying to avoid, so they must not be stored.
      await act(async () => {
        latestResult?.persistVirtualizerCache();
      });

      await closeHarness();

      const second = createScrollFixture();
      await renderHarness({
        sessionId,
        vlist: createMockVirtualizerHandle(second.scrollElement, measurementsOf('cold')),
        scrollElement: second.scrollElement,
        itemCount: 4,
      });
      expect(latestResult?.initialVirtualizerCache).toBeUndefined();
    });
  });
});
