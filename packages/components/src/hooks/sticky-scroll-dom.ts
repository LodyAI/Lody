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

/**
 * Why the initial reveal is still waiting, or `null` once the virtualizer's
 * measured destination agrees with the DOM. Initial visibility requires Virtua's
 * measured destination, not just a DOM scroll write.
 */
export function getInitialScrollLayoutBlocker(
  viewport: HTMLElement,
  virtualizer: { scrollOffset: number; findItemIndex: (offset: number) => number },
  itemCount: number,
  following: boolean
): string | null {
  const content = viewport.firstElementChild;
  if (!content) return 'no-content';
  if (viewport.clientHeight <= 0) return 'zero-viewport';
  if (itemCount <= 0) return 'no-items';
  if (Math.abs(virtualizer.scrollOffset - viewport.scrollTop) > 1) return 'offset-mismatch';
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
      return 'hidden-visible-row';
    if (Number(row.dataset.virtualIndex) === target) targetRow = row;
  }
  if (!targetRow) return 'target-unmounted';
  if (targetRow.style.visibility === 'hidden') return 'target-unmeasured';
  if (following && viewport.scrollHeight > viewport.clientHeight) {
    const bottom = targetRow.getBoundingClientRect().bottom - viewportTop;
    // scrollHeight rounds to an integer; fractional row geometry can therefore
    // differ by <2px.
    if (Math.abs(bottom - (viewport.clientHeight - paddingBottom)) > 2) return 'tail-not-at-bottom';
  }
  return null;
}

export function isInitialScrollLayoutReady(
  viewport: HTMLElement,
  virtualizer: { scrollOffset: number; findItemIndex: (offset: number) => number },
  itemCount: number,
  following: boolean
): boolean {
  return getInitialScrollLayoutBlocker(viewport, virtualizer, itemCount, following) === null;
}

/** Mounted Virtua rows that intersect the viewport while still hidden for measurement. */
export function countHiddenRowsInViewport(viewport: HTMLElement): number {
  const content = viewport.firstElementChild;
  if (!content) return 0;
  const viewportTop = viewport.getBoundingClientRect().top;
  let hidden = 0;
  for (const row of content.children) {
    if (!(row instanceof HTMLElement) || row.style.visibility !== 'hidden') continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewportTop && rect.top < viewportTop + viewport.clientHeight) hidden += 1;
  }
  return hidden;
}

/**
 * The virtualized content's start and end in the viewport's scroll coordinates.
 * The end includes mounted rows that overflow the spacer Virtua has committed.
 */
export function getContentExtentInScroll(
  viewport: HTMLElement
): { top: number; bottom: number } | null {
  const content = viewport.firstElementChild;
  if (!(content instanceof HTMLElement)) return null;
  const viewportTop = viewport.getBoundingClientRect().top;
  const contentRect = content.getBoundingClientRect();
  let bottom = contentRect.bottom;
  for (const row of content.children) {
    bottom = Math.max(bottom, row.getBoundingClientRect().bottom);
  }
  return {
    top: contentRect.top - viewportTop + viewport.scrollTop,
    bottom: bottom - viewportTop + viewport.scrollTop,
  };
}

/** Where the virtualized content starts, in the viewport's scroll coordinates. */
export function getContentTopInScroll(viewport: HTMLElement): number | null {
  const content = viewport.firstElementChild;
  if (!(content instanceof HTMLElement)) return null;
  return (
    content.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
  );
}

/**
 * Whether an upward wheel over `target` scrolls some element nested inside the
 * viewport (a code block, a terminal) rather than the viewport itself.
 */
export function wheelUpScrollsNestedElement(
  target: EventTarget | null,
  viewport: Element
): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== viewport) {
    if (element instanceof HTMLElement && element.scrollTop > 0) {
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return true;
    }
    element = element.parentElement;
  }
  return false;
}
