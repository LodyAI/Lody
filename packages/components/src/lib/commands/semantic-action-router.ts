import { matchesKeyboardEvent } from './key-matcher';

export type SemanticActionResult = 'handled' | 'unhandled';

const INTERACTION_EVENT = 'lody:semantic-action-interaction';

export function reportSemanticActionInteraction(
  element: HTMLElement,
  source: 'pointer' | 'keyboard'
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
  let selected: { id: string; source: 'pointer' | 'keyboard' | 'explicit' } | null = null;
  let pointer: { x: number; y: number } | null = null;
  let keyboardNavigation = false;
  let dragging = false;
  let disposed = false;

  const visibleScopes = () =>
    getScopes().filter((scope) => scope.element && isVisible(scope.element));
  const blocked = () =>
    Array.from(doc.querySelectorAll<HTMLElement>(BLOCKING_LAYER_SELECTOR)).some(isVisible);
  const scopeAt = (target: EventTarget | null) => {
    if (!(target instanceof win.Node)) return undefined;
    return visibleScopes()
      .filter((scope) => scope.element!.contains(target))
      .find(
        (scope, _, scopes) =>
          !scopes.some((child) => child !== scope && scope.element!.contains(child.element))
      );
  };
  const currentScope = () => {
    const scopes = visibleScopes();
    const id = selected?.id;
    if (id) return scopes.find((scope) => scope.id === id);
    return scopeAt(doc.activeElement) ?? scopes.find((scope) => scope.id === defaultScopeId);
  };
  const paint = () => {
    const current = blocked() ? undefined : currentScope();
    for (const scope of getScopes()) {
      if (scope.element) {
        if (scope.id === current?.id) scope.element.dataset.lodyActionActive = 'true';
        else delete scope.element.dataset.lodyActionActive;
      }
    }
  };
  const select = (id: string, source: NonNullable<typeof selected>['source']) => {
    selected = { id, source };
    paint();
  };
  const onPointer = (event: PointerEvent) => {
    const moved = !pointer || pointer.x !== event.clientX || pointer.y !== event.clientY;
    pointer = { x: event.clientX, y: event.clientY };
    keyboardNavigation = false;
    if (dragging || blocked() || (event.type !== 'pointerdown' && (event.buttons !== 0 || !moved)))
      return;
    const scope = scopeAt(event.target);
    if (scope) select(scope.id, 'pointer');
    else if (selected?.source === 'pointer') {
      selected = null;
      paint();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Native close may also reach the renderer. It must not retarget to the
    // old text caret after the pointer has selected another surface.
    if (matchesKeyboardEvent(event, 'Mod+w')) return;
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
    keyboardNavigation = event.key === 'Tab' || event.key.startsWith('Arrow');
    if (blocked()) return;
    const scope = scopeAt(event.target);
    if (scope) select(scope.id, 'keyboard');
  };
  const onFramePointerOver = (event: PointerEvent) => {
    // Chromium sends pointerover to the iframe element, but pointermove inside
    // a cross-origin frame never reaches this document.
    if (event.target instanceof win.HTMLIFrameElement && event.buttons === 0) onPointer(event);
  };
  const onFocus = (event: FocusEvent) => {
    if (blocked()) return;
    if (keyboardNavigation || !selected) {
      const scope = scopeAt(event.target);
      if (scope) select(scope.id, 'keyboard');
    }
  };
  const onKeyUp = () => {
    keyboardNavigation = false;
  };
  const reset = () => {
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
    if (selected?.source === 'pointer') selected = null;
    paint();
  };
  const onDragStart = () => {
    dragging = true;
  };
  const onDragEnd = () => {
    dragging = false;
  };
  const onExternalInteraction = (event: Event) => {
    if (blocked() || dragging) return;
    const source = (event as CustomEvent).detail;
    if (source !== 'pointer' && source !== 'keyboard') return;
    const scope = scopeAt(event.target);
    if (scope) select(scope.id, source);
  };

  win.addEventListener('pointermove', onPointer, true);
  win.addEventListener('pointerdown', onPointer, true);
  win.addEventListener('pointerover', onFramePointerOver, true);
  win.addEventListener('pointerout', onPointerOut, true);
  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('keyup', onKeyUp, true);
  win.addEventListener('focusin', onFocus, true);
  win.addEventListener('blur', reset);
  win.addEventListener('dragstart', onDragStart, true);
  win.addEventListener('dragend', onDragEnd, true);
  root.addEventListener(INTERACTION_EVENT, onExternalInteraction);
  // Modal/menu transitions also update the cue without waiting for input.
  const observer = new MutationObserver(paint);
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-modal', 'data-state'],
  });
  paint();

  return {
    dispatch(action: string): SemanticActionResult {
      if (disposed || blocked()) return 'handled';
      const scope = currentScope();
      // Missing/removed targets and unsupported actions are owned no-ops.
      // Only an explicit target handler may yield to native window close.
      return scope?.actions[action]?.() ?? 'handled';
    },
    activate(id: string) {
      if (!disposed) select(id, 'explicit');
    },
    refresh: paint,
    dispose() {
      disposed = true;
      observer.disconnect();
      win.removeEventListener('pointermove', onPointer, true);
      win.removeEventListener('pointerdown', onPointer, true);
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
