// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useHorizontalWheelScroll,
  type HorizontalWheelScrollOptions,
} from '../src/hooks/use-horizontal-wheel-scroll';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function HorizontalScroller({
  options,
}: {
  options?: HorizontalWheelScrollOptions<HTMLDivElement>;
}) {
  const ref = useHorizontalWheelScroll(options);
  return (
    <div ref={ref}>
      <span data-column />
    </div>
  );
}

function setScrollGeometry(
  viewport: HTMLDivElement,
  {
    scrollLeft = 200,
    scrollWidth = 2000,
    clientWidth = 800,
  }: { scrollLeft?: number; scrollWidth?: number; clientWidth?: number } = {}
) {
  viewport.scrollLeft = scrollLeft;
  Object.defineProperties(viewport, {
    scrollWidth: { configurable: true, value: scrollWidth },
    clientWidth: { configurable: true, value: clientWidth },
  });
}

function dispatchWheel(target: Element, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('useHorizontalWheelScroll', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(options?: HorizontalWheelScrollOptions<HTMLDivElement>) {
    await act(async () => root.render(<HorizontalScroller options={options} />));
    const viewport = container.firstElementChild;
    if (!(viewport instanceof HTMLDivElement)) throw new Error('missing scroll viewport');
    setScrollGeometry(viewport);
    return viewport;
  }

  it('moves the viewport horizontally and cancels the original vertical wheel', async () => {
    const viewport = await render();

    const event = dispatchWheel(viewport, { deltaY: 120 });

    expect(viewport.scrollLeft).toBe(320);
    expect(event.defaultPrevented).toBe(true);
  });

  it('normalizes line and page deltas before clamping to the scroll range', async () => {
    const viewport = await render();

    dispatchWheel(viewport, { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(viewport.scrollLeft).toBe(232);

    dispatchWheel(viewport, { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_PAGE });
    expect(viewport.scrollLeft).toBe(1200);
  });

  it('leaves horizontal gestures, browser zoom, and horizontal edges to the browser', async () => {
    const viewport = await render();

    const horizontal = dispatchWheel(viewport, { deltaX: 10, deltaY: 20 });
    const zoom = dispatchWheel(viewport, { ctrlKey: true, deltaY: 20 });
    setScrollGeometry(viewport, { scrollLeft: 1200 });
    const atEnd = dispatchWheel(viewport, { deltaY: 20 });

    expect(viewport.scrollLeft).toBe(1200);
    expect(horizontal.defaultPrevented).toBe(false);
    expect(zoom.defaultPrevented).toBe(false);
    expect(atEnd.defaultPrevented).toBe(false);
  });

  it('lets a caller reserve wheel events owned by nested content', async () => {
    const viewport = await render({
      shouldHandle: (event, ownViewport) => event.target === ownViewport,
    });
    const child = viewport.querySelector('[data-column]');
    if (!child) throw new Error('missing nested content');

    const nestedEvent = dispatchWheel(child, { deltaY: 120 });
    const viewportEvent = dispatchWheel(viewport, { deltaY: 120 });

    expect(viewport.scrollLeft).toBe(320);
    expect(nestedEvent.defaultPrevented).toBe(false);
    expect(viewportEvent.defaultPrevented).toBe(true);
  });

  it('does not consume wheel events while disabled', async () => {
    const viewport = await render({ enabled: false });

    const event = dispatchWheel(viewport, { deltaY: 120 });

    expect(viewport.scrollLeft).toBe(200);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores sub-pixel overflow at either edge', async () => {
    const viewport = await render();
    setScrollGeometry(viewport, { scrollLeft: 0, scrollWidth: 800.5 });

    const atRightHairline = dispatchWheel(viewport, { deltaY: 120 });
    setScrollGeometry(viewport, { scrollLeft: 0.5, scrollWidth: 1600 });
    const atLeftHairline = dispatchWheel(viewport, { deltaY: -120 });

    expect(viewport.scrollLeft).toBe(0.5);
    expect(atRightHairline.defaultPrevented).toBe(false);
    expect(atLeftHairline.defaultPrevented).toBe(false);
  });
});
