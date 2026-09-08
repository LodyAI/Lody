import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  sidebarNavCallbacksAtom,
  sidebarNavItemsAtom,
  type SidebarNavItem,
} from '@/atoms/focus-layer';
import { toggleNavigationSidebarAtom } from '@/atoms/layout-state';
import { getCommandKeybindings, useCommand } from '@/lib/commands';
import { useFocusScopeSwitcher } from '@/ui/focus-scope';
import { useIsMobile } from './use-mobile';

export type { SidebarNavItem } from '@/atoms/focus-layer';

function isTextInputActive(): boolean {
  const element = document.activeElement;
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function isPopupOpen(): boolean {
  return (
    document.querySelector('[data-radix-popper-content-wrapper]') !== null ||
    document.querySelector('[role="dialog"][data-state="open"]') !== null ||
    document.querySelector('[data-radix-menu-content]') !== null
  );
}

/** App-level navigation commands plus the single global focus-scope switcher. */
export function useKeyboardNavigation(): void {
  const { t } = useTranslation();
  const flatItems = useAtomValue(sidebarNavItemsAtom);
  const sidebarCallbacks = useAtomValue(sidebarNavCallbacksAtom);
  const toggleNavigationSidebar = useSetAtom(toggleNavigationSidebarAtom);
  const isMobile = useIsMobile();

  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;
  const callbacksRef = useRef(sidebarCallbacks);
  callbacksRef.current = sidebarCallbacks;

  const getVisibleSessionIds = useCallback(
    () =>
      flatItemsRef.current
        .filter((item): item is SidebarNavItem & { kind: 'session' } => item.kind === 'session')
        .map((item) => item.sessionId),
    []
  );

  // Switching sessions renders the whole conversation synchronously, which
  // outlasts the keyboard repeat interval: holding the shortcut queues presses
  // faster than they can be painted, and every queued one pays a full render
  // nobody ever sees. `frameRef` is the "a paint is still owed" flag — while it
  // is set, a press only advances the target, and the pending frame navigates to
  // wherever the burst got to. One navigation per painted frame, so a lone press
  // keeps its immediate response and a held key moves as fast as it can render.
  const pendingSessionRef = useRef<string | null>(null);
  const navigatedSessionRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);

  const abandonBurst = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    pendingSessionRef.current = null;
    navigatedSessionRef.current = null;
  }, []);

  /**
   * The target a queued burst may still act on, or `null` once the burst has
   * stopped owning the selection.
   *
   * A keyboard burst is only ever an offset from its OWN last navigation, so it
   * has to yield the moment anything else moves the selection. A sidebar click
   * leaves the route somewhere the burst did not put it; a workspace switch does
   * that and replaces the visible rows underneath it. Carrying a stale id into
   * the queued frame would overwrite the user's choice, or hand
   * `onNavigateToSession` a session id from the previous workspace and build a
   * route the target workspace has no session for.
   */
  const claimBurstTarget = useCallback(
    (sessionIds: readonly string[]): string | null => {
      const target = pendingSessionRef.current;
      if (target === null) return null;
      const callbacks = callbacksRef.current;
      if (!callbacks) return null;
      if (callbacks.getSelectedSessionId() !== navigatedSessionRef.current) return null;
      return sessionIds.includes(target) ? target : null;
    },
    []
  );

  const flushSessionNavigation = useCallback(() => {
    const callbacks = callbacksRef.current;
    const target = pendingSessionRef.current;
    if (!callbacks || target === null) {
      frameRef.current = null;
      return;
    }
    navigatedSessionRef.current = target;
    callbacks.onNavigateToSession(target);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // Re-validate before acting: the paint we were waiting on is also the
      // window in which a click or a workspace switch can land.
      if (claimBurstTarget(getVisibleSessionIds()) === null) {
        abandonBurst();
        return;
      }
      // The burst moved on while this navigation rendered; take the latest.
      if (pendingSessionRef.current !== navigatedSessionRef.current) flushSessionNavigation();
    });
  }, [abandonBurst, claimBurstTarget, getVisibleSessionIds]);

  useEffect(() => () => abandonBurst(), [abandonBurst]);

  const navigateVisibleSession = useCallback(
    (direction: 'previous' | 'next') => {
      const callbacks = callbacksRef.current;
      if (!callbacks) return;
      const sessionIds = getVisibleSessionIds();
      if (sessionIds.length === 0) return;

      // Continue the burst only while it still owns the selection. Otherwise it
      // is dead: drop its queued frame and start again from wherever the route
      // actually is, so this press gets the ordinary immediate response.
      const burstTarget = claimBurstTarget(sessionIds);
      if (burstTarget === null) abandonBurst();
      const anchorId = burstTarget ?? callbacks.getSelectedSessionId();
      const currentIndex = anchorId ? sessionIds.indexOf(anchorId) : -1;
      const nextIndex =
        direction === 'previous'
          ? Math.max(0, currentIndex - 1)
          : Math.min(sessionIds.length - 1, currentIndex + 1);
      const nextId = sessionIds[nextIndex];
      if (!nextId || nextId === anchorId) return;
      pendingSessionRef.current = nextId;
      if (frameRef.current === null) flushSessionNavigation();
    },
    [abandonBurst, claimBurstTarget, flushSessionNavigation, getVisibleSessionIds]
  );

  useFocusScopeSwitcher({ enabled: !isMobile });

  useCommand({
    id: 'sidebar.toggle',
    title: t('commands.sidebar.toggle', 'Toggle Sidebar'),
    category: 'View',
    keybindings: getCommandKeybindings('sidebar.toggle'),
    when: () => !isMobile,
    run: () => toggleNavigationSidebar(),
  });

  useCommand({
    id: 'session.previousVisible',
    title: t('commands.session.previousVisible', 'Switch to Previous Session'),
    category: 'Navigation',
    keybindings: getCommandKeybindings('session.previousVisible'),
    when: () =>
      !isMobile &&
      !isPopupOpen() &&
      callbacksRef.current !== null &&
      getVisibleSessionIds().length > 0,
    run: () => navigateVisibleSession('previous'),
  });

  useCommand({
    id: 'session.nextVisible',
    title: t('commands.session.nextVisible', 'Switch to Next Session'),
    category: 'Navigation',
    keybindings: getCommandKeybindings('session.nextVisible'),
    when: () =>
      !isMobile &&
      !isPopupOpen() &&
      callbacksRef.current !== null &&
      getVisibleSessionIds().length > 0,
    run: () => navigateVisibleSession('next'),
  });

  useEffect(() => {
    if (isMobile) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== 'c' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isTextInputActive() ||
        isPopupOpen()
      ) {
        return;
      }
      const callbacks = callbacksRef.current;
      if (!callbacks) return;
      event.preventDefault();
      callbacks.onNavigateToNewSession();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobile]);
}
