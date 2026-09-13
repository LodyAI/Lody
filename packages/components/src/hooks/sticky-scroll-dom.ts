/** Ignore sub-pixel differences when clamping to the true DOM bottom. */
const SCROLL_EPSILON = 1;

export type ScrollElementLike = Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;

export function getScrollElementDistanceFromBottom(scrollElement: ScrollElementLike): number {
  return Math.max(
    0,
    scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
  );
}

export function getScrollElementMaxOffset(scrollElement: ScrollElementLike): number {
  return Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
}

export function scrollViewportToRealBottom(options: {
  itemCount: number;
  scrollElement: ScrollElementLike | null;
}): void {
  const { itemCount, scrollElement } = options;
  if (itemCount <= 0) return;

  // Follow the viewport, not a captured row index: hydration/eviction can
  // remove that row while Virtua is still waiting for measurements.
  if (!scrollElement) return;

  const maxScrollTop = getScrollElementMaxOffset(scrollElement);
  if (Math.abs(scrollElement.scrollTop - maxScrollTop) > SCROLL_EPSILON) {
    scrollElement.scrollTop = maxScrollTop;
  }
}
