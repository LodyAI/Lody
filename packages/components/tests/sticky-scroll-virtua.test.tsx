// @vitest-environment jsdom
import React, { act, createRef, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { it, expect, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { scrollViewportToRealBottom } from '../src/hooks/sticky-scroll-dom';
import { useStickyScroll } from '../src/hooks/use-sticky-scroll';

it.each([5, 25])(
  'keeps bottom navigation finite when virtual row count changes to %i',
  async (nextCount) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const observers: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        o: { cb: ResizeObserverCallback; targets: Set<Element> };
        constructor(cb: ResizeObserverCallback) {
          this.o = { cb, targets: new Set() };
          observers.push(this.o);
        }
        observe = (e: Element) => this.o.targets.add(e);
        unobserve = (e: Element) => this.o.targets.delete(e);
        disconnect = () => this.o.targets.clear();
      }
    );
    const parentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return this.parentElement;
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host),
      ref = createRef<VirtualizerHandle>();
    let count = 20,
      top = 0;
    const writes: number[] = [];
    const render = () =>
      root.render(
        <div data-viewport="">
          <Virtualizer ref={ref} itemSize={100}>
            {Array.from({ length: count }, (_, i) => (
              <div key={i}>row {i}</div>
            ))}
          </Virtualizer>
        </div>
      );
    const flushResize = (rowHeight: number) => {
      for (const o of observers) {
        const entries = [...o.targets].map((target) => ({
          target,
          contentRect: {
            width: 400,
            height: target.hasAttribute('data-viewport') ? 400 : rowHeight,
          },
        }));
        o.cb(entries as ResizeObserverEntry[], {} as ResizeObserver);
      }
    };
    try {
      act(render);
      const viewport = host.firstElementChild as HTMLElement;
      Object.defineProperties(viewport, {
        clientHeight: { get: () => 400 },
        scrollHeight: { get: () => count * 100 },
        scrollTop: {
          get: () => top,
          set: (value: number) => {
            writes.push(value);
            top = Number.isFinite(value)
              ? Math.min(Math.max(0, count * 100 - 400), Math.max(0, value))
              : 0;
          },
        },
      });
      await act(async () => {
        flushResize(100);
      });
      await act(async () => {
        scrollViewportToRealBottom({ itemCount: count, scrollElement: viewport });
      });
      expect(top).toBe(1600);
      await act(async () => {
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(host.textContent).toContain('row 19');
      writes.length = 0;
      // A row measurement wakes the old scroll request. Membership shrinks before
      // its microtask resumes (e.g. older hydrated rows become placeholders).
      act(() => {
        flushResize(110);
        count = nextCount;
        render();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(writes.every(Number.isFinite)).toBe(true);
      expect(top).toBeGreaterThan(0);
      await act(async () => {
        scrollViewportToRealBottom({ itemCount: count, scrollElement: viewport });
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(top).toBe(count * 100 - 400);
      expect(host.textContent).toContain(`row ${count - 1}`);
    } finally {
      act(() => root.unmount());
      host.remove();
      if (parentDescriptor)
        Object.defineProperty(HTMLElement.prototype, 'offsetParent', parentDescriptor);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  }
);

/**
 * Mounts a real `useStickyScroll` + `Virtualizer` pair against a mocked
 * viewport. `writes` records every scrollTop assignment; `flushResize`
 * delivers one ResizeObserver batch to every observer in creation order, so
 * the sticky library's own content observer runs before the hook's — matching
 * the browser, where a same-batch re-lock has already landed when the hook's
 * callback runs.
 */
function mountStickyScroll(sessionId: SessionId) {
  const observers: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      o: { cb: ResizeObserverCallback; targets: Set<Element> };
      constructor(cb: ResizeObserverCallback) {
        this.o = { cb, targets: new Set() };
        observers.push(this.o);
      }
      observe = (e: Element) => this.o.targets.add(e);
      unobserve = (e: Element) => this.o.targets.delete(e);
      disconnect = () => this.o.targets.clear();
    }
  );
  const parentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<VirtualizerHandle>();
  const state = { count: 30, top: 0 };
  const writes: number[] = [];

  function Harness({ count }: { count: number }) {
    const vlistRef = useRef<VirtualizerHandle>(null);
    const { scrollRef } = useStickyScroll({ sessionId, vlistRef, itemCount: count });
    return (
      <div ref={scrollRef} data-viewport="">
        <Virtualizer ref={vlistRef} itemSize={100}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i}>row {i}</div>
          ))}
        </Virtualizer>
      </div>
    );
  }
  const render = () => root.render(<Harness count={state.count} />);
  const viewport = () => host.firstElementChild as HTMLElement;
  const content = () => viewport().firstElementChild as HTMLElement;
  const maxTop = () => state.count * 100 - 400;
  const flushResize = () => {
    for (const o of observers) {
      const entries = [...o.targets].map((target) => ({
        target,
        contentRect: {
          width: 400,
          height: target.hasAttribute('data-viewport')
            ? 400
            : target === content()
              ? state.count * 100
              : 100,
        },
      }));
      o.cb(entries as ResizeObserverEntry[], {} as ResizeObserver);
    }
  };
  return {
    host,
    root,
    ref,
    state,
    writes,
    render,
    viewport,
    content,
    maxTop,
    flushResize,
    parentDescriptor,
  };
}

async function settleMount(ctx: ReturnType<typeof mountStickyScroll>) {
  const { state, viewport } = ctx;
  Object.defineProperties(viewport(), {
    clientHeight: { get: () => 400 },
    scrollHeight: { get: () => state.count * 100 },
    scrollTop: {
      get: () => Math.min(state.top, Math.max(0, state.count * 100 - 400)),
      set: (value: number) => {
        ctx.writes.push(value);
        if (Number.isFinite(value)) state.top = Math.max(0, value);
      },
    },
  });
  await act(async () => {
    ctx.flushResize();
    await vi.advanceTimersByTimeAsync(50);
  });
}

it('does not re-arm the follow lock from a resize for a non-following reader', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const ctx = mountStickyScroll('sticky-relock-guard' as SessionId);
  const { state, viewport, flushResize } = ctx;
  try {
    act(ctx.render);
    await settleMount(ctx);
    expect(state.top).toBe(ctx.maxTop());

    // Escape follow mode: two upward steps so the library's scroll handler
    // observes a direction change and clears the lock.
    await act(async () => {
      state.top = ctx.maxTop() - 150;
      viewport().dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(2);
      state.top = ctx.maxTop() - 160;
      viewport().dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(2);
    });
    const escapedTop = state.top;
    ctx.writes.length = 0;

    // Collapse-like commit: one row removed. The content shrink lands the
    // viewport inside the library's near-bottom tolerance, where its own
    // ResizeObserver would re-lock follow and drag the reader to the end.
    act(() => {
      state.count = 29;
      ctx.render();
    });
    await act(async () => {
      flushResize();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(state.top).toBe(escapedTop);
    expect(ctx.writes).toEqual([]);
  } finally {
    act(() => ctx.root.unmount());
    ctx.host.remove();
    if (ctx.parentDescriptor)
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', ctx.parentDescriptor);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it('keeps following readers at the bottom across the same resize', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const ctx = mountStickyScroll('sticky-relock-following' as SessionId);
  const { state, flushResize } = ctx;
  try {
    act(ctx.render);
    await settleMount(ctx);
    expect(state.top).toBe(ctx.maxTop());

    // Same collapse, but the reader never escaped: follow stays engaged. The
    // library's own target stops one pixel short of the DOM bottom.
    act(() => {
      state.count = 29;
      ctx.render();
    });
    await act(async () => {
      flushResize();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(state.top).toBeGreaterThanOrEqual(ctx.maxTop() - 1);
  } finally {
    act(() => ctx.root.unmount());
    ctx.host.remove();
    if (ctx.parentDescriptor)
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', ctx.parentDescriptor);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
