import * as React from 'react';
import { flushSync } from 'react-dom';

/**
 * Deferred mounting for interaction-only overlays inside long lists.
 *
 * A conversation row carries a handful of tooltips, popovers and context menus
 * that only matter on hover, focus or click, yet each one mounts 6-7 Radix
 * components with the row. Inside an unarmed boundary the shared `Tooltip`,
 * `Popover` and `ContextMenu` primitives render only their trigger element
 * (props merged exactly as `asChild` would) and no content. The boundary arms
 * on the first pointer entry or focus, which always precedes an interaction
 * with anything inside it, and the real primitives mount then.
 *
 * Outside a boundary the context is armed, so every other surface is unchanged.
 */
const InteractionArmedContext = React.createContext(true);

export function useInteractionArmed(): boolean {
  return React.useContext(InteractionArmedContext);
}

/** Re-arms a subtree (for example an overlay forced open while its row is not). */
export const InteractionArmedProvider = InteractionArmedContext.Provider;

// Touch has no hover: a tap would arm and be lost to the remount in one go.
function prefersEagerMount(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: none), (pointer: coarse)').matches;
}

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Arms on the first pointer entry or keyboard focus into the element the
 * returned handlers are spread on. Arming remounts the triggers inside (they
 * gain their Radix wrappers), so it must never land inside a press: Chromium
 * drops the click when the pressed node is replaced before pointerup.
 *
 * - Pointer entry commits synchronously. React schedules a `pointerenter`
 *   update at continuous priority, which can otherwise commit between the
 *   pointerdown and pointerup of an immediate click.
 * - A press that starts on an unarmed boundary (no entry seen, for example a
 *   row scrolled under a still pointer) keeps the plain trigger: its focus does
 *   not arm, and arming waits until the press and its click are dispatched.
 * - A keyboard focus that arms the boundary is handed back to the same trigger,
 *   found by its position among the focusable elements.
 */
export function useInteractionArm(): {
  armed: boolean;
  armHandlers: {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => void;
    onFocusCapture: (event: React.FocusEvent<HTMLElement>) => void;
  };
} {
  const [armed, setArmed] = React.useState(prefersEagerMount);
  const armedRef = React.useRef(armed);
  armedRef.current = armed;
  const pressingRef = React.useRef(false);
  const pendingFocusRef = React.useRef<{ root: HTMLElement; index: number } | null>(null);

  const onPointerEnter = React.useCallback(() => {
    if (armedRef.current || pressingRef.current) return;
    armedRef.current = true;
    flushSync(() => setArmed(true));
  }, []);

  const onPointerDownCapture = React.useCallback(() => {
    if (armedRef.current || pressingRef.current) return;
    pressingRef.current = true;
    const view = window;
    const release = () => {
      view.removeEventListener('pointerup', release, true);
      view.removeEventListener('pointercancel', release, true);
      // The click follows pointerup in the same dispatch; arm in a later task.
      view.setTimeout(() => {
        pressingRef.current = false;
        setArmed(true);
      }, 0);
    };
    view.addEventListener('pointerup', release, true);
    view.addEventListener('pointercancel', release, true);
  }, []);

  const onFocusCapture = React.useCallback((event: React.FocusEvent<HTMLElement>) => {
    if (armedRef.current || pressingRef.current) return;
    const root = event.currentTarget;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    pendingFocusRef.current = { root, index: focusables.indexOf(event.target as HTMLElement) };
    armedRef.current = true;
    setArmed(true);
  }, []);

  React.useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (!armed || !pending || pending.index < 0) return;
    const active = document.activeElement;
    if (active && active !== document.body && pending.root.contains(active)) return;
    pending.root.querySelectorAll<HTMLElement>(FOCUSABLE)[pending.index]?.focus({
      preventScroll: true,
    });
  }, [armed]);

  return { armed, armHandlers: { onPointerEnter, onPointerDownCapture, onFocusCapture } };
}
