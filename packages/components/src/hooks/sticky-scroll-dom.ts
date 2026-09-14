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

/** Initial visibility requires Virtua's measured destination, not just a DOM scroll write. */
export function isInitialScrollLayoutReady(
  viewport: HTMLElement,
  virtualizer: { scrollOffset: number; findItemIndex: (offset: number) => number },
  itemCount: number,
  following: boolean
): boolean {
  const content = viewport.firstElementChild;
  if (!content || viewport.clientHeight <= 0 || itemCount <= 0) return false;
  if (Math.abs(virtualizer.scrollOffset - viewport.scrollTop) > 1) return false;
  const paddingBottom = parseFloat(getComputedStyle(viewport).paddingBottom) || 0;
  const target = following
    ? itemCount - 1
    : virtualizer.findItemIndex(viewport.scrollTop + viewport.clientHeight - paddingBottom);
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
  if (following && viewport.scrollHeight > viewport.clientHeight) {
    const bottom = targetRow.getBoundingClientRect().bottom - viewportTop;
    // scrollHeight rounds to an integer; the sticky library intentionally stops
    // one pixel short. Fractional row geometry can therefore differ by <2px.
    if (Math.abs(bottom - (viewport.clientHeight - paddingBottom)) > 2) return false;
  }
  return true;
}
