/**
 * @vitest-environment jsdom
 */

import React, { act, useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import type { VirtualizerHandle } from 'virtua';
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

type HarnessProps = {
  sessionId: SessionId;
  vlist: MockVirtualizerHandle | null;
  scrollElement: HTMLDivElement | null;
  itemCount: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  skipNextViewportResizeAutoScrollRef?: React.MutableRefObject<boolean>;
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

  return {
    scrollElement,
    contentElement,
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

function createMockVirtualizerHandle(scrollElement: HTMLElement): MockVirtualizerHandle {
  const handle = {
    scrollSize: 640,
    viewportSize: 400,
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
  onAtBottomChange,
  skipNextViewportResizeAutoScrollRef,
}: HarnessProps) {
  const vlistRef = useRef<VirtualizerHandle | null>(vlist);
  vlistRef.current = vlist;

  const result = useStickyScroll({
    sessionId,
    vlistRef,
    itemCount,
    onAtBottomChange,
    skipNextViewportResizeAutoScrollRef,
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
    expect(latestResult?.initialScrollRestored).toBe(false);
    await act(async () => {
      await advanceAnimationFrames();
    });

    expect(vlist.scrollTo).toHaveBeenCalledWith(96);
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
    expect(fixture.getScrollTop()).toBeCloseTo(319, 5);
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

    expect(vlist.scrollToIndex).toHaveBeenCalledWith(3, { align: 'end', offset: 24 });
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

    expect(vlist.scrollTo).toHaveBeenCalledWith(96);
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

    expect(fixture.getScrollTop()).toBeCloseTo(319, 5);
    expect(latestResult?.isSticky).toBe(true);
  });
});
