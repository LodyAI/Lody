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
import type { CacheSnapshot, VirtualizerHandle } from 'virtua';
import type { SessionId } from '@lody/shared';
import {
  getScrollElementMaxOffset,
  isInitialScrollLayoutReady,
  scrollViewportToRealBottom,
} from './sticky-scroll-dom';
import {
  getScrollPosition,
  getVirtualizerCache,
  saveScrollPosition,
  saveVirtualizerCache,
} from './use-scroll-position-cache';

export interface UseStickyScrollOptions {
  sessionId: SessionId;
  vlistRef: RefObject<VirtualizerHandle | null>;
  /** Total number of items in the list. Used as the scroll-to target index. */
  itemCount: number;
  /**
   * Whether the caller is about to mount the virtualizer. `itemCount` alone
   * cannot say: a non-null leading fragment counts as a row, so a session that
   * is still acquiring its document reports one item while rendering an empty
   * state and no `Virtualizer` at all.
   */
  hasVirtualizedRows?: boolean;
  initialContentReady?: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  /**
   * Set by the session composer immediately before it changes its own height.
   * The next viewport height change consumes this one-shot flag without
   * pulling the reader back to the bottom.
   */
  skipNextViewportResizeAutoScrollRef?: MutableRefObject<boolean>;
  /**
   * When true, releases follow-output before a programmatic jump can resize
   * the list underneath it.
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
  /**
   * Pass to `Virtualizer.cache`. Read once, at mount: the virtualizer only
   * consumes it then, and a later value would silently do nothing.
   */
  initialVirtualizerCache: CacheSnapshot | undefined;
  /** Call when scrolling stops, so the next open restores the newest measurements. */
  persistVirtualizerCache: () => void;
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

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { height } = entry.contentRect;
        if (height === previousHeight) continue;
        previousHeight = height;
        if (skipNextViewportResizeAutoScrollRef?.current) {
          skipNextViewportResizeAutoScrollRef.current = false;
          continue;
        }
        if (!stickyBottomRef.current || itemCountRef.current <= 0) continue;
        if (!suppressAutoScrollRef?.current) scrollToRealBottom();
      }
    });

    observer.observe(scrollElement);
    return () => {
      observer.disconnect();
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
  hasVirtualizedRows = true,
  initialContentReady = true,
  onAtBottomChange,
  skipNextViewportResizeAutoScrollRef,
  suppressAutoScrollRef,
}: UseStickyScrollOptions): UseStickyScrollResult {
  const cachedPositionAtMountRef = useRef(getScrollPosition(sessionId));
  const initialOffsetRef = useRef(
    cachedPositionAtMountRef.current?.type === 'offset'
      ? cachedPositionAtMountRef.current.scrollOffset
      : null
  );
  /**
   * Virtua's measurements from the last time this session was open. Without
   * them the first layout uses estimated row heights, so the restore offset
   * lands in the wrong coordinate space and the conversation stays hidden
   * across the correction — the blank flash on open.
   *
   * Taken on the first render that actually mounts the virtualizer, because
   * `Virtualizer` reads `cache` only at mount and the snapshot is keyed by row
   * count. Reading it during the empty state a session renders while its
   * document is acquired would answer for a one-row list and then never ask
   * again for the real conversation.
   */
  const initialVirtualizerCacheRef = useRef<{ taken: boolean; value?: CacheSnapshot }>({
    taken: false,
  });
  if (!initialVirtualizerCacheRef.current.taken && hasVirtualizedRows && itemCount > 0) {
    initialVirtualizerCacheRef.current = {
      taken: true,
      value: getVirtualizerCache(sessionId, itemCount),
    };
  }
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
  /**
   * The follow lock as of the latest commit. The library can re-arm
   * `state.isAtBottom` between a commit and the observer callbacks that run
   * `follow()` — a downward programmatic scroll or a content shrink landing
   * the viewport within its near-bottom tolerance both re-lock — so the
   * callbacks consult this commit-time snapshot instead: a reader who was not
   * following when the change was committed is never pulled to the end.
   */
  const wasFollowingRef = useRef(state.isAtBottom);

  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;

  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const initialScrollRestoredRef = useRef(false);
  const initialPositionAppliedRef = useRef(false);
  const settleInitialLayoutRef = useRef(() => {});
  const [initialScrollRestored, setInitialScrollRestored] = useState(false);

  const handleWheelUp = useCallback(
    (event: WheelEvent) => {
      if (event.deltaY < 0) {
        initialOffsetRef.current = null;
        stopScroll();
      }
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
    scrollViewportToRealBottom({
      scrollElement: scrollElementRef.current,
      itemCount: itemCountRef.current,
      // Mark programmatic corrections so shrinking content does not look like
      // a user scrolling upward and releasing the follow lock.
      setScrollTop: (offset) => {
        state.scrollTop = offset;
      },
    });
  }, [state]);

  /**
   * Hand Virtua's current measurements to the session cache. Called when the
   * layout has settled and after scrolling stops, never at unmount: React
   * detaches the virtualizer ref before cleanup effects run, so the handle is
   * already gone there.
   */
  const persistVirtualizerCache = useCallback(() => {
    const virtualizer = vlistRef.current;
    if (!virtualizer || !initialScrollRestoredRef.current) return;
    saveVirtualizerCache(sessionId, virtualizer.cache, itemCountRef.current);
  }, [itemCountRef, sessionId, vlistRef]);

  const settleInitialLayout = useCallback(() => {
    if (initialScrollRestoredRef.current || !initialPositionAppliedRef.current) return;
    const viewport = scrollElementRef.current;
    const virtualizer = vlistRef.current;
    if (!viewport || !virtualizer) return;
    if (suppressAutoScrollRef?.current) initialOffsetRef.current = null;
    if (initialOffsetRef.current !== null) {
      const target = Math.min(initialOffsetRef.current, getScrollElementMaxOffset(viewport));
      if (Math.abs(viewport.scrollTop - target) > 1) {
        // Cold measurements can change both the clamped maximum and Virtua's
        // anchor after its scroll request would have expired. Keep restoring
        // through geometry/scroll delivery until the measured window is ready.
        state.scrollTop = target;
        return;
      }
    }
    if (
      !isInitialScrollLayoutReady(viewport, virtualizer, itemCountRef.current, state.isAtBottom)
    ) {
      return;
    }
    initialScrollRestoredRef.current = true;
    setInitialScrollRestored(true);
    persistVirtualizerCache();
  }, [persistVirtualizerCache, state, suppressAutoScrollRef, vlistRef]);
  settleInitialLayoutRef.current = settleInitialLayout;

  // Observe the bounded mounted row set, not streamed descendants. A row can
  // grow before Virtua commits its spacer, so observing only the spacer misses
  // a paint. Row measurement, spacer commits and scroll delivery all converge
  // on the same initial-layout check; no guessed number of frames or timer.
  useLayoutEffect(() => {
    const content = scrollElement?.firstElementChild;
    if (!(content instanceof HTMLElement)) return undefined;
    const follow = () => {
      if (
        initialPositionAppliedRef.current &&
        state.isAtBottom &&
        wasFollowingRef.current &&
        !suppressAutoScrollRef?.current
      ) {
        scrollToRealBottom();
      }
      settleInitialLayout();
    };
    const resizeObserver = new ResizeObserver(() => {
      // Follow is armed by scroll events, never by geometry observers. The
      // library's own content ResizeObserver runs earlier in this same
      // delivery and re-locks `state.isAtBottom` whenever a shrink lands the
      // viewport within its near-bottom tolerance — release that here so a
      // reader who was not following at commit is never pulled to the end,
      // and any scroll tick the library queued finds the lock already open.
      if (!wasFollowingRef.current && state.isAtBottom) stopScroll();
      follow();
    });
    resizeObserver.observe(content);
    const rows = new Set<Element>();
    const observeRows = () => {
      for (const row of rows) {
        if (row.parentElement !== content) {
          resizeObserver.unobserve(row);
          rows.delete(row);
        }
      }
      for (const row of content.children) {
        if (!rows.has(row)) {
          rows.add(row);
          resizeObserver.observe(row);
        }
      }
      mutationObserver.disconnect();
      mutationObserver.observe(content, {
        attributes: true,
        attributeFilter: ['style'],
        childList: true,
      });
      for (const row of rows)
        mutationObserver.observe(row, { attributes: true, attributeFilter: ['style'] });
    };
    let spacerHeight = content.style.height;
    const mutationObserver = new MutationObserver((records) => {
      const membershipChanged = records.some((record) => record.type === 'childList');
      const geometryChanged =
        membershipChanged ||
        spacerHeight !== content.style.height ||
        records.some((record) => record.target !== content);
      spacerHeight = content.style.height;
      if (membershipChanged) observeRows();
      // Virtua also toggles pointer-events during scrolling. That is not a
      // geometry change and must not compete with a scrollbar drag.
      if (geometryChanged) follow();
    });
    observeRows();
    follow();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [
    scrollElement,
    scrollToRealBottom,
    settleInitialLayout,
    state,
    stopScroll,
    suppressAutoScrollRef,
  ]);

  // Restore before paint, and keep the same follow intent when a placeholder
  // becomes several Virtua rows. Waiting for the content ResizeObserver's RAF
  // would expose the old bottom for a frame (or several hydration commits).
  useLayoutEffect(() => {
    if (!scrollElement || itemCount === 0 || !initialContentReady) return;
    const currentVlist = vlistRef.current;
    if (!currentVlist) return;

    if (initialPositionAppliedRef.current) {
      if (state.isAtBottom && !suppressAutoScrollRef?.current) scrollToRealBottom();
      settleInitialLayout();
      return;
    }

    if (initialOffsetRef.current !== null) {
      stopScroll();
      state.scrollTop = Math.min(
        initialOffsetRef.current,
        getScrollElementMaxOffset(scrollElement)
      );
    } else {
      void scrollToBottomWithLock({ animation: 'instant' });
      scrollToRealBottom();
    }
    initialPositionAppliedRef.current = true;
    settleInitialLayout();
  }, [
    itemCount,
    initialContentReady,
    scrollElement,
    scrollToBottomWithLock,
    scrollToRealBottom,
    settleInitialLayout,
    state,
    stopScroll,
    suppressAutoScrollRef,
    vlistRef,
  ]);

  // Search jumps are deliberate reading-position changes. Release follow in a
  // layout effect so the ResizeObserver/MutationObserver geometry callbacks of
  // that commit cannot pull the list to the end behind the reader's back. A
  // suppressed commit snapshots as not-following to those callbacks.
  useLayoutEffect(() => {
    const suppressed = suppressAutoScrollRef?.current ?? false;
    wasFollowingRef.current = !suppressed && state.isAtBottom;
    if (suppressed) stopScroll();
  });

  const scrollToBottom = useCallback(() => {
    initialOffsetRef.current = null;
    saveScrollPosition(sessionId, { type: 'end' });
    if (itemCountRef.current <= 0) return;
    void scrollToBottomWithLock({ animation: 'instant' });
    scrollToRealBottom();
  }, [itemCountRef, scrollToBottomWithLock, scrollToRealBottom, sessionId]);

  const handleScroll = useCallback(
    (offset: number) => {
      settleInitialLayoutRef.current();
      if (!initialScrollRestoredRef.current) return;
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
    initialVirtualizerCache: initialVirtualizerCacheRef.current.value,
    persistVirtualizerCache,
    handleScroll,
  };
}
