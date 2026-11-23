import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import {
  sidebarNavItemsAtom,
  sidebarNavCallbacksAtom,
  type SidebarNavItem,
  type SidebarNavCallbacks,
} from '@/atoms/focus-layer';

/**
 * Hook used by LoroAppSidebar to publish keyboard navigation data to atoms.
 */
export function useSidebarKeyboardNav(opts: {
  items: SidebarNavItem[];
  callbacks: SidebarNavCallbacks;
}) {
  const setNavItems = useSetAtom(sidebarNavItemsAtom);
  const setNavCallbacks = useSetAtom(sidebarNavCallbacksAtom);

  // Publish flat items to the shared atom after commit. Updating the atom during
  // render can notify command consumers while LoroAppSidebar is still rendering.
  const prevFlatItemsRef = useRef<SidebarNavItem[] | null>(null);
  useEffect(() => {
    if (prevFlatItemsRef.current === opts.items) return;
    prevFlatItemsRef.current = opts.items;
    setNavItems(opts.items);
  }, [opts.items, setNavItems]);

  const callbacksRef = useRef(opts.callbacks);
  callbacksRef.current = opts.callbacks;

  // Publish a stable callback object that reads from the ref
  useEffect(() => {
    const stableCallbacks: SidebarNavCallbacks = {
      onNavigateToSession: (id) => callbacksRef.current.onNavigateToSession(id),
      onNavigateToNewSession: (repo) => callbacksRef.current.onNavigateToNewSession(repo),
      onToggleRepoCollapsed: (repo) => callbacksRef.current.onToggleRepoCollapsed(repo),
      onToggleChatsCollapsed: () => callbacksRef.current.onToggleChatsCollapsed(),
      onToggleLocalProjectCollapsed: (m, p) =>
        callbacksRef.current.onToggleLocalProjectCollapsed?.(m, p),
      getSelectedSessionId: () => callbacksRef.current.getSelectedSessionId(),
      getSessionGroupKey: (id) => callbacksRef.current.getSessionGroupKey?.(id) ?? null,
      isChatLanding: () => callbacksRef.current.isChatLanding(),
    };
    setNavCallbacks(stableCallbacks);
    return () => setNavCallbacks(null);
  }, [setNavCallbacks]);

  return opts.items;
}
