import {
  type RefCallback,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { CacheSnapshot, VirtualizerHandle } from '@lody/virtua';
import type { SessionId } from '@lody/shared';
import { describeViewport, isScrollDebugEnabled, scrollDebug } from './scroll-debug-log';
import {
  countHiddenRowsInViewport,
  getContentExtentInScroll,
  getInitialScrollLayoutBlocker,
  getScrollElementDistanceFromBottom,
  getScrollElementMaxOffset,
  scrollViewportToRealBottom,
  wheelUpScrollsNestedElement,
} from './sticky-scroll-dom';
import {
  getScrollPosition,
  getVirtualizerCache,
  saveScrollPosition,
  saveVirtualizerCache,
} from './use-scroll-position-cache';

/**
 * - `follow`: the viewport stays on the real bottom as content and viewport change.
 * - `anchored`: a just-sent message is held at the top of the viewport while a
 *   trailing spacer reserves the room below it for the reply. Once the reply
 *   fills that room the mode becomes `follow`.
 * - `free`: the reader is somewhere else; nothing moves the viewport.
 */
export type StickyScrollMode = 'follow' | 'anchored' | 'free';

/** A downward scroll that ends this close to the real bottom re-arms follow. */
const REARM_DISTANCE_PX = 4;
/** How long a send takes to glide its message to the top of the viewport. */
const ANCHOR_SCROLL_MS = 360;
/**
 * A glide never covers more than this many viewports: Virtua mounts rows only
 * around the viewport, so a long glide would show unmeasured, blank rows.
 */
const ANCHOR_SCROLL_MAX_VIEWPORTS = 1.5;

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

const prefersReducedMotion = (): boolean => {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
};

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
   * When true, releases follow-output before a programmatic jump can resize
   * the list underneath it.
   */
  suppressAutoScrollRef?: RefObject<boolean>;
}

export interface UseStickyScrollResult {
  /** Attach directly to the scroll viewport that owns the Virtua virtualizer. */
  scrollRef: RefCallback<HTMLDivElement>;
  /**
   * Attach to an empty element rendered after the `Virtualizer`, inside the
   * viewport. It is the reply room reserved below an anchored message; the
   * hook writes its height directly, without React renders.
   */
  spacerRef: RefCallback<HTMLDivElement>;
  /**
   * The bound viewport, for consumers that need its geometry. Exposed so they
   * do not compose a second callback ref onto {@link scrollRef} to recover it —
   * that binding has one owner on purpose (see AGENTS.md), and a wrapper in
   * front of it re-attaches this hook's listeners whenever the wrapper's
   * identity changes.
   */
  scrollElement: HTMLDivElement | null;
  /** Whether the view shows the live end (following, or anchored on a sent message). */
  isSticky: boolean;
  /** Force-scroll to bottom and re-enable follow mode. */
  scrollToBottom: () => void;
  /**
   * Hold the row at `index` (a Virtua index) at the top of the viewport and
   * reserve the room below it, until the content below fills that room.
   */
  anchorToRow: (index: number) => void;
  /**
   * Move a held anchor to the anchored message's current index after rows
   * above it were inserted or removed. No-op unless anchored; a negative
   * index (the message is gone) falls back to following the bottom.
   */
  retargetAnchor: (index: number) => void;
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

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT');

const isUpwardNavigationKey = (event: KeyboardEvent): boolean =>
  event.key === 'PageUp' ||
  event.key === 'Home' ||
  event.key === 'ArrowUp' ||
  (event.key === ' ' && event.shiftKey);

const readPadding = (viewport: HTMLElement): { top: number; bottom: number } => {
  const style = getComputedStyle(viewport);
  return {
    top: parseFloat(style.paddingTop) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
  };
};

export function useStickyScroll({
  sessionId,
  vlistRef,
  itemCount,
  hasVirtualizedRows = true,
  initialContentReady = true,
  onAtBottomChange,
  suppressAutoScrollRef,
}: UseStickyScrollOptions): UseStickyScrollResult {
  const cachedPositionAtMountRef = useRef(getScrollPosition(sessionId));
  /**
   * The cached reading offset still being restored, or null. Cold measurements
   * can change both the clamped maximum and Virtua's anchor after any one-shot
   * scroll request would have expired, so the restore is reapplied on every
   * geometry/scroll delivery until the view is revealed; any navigation (reader
   * input, a jump, the end, a send) supersedes it. See the
   * [initial scroll recovery note](../../../../.agents/notes/implemented/bug-fix/2026-09-23-initial-scroll-recovery.md).
   */
  const initialOffsetRef = useRef(
    cachedPositionAtMountRef.current?.type === 'offset'
      ? cachedPositionAtMountRef.current.scrollOffset
      : null
  );
  const mountedAtRef = useRef(0);
  /**
   * Virtua's measurements from the last time this session was open. Without
   * them the first layout uses estimated row heights, so the restore offset
   * lands in the wrong coordinate space and the conversation stays hidden
   * across the correction — the blank flash on open.
   *
   * Taken on the first render that actually mounts the virtualizer, because
   * `Virtualizer` reads `cache` only at mount. Reading it during the empty
   * state a session renders while its document is acquired would hand an
   * unkeyed caller a one-row answer and then never ask again.
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

  /**
   * The follow mode is the single source of truth. Only explicit reader input
   * (upward wheel over the viewport itself, upward navigation keys, an upward
   * scroll while a pointer or touch is held) releases it, and only a downward
   * scroll reaching the real bottom, an explicit jump to the end or a send
   * re-arms it. Geometry observers never change it, so a browser clamp after
   * the viewport grows, a Virtua size correction or a collapsing group cannot
   * pass for reader intent.
   */
  const modeRef = useRef<StickyScrollMode>(
    cachedPositionAtMountRef.current?.type === 'offset' ? 'free' : 'follow'
  );
  const [isSticky, setIsSticky] = useState(modeRef.current !== 'free');
  const anchorIndexRef = useRef(-1);

  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;

  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const spacerElementRef = useRef<HTMLDivElement | null>(null);
  const spacerHeightRef = useRef(0);
  /** Our own last scrollTop write, so its scroll event is not read as reader input. */
  const expectedScrollTopRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const pointerHeldRef = useRef(false);
  const touchActiveRef = useRef(false);
  /**
   * The glide started by a send. Its destination is re-read every frame,
   * because the rows it lands on are still being measured; it ends when it
   * arrives, or as soon as the reader takes over (mode `free`).
   */
  const glideRef = useRef<{ from: number; startedAt: number | null; frame: number } | null>(null);
  const initialScrollRestoredRef = useRef(false);
  const initialPositionAppliedRef = useRef(false);
  const lastSettleBlockerRef = useRef<string | null>(null);
  const settleInitialLayoutRef = useRef(() => {});
  const [initialScrollRestored, setInitialScrollRestored] = useState(false);

  useEffect(() => {
    mountedAtRef.current = performance.now();
    scrollDebug('mount', {
      sessionId,
      cachedPosition: cachedPositionAtMountRef.current?.type ?? 'none',
      cachedMeasurements: initialVirtualizerCacheRef.current.value !== undefined,
    });
    return () => scrollDebug('unmount', { sessionId });
  }, [sessionId]);

  const setMode = useCallback((next: StickyScrollMode, reason: string) => {
    if (modeRef.current === next) return;
    scrollDebug('mode', {
      from: modeRef.current,
      to: next,
      reason,
      viewport: describeViewport(scrollElementRef.current),
    });
    modeRef.current = next;
    if (next !== 'anchored') anchorIndexRef.current = -1;
    setIsSticky(next !== 'free');
  }, []);

  const release = useCallback(
    (reason: string) => {
      // A restoring reader is already `free`; their input still supersedes it.
      initialOffsetRef.current = null;
      if (modeRef.current !== 'free') setMode('free', reason);
    },
    [setMode]
  );

  const writeScrollTop = useCallback(
    (viewport: HTMLElement, offset: number) => {
      viewport.scrollTop = offset;
      expectedScrollTopRef.current = viewport.scrollTop;
      lastScrollTopRef.current = viewport.scrollTop;
      // Before the reveal, let Virtua read the new offset now. Its only input is
      // the scroll event, which arrives next frame; until then it renders the
      // old range, so the reveal waits (`offset-mismatch`, then
      // `target-unmounted`) and the browser paints a hidden frame. The later
      // native event is then a no-op for it and is consumed as our own write.
      const virtualizer = vlistRef.current;
      if (
        !initialScrollRestoredRef.current &&
        virtualizer &&
        Math.abs(virtualizer.scrollOffset - viewport.scrollTop) > 1
      ) {
        viewport.dispatchEvent(new Event('scroll'));
      }
    },
    [vlistRef]
  );

  const scrollToRealBottom = useCallback(
    (source: string) => {
      const viewport = scrollElementRef.current;
      scrollViewportToRealBottom({
        scrollElement: viewport,
        itemCount: itemCountRef.current,
        setScrollTop: (offset) => {
          if (!viewport) return;
          const from = viewport.scrollTop;
          writeScrollTop(viewport, offset);
          scrollDebug('follow-correction', {
            source,
            from: Math.round(from),
            to: Math.round(viewport.scrollTop),
            revealed: initialScrollRestoredRef.current,
            itemCount: itemCountRef.current,
            viewport: describeViewport(viewport),
          });
        },
      });
    },
    [writeScrollTop]
  );

  const setSpacerHeight = useCallback((height: number) => {
    const next = Math.max(0, Math.round(height));
    const previous = spacerHeightRef.current;
    if (next === previous) return;
    spacerHeightRef.current = next;
    if (spacerElementRef.current) spacerElementRef.current.style.height = `${next}px`;
    if (next === 0 || previous === 0) scrollDebug('spacer', { from: previous, to: next });
  }, []);

  /**
   * Outside `anchored`, the reserved room only ever shrinks: to what keeps the
   * current scroll position reachable. Scrolling up therefore eats it without
   * moving anything on screen, and it never reappears once gone.
   */
  const shrinkSpacer = useCallback(() => {
    const viewport = scrollElementRef.current;
    if (!viewport || spacerHeightRef.current <= 0) return;
    const extent = getContentExtentInScroll(viewport);
    if (!extent) return;
    const needed =
      viewport.scrollTop + viewport.clientHeight - readPadding(viewport).bottom - extent.bottom;
    setSpacerHeight(Math.min(spacerHeightRef.current, Math.max(0, needed)));
  }, [setSpacerHeight]);

  const enterFollow = useCallback(
    (reason: string) => {
      setMode('follow', reason);
      setSpacerHeight(0);
      // A glide in flight continues to the new destination: the real bottom.
      if (!glideRef.current) scrollToRealBottom(reason);
    },
    [scrollToRealBottom, setMode, setSpacerHeight]
  );

  /** Returns the anchored scroll target, or undefined once there is none. */
  const applyAnchor = useCallback((): number | undefined => {
    const viewport = scrollElementRef.current;
    const virtualizer = vlistRef.current;
    const index = anchorIndexRef.current;
    if (!viewport || !virtualizer || index < 0 || index >= itemCountRef.current) return undefined;
    const extent = getContentExtentInScroll(viewport);
    if (!extent) return undefined;
    const padding = readPadding(viewport);
    // A message taller than the viewport cannot be pinned by its top without
    // hiding the reply: follow the bottom instead.
    if (virtualizer.getItemSize(index) > viewport.clientHeight - padding.top - padding.bottom) {
      enterFollow('anchor-taller-than-viewport');
      return undefined;
    }
    // The anchored row sits where the first row sits at rest: below the top padding.
    const target = Math.max(0, extent.top + virtualizer.getItemOffset(index) - padding.top);
    const needed = target + viewport.clientHeight - padding.bottom - extent.bottom;
    if (needed <= 0) {
      enterFollow('anchor-filled');
      return undefined;
    }
    setSpacerHeight(needed);
    if (!glideRef.current && Math.abs(viewport.scrollTop - target) > 1) {
      writeScrollTop(viewport, target);
    }
    return target;
  }, [enterFollow, setSpacerHeight, vlistRef, writeScrollTop]);

  /** Where the viewport should be now, re-evaluating the anchor's geometry. */
  const resolveDestination = useCallback((): number | null => {
    const viewport = scrollElementRef.current;
    if (!viewport) return null;
    if (modeRef.current === 'anchored') {
      const target = applyAnchor();
      if (target !== undefined) return target;
    }
    return modeRef.current === 'follow' ? getScrollElementMaxOffset(viewport) : null;
  }, [applyAnchor]);

  const cancelGlide = useCallback(() => {
    const glide = glideRef.current;
    if (!glide) return;
    cancelAnimationFrame(glide.frame);
    glideRef.current = null;
  }, []);

  const stepGlide = useCallback(
    (timestamp: number) => {
      const glide = glideRef.current;
      const viewport = scrollElementRef.current;
      if (!glide || !viewport) return;
      const destination = modeRef.current === 'free' ? null : resolveDestination();
      if (destination === null) {
        glideRef.current = null;
        scrollDebug('glide-stopped', { mode: modeRef.current });
        return;
      }
      glide.startedAt ??= timestamp;
      const progress = Math.min(1, (timestamp - glide.startedAt) / ANCHOR_SCROLL_MS);
      writeScrollTop(viewport, glide.from + (destination - glide.from) * easeOutCubic(progress));
      if (progress < 1) {
        glide.frame = requestAnimationFrame(stepGlideRef.current);
        return;
      }
      glideRef.current = null;
      // Land exactly, with the geometry of this frame.
      onGeometryChangeRef.current('glide-end');
    },
    [resolveDestination, writeScrollTop]
  );
  const stepGlideRef = useRef(stepGlide);
  stepGlideRef.current = stepGlide;

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
        // Late measurements moved the clamp or Virtua's anchor: restore again,
        // as our own write so it is not read as reader intent.
        writeScrollTop(viewport, target);
        if (lastSettleBlockerRef.current !== 'cached-offset-reapplied') {
          lastSettleBlockerRef.current = 'cached-offset-reapplied';
          scrollDebug('reveal-blocked', {
            blocker: 'cached-offset-reapplied',
            target: Math.round(target),
            viewport: describeViewport(viewport),
          });
        }
        return;
      }
    }
    const blocker = getInitialScrollLayoutBlocker(
      viewport,
      virtualizer,
      itemCountRef.current,
      modeRef.current === 'follow'
    );
    if (blocker !== null) {
      if (blocker !== lastSettleBlockerRef.current) {
        lastSettleBlockerRef.current = blocker;
        scrollDebug('reveal-blocked', {
          blocker,
          itemCount: itemCountRef.current,
          viewport: describeViewport(viewport),
        });
      }
      return;
    }
    initialScrollRestoredRef.current = true;
    // Reveal in this frame. Observers and scroll callbacks run before paint, but
    // a state update made from them commits in a later task, so the browser
    // would paint one more hidden frame first. React's commit then writes the
    // same value.
    viewport.style.visibility = 'visible';
    setInitialScrollRestored(true);
    scrollDebug('revealed', {
      afterMs: Math.round(performance.now() - mountedAtRef.current),
      mode: modeRef.current,
      itemCount: itemCountRef.current,
      viewport: describeViewport(viewport),
    });
    persistVirtualizerCache();
  }, [persistVirtualizerCache, suppressAutoScrollRef, vlistRef, writeScrollTop]);
  settleInitialLayoutRef.current = settleInitialLayout;

  /** Every geometry change — rows, spacer commits, viewport height — lands here. */
  const onGeometryChange = useCallback(
    (source: string) => {
      if (initialPositionAppliedRef.current && !suppressAutoScrollRef?.current) {
        if (modeRef.current === 'anchored') applyAnchor();
        else if (modeRef.current === 'follow' && !glideRef.current) scrollToRealBottom(source);
      }
      if (modeRef.current === 'free') shrinkSpacer();
      settleInitialLayout();
      const viewport = scrollElementRef.current;
      if (initialScrollRestoredRef.current && viewport && isScrollDebugEnabled()) {
        const hidden = countHiddenRowsInViewport(viewport);
        if (hidden > 0) {
          scrollDebug('hidden-rows-after-reveal', {
            source,
            hidden,
            mode: modeRef.current,
            itemCount: itemCountRef.current,
            viewport: describeViewport(viewport),
          });
        }
      }
    },
    [applyAnchor, scrollToRealBottom, settleInitialLayout, shrinkSpacer, suppressAutoScrollRef]
  );
  const onGeometryChangeRef = useRef(onGeometryChange);
  onGeometryChangeRef.current = onGeometryChange;

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      const viewport = scrollElementRef.current;
      if (!viewport || event.deltaY >= 0 || event.ctrlKey) return;
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      // A code block or terminal scrolling inside a row is not the conversation.
      if (wheelUpScrollsNestedElement(event.target, viewport)) return;
      release('wheel-up');
    },
    [release]
  );

  const handleNativeScroll = useCallback(() => {
    const viewport = scrollElementRef.current;
    if (!viewport) return;
    const scrollTop = viewport.scrollTop;
    const expected = expectedScrollTopRef.current;
    expectedScrollTopRef.current = null;
    const previous = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    if (expected !== null && Math.abs(scrollTop - expected) <= 1) return;
    // Scrollbar drags, selection auto-scroll and touch pans hold a pointer.
    // Upward movement without one is a clamp or a size correction.
    if (scrollTop < previous - 1 && (pointerHeldRef.current || touchActiveRef.current)) {
      release('drag-up');
    }
    if (modeRef.current !== 'free') return;
    shrinkSpacer();
    if (
      scrollTop > previous &&
      initialScrollRestoredRef.current &&
      !suppressAutoScrollRef?.current &&
      spacerHeightRef.current === 0 &&
      getScrollElementDistanceFromBottom(viewport) <= REARM_DISTANCE_PX
    ) {
      setMode('follow', 'reached-bottom');
    }
  }, [release, setMode, shrinkSpacer, suppressAutoScrollRef]);

  const handlePointerDown = useCallback((event: PointerEvent) => {
    if (event.button === 0) pointerHeldRef.current = true;
  }, []);
  const handlePointerUp = useCallback(() => {
    pointerHeldRef.current = false;
  }, []);
  const handleTouchStart = useCallback(() => {
    touchActiveRef.current = true;
  }, []);
  const handleTouchEnd = useCallback(() => {
    touchActiveRef.current = false;
  }, []);

  const setScrollRef = useCallback<RefCallback<HTMLDivElement>>(
    (nextScrollElement) => {
      const previousScrollElement = scrollElementRef.current;
      if (previousScrollElement === nextScrollElement) return;

      if (previousScrollElement) {
        previousScrollElement.removeEventListener('wheel', handleWheel);
        previousScrollElement.removeEventListener('scroll', handleNativeScroll);
        previousScrollElement.removeEventListener('pointerdown', handlePointerDown);
        previousScrollElement.removeEventListener('touchstart', handleTouchStart);
        previousScrollElement.removeEventListener('touchend', handleTouchEnd);
        previousScrollElement.removeEventListener('touchcancel', handleTouchEnd);
      }

      scrollElementRef.current = nextScrollElement;
      setScrollElement(nextScrollElement);
      if (!nextScrollElement) return;

      lastScrollTopRef.current = nextScrollElement.scrollTop;
      nextScrollElement.addEventListener('wheel', handleWheel, { passive: true });
      nextScrollElement.addEventListener('scroll', handleNativeScroll, { passive: true });
      nextScrollElement.addEventListener('pointerdown', handlePointerDown, { passive: true });
      nextScrollElement.addEventListener('touchstart', handleTouchStart, { passive: true });
      nextScrollElement.addEventListener('touchend', handleTouchEnd, { passive: true });
      nextScrollElement.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    },
    [handleNativeScroll, handlePointerDown, handleTouchEnd, handleTouchStart, handleWheel]
  );

  const setSpacerRef = useCallback<RefCallback<HTMLDivElement>>((element) => {
    spacerElementRef.current = element;
    if (element) element.style.height = `${spacerHeightRef.current}px`;
  }, []);

  // Pointer release and navigation keys can happen outside the viewport.
  useEffect(() => {
    if (!scrollElement) return undefined;
    const ownerDocument = scrollElement.ownerDocument;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isUpwardNavigationKey(event) || isEditableTarget(event.target)) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target !== ownerDocument.body && !scrollElement.contains(target)) return;
      release('key-up');
    };
    ownerDocument.addEventListener('pointerup', handlePointerUp, true);
    ownerDocument.addEventListener('pointercancel', handlePointerUp, true);
    ownerDocument.addEventListener('keydown', handleKeyDown, true);
    return () => {
      ownerDocument.removeEventListener('pointerup', handlePointerUp, true);
      ownerDocument.removeEventListener('pointercancel', handlePointerUp, true);
      ownerDocument.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [handlePointerUp, release, scrollElement]);

  // Viewport HEIGHT changes — the composer growing or shrinking, the mobile
  // keyboard, a terminal dock — keep the current mode's position. A viewport
  // that grows at the bottom clamps scrollTop upward; that clamp arrives as a
  // scroll event without a held pointer, so it cannot release follow. Width-only
  // records are ignored: a flex sibling animating its width would otherwise
  // compete with the content observers every frame.
  useEffect(() => {
    if (!scrollElement || typeof ResizeObserver === 'undefined') return undefined;
    let previousHeight = scrollElement.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { height } = entry.contentRect;
        if (height === previousHeight) continue;
        scrollDebug('viewport-resize', {
          from: previousHeight,
          to: height,
          mode: modeRef.current,
        });
        previousHeight = height;
        if (itemCountRef.current <= 0) continue;
        onGeometryChangeRef.current('viewport');
      }
    });
    observer.observe(scrollElement);
    return () => {
      observer.disconnect();
    };
  }, [scrollElement]);

  // Observe the bounded mounted row set, not streamed descendants. A row can
  // grow before Virtua commits its spacer, so observing only the spacer misses
  // a paint. Row measurement, spacer commits and scroll delivery all converge
  // on the same initial-layout check; no guessed number of frames or timer.
  useLayoutEffect(() => {
    const content = scrollElement?.firstElementChild;
    if (!(content instanceof HTMLElement)) return undefined;
    const resizeObserver = new ResizeObserver(() => {
      onGeometryChangeRef.current('rows');
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
      if (geometryChanged) onGeometryChangeRef.current('virtua-commit');
    });
    observeRows();
    onGeometryChangeRef.current('mount');
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [scrollElement]);

  // Restore before paint, and keep the same follow intent when a placeholder
  // becomes several Virtua rows. Waiting for the content ResizeObserver's RAF
  // would expose the old bottom for a frame (or several hydration commits).
  const previousItemCountRef = useRef(itemCount);
  useLayoutEffect(() => {
    const previousItemCount = previousItemCountRef.current;
    previousItemCountRef.current = itemCount;
    if (!scrollElement || itemCount === 0 || !initialContentReady) return;
    const currentVlist = vlistRef.current;
    if (!currentVlist) return;

    if (initialPositionAppliedRef.current) {
      if (previousItemCount !== itemCount) {
        scrollDebug('item-count', {
          from: previousItemCount,
          to: itemCount,
          mode: modeRef.current,
          revealed: initialScrollRestoredRef.current,
          viewport: describeViewport(scrollElement),
        });
      }
      onGeometryChange('item-count');
      return;
    }

    const cachedState = cachedPositionAtMountRef.current;
    if (initialOffsetRef.current !== null) {
      setMode('free', 'restore-offset');
      // Synchronous, not Virtua's one-shot scrollTo: that request can expire
      // before late measurements arrive. settleInitialLayout reapplies it.
      writeScrollTop(
        scrollElement,
        Math.min(initialOffsetRef.current, getScrollElementMaxOffset(scrollElement))
      );
    } else {
      setMode('follow', 'restore-end');
      scrollToRealBottom('restore-end');
    }
    initialPositionAppliedRef.current = true;
    scrollDebug('initial-position', {
      type: cachedState?.type ?? 'end',
      itemCount,
      viewport: describeViewport(scrollElement),
    });
    settleInitialLayout();
  }, [
    itemCount,
    initialContentReady,
    onGeometryChange,
    scrollElement,
    scrollToRealBottom,
    setMode,
    settleInitialLayout,
    vlistRef,
    writeScrollTop,
  ]);

  useEffect(() => {
    scrollDebug('content-ready', { ready: initialContentReady });
  }, [initialContentReady]);

  // Search jumps, outline jumps and selections are deliberate reading-position
  // changes. Release in a layout effect so the geometry callbacks of that
  // commit cannot pull the list to the end behind the reader's back.
  useLayoutEffect(() => {
    if (suppressAutoScrollRef?.current) release('suppressed');
  });

  const scrollToBottom = useCallback(() => {
    initialOffsetRef.current = null;
    saveScrollPosition(sessionId, { type: 'end' });
    if (itemCountRef.current <= 0) return;
    cancelGlide();
    enterFollow('explicit');
  }, [cancelGlide, enterFollow, sessionId]);

  const anchorToRow = useCallback(
    (index: number) => {
      if (index < 0 || index >= itemCountRef.current) return;
      initialOffsetRef.current = null;
      saveScrollPosition(sessionId, { type: 'end' });
      anchorIndexRef.current = index;
      if (modeRef.current !== 'anchored') {
        scrollDebug('mode', { from: modeRef.current, to: 'anchored', reason: 'send', index });
        modeRef.current = 'anchored';
        setIsSticky(true);
      }
      cancelGlide();
      const viewport = scrollElementRef.current;
      if (!viewport || prefersReducedMotion()) {
        applyAnchor();
        return;
      }
      // Reserve the reply room first so the destination is reachable; the
      // glide, not an instant write, then moves the viewport there.
      const glide = { from: viewport.scrollTop, startedAt: null, frame: 0 };
      glideRef.current = glide;
      const destination = resolveDestination();
      if (destination === null || Math.abs(destination - glide.from) <= 1) {
        glideRef.current = null;
        return;
      }
      const maxDistance = viewport.clientHeight * ANCHOR_SCROLL_MAX_VIEWPORTS;
      if (Math.abs(destination - glide.from) > maxDistance) {
        writeScrollTop(viewport, destination - Math.sign(destination - glide.from) * maxDistance);
        glide.from = viewport.scrollTop;
      }
      scrollDebug('glide', { from: Math.round(glide.from), to: Math.round(destination) });
      glide.frame = requestAnimationFrame(stepGlideRef.current);
    },
    [applyAnchor, cancelGlide, resolveDestination, sessionId, writeScrollTop]
  );

  const retargetAnchor = useCallback(
    (index: number) => {
      if (modeRef.current !== 'anchored' || anchorIndexRef.current === index) return;
      if (index < 0 || index >= itemCountRef.current) {
        cancelGlide();
        enterFollow('anchor-row-gone');
        return;
      }
      scrollDebug('anchor-retarget', { from: anchorIndexRef.current, to: index });
      anchorIndexRef.current = index;
      // A glide re-reads its destination every frame; otherwise re-pin now.
      if (!glideRef.current) applyAnchor();
    },
    [applyAnchor, cancelGlide, enterFollow]
  );

  useEffect(() => cancelGlide, [cancelGlide]);

  const handleScroll = useCallback(
    (offset: number) => {
      settleInitialLayoutRef.current();
      if (!initialScrollRestoredRef.current) return;
      const scrollOffset = scrollElementRef.current?.scrollTop ?? offset;
      saveScrollPosition(
        sessionId,
        modeRef.current !== 'free' ? { type: 'end' } : { type: 'offset', scrollOffset }
      );
    },
    [sessionId]
  );

  const previousStickyRef = useRef(isSticky);
  useEffect(() => {
    if (previousStickyRef.current === isSticky) return;
    previousStickyRef.current = isSticky;
    onAtBottomChange?.(isSticky);
  }, [isSticky, onAtBottomChange]);

  // Persist mode transitions as well as the per-event offsets above: a release
  // or re-arm without a following Virtua scroll callback must still reach the
  // cache, otherwise it can keep saying "end" after the reader left the end.
  useEffect(() => {
    if (!initialScrollRestoredRef.current) return;
    const scrollOffset = scrollElementRef.current?.scrollTop ?? 0;
    saveScrollPosition(sessionId, isSticky ? { type: 'end' } : { type: 'offset', scrollOffset });
  }, [isSticky, sessionId]);

  return {
    scrollRef: setScrollRef,
    spacerRef: setSpacerRef,
    scrollElement,
    isSticky,
    scrollToBottom,
    anchorToRow,
    retargetAnchor,
    initialScrollRestored,
    initialVirtualizerCache: initialVirtualizerCacheRef.current.value,
    persistVirtualizerCache,
    handleScroll,
  };
}
