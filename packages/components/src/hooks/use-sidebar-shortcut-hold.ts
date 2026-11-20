import { useEffect, useRef } from 'react';
import { useStore } from 'jotai';
import {
  SIDEBAR_SHORTCUT_HOLD_DELAY_MS,
  resolvedSidebarShortcutPlatformAtom,
  sidebarShortcutOverlayActiveAtom,
  type SidebarShortcutPlatform,
} from '@/atoms/sidebar-shortcuts';

export type UseSidebarShortcutHoldOptions = {
  /** Whether modifier-hold detection is enabled (e.g. disabled on mobile). */
  enabled: boolean;
  /** Optional hold threshold before pills appear. Defaults to 150ms. */
  holdDelayMs?: number;
  /** Optional runtime guard checked on press and reveal (e.g. sidebar visible, no popup open). */
  canReveal?: () => boolean;
};

function isTargetModifierKey(key: string, platform: SidebarShortcutPlatform): boolean {
  return platform === 'mac' ? key === 'Meta' : key === 'Control';
}

function isTargetModifierPressed(event: KeyboardEvent, platform: SidebarShortcutPlatform): boolean {
  return platform === 'mac'
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

function hasDisallowedExtraModifier(
  event: KeyboardEvent,
  platform: SidebarShortcutPlatform
): boolean {
  return platform === 'mac'
    ? event.ctrlKey || event.altKey || event.shiftKey
    : event.metaKey || event.altKey || event.shiftKey;
}

function isDigitOneToNine(event: KeyboardEvent): boolean {
  return /^[1-9]$/.test(event.key) || /^Digit[1-9]$/.test(event.code);
}

/**
 * Shows the sidebar's `1–9` shortcut pills after the platform's primary
 * modifier (`Command` on macOS, `Control` on Windows/Linux) is held for
 * `holdDelayMs`, suppressing transient flashes during fast chords like `Cmd+K`.
 */
export function useSidebarShortcutHold({
  enabled,
  holdDelayMs = SIDEBAR_SHORTCUT_HOLD_DELAY_MS,
  canReveal,
}: UseSidebarShortcutHoldOptions): void {
  const store = useStore();
  const canRevealRef = useRef(canReveal);
  canRevealRef.current = canReveal;

  useEffect(() => {
    const setOverlayActive = (next: boolean) => {
      if (store.get(sidebarShortcutOverlayActiveAtom) !== next) {
        store.set(sidebarShortcutOverlayActiveAtom, next);
      }
    };

    if (!enabled || typeof window === 'undefined') {
      setOverlayActive(false);
      return undefined;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const reset = () => {
      clearTimer();
      setOverlayActive(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const platform = store.get(resolvedSidebarShortcutPlatformAtom);
      const isActive = store.get(sidebarShortcutOverlayActiveAtom);

      if (isTargetModifierKey(event.key, platform)) {
        if (hasDisallowedExtraModifier(event, platform)) {
          reset();
          return;
        }
        if (event.repeat || isActive || timer !== null) return;
        if (canRevealRef.current && !canRevealRef.current()) return;

        timer = setTimeout(() => {
          timer = null;
          if (canRevealRef.current && !canRevealRef.current()) {
            setOverlayActive(false);
            return;
          }
          setOverlayActive(true);
        }, holdDelayMs);
        return;
      }

      // While already visible, allow pressing 1–9 with the target modifier held
      // without dismissing the pills; any other key (e.g. Cmd+K, Escape) hides them.
      if (isActive) {
        if (isDigitOneToNine(event) && isTargetModifierPressed(event, platform)) {
          return;
        }
        reset();
        return;
      }

      // Any other key pressed during the hold delay cancels reveal so fast
      // chords (Cmd+C, Cmd+K, quick Cmd+1) never flash the pills.
      if (timer !== null) {
        clearTimer();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const platform = store.get(resolvedSidebarShortcutPlatformAtom);
      const modifierStillHeld = platform === 'mac' ? event.metaKey : event.ctrlKey;
      if (isTargetModifierKey(event.key, platform) || !modifierStillHeld) {
        reset();
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) reset();
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', reset);
    window.addEventListener('contextmenu', reset);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      reset();
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', reset);
      window.removeEventListener('contextmenu', reset);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, holdDelayMs, store]);
}
