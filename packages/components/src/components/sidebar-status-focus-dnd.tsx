import { colors as uiColors, shadow as uiShadow } from '@lody/ui/tokens/colors.stylex';
import { corner as uiCorner, radius as uiRadius } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
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
import { buildOpenedBySessionTree } from '@/lib/session-opened-by-tree';
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
import {
  DEFAULT_PIN_SECTION_KEY,
  FOCUS_SECTION_DND_KEY,
  parsePinnedDndId,
} from './pinned-rows-dnd';
import {
  pinnedDropIndexAt,
  SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
  type SidebarUpdatedItem,
} from './sidebar-updated-session-list';

const FOCUS_ROW_LIFT_SHADOW = '0 8px 20px -4px rgb(0 0 0 / 0.16), 0 2px 6px rgb(0 0 0 / 0.08)';

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * Find the Focus section (or a Pinned section when `allowPinTarget` is true)
 * under `point` and the top-level `[data-pin-node]` drop index there.
 */
function focusOrPinPointerTargetAt(
  point: { x: number; y: number },
  draggedId: string,
  allowPinTarget: boolean
): PinnedPointerTarget | null {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-pin-section]'))) {
    const attr = element.getAttribute('data-pin-section');
    if (attr !== FOCUS_SECTION_DND_KEY && !allowPinTarget) continue;
    const box = element.getBoundingClientRect();
    if (point.x < box.left || point.x >= box.right || point.y < box.top || point.y >= box.bottom) {
      continue;
    }
    const sectionId = attr === DEFAULT_PIN_SECTION_KEY ? null : attr;
    const rows = element.querySelector<HTMLElement>('[data-pin-rows]');
    return { sectionId, index: pinnedDropIndexAt(rows, point.y, draggedId) };
  }
  return null;
}

function liftedBackground(): string | null {
  const overlay = document.querySelector('[data-pin-drag-overlay]');
  return overlay ? getComputedStyle(overlay).backgroundColor : null;
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
      data-pin-drag-overlay=""
      {...stylex.props(themeStyles.panel)}
      style={{
        boxShadow: FOCUS_ROW_LIFT_SHADOW,
        cursor: 'grabbing',
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * Renders the Focus drop flight when a Focus drop lands inside Focus.
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
    if (flight.fromBackground) {
      host.style.backgroundColor = flight.fromBackground;
    }
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
      {...stylex.props(themeStyles.panel)}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 60,
        pointerEvents: 'none',
      }}
    />,
    document.body
  );
}

/**
 * Wraps the Status view's Focus list in the same pointer DnD + 100ms settle
 * interaction used by Pinned sections. Tracks top-level root groups so child
 * sessions follow their opener and drop indices match `[data-pin-node]` 1-to-1.
 */
export function SidebarFocusDndContainer({
  items,
  enabled,
  onDropFocusSession,
  onDropIntoPinSection,
  children,
}: {
  items: readonly SidebarUpdatedItem[];
  enabled: boolean;
  onDropFocusSession?: (sessionId: string, toIndex: number) => void;
  onDropIntoPinSection?: (sessionId: string, pinSectionId: string | null, toIndex: number) => void;
  children: (orderedItems: SidebarUpdatedItem[]) => ReactNode;
}) {
  // Partition items into top-level root groups (each root carries its opened-by descendants).
  const rootGroups = useMemo(() => {
    const nodes = buildOpenedBySessionTree(items, SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS);
    const rootIds: string[] = [];
    const membersByRoot = new Map<string, SidebarUpdatedItem[]>();
    let currentRootId: string | null = null;
    for (const node of nodes) {
      if (node.depth === 0 || !currentRootId) {
        currentRootId = node.item.id;
        rootIds.push(currentRootId);
        membersByRoot.set(currentRootId, [node.item]);
      } else {
        membersByRoot.get(currentRootId)?.push(node.item);
      }
    }
    return { rootIds, membersByRoot };
  }, [items]);

  const propsRootIds = rootGroups.rootIds;
  const [pendingRootIds, setPendingRootIds] = useState<readonly string[] | null>(null);

  useEffect(() => {
    if (pendingRootIds !== null && sameIds(pendingRootIds, propsRootIds)) {
      setPendingRootIds(null);
    }
  }, [pendingRootIds, propsRootIds]);

  useEffect(() => {
    if (pendingRootIds === null) return undefined;
    const timer = window.setTimeout(() => setPendingRootIds(null), PINNED_DROP_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingRootIds]);

  const effectiveRootIds = pendingRootIds ?? propsRootIds;
  const orderedItems = useMemo(
    () => effectiveRootIds.flatMap((id) => rootGroups.membersByRoot.get(id) ?? []),
    [effectiveRootIds, rootGroups.membersByRoot]
  );

  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [activeGhost, setActiveGhost] = useState<HTMLElement | null>(null);
  const rootIdsRef = useLatestRef(effectiveRootIds);
  const allowPinTarget = typeof onDropIntoPinSection === 'function';

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

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const dragged = parsePinnedDndId(event.active.id);
      if (dragged?.kind !== 'row') return;
      const point = pointerOf(event);
      setPinnedPointerTarget(
        point ? focusOrPinPointerTargetAt(point, dragged.id, allowPinTarget) : null
      );
    },
    [allowPinTarget]
  );

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
      const currentRootIds = rootIdsRef.current;
      const homeIndex = currentRootIds.indexOf(dragged.id);
      const target =
        (point ? focusOrPinPointerTargetAt(point, dragged.id, allowPinTarget) : null) ??
        (homeIndex >= 0 ? { sectionId: FOCUS_SECTION_DND_KEY, index: homeIndex } : null);
      if (!target || !lifted) {
        endPointerDrag();
        return;
      }

      // Dropped onto a Pinned section: pin the conversation at that exact slot.
      if (target.sectionId !== FOCUS_SECTION_DND_KEY) {
        beginPinnedDropSettle({
          sessionId: dragged.id,
          toSectionId: target.sectionId,
          toIndex: target.index,
          from: { left: lifted.left, top: lifted.top, width: lifted.width, height: lifted.height },
          ghost: activeGhost,
          fromBackground: liftedBackground(),
          fromShadow: FOCUS_ROW_LIFT_SHADOW,
        });
        endPointerDrag();
        onDropIntoPinSection?.(dragged.id, target.sectionId, target.index);
        return;
      }

      const withoutDragged = currentRootIds.filter((id) => id !== dragged.id);
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
      setPendingRootIds(nextIds);
      endPointerDrag();
      if (!sameIds(nextIds, propsRootIds)) {
        onDropFocusSession?.(dragged.id, nextIndex);
      }
    },
    [
      activeGhost,
      allowPinTarget,
      endPointerDrag,
      onDropFocusSession,
      onDropIntoPinSection,
      propsRootIds,
      rootIdsRef,
    ]
  );

  if (!enabled) {
    return <>{children(orderedItems)}</>;
  }

  return (
    <DndContext
      sensors={sensors}
      // The sidebar viewport owns edge scrolling (`useSessionDragAutoScroll`);
      // two scrollers on one container would double the speed.
      autoScroll={false}
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

const themeStyles = stylex.create({
  panel: { overflow: 'hidden', borderRadius: uiRadius.small, cornerShape: uiCorner.shape, boxShadow: uiShadow.card, backgroundColor: uiColors.elevatedBackground },
});
