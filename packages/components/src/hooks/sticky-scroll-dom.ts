/** Ignore sub-pixel differences when clamping to the true DOM bottom. */
const SCROLL_EPSILON = 1;
/** Ready-check slack: the sticky library stops 1px short, plus fractional geometry. */
const INITIAL_LAYOUT_BOTTOM_EPSILON = 2;

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
  setScrollTop?: (offset: number) => void;
}): void {
  const { itemCount, scrollElement, setScrollTop } = options;
  if (itemCount <= 0) return;

  // Follow the viewport, not a captured row index: hydration/eviction can
  // remove that row while Virtua is still waiting for measurements.
  if (!scrollElement) return;

  const maxScrollTop = getScrollElementMaxOffset(scrollElement);
  if (Math.abs(scrollElement.scrollTop - maxScrollTop) > SCROLL_EPSILON) {
    if (setScrollTop) setScrollTop(maxScrollTop);
    else scrollElement.scrollTop = maxScrollTop;
  }
}

/**
 * Virtua item-offset of the visible content bottom. Viewport padding is not in
 * Virtua's coordinate space; subtracting both edges is required or
 * `findItemIndex` looks past the painted last row.
 */
export function visibleContentBottomOffset(viewport: HTMLElement, scrollOffset: number): number {
  const paddingTop = parseFloat(getComputedStyle(viewport).paddingTop) || 0;
  const paddingBottom = parseFloat(getComputedStyle(viewport).paddingBottom) || 0;
  return scrollOffset + viewport.clientHeight - paddingTop - paddingBottom;
}

/** Initial visibility requires Virtua's measured destination, not just a DOM scroll write. */
export function isInitialScrollLayoutReady(
  viewport: HTMLElement,
  virtualizer: { scrollOffset: number; findItemIndex: (offset: number) => number },
  itemCount: number,
  /**
   * Restore intent is the session end, not the library's ~70px near-bottom
   * lock. Offset restores must not take the flush-to-bottom branch.
   */
  following: boolean
): boolean {
  const content = viewport.firstElementChild;
  if (!content || viewport.clientHeight <= 0 || itemCount <= 0) return false;
  if (Math.abs(virtualizer.scrollOffset - viewport.scrollTop) > 1) return false;
  const target = following
    ? itemCount - 1
    : virtualizer.findItemIndex(visibleContentBottomOffset(viewport, virtualizer.scrollOffset));
  const viewportTop = viewport.getBoundingClientRect().top;
  let targetRow: HTMLElement | undefined;
  for (const row of content.children) {
    if (!(row instanceof HTMLElement)) continue;
    const rect = row.getBoundingClientRect();
    // Virtua hides unmeasured rows with an inline visibility style. Inherited
    // visibility is deliberately hidden until this check succeeds.
    if (
      row.style.visibility === 'hidden' &&
      rect.bottom > viewportTop &&
      rect.top < viewportTop + viewport.clientHeight
    )
      return false;
    if (Number(row.dataset.virtualIndex) === target) targetRow = row;
  }
  if (!targetRow || targetRow.style.visibility === 'hidden') return false;
  // Scroll geometry, not last-row getBoundingClientRect: the scroller is
  // `visibility: hidden` with `contain: strict` until this returns true, and
  // descendant boxes are not a reliable flush signal.
  if (
    following &&
    viewport.scrollHeight > viewport.clientHeight &&
    getScrollElementDistanceFromBottom(viewport) > INITIAL_LAYOUT_BOTTOM_EPSILON
  ) {
    return false;
  }
  return true;
}
