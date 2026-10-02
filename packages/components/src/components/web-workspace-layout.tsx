import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useReducedMotion } from 'framer-motion';
import { useLocation } from '@tanstack/react-router';
import { LoroAppSidebar } from './loro-app-sidebar';
import {
  DEFAULT_DESKTOP_SIDEBAR_WIDTH,
  MAX_DESKTOP_SIDEBAR_WIDTH,
  MIN_DESKTOP_SIDEBAR_WIDTH,
} from './loro-sidebar';
import { ErrorBoundary } from './error-boundary';
import { useKeyboardNavigation } from '../hooks/use-keyboard-navigation';
import { useIsCompactDesktop } from '../hooks/use-mobile';
import {
  navigationSidebarVisibleAtom,
  sidebarCollapsedAtom,
  sidebarLastWidthAtom,
  WORKSPACE_FOCUS_SCOPES,
} from '../atoms';
import { getWebWorkspaceLayoutRootClassName, isSettingsRoute } from './workspace-layout-utils';
import { FocusScope } from '@/ui/focus-scope';
import { WindowDragStrip } from '@/ui/window-drag-region';
import { cn } from '@/lib/utils';
import { CompactNavigationDialog } from './compact-navigation-dialog';

const DesktopSidebarContent = memo(function DesktopSidebarContent({
  pathname,
}: {
  pathname: string;
}) {
  return (
    <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
      <LoroAppSidebar
        pauseSidebarSourcesWhenHidden
        className="h-full transition-shadow duration-150"
      />
    </ErrorBoundary>
  );
});

export function WebWorkspaceLayout({ children }: { children: ReactNode }) {
  // Only the pathname drives this layout (settings branch + error boundary
  // resets), so search-only navigations (dialogs, panels) don't re-render the
  // whole workspace shell.
  const pathname = useLocation({ select: (l) => l.pathname });
  const compact = useIsCompactDesktop();
  // Effective on-screen visibility: compact may auto-suppress the sidebar even
  // while the persisted preference says open — see atoms/layout-state.ts.
  const sidebarVisible = useAtomValue(navigationSidebarVisibleAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const sidebarLastWidth = useAtomValue(sidebarLastWidthAtom);
  const shouldReduceMotion = useReducedMotion();
  const sidebarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [layoutRoot, setLayoutRoot] = useState<HTMLDivElement | null>(null);
  const wasSidebarVisibleRef = useRef(sidebarVisible);

  useLayoutEffect(() => {
    const wasVisible = wasSidebarVisibleRef.current;
    wasSidebarVisibleRef.current = sidebarVisible;
    if (!wasVisible || sidebarVisible || compact || isSettingsRoute(pathname)) return;
    const active = document.activeElement;
    // Setting inert can move focus to <body> before layout effects run. A
    // sidebar popover can also have focus in a portal outside this subtree.
    // Preserve focus in another panel or a modal, but dismiss sidebar popovers.
    const inOtherScope =
      active instanceof Element &&
      active.closest('[data-focus-scope]') &&
      !sidebarRef.current?.contains(active);
    const inModal = active instanceof Element && active.closest('[aria-modal="true"]');
    if (!inOtherScope && !inModal) {
      contentRef.current?.focus({ preventScroll: true });
    }
  }, [compact, pathname, sidebarVisible]);
  useKeyboardNavigation();

  if (isSettingsRoute(pathname)) {
    return (
      <div className={getWebWorkspaceLayoutRootClassName({ settingsRoute: true })}>
        <WindowDragStrip />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
            {children}
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  // Keep the sidebar mounted while its transform and flex footprint transition
  // together. The margin transition lets the content pane resize smoothly;
  // retaining the sidebar avoids rebuilding every session row on each Cmd+B.
  // LoroSidebar clamps its persisted default. The hidden wrapper must release
  // that same actual width, or an old out-of-range preference leaves a gap.
  const sidebarSlideWidth = Math.min(
    Math.max(
      sidebarLastWidth > 0 ? sidebarLastWidth : DEFAULT_DESKTOP_SIDEBAR_WIDTH,
      MIN_DESKTOP_SIDEBAR_WIDTH
    ),
    MAX_DESKTOP_SIDEBAR_WIDTH
  );
  return (
    <div ref={setLayoutRoot} className={cn(getWebWorkspaceLayoutRootClassName(), 'relative')}>
      {compact ? (
        <CompactNavigationDialog
          open={sidebarVisible}
          onOpenChange={(open) => setSidebarCollapsed(!open)}
          container={layoutRoot}
          returnFocus={returnFocusRef}
        >
          <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
            <LoroAppSidebar overlay className="h-full border-r border-sidebar-border shadow-xl" />
          </ErrorBoundary>
        </CompactNavigationDialog>
      ) : (
        <div
          ref={sidebarRef}
          className="relative z-10 h-full shrink-0"
          style={{
            transform: `translateX(${sidebarVisible ? 0 : -sidebarSlideWidth}px)`,
            marginRight: sidebarVisible ? 0 : -sidebarSlideWidth,
            transitionProperty: 'transform, margin-right',
            transitionDuration: shouldReduceMotion ? '0ms' : '220ms',
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          }}
          aria-hidden={!sidebarVisible}
          inert={!sidebarVisible}
        >
          <DesktopSidebarContent pathname={pathname} />
        </div>
      )}
      <FocusScope
        ref={contentRef}
        id={WORKSPACE_FOCUS_SCOPES.content}
        inert={compact && sidebarVisible}
        onFocusCapture={(event) => {
          // Capture before inert can blur the opener during the open commit.
          returnFocusRef.current = event.target;
        }}
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
