import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  sidebarNavCallbacksAtom,
  sidebarNavItemsAtom,
  type SidebarNavItem,
} from '@/atoms/focus-layer';
import { toggleSidebarCollapsedAtom } from '@/atoms/sidebar-state';
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
  const toggleSidebarCollapsed = useSetAtom(toggleSidebarCollapsedAtom);
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
      // The burst moved on while this navigation rendered; take the latest.
      if (pendingSessionRef.current !== navigatedSessionRef.current) flushSessionNavigation();
    });
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    []
  );

  const navigateVisibleSession = useCallback(
    (direction: 'previous' | 'next') => {
      const callbacks = callbacksRef.current;
      if (!callbacks) return;
      const sessionIds = getVisibleSessionIds();
      if (sessionIds.length === 0) return;

      // No paint is owed, so this press starts a burst rather than continuing
      // one: re-anchor on the route, which has committed by now, and drop a
      // pending target left over from a selection the user has since changed.
      if (frameRef.current === null) pendingSessionRef.current = null;
      const anchorId =
        pendingSessionRef.current !== null && sessionIds.includes(pendingSessionRef.current)
          ? pendingSessionRef.current
          : callbacks.getSelectedSessionId();
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
    [flushSessionNavigation, getVisibleSessionIds]
  );

  useFocusScopeSwitcher({ enabled: !isMobile });

  useCommand({
    id: 'sidebar.toggle',
    title: t('commands.sidebar.toggle', 'Toggle Sidebar'),
    category: 'View',
    keybindings: getCommandKeybindings('sidebar.toggle'),
    when: () => !isMobile,
    run: () => toggleSidebarCollapsed(),
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
