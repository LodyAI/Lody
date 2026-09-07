import { useEffect, useRef, type RefObject } from 'react';
import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';

/**
 * Keyboard control over the desktop chat landing's config + composer column.
 *
 * The surface is a vertical stack of option controls (machine / context / project /
 * branch / model / mode / fast / agent / permission pickers, toggles, the send button)
 * with a text composer. This hook makes every option reachable without the mouse:
 *
 *   - Arrow keys do 2D spatial navigation: ↑/↓ move between rows (nearest column),
 *     ←/→ move within a row, then yield at the horizontal edge so the shell can switch
 *     FocusScope. The highlight follows the real layout because we focus the actual
 *     element and mirror it onto `[data-qs-active]`. Arrows ONLY act when focus is
 *     already inside `rootRef`, so they never hijack the sidebar / page.
 *   - Esc steps out: from the composer → onto the first option (focus-move mode); from
 *     an option → blur + clear the highlight (exit focus-move mode entirely). After that
 *     exit, an arrow key re-enters focus-move mode (landing back on the option you left),
 *     so the ring is never a dead end.
 *   - Tab stays native so focus can leave the config area.
 *   - Space / Enter are left to the focused control's native activation — a picker opens
 *     its dropdown, whose own ↑/↓/Enter/Esc take over (we yield all keys while any
 *     control reports `aria-expanded="true"`).
 *   - The composer textarea is NOT part of the arrow ring (arrows edit text there); it
 *     is reached via the ⌘L `session.focusInput` command (a toggle: focus / exit).
 *
 * Scoped to `rootRef` and only active when `enabled`, so mobile/touch is untouched.
 */

type Direction = 'up' | 'down' | 'left' | 'right';

const ARROW_DIRECTION: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** Visible, enabled controls that participate in navigation, in DOM order. */
function collectOptions(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>('button, [role="tab"]');
  return Array.from(nodes).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.dataset.qsSkip === 'true') return false;
    // Options inside an open dropdown panel are owned by the picker's own handler.
    if (el.closest('[role="listbox"], [role="menu"]')) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

const centerX = (el: HTMLElement): number => {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
};
const centerY = (el: HTMLElement): number => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

/** Pick the spatial neighbor of `current` in `direction`, or null if none. */
function spatialNeighbor(
  current: HTMLElement,
  options: HTMLElement[],
  direction: Direction
): HTMLElement | null {
  const cx = centerX(current);
  const cy = centerY(current);
  const others = options.filter((el) => el !== current);
  // Two centers within this many px count as the same row.
  const rowBand = Math.max(16, current.getBoundingClientRect().height * 0.6);

  if (direction === 'left' || direction === 'right') {
    const sameRow = others.filter((el) => Math.abs(centerY(el) - cy) <= rowBand);
    const inDir = sameRow.filter((el) =>
      direction === 'right' ? centerX(el) > cx + 1 : centerX(el) < cx - 1
    );
    if (inDir.length === 0) return null;
    return inDir.reduce((best, el) =>
      Math.abs(centerX(el) - cx) < Math.abs(centerX(best) - cx) ? el : best
    );
  }

  // up / down: jump to the nearest row in that direction, then nearest column.
  const inDir = others.filter((el) =>
    direction === 'down' ? centerY(el) > cy + 1 : centerY(el) < cy - 1
  );
  if (inDir.length === 0) return null;
  const targetY =
    direction === 'down' ? Math.min(...inDir.map(centerY)) : Math.max(...inDir.map(centerY));
  const targetRow = inDir.filter((el) => Math.abs(centerY(el) - targetY) <= rowBand);
  return targetRow.reduce((best, el) =>
    Math.abs(centerX(el) - cx) < Math.abs(centerX(best) - cx) ? el : best
  );
}

/** Index of the first option that follows `el` in DOM order (for Tab from outside the ring). */
function firstOptionAfter(el: Element | null, options: HTMLElement[]): number {
  if (!el) return 0;
  for (let i = 0; i < options.length; i++) {
    const pos = el.compareDocumentPosition(options[i]!);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return i;
  }
  return 0;
}

function focusChatLandingOption(el: HTMLElement): void {
  el.focus();
  // The hook owns arrow navigation in capture phase, so Radix Tabs never sees its
  // own ArrowLeft/ArrowRight handler. Activating focused tabs keeps Local/GitHub/Chat
  // selectable from keyboard mode without auto-clicking ordinary picker buttons.
  if (el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') !== 'true') {
    el.click();
  }
}

/**
 * Move focus out of the composer into the option ring — used by ⌘L (toggle) and Esc
 * to leave the textarea's focus mode. Lands on the first option after `anchor` in DOM
 * order (matching Tab-out), falling back to the first option. Returns false if there
 * is nothing to focus (so the caller can leave the textarea as-is).
 */
export function focusFirstChatLandingOption(
  root: HTMLElement | null,
  anchor?: Element | null
): boolean {
  if (!root) return false;
  const options = collectOptions(root);
  if (options.length === 0) return false;
  const index = anchor ? Math.max(0, firstOptionAfter(anchor, options)) : 0;
  const option = options[index];
  if (option) focusChatLandingOption(option);
  return true;
}

export function useChatLandingKeyboardNav(
  rootRef: RefObject<HTMLElement | null>,
  { enabled }: { enabled: boolean }
): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // After Esc-exits focus-move mode (option → blur to <body>), an arrow key re-enters
  // it. We arm on that exit and remember the option to land back on. Kept out of the
  // armed state, arrows are never hijacked from the page/sidebar.
  const reentryArmedRef = useRef(false);
  const lastOptionRef = useRef<HTMLElement | null>(null);
  // Whether the most recent interaction was via keyboard. The big [data-qs-active]
  // focus ring is keyboard-only: a mouse click that focuses a control must NOT light
  // it up (pointer users find the extra border confusing). This mirrors the browser's
  // :focus-visible heuristic, which the [data-qs-active] highlight deliberately bypasses.
  const keyboardModalityRef = useRef(false);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof window === 'undefined') return undefined;

    // Mirror the focused option onto [data-qs-active] so the highlight is consistent
    // across controls, independent of each control's own :focus-visible heuristics —
    // but ONLY for keyboard-driven focus. A mouse click focuses its control natively
    // without the big ring, so pointer users never see the keyboard-mode border.
    const syncHighlight = () => {
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      const showRing = keyboardModalityRef.current;
      for (const option of collectOptions(root)) {
        if (option === active) {
          // Remember the live option (keyboard or mouse focus) so re-entry can land
          // back on it — but only paint the ring when the user is on the keyboard.
          lastOptionRef.current = option;
          if (showRing) option.setAttribute('data-qs-active', 'true');
          else option.removeAttribute('data-qs-active');
        } else option.removeAttribute('data-qs-active');
      }
    };

    const focusOption = (el: HTMLElement) => {
      // focusOption is only ever called from the keyboard handlers below.
      keyboardModalityRef.current = true;
      focusChatLandingOption(el);
      syncHighlight();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // Esc belongs to the IME while it is cancelling a preedit; do not turn
      // that same keydown into a focus-mode transition.
      if (isImeComposingNativeKeyboardEvent(event)) return;
      // A key press means the user is driving with the keyboard, so the focus ring may
      // show; a pointerdown flips this back off. Covers native Tab and ⌘L too (they
      // move focus via focusin, not focusOption).
      keyboardModalityRef.current = true;
      const root = rootRef.current;
      if (!root) return;
      // A picker/menu dropdown is open: it owns arrows / Enter / Esc.
      const dropdownOpen = root.querySelector('[aria-expanded="true"]') !== null;
      const active = document.activeElement as HTMLElement | null;
      const inTextField =
        !!active &&
        (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);

      // Esc steps out of the current keyboard mode (when a picker dropdown is open it
      // owns Esc to close itself; we yielded above):
      //   - in the composer → exit input mode onto the first option (focus-move mode);
      //   - on a focused option → exit focus-move mode entirely (blur + drop highlight).
      if (event.key === 'Escape') {
        if (dropdownOpen) return;
        if (!active || !root.contains(active)) return;
        const options = collectOptions(root);
        if (active.tagName === 'TEXTAREA') {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (options.length > 0) {
            focusOption(options[Math.max(0, firstOptionAfter(active, options))]!);
          } else {
            active.blur();
          }
          return;
        }
        if (options.includes(active)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          lastOptionRef.current = active;
          active.blur();
          // Arm re-entry: the next arrow key (while focus is back on <body>) wakes the
          // option ring up again instead of doing nothing.
          reentryArmedRef.current = true;
          syncHighlight(); // activeElement is now <body> → clears every [data-qs-active]
        }
        return;
      }

      const direction = ARROW_DIRECTION[event.key];
      if (!direction) return;
      if (dropdownOpen) return;
      if (inTextField) return; // arrows edit text inside the composer / search

      if (!active || !root.contains(active)) {
        // Focus left the nav scope. Re-enter focus-move mode only when the user just
        // Esc-exited it (armed) and focus is back on <body> — so arrows "wake" the ring
        // back up. Otherwise stay hands-off: never hijack arrows meant for the sidebar /
        // rest of the page (the chat landing shares the page).
        const onBody = !active || active === document.body;
        if (reentryArmedRef.current && onBody) {
          const options = collectOptions(root);
          if (options.length > 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            reentryArmedRef.current = false;
            const remembered =
              lastOptionRef.current && options.includes(lastOptionRef.current)
                ? lastOptionRef.current
                : options[0]!;
            focusOption(remembered);
          }
        }
        return;
      }

      const options = collectOptions(root);
      if (options.length === 0) return;

      if (!options.includes(active)) {
        // Focus is in the scope but not on a ring option yet — enter at the first option.
        event.preventDefault();
        event.stopImmediatePropagation();
        focusOption(options[0]!);
        return;
      }

      const neighbor = spatialNeighbor(active, options, direction);
      if (neighbor) {
        event.preventDefault();
        event.stopImmediatePropagation();
        focusOption(neighbor);
      } else if (direction === 'up' || direction === 'down') {
        // Vertical boundaries stay inside this 2D list. Horizontal boundaries
        // deliberately yield so the shell can switch FocusScope.
        event.preventDefault();
      }
    };

    // A pointer interaction switches off keyboard modality BEFORE the click's focusin
    // fires (pointerdown is dispatched first), so a mouse-focused control never gets
    // the ring. Capture phase so nothing can swallow it first.
    const onPointerDown = () => {
      keyboardModalityRef.current = false;
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('focusin', syncHighlight);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('focusin', syncHighlight);
    };
  }, [enabled, rootRef]);
}
