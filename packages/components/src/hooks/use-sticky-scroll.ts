import {
  type MutableRefObject,
  type RefCallback,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { VirtualizerHandle } from 'virtua';
import type { SessionId } from '@lody/shared';
import { getScrollBottomPaddingOffset, scrollViewportToRealBottom } from './sticky-scroll-dom';
import { getScrollPosition, saveScrollPosition } from './use-scroll-position-cache';

export interface UseStickyScrollOptions {
  sessionId: SessionId;
  vlistRef: RefObject<VirtualizerHandle | null>;
  /** Total number of items in the list. Used as the scroll-to target index. */
  itemCount: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  /**
   * Set by the session composer immediately before it changes its own height.
   * The next viewport height change consumes this one-shot flag without
   * pulling the reader back to the bottom.
   */
  skipNextViewportResizeAutoScrollRef?: MutableRefObject<boolean>;
  /**
   * When true, releases follow-output before a programmatic jump or expansion
   * can resize the list underneath it.
   */
  suppressAutoScrollRef?: RefObject<boolean>;
}

export interface UseStickyScrollResult {
  /** Attach directly to the scroll viewport that owns the Virtua virtualizer. */
  scrollRef: RefCallback<HTMLDivElement>;
  /**
   * The bound viewport, for consumers that need its geometry. Exposed so they
   * do not compose a second callback ref onto {@link scrollRef} to recover it —
   * that binding has one owner on purpose (see AGENTS.md), and a wrapper in
   * front of it re-attaches this hook's listeners whenever the wrapper's
   * identity changes.
   */
  scrollElement: HTMLDivElement | null;
  /** Whether the view is currently locked to the bottom. */
  isSticky: boolean;
  /** Force-scroll to bottom and re-enable sticky mode. */
  scrollToBottom: () => void;
  /** Whether the initial cached/end position has been applied to the virtualizer. */
  initialScrollRestored: boolean;
  /** Pass to Virtua's onScroll prop. */
  handleScroll: (offset: number) => void;
}

/**
 * `use-stick-to-bottom` observes content growth. Observe the viewport too so a
 * docked panel or window inset shrinking the available height cannot leave a
 * followed conversation floating above the real bottom. ResizeObserver is the
 * completion signal for every committed viewport height; no transition-duration
 * clock or custom resize-event pump is needed.
 */
function useStickyViewportResizeObserver(options: {
  itemCountRef: MutableRefObject<number>;
  stickyBottomRef: MutableRefObject<boolean>;
  scrollElement: HTMLElement | null;
  scrollToRealBottom: () => void;
  skipNextViewportResizeAutoScrollRef?: MutableRefObject<boolean>;
  suppressAutoScrollRef?: RefObject<boolean>;
}): void {
  const {
    itemCountRef,
    stickyBottomRef,
    scrollElement,
    scrollToRealBottom,
    skipNextViewportResizeAutoScrollRef,
    suppressAutoScrollRef,
  } = options;

  useEffect(() => {
    if (!scrollElement || typeof ResizeObserver === 'undefined') return undefined;

    let previousHeight = scrollElement.getBoundingClientRect().height;
    let rafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { height } = entry.contentRect;
        if (height === previousHeight) continue;
        previousHeight = height;
        if (skipNextViewportResizeAutoScrollRef?.current) {
          skipNextViewportResizeAutoScrollRef.current = false;
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          continue;
        }
        if (!stickyBottomRef.current || itemCountRef.current <= 0) continue;
        if (suppressAutoScrollRef?.current || rafId !== null) continue;

        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (stickyBottomRef.current && !suppressAutoScrollRef?.current) {
            scrollToRealBottom();
          }
        });
      }
    });

    observer.observe(scrollElement);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    itemCountRef,
    scrollElement,
    scrollToRealBottom,
    skipNextViewportResizeAutoScrollRef,
    stickyBottomRef,
    suppressAutoScrollRef,
  ]);
}

export function useStickyScroll({
  sessionId,
  vlistRef,
  itemCount,
  onAtBottomChange,
  skipNextViewportResizeAutoScrollRef,
  suppressAutoScrollRef,
}: UseStickyScrollOptions): UseStickyScrollResult {
  const cachedPositionAtMountRef = useRef(getScrollPosition(sessionId));
  const stickToBottom = useStickToBottom({
    initial: cachedPositionAtMountRef.current?.type === 'offset' ? false : 'instant',
    resize: 'instant',
  });
  const {
    contentRef,
    scrollRef: stickToBottomScrollRef,
    scrollToBottom: scrollToBottomWithLock,
    state,
    stopScroll,
  } = stickToBottom;

  // `isAtBottom` returned by the library also includes its near-bottom
  // tolerance. The mutable state field is the actual follow lock: upward user
  // intent clears it, while an explicit scrollToBottom call restores it. Using
  // `escapedFromLock` here would leave the UI permanently escaped after that
  // explicit re-lock because it records history rather than the current lock.
  const isSticky = state.isAtBottom;
  const stickyBottomRef = useRef(isSticky);
  stickyBottomRef.current = isSticky;

  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;

  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const initialScrollRestoredRef = useRef(false);
  const [initialScrollRestored, setInitialScrollRestored] = useState(false);

  const handleWheelUp = useCallback(
    (event: WheelEvent) => {
      if (event.deltaY < 0) stopScroll();
    },
    [stopScroll]
  );

  const setScrollRef = useCallback<RefCallback<HTMLDivElement>>(
    (nextScrollElement) => {
      const previousScrollElement = scrollElementRef.current;
      if (previousScrollElement === nextScrollElement) return;

      if (previousScrollElement) {
        previousScrollElement.removeEventListener('wheel', handleWheelUp);
      }
      contentRef(null);
      stickToBottomScrollRef(null);

      scrollElementRef.current = nextScrollElement;
      setScrollElement(nextScrollElement);
      if (!nextScrollElement) return;

      const contentElement = nextScrollElement.firstElementChild;
      if (!(contentElement instanceof HTMLElement)) return;

      stickToBottomScrollRef(nextScrollElement);
      contentRef(contentElement);
      nextScrollElement.addEventListener('wheel', handleWheelUp, { passive: true });
    },
    [contentRef, handleWheelUp, stickToBottomScrollRef]
  );

  const scrollToRealBottom = useCallback(() => {
    const currentScrollElement = scrollElementRef.current;
    scrollViewportToRealBottom({
      itemCount: itemCountRef.current,
      vlist: vlistRef.current,
      scrollElement: currentScrollElement,
      bottomOffset: getScrollBottomPaddingOffset(currentScrollElement),
    });
  }, [itemCountRef, vlistRef]);

  useEffect(() => {
    if (initialScrollRestoredRef.current || itemCount === 0) return;
    if (!vlistRef.current) return;

    const cachedState = cachedPositionAtMountRef.current;
    requestAnimationFrame(() => {
      const currentVlist = vlistRef.current;
      if (!currentVlist) return;

      if (cachedState?.type === 'offset') {
        stopScroll();
        currentVlist.scrollTo(cachedState.scrollOffset);
      } else {
        void scrollToBottomWithLock({ animation: 'instant' });
        scrollToRealBottom();
      }
      initialScrollRestoredRef.current = true;
      setInitialScrollRestored(true);
    });
  }, [itemCount, scrollToBottomWithLock, scrollToRealBottom, stopScroll, vlistRef]);

  // Search jumps and group expansion are deliberate reading-position changes.
  // Release follow in a layout effect so ResizeObserver cannot pull the list to
  // the end between the React commit and the caller's programmatic jump.
  useLayoutEffect(() => {
    if (suppressAutoScrollRef?.current) stopScroll();
  });

  const scrollToBottom = useCallback(() => {
    saveScrollPosition(sessionId, { type: 'end' });
    if (itemCountRef.current <= 0) return;
    void scrollToBottomWithLock({ animation: 'instant' });
    scrollToRealBottom();
  }, [itemCountRef, scrollToBottomWithLock, scrollToRealBottom, sessionId]);

  const handleScroll = useCallback(
    (offset: number) => {
      const scrollOffset = scrollElementRef.current?.scrollTop ?? offset;
      const followingBottom = state.isAtBottom;
      saveScrollPosition(
        sessionId,
        followingBottom ? { type: 'end' } : { type: 'offset', scrollOffset }
      );
    },
    [sessionId, state]
  );

  const previousStickyRef = useRef(isSticky);
  useEffect(() => {
    if (previousStickyRef.current === isSticky) return;
    previousStickyRef.current = isSticky;
    onAtBottomChange?.(isSticky);
  }, [isSticky, onAtBottomChange]);

  // The library settles touch, selection, and scrollbar-drag intent after the
  // native scroll event. Persist that settled state as well as the per-event
  // offsets above, otherwise the final event in a gesture can leave the cache
  // saying "end" even though follow mode has been released.
  useEffect(() => {
    if (!initialScrollRestoredRef.current) return;
    const scrollOffset = scrollElementRef.current?.scrollTop ?? 0;
    saveScrollPosition(sessionId, isSticky ? { type: 'end' } : { type: 'offset', scrollOffset });
  }, [isSticky, sessionId]);

  useStickyViewportResizeObserver({
    itemCountRef,
    stickyBottomRef,
    scrollElement,
    scrollToRealBottom,
    skipNextViewportResizeAutoScrollRef,
    suppressAutoScrollRef,
  });

  return {
    scrollRef: setScrollRef,
    scrollElement,
    isSticky,
    scrollToBottom,
    initialScrollRestored,
    handleScroll,
  };
}
