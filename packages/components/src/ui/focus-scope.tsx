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
      const itemSelector = optionsRef.current.itemSelector ?? DEFAULT_ITEM_SELECTOR;
      const items = getScopeItems(root, itemSelector);
      if (items.length === 0) return;

      const active = document.activeElement;
      const current =
        active instanceof HTMLElement ? active.closest<HTMLElement>(itemSelector) : null;
      const currentIndex = current ? items.indexOf(current) : -1;
      let nextIndex: number;

      switch (event.key) {
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
          return;
      }

      if (optionsRef.current.loop !== false) {
        nextIndex = (nextIndex + items.length) % items.length;
      } else {
        nextIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
      }

      event.preventDefault();
      const next = items[nextIndex];
      if (!next) return;
      focusScopeItem(options.scopeId, next);
      optionsRef.current.onItemFocus?.(next);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeScopeId, options.enabled, options.scopeId]);
}

/** Switches between visible sibling/leaf scopes with Left and Right. Mount once. */
export function useFocusScopeSwitcher(options: { enabled?: boolean } = {}): void {
  const activeScopeId = useAtomValue(activeFocusScopeAtom);
  const setActiveScopeId = useSetAtom(activeFocusScopeAtom);

  useEffect(() => {
    if (options.enabled === false || typeof window === 'undefined') return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !activeScopeId) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (isImeComposingNativeKeyboardEvent(event) || isTextInput(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      const activeRoot = getScopeRoot(activeScopeId);
      if (!activeRoot || !eventBelongsToScope(event, activeRoot)) return;

      const activeLayer = scopeLayer(activeRoot);
      const visible = getScopeRoots().filter((scope) => scopeLayer(scope) === activeLayer);
      const scopes = visible.filter(
        (scope) => !visible.some((candidate) => candidate !== scope && scope.contains(candidate))
      );
      const currentIndex = scopes.indexOf(activeRoot);
      if (currentIndex < 0) return;
      const nextIndex = currentIndex + (event.key === 'ArrowRight' ? 1 : -1);
      const nextScope = scopes[nextIndex];
      if (!nextScope) return;

      event.preventDefault();
      const nextScopeId = nextScope.dataset.focusScope;
      if (!nextScopeId) return;
      setActiveScopeId(nextScopeId);

      const items = getScopeItems(nextScope, DEFAULT_ITEM_SELECTOR);
      const remembered = lastFocusedItemByScope.get(nextScopeId);
      if (
        remembered &&
        (items.includes(remembered.element) || isUsableFocusTarget(nextScope, remembered.element))
      ) {
        focusScopeItem(nextScopeId, remembered.element);
        return;
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
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeScopeId, options.enabled, setActiveScopeId]);
}
