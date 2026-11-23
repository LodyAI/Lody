import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export type PullToRefreshOptions = {
  /** Scroll container to attach the gesture to. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Called after the user releases past `threshold`. Awaited; the
     hook flips `isRefreshing` back to `false` once it resolves. */
  onRefresh: () => Promise<void> | void;
  /** Damped pull distance (px) required to trigger a refresh. Note
     this is the post-damping distance, not raw finger travel — with
     the rubber-band curve below, a 120px threshold needs ~175px of
     actual finger movement, which reads as a deliberate long pull
     rather than an accidental tug at the top of the list. */
  threshold?: number;
  /** When false, the hook attaches nothing (use to gate by viewport
     or feature flag without changing call sites). */
  enabled?: boolean;
};

export type PullToRefreshState = {
  /** Visual offset (in CSS px) the caller should apply to the
     pulled content during the gesture. Rubber-band damped so the
     pull feels resistive past `threshold`. Returns to 0 on
     release; stays 0 during `isRefreshing` (the caller is expected
     to show its own indicator for the in-flight state). */
  pullDistance: number;
  /** True while `onRefresh` is in flight. */
  isRefreshing: boolean;
  /** Pixels of overscroll required to trigger a refresh. Exposed so
     the caller can fade indicator content as `pullDistance / threshold`
     without re-declaring the same constant. */
  threshold: number;
};

/**
 * Pull-to-refresh with rubber-band visual feedback during the
 * pull. At `scrollTop === 0`, downward touchmove gets converted to
 * a damped `pullDistance` that the caller renders as a growing
 * indicator strip above the list. On release past `threshold` we
 * snap distance back to 0, flip `isRefreshing` true, and call
 * `onRefresh`. While refreshing the caller is expected to show
 * its own indicator (we don't pin the distance to keep "open"
 * after release — that's a separate animation concern best owned
 * by the rendering surface).
 *
 * `touchmove` is registered with `{ passive: false }` so we can
 * call `preventDefault()` once a pull starts; without that, iOS
 * Safari runs its native overscroll bounce in parallel and the
 * indicator visibly fights it.
 */
export function usePullToRefresh({
  scrollRef,
  onRefresh,
  threshold = 120,
  enabled = true,
}: PullToRefreshOptions): PullToRefreshState {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  /* Mirror the latest `pullDistance` into a ref so `onTouchEnd` can
     read it synchronously without re-binding listeners on every
     state update. */
  const pullDistanceRef = useRef(0);
  const setPull = useCallback((next: number) => {
    pullDistanceRef.current = next;
    setPullDistance(next);
  }, []);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefreshRef.current();
    } catch (error) {
      console.error('[pull-to-refresh] refresh failed', error);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const el = scrollRef.current;
    if (!el) return undefined;

    let startX: number | null = null;
    let startY: number | null = null;
    let startScrollTop = 0;
    let active = false;
    /* Gesture-axis lock: once we've decided the user is scrolling
       horizontally (e.g. swiping the recents strip / a carousel
       inside the list), we ignore vertical delta for the rest of
       this touch sequence. Without this, even a slight vertical
       drift during a horizontal swipe was enough to engage the pull
       and visibly fight the native horizontal scroll. */
    let axisLock: 'horizontal' | 'vertical' | null = null;
    /* Minimum total motion before we commit to an axis. Below this
       any direction read is noise (thumb settling on the screen).
       8px matches the touch-slop value iOS Safari uses internally
       before it commits to a scroll direction. */
    const AXIS_DECIDE_DISTANCE = 8;

    function onTouchStart(event: TouchEvent) {
      if (!el) return;
      const touch = event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      startScrollTop = el.scrollTop;
      active = false;
      axisLock = null;
    }

    function onTouchMove(event: TouchEvent) {
      if (startY == null || startX == null) return;
      // A nested gesture (a lifted list row being dragged) owns this touch.
      if (event.defaultPrevented) {
        startX = null;
        startY = null;
        if (active) {
          active = false;
          setPull(0);
        }
        return;
      }
      /* Only treat this as a pull when the scroll started at the
         very top. Otherwise it's a normal content scroll and we
         leave the native behavior alone. */
      if (startScrollTop > 0) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const rawDelta = touch.clientY - startY;
      /* Decide the gesture's axis once it's moved far enough to
         actually mean something — then stick with that decision
         for the rest of the touch. */
      if (axisLock == null) {
        const absX = Math.abs(dx);
        const absY = Math.abs(rawDelta);
        if (Math.max(absX, absY) >= AXIS_DECIDE_DISTANCE) {
          axisLock = absX > absY ? 'horizontal' : 'vertical';
        }
      }
      if (axisLock === 'horizontal') {
        /* User is swiping the horizontal recents strip / carousel.
           Skip pull entirely — engaging here would steal vertical
           drift from the swipe and produce a tiny, jittery pull
           that snaps back when they continue horizontally. */
        if (active) {
          active = false;
          setPull(0);
        }
        return;
      }
      if (rawDelta <= 0) {
        /* Upward / no movement — let the browser scroll the list
           normally. If we'd previously engaged the pull, clear it. */
        if (active) {
          active = false;
          setPull(0);
        }
        return;
      }
      active = true;
      /* Suppress the native iOS overscroll bounce so our indicator
         is the only thing moving. `passive: false` is set below so
         this call actually has effect. */
      if (event.cancelable) event.preventDefault();
      /* Rubber-band damping. The pull tracks the finger 1:1 at the
         very start and gains resistance as it grows, asymptoting to
         `maxPull` so a long/fast swipe never runs unbounded.

         Rejected: the previous `sqrt(rawDelta) * 9` curve. sqrt has an
         infinite slope at 0, so the first pixel of finger travel
         snapped the content to ~9px and then kept running ahead of the
         finger (it stays >1:1 until ~80px) — that's the "it suddenly
         jumps a chunk instead of following my finger" feel. This
         exponential has slope 1 at the origin, so it eases out of 0
         smoothly. Tuned (maxPull = 1.8× threshold) so crossing
         `threshold` still takes a deliberate ~175px pull rather than an
         accidental tug. */
      const maxPull = threshold * 1.8;
      const damped = maxPull * (1 - Math.exp(-rawDelta / maxPull));
      setPull(damped);
    }

    function onTouchEnd() {
      const triggered = active && pullDistanceRef.current >= threshold;
      const wasActive = active;
      startX = null;
      startY = null;
      active = false;
      axisLock = null;
      if (wasActive) setPull(0);
      if (triggered) void handleRefresh();
    }

    function onTouchCancel() {
      const wasActive = active;
      startX = null;
      startY = null;
      active = false;
      axisLock = null;
      if (wasActive) setPull(0);
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [enabled, handleRefresh, scrollRef, setPull, threshold]);

  return { pullDistance, isRefreshing, threshold };
}
