import {
  memo,
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { flushSync } from 'react-dom';
import {
  ScrollController,
  type ControllerCallbacks,
  type ScrollHost,
} from '@/lib/conversation-scroll/controller';
import {
  getSavedScrollState,
  recordScrollEngineDiagnostic,
  saveScrollState,
} from '@/lib/conversation-scroll/saved-state';
import { recordSessionRenderTrace, shortTraceId } from '@/lib/session-render-trace';
import { scrollDebug } from '@/hooks/scroll-debug-log';
import type { ConversationRowComponent, ConversationScrollerProps } from './types';

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

/**
 * Whether an upward wheel over `target` scrolls some element nested inside the
 * viewport (a code block, a terminal) rather than the viewport itself.
 */
function wheelUpScrollsNestedElement(target: EventTarget | null, viewport: Element): boolean {
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

const prefersReducedMotion = (): boolean => {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
};

const EngineRowItem = memo(function EngineRowItem({
  Item,
  rowKey,
  index,
  top,
  register,
  children,
}: {
  Item: ConversationRowComponent;
  rowKey: string;
  index: number;
  top: number;
  register: (element: HTMLElement | null, key: string) => void;
  children: ReactElement;
}) {
  // Registered by key: indexes shift when rows are inserted above.
  const ref = useCallback(
    (element: HTMLElement | null) => register(element, rowKey),
    [register, rowKey]
  );
  return (
    <Item
      ref={ref}
      index={index}
      style={{ position: 'absolute', top, left: 0, width: '100%', contain: 'layout style' }}
    >
      {children}
    </Item>
  );
});

/**
 * The conversation list: rendered and scrolled by the conversation scroll engine
 * (`lib/conversation-scroll`). The engine is the viewport's only
 * programmatic writer and owns the rows container's height; this component
 * renders the engine's plan and executes its commit protocol:
 *
 * - every commit's layout effect continues the engine's transaction;
 * - a transaction that needs another commit re-renders synchronously (a state
 *   update from a layout effect, or `flushSync` from an observer, a scroll
 *   event or a command), so the first painted frame is already covered;
 * - the viewport is never hidden (I7).
 *
 * Design: `.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md`.
 */
export function EngineConversationScroller({
  sessionId,
  rows,
  rowMeta,
  item,
  keepMounted,
  initialWindowReady,
  suppressAutoScrollRef,
  onAtBottomChange,
  onScroll,
  onStateChange,
  layoutKey,
  viewportClassName,
  viewportStyle,
  trailing,
  bufferSize,
  handleRef,
}: ConversationScrollerProps) {
  const [, forceCommit] = useReducer((count: number) => count + 1, 0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const rowElements = useRef(new Map<string, HTMLElement>());
  const keyOfElement = useRef(new WeakMap<Element, string>());
  const rowObserver = useRef<ResizeObserver | null>(null);
  const inLayoutEffect = useRef(false);
  const widthRef = useRef(0);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [isSticky, setIsSticky] = useState(
    () => getSavedScrollState(sessionId)?.intent.kind !== 'read'
  );
  const [revealed, setRevealed] = useState(false);

  const latest = useRef({ onAtBottomChange, onScroll, suppressAutoScrollRef, layoutKey });
  latest.current = { onAtBottomChange, onScroll, suppressAutoScrollRef, layoutKey };

  const layoutVersion = (width: number) => `${Math.round(width)}|${latest.current.layoutKey}`;

  const hostRef = useRef<ScrollHost | null>(null);
  if (!hostRef.current) {
    const viewport = () => viewportRef.current;
    hostRef.current = {
      readScrollTop: () => viewport()?.scrollTop ?? 0,
      readScrollHeight: () => viewport()?.scrollHeight ?? 0,
      readViewportHeight: () => viewport()?.clientHeight ?? 0,
      readContentTop: () => {
        const element = viewport();
        const container = containerRef.current;
        if (!element || !container) return 0;
        return (
          container.getBoundingClientRect().top -
          element.getBoundingClientRect().top +
          element.scrollTop
        );
      },
      readPaddingBottom: () => {
        const element = viewport();
        return element ? parseFloat(getComputedStyle(element).paddingBottom) || 0 : 0;
      },
      measure: (keys) =>
        keys.map((key) => rowElements.current.get(key)?.getBoundingClientRect().height),
      setExtent: (px) => {
        if (containerRef.current) containerRef.current.style.height = `${Math.max(0, px)}px`;
      },
      setReplyRoom: (px) => {
        if (spacerRef.current) spacerRef.current.style.height = `${Math.max(0, Math.round(px))}px`;
      },
      writeScrollTop: (value) => {
        const element = viewport();
        if (element) element.scrollTop = value;
      },
      scrollBy: (delta) => {
        const element = viewport();
        if (!element) return;
        if (typeof element.scrollBy === 'function') {
          element.scrollBy({ top: delta, behavior: 'instant' });
        } else {
          element.scrollTop += delta;
        }
      },
      requestCommit: (sync) => {
        if (sync && !inLayoutEffect.current) flushSync(forceCommit);
        else forceCommit();
      },
      isSuppressed: () => Boolean(latest.current.suppressAutoScrollRef?.current),
      prefersReducedMotion,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    };
  }

  const controllerRef = useRef<ScrollController | null>(null);
  if (!controllerRef.current) {
    const saved = getSavedScrollState(sessionId);
    controllerRef.current = new ScrollController({
      host: hostRef.current,
      initialIntent: saved?.intent,
      savedSizes: saved?.sizes ?? null,
      layoutVersion: saved?.sizes?.layoutVersion ?? '',
      initialViewportHeight: typeof window === 'undefined' ? 800 : window.innerHeight,
      overscanPx: bufferSize,
    });
    scrollDebug('engine-mount', { sessionId, restored: saved?.intent.kind ?? 'none' });
  }
  const controller = controllerRef.current;
  const callbacks: ControllerCallbacks = {
    onStickyChange: (sticky) => {
      setIsSticky(sticky);
      latest.current.onAtBottomChange?.(sticky);
    },
    onFirstCycle: () => setRevealed(true),
    onScroll: (offset) => latest.current.onScroll?.(offset),
    onDiagnostic: (diagnostic) => {
      recordScrollEngineDiagnostic(sessionId, diagnostic);
      scrollDebug('engine-cycle', { ...diagnostic });
      if (!diagnostic.covered || diagnostic.pendingExternalMove) {
        recordSessionRenderTrace(
          `scroll-engine ${shortTraceId(sessionId)} ${diagnostic.reason} covered=${diagnostic.covered} pending=${diagnostic.pendingExternalMove} commits=${diagnostic.supplementaryCommits}`
        );
      }
    },
    onMomentumEnd: (stats) => {
      scrollDebug('engine-momentum', { ...stats });
      recordSessionRenderTrace(
        `scroll-engine ${shortTraceId(sessionId)} momentum compensations=${stats.compensations} interrupted=${stats.interruptions}`
      );
    },
    onMinRowViolation: (key, height) => {
      if (import.meta.env?.DEV) {
        console.warn(
          `[scroll-engine] row ${key} measured ${height}px, below the minimum row height`
        );
      }
    },
  };
  controller.setCallbacks(callbacks);
  controller.syncRows(rowMeta, 1);
  controller.setMustMount(keepMounted ?? []);
  const plan = controller.plan();

  // Persist on unmount: the next open of this session restores from it. The
  // setup resumes the controller, so StrictMode's cleanup-then-setup on a live
  // component does not leave it disposed. Declared first, so its setup
  // runs before the commit effect below.
  useLayoutEffect(() => {
    controller.resume();
    return () => {
      saveScrollState(sessionId, {
        formatVersion: 1,
        intent: controller.savedIntent(),
        sizes: controller.geometry.snapshot(),
      });
      controller.dispose();
    };
  }, [controller, sessionId]);

  // Continue the engine's transaction after every commit, before paint.
  useLayoutEffect(() => {
    inLayoutEffect.current = true;
    try {
      controller.afterCommit();
    } finally {
      inLayoutEffect.current = false;
    }
  });

  useLayoutEffect(() => {
    onStateChange({ scrollElement, revealed, isSticky });
  }, [isSticky, onStateChange, revealed, scrollElement]);

  useLayoutEffect(() => {
    handleRef.current = {
      get scrollOffset() {
        return controller.scrollOffset;
      },
      get scrollSize() {
        return controller.scrollSize;
      },
      get viewportSize() {
        return controller.viewportSize;
      },
      findItemIndex: (offset) => controller.findItemIndex(offset),
      getItemOffset: (index) => controller.getItemOffset(index),
      getItemSize: (index) => controller.getItemSize(index),
      scrollRowToTop: (index, { smooth }) => controller.jumpToIndex(index, smooth),
      scrollToBottom: () => controller.scrollToBottom(),
      anchorToRow: (index) => controller.anchorToRow(index),
      retargetAnchor: (index) => controller.retargetAnchor(index),
    };
    return () => {
      handleRef.current = null;
    };
  }, [controller, handleRef]);

  const registerRow = useCallback((element: HTMLElement | null, key: string) => {
    const previous = rowElements.current.get(key);
    if (previous && previous !== element) {
      rowObserver.current?.unobserve(previous);
      keyOfElement.current.delete(previous);
      rowElements.current.delete(key);
    }
    if (element) {
      rowElements.current.set(key, element);
      keyOfElement.current.set(element, key);
      rowObserver.current?.observe(element);
    }
  }, []);

  // Row size changes that do not come from a commit (images, fonts, late
  // highlighting). Sizes our own commits cause are equal and ignored.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const resized: Array<{ key: string; height: number }> = [];
      for (const entry of entries) {
        const key = keyOfElement.current.get(entry.target);
        if (!key) continue;
        const height =
          entry.borderBoxSize?.[0]?.blockSize ??
          (entry.target as HTMLElement).getBoundingClientRect().height;
        resized.push({ key, height });
      }
      if (resized.length) controller.onRowsResized(resized);
    });
    rowObserver.current = observer;
    for (const element of rowElements.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      rowObserver.current = null;
    };
  }, [controller]);

  // Viewport height (composer, keyboard, dock) and width (layout version).
  useLayoutEffect(() => {
    const element = scrollElement;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    let previous = { width: element.clientWidth, height: element.clientHeight };
    widthRef.current = previous.width;
    controller.setLayoutVersion(layoutVersion(previous.width));
    const observer = new ResizeObserver(() => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (next.width === previous.width && next.height === previous.height) return;
      previous = next;
      widthRef.current = next.width;
      controller.onViewportResized(layoutVersion(next.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, scrollElement]);

  // The conversation font setting is part of the layout version.
  const firstLayoutKey = useRef(true);
  useLayoutEffect(() => {
    if (firstLayoutKey.current) {
      firstLayoutKey.current = false;
      return;
    }
    controller.onViewportResized(layoutVersion(widthRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, layoutKey]);

  // Reader input and scroll events.
  useLayoutEffect(() => {
    const element = scrollElement;
    if (!element) return undefined;
    const ownerDocument = element.ownerDocument;
    const onScrollEvent = () => controller.onScrollEvent();
    const handleScrollEnd = () => {
      controller.onScrollEnd();
      saveScrollState(sessionId, {
        formatVersion: 1,
        intent: controller.savedIntent(),
        sizes: controller.geometry.snapshot(),
      });
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || event.ctrlKey) return;
      if (element.scrollHeight <= element.clientHeight) return;
      // A code block or terminal scrolling inside a row is not the conversation.
      if (wheelUpScrollsNestedElement(event.target, element)) return;
      controller.release('wheel-up');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isUpwardNavigationKey(event) || isEditableTarget(event.target)) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target !== ownerDocument.body && !element.contains(target)) return;
      controller.release('key-up');
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0) controller.setPointerHeld(true);
    };
    const onPointerUp = () => controller.setPointerHeld(false);
    const onTouchStart = () => controller.setTouchActive(true);
    const onTouchEnd = () => controller.setTouchActive(false);
    element.addEventListener('scroll', onScrollEvent, { passive: true });
    element.addEventListener('scrollend', handleScrollEnd, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('pointerdown', onPointerDown, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    ownerDocument.addEventListener('pointerup', onPointerUp, true);
    ownerDocument.addEventListener('pointercancel', onPointerUp, true);
    ownerDocument.addEventListener('keydown', onKeyDown, true);
    return () => {
      element.removeEventListener('scroll', onScrollEvent);
      element.removeEventListener('scrollend', handleScrollEnd);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      ownerDocument.removeEventListener('pointerup', onPointerUp, true);
      ownerDocument.removeEventListener('pointercancel', onPointerUp, true);
      ownerDocument.removeEventListener('keydown', onKeyDown, true);
    };
  }, [controller, scrollElement, sessionId]);

  const setViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setScrollElement(element);
  }, []);

  const ready = initialWindowReady && revealed;
  return (
    <div
      ref={setViewport}
      data-message-selection-scroll=""
      data-conversation-scroll-engine=""
      data-window-session-stream-ready={ready ? sessionId : undefined}
      className={viewportClassName}
      style={viewportStyle}
    >
      {/* The rows container: the engine sets its height (the scroll extent)
          imperatively and it clips in the block direction, so no row can
          change the scroll range behind the engine's back. It stays the
          viewport's first child: the view measures item offsets from it. */}
      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', overflowY: 'clip', overflowAnchor: 'none' }}
      >
        {plan.indices.map((index, position) => {
          const element = rows[index];
          if (!element) return null;
          return (
            <EngineRowItem
              key={plan.keys[position]}
              rowKey={plan.keys[position]!}
              Item={item}
              index={index}
              top={plan.offsets[position]!}
              register={registerRow}
            >
              {element}
            </EngineRowItem>
          );
        })}
      </div>
      <div ref={spacerRef} aria-hidden data-conversation-reply-room="" />
      {trailing}
    </div>
  );
}
