import type { ReactNode } from 'react';
import { useLocation, useRouterState } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { navigationSidebarVisibleAtom } from '@/atoms/layout-state';
import { sidebarLastWidthAtom } from '@/atoms/sidebar-state';
import { useIsCompactDesktop, useIsMobile } from '@/hooks/use-mobile';
import { BootShellProvider } from './boot-shell';

/** Route geometry stays current without mounting any workspace-owned UI. */
export function BootShellBoundary({ children }: { children: ReactNode }) {
  const path = useLocation({ select: (location) => location.pathname });
  const pending = useRouterState({
    select: (state) => state.isLoading || state.status === 'pending',
  });
  const sidebarVisible = useAtomValue(navigationSidebarVisibleAtom);
  const sidebarWidth = useAtomValue(sidebarLastWidthAtom);
  const mobile = useIsMobile();
  const compact = useIsCompactDesktop();
  return (
    <BootShellProvider
      pending={pending}
      path={path}
      sidebar={sidebarVisible && !compact}
      sidebarWidth={sidebarWidth}
      mobile={mobile}
    >
      {children}
    </BootShellProvider>
  );
}
