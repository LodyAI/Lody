import {
  forwardRef,
  useEffect,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';

const activeFocusScopeAtom = atom<string | null>(null);
const lastFocusedItemByScope = new Map<string, { element: HTMLElement; id: string | null }>();

/**
 * A scope's registered list navigation, keyed by scope id. `FocusScope` reads it
 * to move within the scope on its own React `onKeyDown`: a dialog popup stops
 * composite keys (arrows, Home, End) at the portal edge, so a window listener
 * never sees them inside one — the scope element's synthetic handler still does.
 */
const listNavByScope = new Map<string, { current: ListNavigationOptions }>();
/** How many mounted `useFocusScopeSwitcher` calls — the switcher runs wherever a scope sees Left/Right. */
let scopeSwitcherSubscriptions = 0;

const DEFAULT_ITEM_SELECTOR = '[data-scope-item]';
const OPEN_LAYER_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.closest('[aria-hidden="true"]')) return false;
  const checkVisibility = (
    element as HTMLElement & {
      checkVisibility?: (options?: {
        checkOpacity?: boolean;
        checkVisibilityCSS?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  return typeof checkVisibility === 'function'
    ? checkVisibility.call(element, { checkOpacity: true, checkVisibilityCSS: true })
    : element.offsetParent !== null;
}

function getScopeRoots(scopeId?: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-focus-scope]')).filter(
    (element) => (!scopeId || element.dataset.focusScope === scopeId) && isVisible(element)
  );
}

function getScopeRoot(scopeId: string): HTMLElement | null {
  const roots = getScopeRoots(scopeId);
  const active = document.activeElement;
  return roots.find((root) => active instanceof Node && root.contains(active)) ?? roots[0] ?? null;
}

function getScopeItems(root: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (item) =>
      item.closest('[data-focus-scope]') === root &&
      item.getAttribute('aria-disabled') !== 'true' &&
      !item.hasAttribute('disabled') &&
      (item.matches(FOCUSABLE_SELECTOR) || item.querySelector(FOCUSABLE_SELECTOR) !== null) &&
      isVisible(item)
  );
}

function isUsableFocusTarget(root: HTMLElement, target: HTMLElement): boolean {
  return (
    target.isConnected &&
    target.closest('[data-focus-scope]') === root &&
    target.getAttribute('aria-disabled') !== 'true' &&
    !target.hasAttribute('disabled') &&
    target.matches(FOCUSABLE_SELECTOR) &&
    isVisible(target)
  );
}

function rememberScopeItem(scopeId: string, item: HTMLElement): void {
  lastFocusedItemByScope.set(scopeId, {
    element: item,
    id: item.getAttribute('data-id'),
  });
}

function focusScopeItem(scopeId: string, item: HTMLElement): void {
  const target = item.matches(FOCUSABLE_SELECTOR)
    ? item
    : item.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  if (!target) return;
  target.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  rememberScopeItem(scopeId, item);
}

function eventBelongsToScope(event: KeyboardEvent, root: HTMLElement): boolean {
  const target = event.target;
  return !(target instanceof Node) || target === document.body || root.contains(target);
}

function scopeLayer(root: HTMLElement): HTMLElement | null {
  return root.closest<HTMLElement>(OPEN_LAYER_SELECTOR);
}

interface ListNavigationOptions {
  enabled?: boolean;
  itemSelector?: string;
  loop?: boolean;
  onItemFocus?: (item: HTMLElement) => void;
}

/**
 * Moves through a scope's items on one list-navigation key. Shared by the
 * window listener (events whose target sits outside every scope) and the scope
 * element's own key handler (which a dialog's composite-key stop cannot reach).
 */
function moveWithinScope(
  scopeId: string,
  root: HTMLElement,
  key: string,
  options: ListNavigationOptions
): boolean {
  const itemSelector = options.itemSelector ?? DEFAULT_ITEM_SELECTOR;
  const items = getScopeItems(root, itemSelector);
  if (items.length === 0) return false;

  const active = document.activeElement;
  const current = active instanceof HTMLElement ? active.closest<HTMLElement>(itemSelector) : null;
  const currentIndex = current ? items.indexOf(current) : -1;
  let nextIndex: number;

  switch (key) {
    case 'ArrowDown':
    case 'j':
      nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
      break;
    case 'ArrowUp':
    case 'k':
      nextIndex = currentIndex < 0 ? items.length - 1 : currentIndex - 1;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = items.length - 1;
      break;
    default:
      return false;
  }

  if (options.loop !== false) {
    nextIndex = (nextIndex + items.length) % items.length;
  } else {
    nextIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
  }

  const next = items[nextIndex];
  if (!next) return false;
  focusScopeItem(scopeId, next);
  options.onItemFocus?.(next);
  return true;
}

/**
 * The scope switch itself, shared between the window listener and the scope
 * element that saw Left/Right inside a dialog. `sourceRoot` is the scope the
 * event belongs to — the element handler, or the active scope at window level.
 */
function switchFocusScope(
  sourceRoot: HTMLElement,
  key: 'ArrowLeft' | 'ArrowRight',
  setActiveScopeId: (id: string | null) => void
): boolean {
  const sourceLayer = scopeLayer(sourceRoot);
  const visible = getScopeRoots().filter((scope) => scopeLayer(scope) === sourceLayer);
  const scopes = visible.filter(
    (scope) => !visible.some((candidate) => candidate !== scope && scope.contains(candidate))
  );
  const currentIndex = scopes.indexOf(sourceRoot);
  if (currentIndex < 0) return false;
  const nextScope = scopes[currentIndex + (key === 'ArrowRight' ? 1 : -1)];
  if (!nextScope) return false;
  const nextScopeId = nextScope.dataset.focusScope;
  if (!nextScopeId) return false;
  setActiveScopeId(nextScopeId);

  const items = getScopeItems(nextScope, DEFAULT_ITEM_SELECTOR);
  const remembered = lastFocusedItemByScope.get(nextScopeId);
  if (
    remembered &&
    (items.includes(remembered.element) || isUsableFocusTarget(nextScope, remembered.element))
  ) {
    focusScopeItem(nextScopeId, remembered.element);
    return true;
  }

  const restored = remembered?.id
    ? items.find((item) => item.getAttribute('data-id') === remembered.id)
    : null;
  const current = items.find((item) => {
    const value = item.getAttribute('aria-current');
    return (
      (value !== null && value !== 'false') ||
      item.getAttribute('aria-selected') === 'true' ||
      item.getAttribute('aria-pressed') === 'true'
    );
  });
  if (restored ?? current ?? items[0]) {
    focusScopeItem(nextScopeId, restored ?? current ?? items[0]!);
  } else {
    nextScope.focus({ preventScroll: true });
    nextScope.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  return true;
}

/**
 * A scope element's own key handling. It runs as a React handler on the scope
 * root — after controls inside it, so their first refusal is kept — and before
 * an enclosing dialog popup's composite-key `stopPropagation`, which is why it
 * sees arrow keys the window listeners never will.
 */
function handleScopeKeyNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  scopeId: string,
  root: HTMLElement,
  setActiveScopeId: (id: string | null) => void
): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (isImeComposingNativeKeyboardEvent(event.nativeEvent) || isTextInput(event.target)) return;
  // The event may belong to a nested scope, whose own handler already ran.
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest('[data-focus-scope]') !== root) return;

  const nav = listNavByScope.get(scopeId);
  if (
    nav &&
    nav.current.enabled !== false &&
    moveWithinScope(scopeId, root, event.key, nav.current)
  ) {
    event.preventDefault();
    return;
  }
  if (
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
    scopeSwitcherSubscriptions > 0 &&
    switchFocusScope(root, event.key, setActiveScopeId)
  ) {
    event.preventDefault();
  }
}

export interface FocusScopeProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
}

/** Marks a DOM subtree as one independently navigable keyboard region. */
export const FocusScope = forwardRef<HTMLDivElement, FocusScopeProps>(function FocusScope(
  { id, onFocusCapture, onKeyDown, onPointerDownCapture, ...props },
  forwardedRef
) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const activeScopeId = useAtomValue(activeFocusScopeAtom);
  const setActiveScopeId = useSetAtom(activeFocusScopeAtom);

  useEffect(
    () => () => {
      lastFocusedItemByScope.delete(id);
      setActiveScopeId((current) => (current === id ? null : current));
    },
    [id, setActiveScopeId]
  );

  const activate = (target: EventTarget | null) => {
    setActiveScopeId(id);
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLElement>(DEFAULT_ITEM_SELECTOR);
    if (item?.closest('[data-focus-scope]') === localRef.current) {
      rememberScopeItem(id, item);
      return;
    }
    const focusable = target.closest<HTMLElement>(FOCUSABLE_SELECTOR);
    if (
      localRef.current &&
      focusable &&
      focusable !== localRef.current &&
      isUsableFocusTarget(localRef.current, focusable)
    ) {
      rememberScopeItem(id, focusable);
    }
  };

  return (
    <div
      {...props}
      ref={(node) => {
        localRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      data-focus-scope={id}
      data-scope-active={import.meta.env.DEV && activeScopeId === id ? '' : undefined}
      tabIndex={props.tabIndex ?? -1}
      onFocusCapture={(event) => {
        onFocusCapture?.(event);
        activate(event.target);
      }}
      onPointerDownCapture={(event) => {
        onPointerDownCapture?.(event);
        activate(event.target);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && localRef.current) {
          handleScopeKeyNavigation(event, id, localRef.current, setActiveScopeId);
        }
        if (
          !event.defaultPrevented &&
          event.key === 'Escape' &&
          !isImeComposingNativeKeyboardEvent(event.nativeEvent)
        ) {
          setActiveScopeId(null);
        }
      }}
    />
  );
});

export function useFocusScopeActive(scopeId: string): boolean {
  return useAtomValue(activeFocusScopeAtom) === scopeId;
}

/**
 * Moves through the visible items owned by one active scope. Local controls get
 * first refusal: handled events and text inputs are never intercepted.
 */
export function useListKeyboardNavigation(options: {
  scopeId: string;
  enabled?: boolean;
  itemSelector?: string;
  loop?: boolean;
  onItemFocus?: (item: HTMLElement) => void;
}): void {
  const activeScopeId = useAtomValue(activeFocusScopeAtom);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // The scope element handles keys that belong to it; this registration is what
  // it looks up. The window listener below stays for the rest (a press landing
  // on the document body while a scope is active).
  useEffect(() => {
    listNavByScope.set(options.scopeId, optionsRef);
    return () => {
      if (listNavByScope.get(options.scopeId) === optionsRef) {
        listNavByScope.delete(options.scopeId);
      }
    };
  }, [options.scopeId]);

  useEffect(() => {
    if (options.enabled === false || typeof window === 'undefined') return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (activeScopeId && activeScopeId !== options.scopeId) return;
      if (isImeComposingNativeKeyboardEvent(event) || isTextInput(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      const root = getScopeRoot(options.scopeId);
      if (!root || !eventBelongsToScope(event, root)) return;
      if (!activeScopeId && !root.contains(document.activeElement)) return;
      if (moveWithinScope(options.scopeId, root, event.key, optionsRef.current)) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeScopeId, options.enabled, options.scopeId]);
}

/** Switches between visible sibling/leaf scopes with Left and Right. Mount once. */
export function useFocusScopeSwitcher(options: { enabled?: boolean } = {}): void {
  const activeScopeId = useAtomValue(activeFocusScopeAtom);
  const setActiveScopeId = useSetAtom(activeFocusScopeAtom);

  // While a switcher is mounted, scope elements run it on their own Left/Right;
  // a dialog popup would otherwise stop those keys before this listener.
  useEffect(() => {
    if (options.enabled === false) return undefined;
    scopeSwitcherSubscriptions += 1;
    return () => {
      scopeSwitcherSubscriptions -= 1;
    };
  }, [options.enabled]);

  useEffect(() => {
    if (options.enabled === false || typeof window === 'undefined') return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !activeScopeId) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (isImeComposingNativeKeyboardEvent(event) || isTextInput(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      const activeRoot = getScopeRoot(activeScopeId);
      if (!activeRoot || !eventBelongsToScope(event, activeRoot)) return;
      if (switchFocusScope(activeRoot, event.key, setActiveScopeId)) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeScopeId, options.enabled, setActiveScopeId]);
}
