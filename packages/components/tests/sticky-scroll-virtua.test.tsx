// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { it, expect, vi } from 'vitest';
import { scrollViewportToRealBottom } from '../src/hooks/sticky-scroll-dom';

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
