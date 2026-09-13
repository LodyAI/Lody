import { useCallback, useRef, type RefCallback } from 'react';
import { useLatestRef } from './use-latest-ref';

type HorizontalWheelScrollViewport = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

export type HorizontalWheelScrollOptions<ElementType extends HTMLElement> = {
  enabled?: boolean;
  shouldHandle?: (event: WheelEvent, viewport: ElementType) => boolean;
};

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const LINE_HEIGHT_PX = 16;
const SCROLL_EPSILON_PX = 1;

function resolveHorizontalWheelScrollLeft(input: {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  defaultPrevented?: boolean;
  viewport: HorizontalWheelScrollViewport;
}): number | null {
  const {
    deltaX,
    deltaY,
    deltaMode = DOM_DELTA_PIXEL,
    ctrlKey = false,
    defaultPrevented = false,
    viewport,
  } = input;
  if (defaultPrevented || ctrlKey || deltaX !== 0 || deltaY === 0) return null;

  const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const remainingScroll = deltaY < 0 ? viewport.scrollLeft : maxScrollLeft - viewport.scrollLeft;
  if (remainingScroll <= SCROLL_EPSILON_PX) return null;

  const unit =
    deltaMode === DOM_DELTA_LINE
      ? LINE_HEIGHT_PX
      : deltaMode === DOM_DELTA_PAGE
        ? viewport.clientWidth
        : 1;
  return Math.max(0, Math.min(maxScrollLeft, viewport.scrollLeft + deltaY * unit));
}

/**
 * Converts a plain vertical mouse wheel into horizontal viewport movement.
 * Native horizontal/zoom gestures and wheels at a horizontal edge remain with
 * the browser. A native listener is required because React delegates `wheel`
 * passively, which cannot reliably cancel the original vertical scroll.
 */
export function useHorizontalWheelScroll<ElementType extends HTMLElement = HTMLDivElement>(
  options: HorizontalWheelScrollOptions<ElementType> = {}
): RefCallback<ElementType> {
  const optionsRef = useLatestRef(options);
  const viewportRef = useRef<ElementType | null>(null);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      const viewport = viewportRef.current;
      const { enabled = true, shouldHandle } = optionsRef.current;
      if (!viewport || !enabled) return;

      const nextScrollLeft = resolveHorizontalWheelScrollLeft({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        defaultPrevented: event.defaultPrevented,
        viewport,
      });
      if (nextScrollLeft === null || (shouldHandle && !shouldHandle(event, viewport))) return;

      event.preventDefault();
      viewport.scrollLeft = nextScrollLeft;
    },
    [optionsRef]
  );

  return useCallback(
    (nextViewport) => {
      const previousViewport = viewportRef.current;
      if (previousViewport === nextViewport) return;

      previousViewport?.removeEventListener('wheel', handleWheel);
      viewportRef.current = nextViewport;
      nextViewport?.addEventListener('wheel', handleWheel, { passive: false });
    },
    [handleWheel]
  );
}
