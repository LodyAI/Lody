import { matchesKeyboardEvent } from './key-matcher';

export type SemanticActionResult = 'handled' | 'unhandled';
export type SemanticActionInteraction =
  | 'pointer'
  | 'pointerdown'
  | 'pointerleave'
  | 'wheel'
  | 'keyboard';

export const SEMANTIC_HOVER_DWELL_MS = 250;

const INTERACTION_EVENT = 'lody:semantic-action-interaction';

export function reportSemanticActionInteraction(
  element: HTMLElement,
  source: SemanticActionInteraction
) {
  element.dispatchEvent(new CustomEvent(INTERACTION_EVENT, { bubbles: true, detail: source }));
}

export type SemanticActionScope = {
  id: string;
  element: HTMLElement | null;
  actions: Record<string, () => SemanticActionResult>;
};

const BLOCKING_LAYER_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], ' +
  '[aria-modal="true"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  return typeof element.checkVisibility === 'function'
    ? element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    : element.getClientRects().length > 0;
}

/** Tracks action ownership without moving the text caret on hover. */
export function createSemanticActionRouter(
  root: HTMLElement,
  getScopes: () => readonly SemanticActionScope[],
  defaultScopeId: string
) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  let selected: { id: string; source: 'hover' | 'explicit' } | null = null;
  let hover: { id: string; element: HTMLElement; timer: number } | null = null;
  let generation = 0;
  let pointer: { x: number; y: number } | null = null;
  let keyboardNavigation = false;
  let dragging = false;
  let disposed = false;

  const visibleScopes = () =>
    getScopes().filter((scope) => scope.element && isVisible(scope.element));
  const blocked = () =>
    Array.from(doc.querySelectorAll<HTMLElement>(BLOCKING_LAYER_SELECTOR)).some(isVisible);
  const scopeAt = (target: EventTarget | null, scopes = visibleScopes()) => {
    if (!(target instanceof win.Node)) return undefined;
    return scopes
      .filter((scope) => scope.element!.contains(target))
      .find(
        (scope, _, candidates) =>
          !candidates.some((child) => child !== scope && scope.element!.contains(child.element))
      );
  };
  const currentScope = (scopes = visibleScopes()) => {
    const id = selected?.id;
    if (id) return scopes.find((scope) => scope.id === id);
    return (
      scopeAt(doc.activeElement, scopes) ?? scopes.find((scope) => scope.id === defaultScopeId)
    );
  };
  const cancelHover = () => {
    if (hover) win.clearTimeout(hover.timer);
    hover = null;
  };
  const paint = () => {
    const isBlocked = blocked();
    const scopes = visibleScopes();
    if (
      hover &&
      (isBlocked ||
        !scopes.some((scope) => scope.id === hover!.id && scope.element === hover!.element))
    )
      cancelHover();
    const current = isBlocked ? undefined : currentScope(scopes);
    for (const scope of getScopes()) {
      if (scope.element) {
        if (scope.id === current?.id) {
          if (scope.element.dataset.lodyActionActive !== 'true') {
            scope.element.dataset.lodyActionActive = 'true';
          }
        } else delete scope.element.dataset.lodyActionActive;
      }
    }
  };
  const select = (id: string, source: NonNullable<typeof selected>['source']) => {
    cancelHover();
    if (source === 'explicit') generation += 1;
    selected = { id, source };
    paint();
  };
  const deliberateInteraction = (target: EventTarget | null) => {
    // Even input outside our scopes supersedes an outstanding async open.
    generation += 1;
    cancelHover();
    if (blocked() || dragging) return;
    const scope = scopeAt(target);
    if (scope) select(scope.id, 'explicit');
  };
  const considerHover = (target: EventTarget | null) => {
    if (selected?.source === 'explicit' || dragging || blocked()) {
      cancelHover();
      return;
    }
    const scope = scopeAt(target);
    if (!scope) {
      cancelHover();
      if (selected?.source === 'hover') selected = null;
      paint();
      return;
    }
    if (hover?.id === scope.id && hover.element === scope.element) return;
    cancelHover();
    if (selected?.id === scope.id) return;
    const candidate = {
      id: scope.id,
      element: scope.element!,
      timer: win.setTimeout(() => {
        if (hover !== candidate) return;
        hover = null;
        if (disposed || dragging || blocked() || selected?.source === 'explicit') return;
        if (
          visibleScopes().some(
            (item) => item.id === candidate.id && item.element === candidate.element
          )
        ) {
          select(candidate.id, 'hover');
        }
      }, SEMANTIC_HOVER_DWELL_MS),
    };
    hover = candidate;
  };
  const onPointer = (event: PointerEvent) => {
    const moved = !pointer || pointer.x !== event.clientX || pointer.y !== event.clientY;
    pointer = { x: event.clientX, y: event.clientY };
    keyboardNavigation = false;
    if (event.type === 'pointerdown') {
      deliberateInteraction(event.target);
    } else if (selected?.source === 'explicit') {
      return;
    } else if (event.buttons !== 0 || dragging || blocked()) {
      cancelHover();
    } else if (moved) {
      considerHover(event.target);
    }
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && (event.deltaX !== 0 || event.deltaY !== 0)) {
      deliberateInteraction(event.target);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Native close may also reach the renderer. It must not retarget to the
    // old text caret after the pointer has selected another surface.
    if (matchesKeyboardEvent(event, 'Mod+w')) return;
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
    keyboardNavigation = event.key === 'Tab' || event.key.startsWith('Arrow');
    deliberateInteraction(event.target);
  };
  const onFramePointerOver = (event: PointerEvent) => {
    // Chromium sends pointerover to the iframe element, but pointermove inside
    // a cross-origin frame never reaches this document.
    if (event.target instanceof win.HTMLIFrameElement && event.buttons === 0) onPointer(event);
  };
  const onFocus = (event: FocusEvent) => {
    if (blocked()) return;
    if (keyboardNavigation) {
      const scope = scopeAt(event.target);
      if (scope) select(scope.id, 'explicit');
    }
  };
  const onKeyUp = () => {
    keyboardNavigation = false;
  };
  const reset = () => {
    generation += 1;
    cancelHover();
    selected = null;
    pointer = null;
    keyboardNavigation = false;
    dragging = false;
    for (const scope of getScopes()) {
      if (scope.element) delete scope.element.dataset.lodyActionActive;
    }
  };
  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget !== null) return;
    pointer = null;
    cancelHover();
    if (selected?.source === 'hover') selected = null;
    paint();
  };
  const onDragStart = () => {
    generation += 1;
    cancelHover();
    dragging = true;
  };
  const onDragEnd = () => {
    dragging = false;
  };
  const onExternalInteraction = (event: Event) => {
    const source = (event as CustomEvent).detail;
    if (source === 'pointer') considerHover(event.target);
    else if (source === 'pointerdown' || source === 'keyboard' || source === 'wheel') {
      deliberateInteraction(event.target);
    } else if (source === 'pointerleave') {
      const scope = scopeAt(event.target);
      if (hover?.id === scope?.id) cancelHover();
      if (selected?.source === 'hover' && selected.id === scope?.id) {
        selected = null;
        paint();
      }
    }
  };

  win.addEventListener('pointermove', onPointer, true);
  win.addEventListener('pointerdown', onPointer, true);
  win.addEventListener('wheel', onWheel, { capture: true, passive: true });
  win.addEventListener('pointerover', onFramePointerOver, true);
  win.addEventListener('pointerout', onPointerOut, true);
  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('keyup', onKeyUp, true);
  win.addEventListener('focusin', onFocus, true);
  win.addEventListener('blur', reset);
  win.addEventListener('dragstart', onDragStart, true);
  win.addEventListener('dragend', onDragEnd, true);
  root.addEventListener(INTERACTION_EVENT, onExternalInteraction);
  // Content updates do not change action ownership. Observe scope/layer
  // boundaries, including ancestor visibility, instead of measuring every commit.
  const boundarySelector =
    '[data-lody-action-scope], [role="dialog"], [role="alertdialog"], ' +
    '[aria-modal], [role="menu"], [role="listbox"]';
  const hasBoundary = (node: Node) =>
    node instanceof win.Element &&
    (node.matches(boundarySelector) || node.querySelector(boundarySelector) !== null);
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === 'attributes'
          ? hasBoundary(record.target)
          : [...record.addedNodes, ...record.removedNodes].some(hasBoundary)
      )
    )
      paint();
  });
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'hidden',
      'inert',
      'aria-hidden',
      'aria-modal',
      'data-state',
      'data-lody-action-scope',
      'class',
      'style',
    ],
  });
  paint();

  return {
    dispatch(action: string): SemanticActionResult {
      if (disposed || blocked()) return 'handled';
      const scope = currentScope();
      // Missing/removed targets and unsupported actions are owned no-ops.
      // Only an explicit target handler may yield to native window close.
      const result = scope?.actions[action]?.() ?? 'handled';
      // An incidental hover/focus fallback cannot escalate to closing a window
      // while another visible surface still owns closeable content.
      if (
        result === 'unhandled' &&
        selected?.source !== 'explicit' &&
        visibleScopes().some((other) => other.id !== scope?.id && other.actions[action])
      ) {
        return 'handled';
      }
      return result;
    },
    activate(id: string) {
      if (!disposed) select(id, 'explicit');
    },
    /** Complete an async user action only if no newer input/reset superseded it. */
    deferActivation(id: string) {
      const requestedGeneration = ++generation;
      cancelHover();
      return () => {
        if (!disposed && generation === requestedGeneration) select(id, 'explicit');
      };
    },
    refresh: paint,
    dispose() {
      disposed = true;
      observer.disconnect();
      win.removeEventListener('pointermove', onPointer, true);
      win.removeEventListener('pointerdown', onPointer, true);
      win.removeEventListener('wheel', onWheel, true);
      win.removeEventListener('pointerover', onFramePointerOver, true);
      win.removeEventListener('pointerout', onPointerOut, true);
      win.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('keyup', onKeyUp, true);
      win.removeEventListener('focusin', onFocus, true);
      win.removeEventListener('blur', reset);
      win.removeEventListener('dragstart', onDragStart, true);
      win.removeEventListener('dragend', onDragEnd, true);
      root.removeEventListener(INTERACTION_EVENT, onExternalInteraction);
      reset();
    },
  };
}

export type SemanticActionRouter = ReturnType<typeof createSemanticActionRouter>;
