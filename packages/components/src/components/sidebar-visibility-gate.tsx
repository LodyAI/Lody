import { useLayoutEffect, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { navigationSidebarVisibleAtom } from '@/atoms/layout-state';

/** Pause sidebar-only sources without rerendering the retained sidebar tree. */
export function SidebarVisibilityGate({
  disableWhenHidden,
  onHidden,
  children,
}: {
  disableWhenHidden: boolean;
  onHidden?: () => void;
  children: ReactNode;
}) {
  const sidebarVisible = useAtomValue(navigationSidebarVisibleAtom);
  useLayoutEffect(() => {
    if (disableWhenHidden && !sidebarVisible) onHidden?.();
  }, [disableWhenHidden, onHidden, sidebarVisible]);
  return disableWhenHidden && !sidebarVisible ? null : children;
}
