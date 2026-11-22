import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatusViewCommand, StatusViewLayout } from '@lody/shared';
import { findStatusViewRow, type StatusViewArea } from './mobile-status-view';

/** Long press → menu or drag on the phone Status list: [README](./README.md#status-grouping). */
export const LIFT_DELAY_MS = 450;
export const SCROLL_SLOP_PX = 10;
const DRAG_START_PX = 6;
const EDGE_PX = 56;
/** Auto-scroll speed, scaled by frame time so 120 Hz screens do not scroll twice as fast. */
const EDGE_SPEED_PX_PER_MS = 0.84;

type MoveCommand = Extract<StatusViewCommand, { type: 'move' }>;

export type StatusDropTarget = { to: StatusViewArea; beforeId: string | null };

export type StatusListDragState =
  | { phase: 'idle' }
  | { phase: 'lifted'; sessionId: string }
  | { phase: 'dragging'; sessionId: string; target: StatusDropTarget | null };

type Pointer = { id: number; x: number; y: number };

/** No native haptics bridge exists; Android WebViews vibrate, WKWebView stays silent. */
function haptic(ms: number) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(ms);
    } catch {
      return;
    }
  }
}

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  let cursor = element?.parentElement ?? null;
  while (cursor) {
    const overflow = getComputedStyle(cursor).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && cursor.scrollHeight > cursor.clientHeight)
      return cursor;
    cursor = cursor.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/** Height the floating tab bar and the safe area cover at the bottom of the window. */
function bottomObstruction(): number {
  const style = getComputedStyle(document.documentElement);
  const rem = parseFloat(style.fontSize) || 16;
  const read = (name: string) => {
    const value = style.getPropertyValue(name).trim();
    if (!value) return 0;
    const number = parseFloat(value);
    if (!Number.isFinite(number)) return 0;
    return value.endsWith('rem') ? number * rem : number;
  };
  return read('--mobile-tabbar-height') + read('--k-safe-area-bottom');
}

/** Viewport y below which and above which a dragged row scrolls the list. */
function edgeZones(scroller: HTMLElement | null): { top: number; bottom: number } {
  const rect =
    !scroller || scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
  const bottom = Math.min(rect.bottom, window.innerHeight - bottomObstruction());
  return { top: rect.top + EDGE_PX, bottom: bottom - EDGE_PX };
}

function areaOf(element: Element): StatusViewArea | null {
  const area = element.getAttribute('data-status-area');
  if (area === 'focus') return { area: 'focus' };
  if (area === 'pinned') {
    const section = element.getAttribute('data-status-section') ?? '';
    return { area: 'pinned', sectionId: section === '' ? null : section };
  }
  return null;
}

/** The drop target under a point; Later and Settled order is derived, so they take no drop. */
export function resolveStatusDropTarget(
  layout: StatusViewLayout,
  draggedId: string,
  element: Element | null,
  clientY: number
): StatusDropTarget | null {
  const header = element?.closest('[data-status-drop-header]');
  if (header) {
    const to = areaOf(header);
    if (!to) return null;
    const rows =
      to.area === 'focus'
        ? layout.focus
        : (layout.pinned.find((section) => section.sectionId === to.sectionId)?.rows ?? []);
    const first = rows.find((row) => row.id !== draggedId);
    return { to, beforeId: first?.id ?? null };
  }
  const rowElement = element?.closest('[data-status-row-id]');
  if (!rowElement) return null;
  const to = areaOf(rowElement);
  const hoveredId =
    rowElement.getAttribute('data-status-root-id') ?? rowElement.getAttribute('data-status-row-id');
  if (!to || !hoveredId) return null;
  const place = findStatusViewRow(layout, hoveredId);
  if (!place) return null;
  const rect = rowElement.getBoundingClientRect();
  const before = clientY < rect.top + rect.height / 2;
  const rows = place.rows.filter((row) => row.id !== draggedId);
  const index = rows.findIndex((row) => row.id === hoveredId);
  if (index < 0) return { to, beforeId: place.rows[place.index + 1]?.id ?? null };
  const beforeId = before ? hoveredId : (rows[index + 1]?.id ?? null);
  return { to, beforeId };
}

/** Whether dropping there would change nothing (same list, same neighbour). */
export function isNoopStatusDrop(
  layout: StatusViewLayout,
  sessionId: string,
  target: StatusDropTarget
): boolean {
  const place = findStatusViewRow(layout, sessionId);
  if (!place) return true;
  const from = place.area;
  const sameList =
    from.area === target.to.area &&
    (from.area !== 'pinned' ||
      (target.to.area === 'pinned' && from.sectionId === target.to.sectionId));
  if (!sameList) return false;
  const nextId = place.rows[place.index + 1]?.id ?? null;
  return target.beforeId === nextId || target.beforeId === sessionId;
}

export function useStatusListDrag({
  enabled,
  canDrag,
  layout,
  onOpenMenu,
  onDrop,
  extraSurfaces,
}: {
  enabled: boolean;
  /** Whether a top-level row may move; a row that may not still opens its menu. */
  canDrag: (rootId: string) => boolean;
  /** Split-panel portal targets that also hold rows (`MobileChatList` `splitTargets`). */
  extraSurfaces?: readonly HTMLElement[];
  /** The layout as rendered; frozen by the caller while a drag is in flight. */
  layout: StatusViewLayout;
  onOpenMenu: (sessionId: string) => void;
  onDrop: (move: MoveCommand) => void;
}) {
  const [state, setState] = useState<StatusListDragState>({ phase: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const callbacks = useRef({ onOpenMenu, onDrop, canDrag });
  callbacks.current = { onOpenMenu, onDrop, canDrag };
  const gesture = useRef<{
    pointer: Pointer;
    start: { x: number; y: number };
    /** The pressed row: its menu opens on release. */
    sessionId: string;
    /** The top-level row that moves; null when the pressed row cannot be dragged. */
    dragId: string | null;
    element: HTMLElement;
    timer: number | null;
    scroller: HTMLElement | null;
    startScrollTop: number;
    frame: number | null;
    frameAt: number | null;
    swallowClick: boolean;
  } | null>(null);

  const setPhase = useCallback((next: StatusListDragState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const preventScroll = useCallback((event: TouchEvent) => {
    if (stateRef.current.phase !== 'idle') event.preventDefault();
  }, []);

  const [surface, touchSurfaceRef] = useState<HTMLElement | null>(null);
  const extra0 = extraSurfaces?.[0] ?? null;
  const extra1 = extraSurfaces?.[1] ?? null;
  useEffect(() => {
    if (!enabled) return undefined;
    const elements = [surface, extra0, extra1].filter(
      (element): element is HTMLElement => !!element
    );
    for (const element of elements)
      element.addEventListener('touchmove', preventScroll, { passive: false });
    return () => {
      for (const element of elements) element.removeEventListener('touchmove', preventScroll);
    };
  }, [enabled, extra0, extra1, preventScroll, surface]);

  const end = useCallback(() => {
    const current = gesture.current;
    if (current) {
      if (current.timer !== null) window.clearTimeout(current.timer);
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      current.element.style.transform = '';
      current.element.style.zIndex = '';
      current.element.style.boxShadow = '';
      current.element.style.position = '';
      current.element.style.transition = '';
    }
    setPhase({ phase: 'idle' });
  }, [setPhase]);

  const cancel = useCallback(() => {
    if (gesture.current?.timer != null) window.clearTimeout(gesture.current.timer);
    if (stateRef.current.phase !== 'idle') end();
    gesture.current = null;
  }, [end]);

  const retarget = useCallback(() => {
    const current = gesture.current;
    const phase = stateRef.current;
    if (!current || phase.phase !== 'dragging') return;
    const scrolled = (current.scroller?.scrollTop ?? 0) - current.startScrollTop;
    current.element.style.transform = `translateY(${current.pointer.y - current.start.y + scrolled}px)`;
    current.element.style.pointerEvents = 'none';
    const hit = document.elementFromPoint(current.pointer.x, current.pointer.y);
    current.element.style.pointerEvents = '';
    const previous = phase.target;
    const resolved = resolveStatusDropTarget(
      layoutRef.current,
      phase.sessionId,
      hit,
      current.pointer.y
    );
    const edges = edgeZones(current.scroller);
    const inEdge = current.pointer.y < edges.top || current.pointer.y > edges.bottom;
    const overNothing = !hit?.closest('[data-status-row-id],[data-status-drop-header]');
    const target = resolved ?? (inEdge && overNothing ? previous : null);
    if (
      previous?.beforeId !== target?.beforeId ||
      previous?.to.area !== target?.to.area ||
      (previous?.to.area === 'pinned' &&
        target?.to.area === 'pinned' &&
        previous.to.sectionId !== target.to.sectionId)
    ) {
      if (target) haptic(5);
      setPhase({ phase: 'dragging', sessionId: phase.sessionId, target });
    }
  }, [setPhase]);
  const autoScroll = useCallback(
    (frameAt: number) => {
      const current = gesture.current;
      if (!current || stateRef.current.phase !== 'dragging') return;
      const elapsed = current.frameAt === null ? 16 : Math.min(64, frameAt - current.frameAt);
      current.frameAt = frameAt;
      const scroller = current.scroller;
      if (scroller) {
        const edges = edgeZones(scroller);
        const y = current.pointer.y;
        const step = EDGE_SPEED_PX_PER_MS * elapsed;
        const delta = y < edges.top ? -step : y > edges.bottom ? step : 0;
        if (delta !== 0) {
          scroller.scrollTop += delta;
          retarget();
        }
      }
      current.frame = requestAnimationFrame(autoScroll);
    },
    [retarget]
  );

  useEffect(() => end, [end]);
  useEffect(() => {
    if (!enabled && stateRef.current.phase !== 'idle') end();
  }, [enabled, end]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.button !== 0) return;
      const live =
        gesture.current !== null &&
        (gesture.current.timer !== null || stateRef.current.phase !== 'idle');
      if (live && gesture.current!.pointer.id !== event.pointerId) {
        cancel();
        return;
      }
      if ((event.target as Element).closest('[data-status-swipe-action]')) return;
      const element = (event.target as Element).closest<HTMLElement>('[data-status-row-id]');
      const sessionId = element?.getAttribute('data-status-row-id');
      if (!element || !sessionId) return;
      const rootId = element.getAttribute('data-status-root-id') ?? sessionId;
      const dragId = rootId === sessionId && callbacks.current.canDrag(rootId) ? rootId : null;
      if (gesture.current?.timer != null) window.clearTimeout(gesture.current.timer);
      const scroller = scrollParent(element);
      gesture.current = {
        pointer: { id: event.pointerId, x: event.clientX, y: event.clientY },
        start: { x: event.clientX, y: event.clientY },
        sessionId,
        dragId,
        element,
        scroller,
        startScrollTop: scroller?.scrollTop ?? 0,
        frame: null,
        frameAt: null,
        swallowClick: false,
        timer: window.setTimeout(() => {
          const current = gesture.current;
          if (!current) return;
          current.timer = null;
          current.swallowClick = true;
          haptic(10);
          current.element.style.position = 'relative';
          current.element.style.zIndex = '40';
          current.element.style.transition = 'box-shadow 120ms ease-out';
          current.element.style.boxShadow = '0 8px 24px rgb(0 0 0 / 0.18)';
          setPhase({ phase: 'lifted', sessionId });
        }, LIFT_DELAY_MS),
      };
    },
    [cancel, enabled, setPhase]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointer.id) return;
      const dx = event.clientX - current.start.x;
      const dy = event.clientY - current.start.y;
      const phase = stateRef.current.phase;
      if (phase === 'idle') {
        if (Math.hypot(dx, dy) > SCROLL_SLOP_PX) {
          if (current.timer !== null) window.clearTimeout(current.timer);
          gesture.current = null;
        }
        return;
      }
      current.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      if (phase === 'lifted') {
        if (current.dragId === null) return;
        if (Math.abs(dy) < DRAG_START_PX && Math.abs(dx) < DRAG_START_PX) return;
        setPhase({ phase: 'dragging', sessionId: current.dragId, target: null });
        current.frame = requestAnimationFrame(autoScroll);
      }
      retarget();
    },
    [autoScroll, retarget, setPhase]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointer.id) return;
      const phase = stateRef.current;
      if (phase.phase === 'lifted') {
        end();
        callbacks.current.onOpenMenu(current.sessionId);
      } else if (phase.phase === 'dragging') {
        const { target, sessionId } = phase;
        end();
        if (target && !isNoopStatusDrop(layoutRef.current, sessionId, target)) {
          haptic(10);
          callbacks.current.onDrop({
            type: 'move',
            sessionId,
            to: target.to,
            beforeId: target.beforeId,
          });
        }
      } else {
        if (current.timer !== null) window.clearTimeout(current.timer);
        gesture.current = null;
      }
    },
    [end]
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      if (gesture.current && event.pointerId === gesture.current.pointer.id) cancel();
    },
    [cancel]
  );
  /**
   * The platform's own long-press menu (an image, a link) would take over the
   * gesture; a context-menu request (right click, TalkBack, a keyboard's menu key)
   * opens the row's action menu instead.
   */
  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      const element = (event.target as Element).closest<HTMLElement>('[data-status-row-id]');
      const sessionId = element?.getAttribute('data-status-row-id');
      if (!sessionId) return;
      event.preventDefault();
      if (stateRef.current.phase !== 'idle' || gesture.current?.swallowClick) return;
      cancel();
      callbacks.current.onOpenMenu(sessionId);
    },
    [cancel]
  );

  /**
   * Capture-phase click guard: the tap that ends a lift must not open the row.
   * WebKit often sends no click after a long press, so only a click on the
   * pressed row itself is swallowed.
   */
  const onClickCapture = useCallback((event: React.MouseEvent) => {
    const current = gesture.current;
    if (!current?.swallowClick) return;
    gesture.current = null;
    if (!current.element.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  /** Swipe rows consult this so a lifted row does not also slide sideways. */
  const isLifted = useCallback(() => stateRef.current.phase !== 'idle', []);

  return {
    state,
    isLifted,
    touchSurfaceRef,
    handlers: enabled
      ? {
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel,
          onClickCapture,
          onContextMenu,
        }
      : {},
  };
}
