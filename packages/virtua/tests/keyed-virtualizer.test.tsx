// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Virtualizer, type VirtualizerHandle } from '../src/index';

type Observed = { cb: ResizeObserverCallback; targets: Set<Element> };
let observers: Observed[];
let host: HTMLDivElement;
let root: Root;
let scrollTop: number;
let rowHeight: (key: string) => number;
const ROW = 100;
const VIEWPORT = 400;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observers = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      o: Observed;
      constructor(cb: ResizeObserverCallback) {
        this.o = { cb, targets: new Set() };
        observers.push(this.o);
      }
      observe = (e: Element) => this.o.targets.add(e);
      unobserve = (e: Element) => this.o.targets.delete(e);
      disconnect = () => this.o.targets.clear();
    }
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  scrollTop = 0;
  rowHeight = () => ROW;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // Restore jsdom's own getter.
  delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
  vi.unstubAllGlobals();
});

/**
 * Deliver ResizeObserver measurements (the viewport, then every mounted row by
 * its key) until no new row mounts: each measurement can mount more rows.
 */
async function settle() {
  for (let round = 0; round < 10; round += 1) {
    const before = host.querySelectorAll('[data-key]').length;
    await act(async () => measure());
    if (host.querySelectorAll('[data-key]').length === before && round > 0) return;
  }
}

function measure() {
  for (const o of observers) {
    const entries = [...o.targets].map((target) => ({
      target,
      contentRect: {
        width: 400,
        height: target.hasAttribute('data-viewport')
          ? VIEWPORT
          : rowHeight((target.firstElementChild as HTMLElement).dataset.key!),
      },
    }));
    o.cb(entries as unknown as ResizeObserverEntry[], {} as ResizeObserver);
  }
}

function renderList(
  keys: string[],
  ref = createRef<VirtualizerHandle>(),
  cache?: VirtualizerHandle['cache']
) {
  act(() =>
    root.render(
      <div data-viewport="">
        <Virtualizer ref={ref} keyed cache={cache} bufferSize={0}>
          {keys.map((key) => (
            <div key={key} data-key={key}>
              {key}
            </div>
          ))}
        </Virtualizer>
      </div>
    )
  );
  return ref;
}

function viewport(): HTMLElement {
  const element = host.firstElementChild as HTMLElement;
  if (!Object.getOwnPropertyDescriptor(element, 'scrollTop')) {
    Object.defineProperties(element, {
      clientHeight: { get: () => VIEWPORT },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    element.scrollBy = ((options: ScrollToOptions) => {
      scrollTop += options.top ?? 0;
    }) as typeof element.scrollBy;
  }
  return element;
}

async function scrollTo(offset: number) {
  scrollTop = offset;
  await act(async () => {
    viewport().dispatchEvent(new Event('scroll'));
  });
  await settle();
}

/** The key of the row drawn at the viewport's top edge. */
function rowAtViewportTop(): string | undefined {
  const rows = [...host.querySelectorAll<HTMLElement>('[data-key]')];
  return rows.find((row) => parseFloat(row.parentElement!.style.top) === scrollTop)?.dataset.key;
}

const keys = (count: number, prefix = 'r') =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

it('keeps the row at the viewport top in place when rows are inserted above it', async () => {
  renderList(keys(20));
  viewport();
  await settle();
  await scrollTo(500);
  expect(rowAtViewportTop()).toBe('r5');

  // A placeholder above the reader becomes three rows.
  const next = keys(20);
  next.splice(2, 1, 'turn-a', 'turn-b', 'turn-c');
  renderList(next);
  await settle();

  expect(scrollTop).toBe(700);
  expect(rowAtViewportTop()).toBe('r5');
});

it('restores sizes by key although rows were inserted while the list was closed', async () => {
  rowHeight = (key) => (key === 'r1' ? 250 : ROW);
  const ref = renderList(keys(5));
  viewport();
  await settle();
  const snapshot = ref.current!.cache;
  act(() => root.unmount());

  root = createRoot(host);
  scrollTop = 0;
  const reopened = renderList(['new', ...keys(5)], createRef<VirtualizerHandle>(), snapshot);
  // Before any measurement: "r1" already has its 250px, "new" the estimate.
  expect(reopened.current!.getItemSize(2)).toBe(250);
  expect(reopened.current!.getItemOffset(3)).toBe(ROW + ROW + 250);
});
