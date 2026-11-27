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
import { WorkspaceCard } from './workspace-frame';
import { useVerticalDivision } from './mobile/use-vertical-division';

const DesktopSidebarContent = memo(function DesktopSidebarContent({
  pathname,
  fitDivision,
}: {
  pathname: string;
  fitDivision: boolean;
}) {
  return (
    <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
      <LoroAppSidebar
        pauseSidebarSourcesWhenHidden
        overlay={fitDivision}
        className={cn('h-full transition-shadow duration-150', fitDivision && 'w-full')}
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
  const division = useVerticalDivision();
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

  // The page slides over a still sidebar: the column keeps its place and width,
  // and the content pane pulls left over it with a negative margin. The pane
  // (not the column) carries z-10 so the covering edge paints above the rows
  // it passes. Keep the sidebar mounted through the transition; unmounting it
  // would rebuild every session row on each Cmd+B.
  // LoroSidebar clamps its persisted default. The hidden pane must release
  // that same actual width, or an old out-of-range preference leaves a gap.
  const sidebarSlideWidth = Math.min(
    Math.max(
      sidebarLastWidth > 0 ? sidebarLastWidth : DEFAULT_DESKTOP_SIDEBAR_WIDTH,
      MIN_DESKTOP_SIDEBAR_WIDTH
    ),
    MAX_DESKTOP_SIDEBAR_WIDTH
  );
  // Only use a division when each side can hold its own usable surface.
  const fold =
    !compact &&
    division &&
    division.left >= 240 &&
    division.viewportWidth - division.left - division.width >= 240
      ? division
      : null;
  const visibleSidebarWidth = fold?.left ?? sidebarSlideWidth;
  return (
    // `bg-sidebar` after the base class: the sidebar's colour is the window's ground.
    <div
      ref={setLayoutRoot}
      className={cn(getWebWorkspaceLayoutRootClassName(), 'relative bg-sidebar')}
    >
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
          // z-0 confines the sidebar's inner z-20 (Electron traffic-light
          // helper) inside this stacking context. Without it that z-20 would
          // outrank the covering content pane's z-10 and the slide-over would
          // paint the rows on top of the card passing over them.
          className="relative z-0 h-full shrink-0"
          style={{
            width: fold ? visibleSidebarWidth : undefined,
            // Inside a hardware fold the panes never overlap: the column slides
            // out of its own left panel while the page keeps the right one.
            transform: fold ? `translateX(${sidebarVisible ? 0 : -visibleSidebarWidth}px)` : undefined,
            marginRight: fold
              ? sidebarVisible
                ? fold.width
                : -visibleSidebarWidth
              : undefined,
            transitionProperty: fold ? 'transform, margin-right' : undefined,
            transitionDuration: shouldReduceMotion ? '0ms' : '220ms',
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          }}
          aria-hidden={!sidebarVisible}
          inert={!sidebarVisible}
        >
          <DesktopSidebarContent pathname={pathname} fitDivision={fold !== null} />
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
        style={{
          marginLeft: fold
            ? sidebarVisible
              ? undefined
              : fold.left + fold.width
            : sidebarVisible
              ? undefined
              : -sidebarSlideWidth,
          transitionProperty: 'margin-left',
          transitionDuration: shouldReduceMotion ? '0ms' : '220ms',
          transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        className="relative z-10 flex min-w-0 flex-1 overflow-hidden"
      >
        <WindowDragStrip />
        <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
          <WorkspaceCard anchored={sidebarVisible && !compact}>{children}</WorkspaceCard>
        </ErrorBoundary>
      </FocusScope>
    </div>
  );
}
