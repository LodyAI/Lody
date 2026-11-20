import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react';
import {
  getInFlightSessionMentionDragId,
  subscribeSessionMentionDrag,
} from '@/lib/session-mention-drag';
import { isPinnedPointerDragActive, subscribePinnedPointerDrag } from '@/lib/pinned-drop-settle';

// The band inside each viewport edge that starts scrolling, and the per-frame
// speed at the very edge. Speed eases linearly to zero at the band's inner
// edge, so the list creeps on approach and flies at the edge.
const EDGE_ZONE_PX = 48;
const MAX_STEP_PX = 14;

const readNoDrag = () => false;

/**
 * Scrolls a sidebar viewport while a session or pinned-section drag holds the
 * pointer near its top or bottom edge.
 *
 * Session drags arm the mention-drag store (HTML5 row drags and pointer-driven
 * dnd-kit drags alike); pinned-section drags set the pinned pointer-drag flag
 * instead. HTML5 drags report the pointer through `dragover` and never emit
 * pointer events; pointer drags emit `pointermove` and never drag events, so
 * both are tracked. The frame loop keeps scrolling while the pointer is held
 * still at an edge: `dragover` repeats on its own, `pointermove` does not.
 */
export function useSessionDragAutoScroll(viewportRef: RefObject<HTMLElement | null>): void {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const releaseMention = subscribeSessionMentionDrag(onStoreChange);
    const releasePinned = subscribePinnedPointerDrag(onStoreChange);
    return () => {
      releaseMention();
      releasePinned();
    };
  }, []);
  const snapshot = useCallback(
    () => getInFlightSessionMentionDragId() !== null || isPinnedPointerDragActive(),
    []
  );
  const dragging = useSyncExternalStore(subscribe, snapshot, readNoDrag);

  useEffect(() => {
    if (!dragging) return undefined;

    const pointer = { x: 0, y: 0, seen: false };
    const track = (event: { clientX: number; clientY: number }) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.seen = true;
    };
    window.addEventListener('dragover', track, true);
    window.addEventListener('pointermove', track, true);

    let frame = requestAnimationFrame(function step() {
      frame = requestAnimationFrame(step);
      const viewport = viewportRef.current;
      if (!viewport || !pointer.seen) return;
      const rect = viewport.getBoundingClientRect();
      // Only a pointer inside the list's width scrolls it; a drag aimed at a
      // conversation mention surface leaves the sidebar alone.
      if (pointer.x < rect.left || pointer.x > rect.right) return;
      const fromTop = pointer.y - rect.top;
      const fromBottom = rect.bottom - pointer.y;
      // Past an edge the distance clamps at 0: full speed, so holding the drag
      // over the header or footer still walks the list to its end.
      const speed = (edge: number) => MAX_STEP_PX * (1 - Math.max(edge, 0) / EDGE_ZONE_PX);
      if (fromTop < EDGE_ZONE_PX) {
        viewport.scrollTop -= speed(fromTop);
      } else if (fromBottom < EDGE_ZONE_PX) {
        viewport.scrollTop += speed(fromBottom);
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('dragover', track, true);
      window.removeEventListener('pointermove', track, true);
    };
  }, [dragging, viewportRef]);
}
