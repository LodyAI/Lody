import { lazy, Suspense, type ReactNode } from 'react';
import { useAtom } from 'jotai';
import { useLocation, useMatchRoute, useParams } from '@tanstack/react-router';
import { mobileDrawerOpenAtom } from '../../atoms';
import { ErrorBoundary } from '../error-boundary';
import { LoroAppSidebar } from '../loro-app-sidebar';
import { MobileSidebarDrawer } from './mobile-sidebar-drawer';
import { TerminalDockHost } from '../terminal-dock-host';
import {
  getMobileMainLayoutContentClassName,
  getMobileMainLayoutRootClassName,
} from '../workspace-layout-utils';

/* Lazy so the (mobile-only) home/project + session stack — and its heavy
   `ChatLanding` / `SessionDetail` dependency graphs — are not pulled into the
   shared `main-layout` chunk. Desktop renders `WebWorkspaceLayout` and never
   loads this; on mobile it loads on first stack render, matching the prior
   per-route lazy loading of those surfaces. */
const MobileWorkspaceStack = lazy(() =>
  import('./mobile-workspace-stack').then((m) => ({ default: m.MobileWorkspaceStack }))
);

/* The legacy `MobileBottomNavigation` (chat / archive / settings / more)
   was deleted in the 2026-05 mobile redesign. Each route now owns its
   own bottom chrome: the chat landing + project detail render the
   shared MobileWorkspaceTabBar, the session view shows a back chip in
   the header instead, and the settings layout draws the same tabbar
   at its bottom. The workspace layout therefore renders no bottom bar
   of its own. */

export function MobileWorkspaceLayout({
  children,
  workspaceReady = true,
}: {
  children: ReactNode;
  /** Do not mount the workspace-owned stack while route/runtime scope is converging. */
  workspaceReady?: boolean;
}) {
  // Only the pathname drives this layout (error boundary resets), so
  // search-only navigations don't re-render the whole mobile shell.
  const pathname = useLocation({ select: (l) => l.pathname });
  const [drawerOpen, setDrawerOpen] = useAtom(mobileDrawerOpenAtom);
  const params = useParams({ strict: false });
  const workspaceName = params.workspaceName;
  const matchRoute = useMatchRoute();

  /* The home/project landing and the session detail page form a single
     navigation *stack* on mobile: the landing stays mounted as the base and
     the session slides in on top (see `MobileWorkspaceStack`). For those two
     routes we render the stack instead of the route `<Outlet/>` (those routes
     render `null` on mobile and let the stack own them). Every other route
     (settings, archive, …) renders its `<Outlet/>` content as usual. */
  const onStackRoute =
    workspaceName != null &&
    (matchRoute({ to: '/$workspaceName/chat' }) !== false ||
      matchRoute({ to: '/$workspaceName/sessions/$sessionId' }) !== false);

  return (
    <div className={getMobileMainLayoutRootClassName()}>
      <MobileSidebarDrawer open={drawerOpen} onOpenChange={setDrawerOpen} width={320}>
        <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
          <LoroAppSidebar className="h-full" />
        </ErrorBoundary>
      </MobileSidebarDrawer>

      <div className={getMobileMainLayoutContentClassName()}>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
            {/* On a stack route the stack owns the *visible* surface; on every
               other route it renders nothing and the route `<Outlet/>` (inside
               `children`) is the page. `children` is ALWAYS rendered either way
               — it is the whole `_auth.tsx` subtree, not just the Outlet:
                 - On mobile the `/chat` + `/sessions/$sessionId` route
                   components return `null` visually, but still run their
                   effects — notably ChatRoute publishing the home/project
                   context to `mobileWorkspaceBaseContextAtom`, which the stack
                   reads to keep the right page beneath an open session.
                 - It also carries the always-on globals (route tracker,
                   auto-archive PR watcher, …) that must keep
                   running on these — the most common — mobile pages.
               The stack is layered on top; since the route components render
               nothing on mobile there is no duplicate content. */}
            {workspaceReady && onStackRoute && workspaceName != null && (
              <Suspense fallback={<div className="h-full w-full bg-background" />}>
                <MobileWorkspaceStack workspaceName={workspaceName} />
              </Suspense>
            )}
            {children}
          </ErrorBoundary>
        </div>
        <TerminalDockHost />
      </div>
    </div>
  );
}
