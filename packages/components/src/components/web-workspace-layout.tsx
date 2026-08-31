import { lazy, Suspense, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useLocation } from '@tanstack/react-router';
import { LoroAppSidebar } from './loro-app-sidebar';
import { ErrorBoundary } from './error-boundary';
import { useKeyboardNavigation } from '../hooks/use-keyboard-navigation';
import { sidebarCollapsedAtom, sidebarLastWidthAtom, WORKSPACE_FOCUS_SCOPES } from '../atoms';
import { CHAT_WORKSPACE_GEOMETRY_ANCHORS } from '@/lib/chat-workspace-geometry';
import { cn } from '@/lib/utils';
import { isSettingsRoute, NATIVE_KEYBOARD_OFFSET_CLASS } from './workspace-layout-utils';
import { FocusScope } from '@/ui/focus-scope';
import { WindowDragStrip } from '@/ui/window-drag-region';

// LoroSidebar's default expanded width (see loro-sidebar.tsx `defaultWidth`);
// `sidebarLastWidthAtom` stores 0 until the user resizes, so fall back to this.
const DEFAULT_SIDEBAR_WIDTH = 280;
// Extra px the sidebar card is inset by (`ml-2` + `mr-1` in loro-app-sidebar),
// added to the slide distance so it clears fully off the left edge.
const SIDEBAR_GUTTER = 12;

const WorkspaceGeometryDevtools =
  import.meta.env.DEV && import.meta.env.MODE !== 'test'
    ? lazy(() => import('./devtools/workspace-geometry-devtools'))
    : null;

type WebWorkspaceFrameProps = {
  children: ReactNode;
  pathname: string;
  sidebar: ReactNode;
  sidebarCollapsed: boolean;
  sidebarSlideWidth: number;
  shouldReduceMotion: boolean;
};

/**
 * Production workspace frame with its stateful Sidebar supplied by the caller.
 * The deterministic geometry story uses this same frame with a fixture Sidebar,
 * so browser validation cannot drift onto a copied shell implementation.
 */
export function WebWorkspaceFrame({
  children,
  pathname,
  sidebar,
  sidebarCollapsed,
  sidebarSlideWidth,
  shouldReduceMotion,
}: WebWorkspaceFrameProps) {
  return (
    <div
      data-geometry-anchor={CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}
      className={cn(
        'flex h-svh w-full overflow-hidden bg-background',
        NATIVE_KEYBOARD_OFFSET_CLASS
      )}
    >
      <AnimatePresence initial={false}>
        {!sidebarCollapsed && (
          <motion.div
            key="app-sidebar"
            data-geometry-anchor={CHAT_WORKSPACE_GEOMETRY_ANCHORS.sidebarSlot}
            className="h-full shrink-0"
            initial={{ marginLeft: -sidebarSlideWidth }}
            animate={{ marginLeft: 0 }}
            exit={{ marginLeft: -sidebarSlideWidth }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
          >
            <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
              {sidebar}
            </ErrorBoundary>
          </motion.div>
        )}
      </AnimatePresence>
      <FocusScope
        id={WORKSPACE_FOCUS_SCOPES.content}
        data-geometry-anchor={CHAT_WORKSPACE_GEOMETRY_ANCHORS.mainPane}
        className="relative flex min-w-0 flex-1 overflow-hidden"
      >
        <WindowDragStrip />
        <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
          <div className="flex h-full min-w-0 w-full flex-1 flex-col overflow-hidden">
            {children}
          </div>
        </ErrorBoundary>
      </FocusScope>
    </div>
  );
}

export function WebWorkspaceLayout({ children }: { children: ReactNode }) {
  // Only the pathname drives this layout (settings branch + error boundary
  // resets), so search-only navigations (dialogs, panels) don't re-render the
  // whole workspace shell.
  const pathname = useLocation({ select: (l) => l.pathname });
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const sidebarLastWidth = useAtomValue(sidebarLastWidthAtom);
  const shouldReduceMotion = useReducedMotion();

  useKeyboardNavigation();

  if (isSettingsRoute(pathname)) {
    return (
      <div
        className={cn(
          'relative flex h-svh w-full overflow-hidden bg-background',
          NATIVE_KEYBOARD_OFFSET_CLASS
        )}
      >
        <WindowDragStrip />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
            {children}
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  // Slide the sidebar in/out horizontally on collapse/expand. Animating
  // `marginLeft` (not width/transform) both slides the card off the left edge —
  // clipped by this row's `overflow-hidden` — and reclaims the flex space so the
  // content pane grows to fill. AnimatePresence keeps the sidebar mounted for the
  // exit slide, then unmounts it. marginLeft stays 0 while expanded, so live
  // resize never fights the animation.
  const sidebarSlideWidth =
    (sidebarLastWidth > 0 ? sidebarLastWidth : DEFAULT_SIDEBAR_WIDTH) + SIDEBAR_GUTTER;

  return (
    <>
      <WebWorkspaceFrame
        pathname={pathname}
        sidebar={<LoroAppSidebar className="h-full transition-shadow duration-150" />}
        sidebarCollapsed={sidebarCollapsed}
        sidebarSlideWidth={sidebarSlideWidth}
        shouldReduceMotion={shouldReduceMotion === true}
      >
        {children}
      </WebWorkspaceFrame>
      {WorkspaceGeometryDevtools ? (
        <Suspense fallback={null}>
          <WorkspaceGeometryDevtools />
        </Suspense>
      ) : null}
    </>
  );
}
