import { vi } from 'vitest';

/**
 * A browser-shaped frame loop for jsdom scroll tests.
 *
 * jsdom has no layout, no scroll events and no ResizeObserver. This harness
 * supplies the three with the ordering the HTML "update the rendering" steps
 * give them, because the conversation's blank-pane bugs live in that ordering:
 *
 * - `scrollTop` writes clamp to `[0, scrollHeight - clientHeight]` at the moment
 *   of the write; `scrollBy` adds to the current value.
 * - A frame dispatches at most one `scroll` event per viewport, and only when
 *   the offset changed since the last dispatch — a change undone within the
 *   same task still queues one (CSSOM pending scroll event targets).
 * - Scroll steps run before ResizeObserver delivery.
 * - A ResizeObserver delivers a target only when its size differs from the
 *   size it last delivered for that target (the first observation always
 *   delivers).
 *
 * Sizes come from the caller: `sizeOf(element)` returns the element's height,
 * or `undefined` for elements whose size never matters. `rectOf(element)`
 * optionally returns an element's top and height in viewport coordinates, for
 * code that reads `getBoundingClientRect`.
 */
export interface FrameHarness {
  /** Install on a viewport element once it is mounted. */
  attachViewport(viewport: HTMLElement): void;
  /** Current scrollTop of the attached viewport. */
  readonly scrollTop: number;
  /** Every value assigned to scrollTop, in order (before clamping). */
  readonly writes: number[];
  /** Run one frame: scroll steps, then ResizeObserver delivery. Returns true if anything was delivered. */
  frame(): boolean;
  /** Hold ResizeObserver deliveries for targets matching `predicate`. */
  hold(predicate: ((target: Element) => boolean) | null): void;
  /** Simulated reader scroll: moves the offset like a native scroll would. */
  nativeScrollTo(offset: number): void;
  restore(): void;
}

type Observation = {
  callback: ResizeObserverCallback;
  targets: Map<Element, number | undefined>;
  observer: ResizeObserver;
};

export function createFrameHarness({
  viewportHeight,
  sizeOf,
  scrollHeightOf,
  rectOf,
}: {
  viewportHeight: () => number;
  sizeOf: (element: Element) => number | undefined;
  scrollHeightOf: (viewport: HTMLElement) => number;
  rectOf?: (element: Element, scrollTop: number) => { top: number; height: number } | undefined;
}): FrameHarness {
  const observations: Observation[] = [];
  let heldPredicate: ((target: Element) => boolean) | null = null;
  let viewport: HTMLElement | null = null;
  let top = 0;
  let pendingScroll = false;
  const writes: number[] = [];

  class FakeResizeObserver {
    private readonly observation: Observation;
    constructor(callback: ResizeObserverCallback) {
      this.observation = {
        callback,
        targets: new Map(),
        observer: this as unknown as ResizeObserver,
      };
      observations.push(this.observation);
    }
    observe(target: Element) {
      if (!this.observation.targets.has(target)) this.observation.targets.set(target, undefined);
    }
    unobserve(target: Element) {
      this.observation.targets.delete(target);
    }
    disconnect() {
      this.observation.targets.clear();
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);

  const originalRect = Element.prototype.getBoundingClientRect;
  if (rectOf) {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = rectOf(this, Math.min(top, maxTop()));
      if (!rect) return originalRect.call(this);
      return {
        x: 0,
        y: rect.top,
        top: rect.top,
        left: 0,
        width: 400,
        height: rect.height,
        bottom: rect.top + rect.height,
        right: 400,
        toJSON() {},
      } as DOMRect;
    };
  }

  const maxTop = () => (viewport ? Math.max(0, scrollHeightOf(viewport) - viewportHeight()) : 0);
  const setTop = (value: number) => {
    writes.push(value);
    const next = Number.isFinite(value) ? Math.min(maxTop(), Math.max(0, value)) : 0;
    if (next !== top) pendingScroll = true;
    top = next;
  };

  return {
    attachViewport(element) {
      viewport = element;
      Object.defineProperties(element, {
        clientHeight: { configurable: true, get: () => viewportHeight() },
        offsetHeight: { configurable: true, get: () => viewportHeight() },
        scrollHeight: { configurable: true, get: () => scrollHeightOf(element) },
        scrollTop: {
          configurable: true,
          get: () => Math.min(top, maxTop()),
          set: setTop,
        },
      });
      element.scrollTo = ((arg: ScrollToOptions | number, y?: number) => {
        setTop(typeof arg === 'number' ? (y ?? 0) : (arg.top ?? top));
      }) as HTMLElement['scrollTo'];
      element.scrollBy = ((arg: ScrollToOptions | number, y?: number) => {
        setTop(Math.min(top, maxTop()) + (typeof arg === 'number' ? (y ?? 0) : (arg.top ?? 0)));
      }) as HTMLElement['scrollBy'];
    },
    get scrollTop() {
      return Math.min(top, maxTop());
    },
    writes,
    frame() {
      let delivered = false;
      // A clamp from a shrinking scroll range is a position change too.
      const clamped = Math.min(top, maxTop());
      if (clamped !== top) {
        top = clamped;
        pendingScroll = true;
      }
      if (viewport && pendingScroll) {
        pendingScroll = false;
        viewport.dispatchEvent(new Event('scroll'));
        delivered = true;
      }
      for (const observation of observations) {
        const entries: ResizeObserverEntry[] = [];
        for (const [target, last] of observation.targets) {
          if (!target.isConnected) continue;
          if (heldPredicate?.(target)) continue;
          const height = sizeOf(target);
          if (height === undefined) continue;
          if (last === height) continue;
          observation.targets.set(target, height);
          entries.push({
            target,
            contentRect: { width: 400, height, top: 0, left: 0, bottom: height, right: 400 },
            borderBoxSize: [{ blockSize: height, inlineSize: 400 }],
            contentBoxSize: [{ blockSize: height, inlineSize: 400 }],
          } as unknown as ResizeObserverEntry);
        }
        if (entries.length) {
          delivered = true;
          observation.callback(entries, observation.observer);
        }
      }
      return delivered;
    },
    hold(predicate) {
      heldPredicate = predicate;
    },
    nativeScrollTo(offset) {
      const next = Math.min(maxTop(), Math.max(0, offset));
      if (next !== top) pendingScroll = true;
      top = next;
    },
    restore() {
      Element.prototype.getBoundingClientRect = originalRect;
      vi.unstubAllGlobals();
    },
  };
}
