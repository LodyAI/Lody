import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { dndPointerPoint } from '@/lib/dnd-pointer';
import { useLatestRef } from '@/hooks/use-latest-ref';
import {
  PINNED_DROP_FLIGHT_MS,
  PINNED_DROP_WAIT_MS,
  beginPinnedDropSettle,
  endPinnedDropSettle,
  getPinnedDropSettle,
  setPinnedPointerDrag,
  setPinnedPointerTarget,
  subscribePinnedDropSettle,
  type PinnedPointerTarget,
} from '@/lib/pinned-drop-settle';
import {
  armSessionMentionDrag,
  clearSessionMentionDrag,
  dropSessionMentionAtPoint,
} from '@/lib/session-mention-drag';
import { FOCUS_SECTION_DND_KEY, parsePinnedDndId } from './pinned-rows-dnd';
import { pinnedDropIndexAt, type SidebarUpdatedItem } from './sidebar-updated-session-list';

const FOCUS_ROW_LIFT_SHADOW = '0 10px 26px -10px rgb(0 0 0 / 0.28), 0 0 0 1px var(--sidebar-border)';

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

function focusPointerTargetAt(
  point: { x: number; y: number },
  draggedId: string
): PinnedPointerTarget | null {
  const element = document.querySelector<HTMLElement>(
    `[data-pin-section="${FOCUS_SECTION_DND_KEY}"]`
  );
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (point.x < box.left || point.x >= box.right || point.y < box.top || point.y >= box.bottom) {
    return null;
  }
  const rows = element.querySelector<HTMLElement>('[data-pin-rows]');
  return { sectionId: FOCUS_SECTION_DND_KEY, index: pinnedDropIndexAt(rows, point.y, draggedId) };
}

function liftedBackground(): string {
  const sidebar = document.querySelector('[data-sidebar="sidebar"]') ?? document.body;
  return getComputedStyle(sidebar).backgroundColor || 'var(--sidebar)';
}

function FocusRowGhost({ source }: { source: HTMLElement | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    host.replaceChildren(source ? (source.cloneNode(true) as HTMLElement) : '');
    return () => host.replaceChildren();
  }, [source]);
  return (
    <div
      ref={hostRef}
      style={{
        backgroundColor: 'var(--sidebar)',
        boxShadow: FOCUS_ROW_LIFT_SHADOW,
        borderRadius: '0.375rem',
        cursor: 'grabbing',
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * Renders the Focus drop flight when no Pinned section is mounted to host it.
 */
function FocusDropFlight() {
  const settle = useSyncExternalStore(
    subscribePinnedDropSettle,
    getPinnedDropSettle,
    getPinnedDropSettle
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const flight =
    settle?.phase === 'flying' && settle.toSectionId === FOCUS_SECTION_DND_KEY ? settle : null;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !flight || !flight.to) return undefined;
    host.replaceChildren(flight.ghost ? (flight.ghost.cloneNode(true) as HTMLElement) : '');
    host.style.transition = 'none';
    host.style.transform = `translate3d(${flight.from.left}px, ${flight.from.top}px, 0)`;
    host.style.width = `${flight.from.width}px`;
    host.style.backgroundColor = flight.fromBackground ?? 'var(--sidebar)';
    host.style.boxShadow = flight.fromShadow ?? FOCUS_ROW_LIFT_SHADOW;
    // Force layout before animating to destination.
    void host.offsetHeight;
    const dx = flight.to.left;
    const dy = flight.to.top;
    host.style.transition = `transform ${PINNED_DROP_FLIGHT_MS}ms cubic-bezier(0.2, 0, 0, 1), box-shadow ${PINNED_DROP_FLIGHT_MS}ms ease`;
    host.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    host.style.boxShadow = 'none';

    const timer = window.setTimeout(() => {
      endPinnedDropSettle();
    }, PINNED_DROP_FLIGHT_MS + 20);
    return () => {
      window.clearTimeout(timer);
      host.replaceChildren();
    };
  }, [flight]);

  if (!flight || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={hostRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 60,
        borderRadius: '0.375rem',
        pointerEvents: 'none',
      }}
    />,
    document.body
  );
}

/**
 * Wraps the Status view's Focus list in the same pointer DnD + 100ms settle
 * interaction used by Pinned sections.
 */
export function SidebarFocusDndContainer({
  items,
  enabled,
  onDropFocusSession,
  children,
}: {
  items: readonly SidebarUpdatedItem[];
  enabled: boolean;
  onDropFocusSession?: (sessionId: string, toIndex: number) => void;
  children: (orderedItems: SidebarUpdatedItem[]) => ReactNode;
}) {
  const propsIds = useMemo(() => items.map((item) => item.id), [items]);
  const [pendingIds, setPendingIds] = useState<readonly string[] | null>(null);

  useEffect(() => {
    if (pendingIds !== null && sameIds(pendingIds, propsIds)) {
      setPendingIds(null);
    }
  }, [pendingIds, propsIds]);

  useEffect(() => {
    if (pendingIds === null) return undefined;
    const timer = window.setTimeout(() => setPendingIds(null), PINNED_DROP_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingIds]);

  const effectiveIds = pendingIds ?? propsIds;
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const orderedItems = useMemo(
    () =>
      effectiveIds
        .map((id) => itemsById.get(id))
        .filter((item): item is SidebarUpdatedItem => item != null),
    [effectiveIds, itemsById]
  );

  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [activeGhost, setActiveGhost] = useState<HTMLElement | null>(null);
  const idsRef = useLatestRef(effectiveIds);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const stopPointerTracking = useRef<(() => void) | null>(null);
  const pointerOf = (event: DragEndEvent | DragMoveEvent) =>
    pointerRef.current ?? dndPointerPoint(event);

  const endPointerDrag = useCallback(() => {
    stopPointerTracking.current?.();
    stopPointerTracking.current = null;
    pointerRef.current = null;
    setActiveRow(null);
    setActiveGhost(null);
    setPinnedPointerTarget(null);
    clearSessionMentionDrag();
    setPinnedPointerDrag(false);
  }, []);

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setPinnedPointerDrag(true);
    const track = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', track, true);
    stopPointerTracking.current = () => window.removeEventListener('pointermove', track, true);
    const target = parsePinnedDndId(active.id);
    if (target?.kind !== 'row') return;
    setActiveRow(target.id);
    const slot = Array.from(document.querySelectorAll('[data-pin-node]')).find(
      (node) => node.getAttribute('data-pin-node') === target.id
    );
    const ghost = slot ? (slot.cloneNode(true) as HTMLElement) : null;
    if (ghost) {
      ghost.style.transform = '';
      ghost.style.transition = '';
      ghost.style.opacity = '';
      ghost.style.pointerEvents = 'none';
    }
    setActiveGhost(ghost);
    armSessionMentionDrag(target.id);
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const dragged = parsePinnedDndId(event.active.id);
    if (dragged?.kind !== 'row') return;
    const point = pointerOf(event);
    setPinnedPointerTarget(point ? focusPointerTargetAt(point, dragged.id) : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragged = parsePinnedDndId(event.active.id);
      if (dragged?.kind !== 'row') {
        endPointerDrag();
        return;
      }
      const point = pointerOf(event);
      if (point && dropSessionMentionAtPoint(point.x, point.y, dragged.id)) {
        endPointerDrag();
        return;
      }
      const lifted = event.active.rect.current.translated;
      const currentIds = idsRef.current;
      const homeIndex = currentIds.indexOf(dragged.id);
      const target =
        (point ? focusPointerTargetAt(point, dragged.id) : null) ??
        (homeIndex >= 0 ? { sectionId: FOCUS_SECTION_DND_KEY, index: homeIndex } : null);
      if (!target || !lifted) {
        endPointerDrag();
        return;
      }
      const withoutDragged = currentIds.filter((id) => id !== dragged.id);
      const nextIndex = Math.max(0, Math.min(target.index, withoutDragged.length));
      const nextIds = [
        ...withoutDragged.slice(0, nextIndex),
        dragged.id,
        ...withoutDragged.slice(nextIndex),
      ];

      beginPinnedDropSettle({
        sessionId: dragged.id,
        toSectionId: FOCUS_SECTION_DND_KEY,
        toIndex: nextIndex,
        from: { left: lifted.left, top: lifted.top, width: lifted.width, height: lifted.height },
        ghost: activeGhost,
        fromBackground: liftedBackground(),
        fromShadow: FOCUS_ROW_LIFT_SHADOW,
      });
      setPendingIds(nextIds);
      endPointerDrag();
      if (!sameIds(nextIds, propsIds)) {
        onDropFocusSession?.(dragged.id, nextIndex);
      }
    },
    [activeGhost, endPointerDrag, idsRef, onDropFocusSession, propsIds]
  );

  if (!enabled) {
    return <>{children(orderedItems)}</>;
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={endPointerDrag}
    >
      {children(orderedItems)}
      {typeof document !== 'undefined'
        ? createPortal(
            <DragOverlay dropAnimation={null} zIndex={60}>
              {activeRow ? <FocusRowGhost source={activeGhost} /> : null}
            </DragOverlay>,
            document.body
          )
        : null}
      <FocusDropFlight />
    </DndContext>
  );
}
