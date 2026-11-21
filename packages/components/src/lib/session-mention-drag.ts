/**
 * Dragging a sidebar session onto a chat surface, as a data transfer.
 *
 * The drop turns into a session mention in that surface's composer. Transfer
 * format stays here so both ends — sidebar rows and session tabs that start
 * the drag, and the pages that accept it — agree without importing each other.
 *
 * A tiny in-memory store also tracks the drag WHILE it is in flight. HTML5
 * `dragenter` only fires after the pointer is already over a surface, which is
 * too late to show the drop mask; the store lets landing/session pages light up
 * as soon as a sidebar row or session tab is picked up. HTML5 drags clear on
 * `window` `dragend` (capture). Pointer-driven tab-strip drags (dnd-kit) have
 * no HTML5 `dragend` and must call `clearSessionMentionDrag` themselves.
 */

/** Marks the drag as ours. Present on every session drag. */
export const SESSION_MENTION_DRAG_TYPE = 'application/x-lody-session-mention';

/**
 * The dragged session id, encoded INTO a second type name.
 *
 * `dragover` may read `dataTransfer.types` but not `getData()` — the payload is
 * protected until drop. Without the id in the type name a surface cannot tell,
 * while the pointer is over it, whether the drag is the conversation the user
 * is already in; it would light up a drop target that then has to do nothing,
 * which reads as a bug. Browsers lowercase type names, so the id round-trips
 * through `.toLowerCase()` on both sides and is compared case-insensitively.
 */
const SESSION_MENTION_DRAG_ID_PREFIX = `${SESSION_MENTION_DRAG_TYPE}+id:`;

export type SessionMentionDragPayload = {
  sessionId: string;
  /** Only for the `text/plain` fallback outside the app. */
  title?: string;
};

type DragTypes = { types?: ArrayLike<string> | Iterable<string> };

function toTypeArray(dataTransfer: DragTypes | null | undefined): string[] {
  if (!dataTransfer?.types) return [];
  return Array.from(dataTransfer.types);
}

let inFlightSessionId: string | null = null;
const inFlightListeners = new Set<() => void>();
let dragEndBound = false;

function notifySessionMentionDragListeners(): void {
  for (const listener of inFlightListeners) listener();
}

function setInFlightSessionId(next: string | null): void {
  if (inFlightSessionId === next) return;
  inFlightSessionId = next;
  notifySessionMentionDragListeners();
}

function onWindowDragEnd(): void {
  clearSessionMentionDrag();
}

function bindWindowDragEnd(): void {
  if (dragEndBound || typeof window === 'undefined') return;
  dragEndBound = true;
  window.addEventListener('dragend', onWindowDragEnd, true);
}

function unbindWindowDragEnd(): void {
  if (!dragEndBound || typeof window === 'undefined') return;
  dragEndBound = false;
  window.removeEventListener('dragend', onWindowDragEnd, true);
}

/** Session id currently being dragged out of the sidebar or a session tab, if any. */
export function getInFlightSessionMentionDragId(): string | null {
  return inFlightSessionId;
}

/**
 * Marks the conversation column that accepts a session-mention drop.
 *
 * Tab-strip drags use dnd-kit (no HTML5 `dataTransfer`), so drop detection
 * is `elementFromPoint` + this attribute rather than `onDrop`.
 */
export const SESSION_MENTION_DROP_LAYER_ATTR = 'data-session-mention-drop-layer';

export function isPointOverSessionMentionDropLayer(x: number, y: number): boolean {
  if (typeof document === 'undefined') return false;
  const node = document.elementFromPoint(x, y);
  return Boolean(node?.closest(`[${SESSION_MENTION_DROP_LAYER_ATTR}]`));
}

let stopPointerHover: (() => void) | null = null;

/**
 * Lights up drop surfaces without an HTML5 transfer.
 *
 * Used by pointer drags (dnd-kit: tab strip, Pinned, Focus rows). Until the
 * drag clears, pointer moves are reported to the surface under the pointer
 * (`hoverSessionMentionAtPoint`), so every source shows Today's drop line. The
 * caller must clear (`clearSessionMentionDrag`) on drag end/cancel — there is
 * no `dragend`.
 */
export function armSessionMentionDrag(sessionId: string): void {
  setInFlightSessionId(sessionId);
  if (stopPointerHover || typeof window === 'undefined') return;
  const move = (event: PointerEvent) => {
    if (inFlightSessionId)
      hoverSessionMentionAtPoint(event.clientX, event.clientY, inFlightSessionId);
  };
  window.addEventListener('pointermove', move, true);
  stopPointerHover = () => window.removeEventListener('pointermove', move, true);
}

export function subscribeSessionMentionDrag(onStoreChange: () => void): () => void {
  inFlightListeners.add(onStoreChange);
  return () => {
    inFlightListeners.delete(onStoreChange);
  };
}

/** Ends the in-flight drag. Tests call this between cases. */
export function clearSessionMentionDrag(): void {
  stopPointerHover?.();
  stopPointerHover = null;
  hoveredPointerTarget?.leave?.();
  hoveredPointerTarget = null;
  unbindWindowDragEnd();
  setInFlightSessionId(null);
}

/**
 * What a sidebar row's `onDragStart` does. Paired with `draggable` on the row.
 *
 * A row whose whole surface is covered by a navigation `<a>` must ALSO mark
 * that anchor `draggable={false}`: the anchor is the deepest draggable node, so
 * without it the browser starts its own link drag and never reaches this.
 */
export function startSessionMentionDrag(
  event: { dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'> | null },
  payload: SessionMentionDragPayload
): void {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  // Mention drops copy a reference; reordering pinned rows in the sidebar moves one.
  dataTransfer.effectAllowed = 'copyMove';
  dataTransfer.setData(SESSION_MENTION_DRAG_TYPE, payload.sessionId);
  dataTransfer.setData(`${SESSION_MENTION_DRAG_ID_PREFIX}${payload.sessionId.toLowerCase()}`, '');
  // A drop outside any of our surfaces still leaves something readable behind.
  dataTransfer.setData('text/plain', payload.title?.trim() || payload.sessionId);
  setInFlightSessionId(payload.sessionId);
  bindWindowDragEnd();
}

/** The dragged session id, readable during `dragover`. */
function peekSessionMentionDragSessionId(
  dataTransfer: DragTypes | null | undefined
): string | null {
  for (const type of toTypeArray(dataTransfer)) {
    const lowered = type.toLowerCase();
    if (lowered.startsWith(SESSION_MENTION_DRAG_ID_PREFIX)) {
      return lowered.slice(SESSION_MENTION_DRAG_ID_PREFIX.length) || null;
    }
  }
  return null;
}

/**
 * Whether this drag is one this surface would accept.
 *
 * `excludeSessionId` is the conversation the surface already is: mentioning
 * itself is never what the user means, and the session mention list excludes it
 * too, so the drop would have nothing to insert.
 */
export function hasAcceptableSessionMentionTransfer(
  dataTransfer: DragTypes | null | undefined,
  options?: { excludeSessionId?: string | null }
): boolean {
  const types = toTypeArray(dataTransfer).map((type) => type.toLowerCase());
  if (!types.includes(SESSION_MENTION_DRAG_TYPE)) return false;
  const exclude = options?.excludeSessionId?.toLowerCase();
  if (!exclude) return true;
  const dragged = peekSessionMentionDragSessionId(dataTransfer);
  // An id-less drag (a browser that dropped the second type) stays acceptable;
  // the drop resolves it against the mention list, which excludes self anyway.
  return dragged === null || dragged !== exclude;
}

/**
 * The dragged session id, readable only on `drop`.
 *
 * Deliberately does not fall back to the id-carrying type name: that one is
 * lowercased by the browser, and a case-folded id resolves to no session at all
 * — a silent no-op is worse than a drop that never had a payload to begin with.
 */
export function readSessionMentionDragSessionId(
  dataTransfer: Pick<DataTransfer, 'getData'>
): string | null {
  return dataTransfer.getData(SESSION_MENTION_DRAG_TYPE) || null;
}

// Pointer drops. Pointer-driven drags (dnd-kit: pinned sidebar rows) carry no
// `dataTransfer`, so a mention surface also registers its element here and a
// release over it is delivered like a native drop.

type PointerMentionTarget = {
  accepts: (sessionId: string) => boolean;
  drop: (sessionId: string, point?: { x: number; y: number }) => void;
  /** Optional: where the drag hovers, for surfaces that show a drop position. */
  hover?: (x: number, y: number, sessionId: string) => void;
  /** Optional: the drag left this surface or ended. */
  leave?: () => void;
};

const pointerTargets = new Map<Element, PointerMentionTarget>();
let hoveredPointerTarget: PointerMentionTarget | null = null;

function pointerTargetAt(x: number, y: number): PointerMentionTarget | null {
  if (typeof document === 'undefined') return null;
  // The dragged copy follows the pointer and sits on top: look through it.
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)];
  for (const top of stack) {
    for (let node: Element | null = top; node; node = node.parentElement) {
      const target = pointerTargets.get(node);
      if (target) return target;
    }
  }
  return null;
}

/**
 * Report a pointer drag's position to the surface under it (and `leave` to the
 * one it left), so a surface such as Today can draw where a drop would land.
 */
function hoverSessionMentionAtPoint(x: number, y: number, sessionId: string): void {
  const target = pointerTargetAt(x, y);
  const hovered = target?.accepts(sessionId) ? target : null;
  if (hoveredPointerTarget && hoveredPointerTarget !== hovered) hoveredPointerTarget.leave?.();
  hoveredPointerTarget = hovered;
  hovered?.hover?.(x, y, sessionId);
}

/** Register `element` as a pointer-drop mention surface; returns the release. */
export function registerSessionMentionPointerTarget(
  element: Element,
  target: PointerMentionTarget
): () => void {
  pointerTargets.set(element, target);
  return () => {
    if (pointerTargets.get(element) === target) pointerTargets.delete(element);
  };
}

/**
 * Deliver a pointer drag released at (x, y) to the innermost mention surface
 * under it. Returns whether a surface took the mention.
 */
export function dropSessionMentionAtPoint(x: number, y: number, sessionId: string): boolean {
  const target = pointerTargetAt(x, y);
  if (!target || !target.accepts(sessionId)) return false;
  target.drop(sessionId, { x, y });
  return true;
}
