/**
 * The landing of a dropped pinned conversation.
 *
 * A drop does not move the row at once: the move is a metadata write, and the
 * row only appears in its new place once that write is read back. Until then
 * (`waiting`) every pin section keeps its drag layout, so nothing snaps back.
 * When the row renders in its slot (`flying`), a copy of it travels from where
 * the drag image was released to that slot while the row itself stays hidden,
 * and hover is held off until the pointer moves, so neither the position nor
 * the background jumps. See specs/pinned-session-sections.md.
 */

export type PinnedDropRect = { left: number; top: number; width: number; height: number };

export type PinnedDropSettle = {
  sessionId: string;
  toSectionId: string | null;
  /** Index among the target section's pinned rows, the dropped one excluded. */
  toIndex: number;
  /** Where the drag image was when it was released. */
  from: PinnedDropRect;
  /** The row as it looked when the drag started, if it was a sidebar row. */
  ghost: HTMLElement | null;
  fromBackground: string | null;
  /** A pointer drag's lifted copy settles its shadow on the way down. */
  fromShadow?: string;
  phase: 'waiting' | 'flying';
  to?: PinnedDropRect;
  toBackground?: string | null;
  /** The landed row's corner radius, so the copy's fill has the row's shape. */
  radius?: string;
};

/** How long a drop waits for its write before the sidebar stops holding the gap. */
export const PINNED_DROP_WAIT_MS = 1_200;
export const PINNED_DROP_FLIGHT_MS = 100;

let current: PinnedDropSettle | null = null;
let waitTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export function getPinnedDropSettle(): PinnedDropSettle | null {
  return current;
}

export function subscribePinnedDropSettle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginPinnedDropSettle(
  settle: Omit<PinnedDropSettle, 'phase' | 'to' | 'toBackground' | 'radius'>
): void {
  if (waitTimer) clearTimeout(waitTimer);
  current = { ...settle, phase: 'waiting' };
  suppressPinnedHover();
  waitTimer = setTimeout(() => {
    if (current?.phase === 'waiting') endPinnedDropSettle();
  }, PINNED_DROP_WAIT_MS);
  notify();
}

export function flyPinnedDropSettle(
  to: PinnedDropRect,
  toBackground: string | null,
  landedRow: HTMLElement,
  radius: string
): void {
  if (!current || current.phase !== 'waiting') return;
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = null;
  current = {
    ...current,
    phase: 'flying',
    to,
    toBackground,
    radius,
    // A drag that did not start on a sidebar row flies the landed row's look.
    ghost: current.ghost ?? landedRow,
    from: current.from.width > 0 ? current.from : { ...current.from, width: to.width },
  };
  notify();
}

export function endPinnedDropSettle(): void {
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = null;
  if (!current) return;
  current = null;
  releasePinnedHoverOnPointerMove();
  notify();
}

// Where a drag started: the row's look and the pointer's offset inside it.

export type PinnedDragOrigin = {
  sessionId: string;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  ghost: HTMLElement;
  background: string;
};

let origin: PinnedDragOrigin | null = null;

/**
 * Record where a native row drag started (called from the row's own
 * `dragstart`), so a drop into a pin section can start from the released image.
 */
export function recordPinnedDragOrigin(
  sessionId: string,
  row: HTMLElement,
  event: { clientX: number; clientY: number }
): void {
  const rect = row.getBoundingClientRect();
  origin = {
    sessionId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    ghost: row.cloneNode(true) as HTMLElement,
    background: getComputedStyle(row).backgroundColor,
  };
}

export function takePinnedDragOrigin(sessionId: string): PinnedDragOrigin | null {
  const found = origin?.sessionId === sessionId ? origin : null;
  origin = null;
  return found;
}

// Hover is held off from the drop until the pointer next moves: the landed row
// sits under a still pointer, and lighting it up then is the jump to avoid.

// The rules live in `tailwind/index.css`, keyed by these body attributes.
const HOVER_ATTR = 'data-pin-hover-suppressed';
const DRAGGING_ATTR = 'data-pin-dragging';

function suppressPinnedHover(): void {
  if (typeof document === 'undefined') return;
  document.body.setAttribute(HOVER_ATTR, '');
}

function releasePinnedHoverOnPointerMove(): void {
  if (typeof document === 'undefined') return;
  const release = () => document.body.removeAttribute(HOVER_ATTR);
  document.addEventListener('pointermove', release, { once: true });
}

/**
 * While a pin row or section is held: a grabbing cursor everywhere, and no
 * hover under the moving pointer. Hover returns on the first pointer move
 * after the drop, so the landed row does not light up under a still pointer.
 */
export function setPinnedPointerDrag(active: boolean): void {
  if (pointerDragActive === active) return;
  pointerDragActive = active;
  for (const listener of pointerDragListeners) listener();
  if (typeof document === 'undefined') return;
  if (active) {
    document.body.setAttribute(DRAGGING_ATTR, '');
    suppressPinnedHover();
    return;
  }
  document.body.removeAttribute(DRAGGING_ATTR);
  releasePinnedHoverOnPointerMove();
}

let pointerDragActive = false;
const pointerDragListeners = new Set<() => void>();

/** Whether a pinned-row or pin-section pointer drag is in flight. */
export function isPinnedPointerDragActive(): boolean {
  return pointerDragActive;
}

export function subscribePinnedPointerDrag(listener: () => void): () => void {
  pointerDragListeners.add(listener);
  return () => pointerDragListeners.delete(listener);
}

// Where a pointer-dragged pinned row would land right now: the pin section
// under the pointer and the index among its other rows. Each section reads it
// to open its gap, exactly as for a native drag over it.

export type PinnedPointerTarget = { sectionId: string | null; index: number };

let pointerTarget: PinnedPointerTarget | null = null;
const pointerTargetListeners = new Set<() => void>();

export function getPinnedPointerTarget(): PinnedPointerTarget | null {
  return pointerTarget;
}

export function subscribePinnedPointerTarget(listener: () => void): () => void {
  pointerTargetListeners.add(listener);
  return () => pointerTargetListeners.delete(listener);
}

export function setPinnedPointerTarget(next: PinnedPointerTarget | null): void {
  if (
    next === pointerTarget ||
    (next &&
      pointerTarget &&
      next.sectionId === pointerTarget.sectionId &&
      next.index === pointerTarget.index)
  ) {
    return;
  }
  pointerTarget = next;
  for (const listener of pointerTargetListeners) listener();
}
