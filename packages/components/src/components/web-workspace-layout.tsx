import { Suspense, lazy, memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useReducedMotion } from 'framer-motion';
import { useLocation } from '@tanstack/react-router';
import * as stylex from '@stylexjs/stylex';
import { LoroAppSidebar } from './loro-app-sidebar';
import { DEFAULT_DESKTOP_SIDEBAR_WIDTH, MAX_DESKTOP_SIDEBAR_WIDTH } from './loro-sidebar';
import { ErrorBoundary } from './error-boundary';
import { useKeyboardNavigation } from '../hooks/use-keyboard-navigation';
import { useIsCompactDesktop } from '../hooks/use-mobile';
import {
  compactDesktopLayoutAtom,
  navigationSidebarVisibleAtom,
  sidebarCollapsedAtom,
  sidebarLastWidthAtom,
  WORKSPACE_FOCUS_SCOPES,
} from '../atoms';
import { getWebWorkspaceLayoutRootClassName, isSettingsRoute } from './workspace-layout-utils';
import { FocusScope } from '@/ui/focus-scope';
import { WindowDragStrip } from '@/ui/window-drag-region';
import { clsx } from 'clsx';
import { getNavigationSidebarMinWidth } from '@/lib/boot-shell-script';
import { CompactNavigationDialog } from './compact-navigation-dialog';
import { WorkspaceCard } from './workspace-frame';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { todayPinnedAtom } from '@/atoms/sidebar-state';

const TodayPinnedColumn = lazy(async () => {
  const module = await import('./today/today-pinned-column');
  return { default: module.TodayPinnedColumn };
});
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
        xstyle={[styles.desktopSidebar, fitDivision && styles.fitDivision]}
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
  const todayEnabled = useAtomValue(todayFeatureEnabledAtom);
  const todayPinned = useAtomValue(todayPinnedAtom);
  const todayColumnShown = !compact && todayEnabled && todayPinned;
  const division = useVerticalDivision();
  // Effective on-screen visibility: compact may auto-suppress the sidebar even
  // while the persisted preference says open — see atoms/layout-state.ts.
  const sidebarVisible = useAtomValue(navigationSidebarVisibleAtom);
  // The viewport hook knows the window is compact one commit before the layout bridge
  // syncs that into atom state, and only the synced state applies the compact
  // auto-hide. Until then the navigation would mount open and close again before its
  // opening frame, an exit Base UI never finishes. Open it only once they agree.
  const compactSynced = useAtomValue(compactDesktopLayoutAtom);
  const compactNavigationOpen = compact && compactSynced && sidebarVisible;
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
        <div {...stylex.props(styles.settingsPane)}>
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
      getNavigationSidebarMinWidth()
    ),
    MAX_DESKTOP_SIDEBAR_WIDTH
  );
  const rootProps = stylex.props(styles.root);
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
    <div
      ref={setLayoutRoot}
      {...rootProps}
      className={clsx(
        getWebWorkspaceLayoutRootClassName({ surface: 'sidebar' }),
        rootProps.className
      )}
    >
      {compact ? (
        <CompactNavigationDialog
          open={compactNavigationOpen}
          onOpenChange={(open) => setSidebarCollapsed(!open)}
          container={layoutRoot}
          returnFocus={returnFocusRef}
        >
          <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
            <LoroAppSidebar overlay xstyle={styles.overlaySidebar} />
          </ErrorBoundary>
        </CompactNavigationDialog>
      ) : (
        <div
          ref={sidebarRef}
          {...stylex.props(styles.sidebarColumn)}
          style={{
            width: fold ? visibleSidebarWidth : undefined,
            transform: `translateX(${sidebarVisible ? 0 : -visibleSidebarWidth}px)`,
            marginRight: sidebarVisible ? (fold?.width ?? 0) : -visibleSidebarWidth,
            transitionProperty: 'transform, margin-right',
            transitionDuration: shouldReduceMotion ? '0ms' : '220ms',
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          }}
          aria-hidden={!sidebarVisible}
          inert={!sidebarVisible}
        >
          <DesktopSidebarContent pathname={pathname} fitDivision={fold !== null} />
        </div>
      )}
      {todayColumnShown ? (
        // Outside the pathname-keyed boundary: navigating the main area keeps Today mounted.
        <ErrorBoundary name="TodayColumn" variant="section">
          <Suspense fallback={null}>
            <TodayPinnedColumn />
          </Suspense>
        </ErrorBoundary>
      ) : null}
      <FocusScope
        ref={contentRef}
        id={WORKSPACE_FOCUS_SCOPES.content}
        inert={compactNavigationOpen}
        onFocusCapture={(event) => {
          // Capture before inert can blur the opener during the open commit.
          returnFocusRef.current = event.target;
        }}
        style={fold && !sidebarVisible ? { marginLeft: fold.left + fold.width } : undefined}
        className={stylex.props(styles.content).className}
      >
        <WindowDragStrip />
        <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
          {/* Beside a pinned Today card the main card anchors to it, as it does to the
              sidebar: the Today card's own rim keeps 4px of ground between them. */}
          <WorkspaceCard anchored={(sidebarVisible || todayColumnShown) && !compact}>
            {children}
          </WorkspaceCard>
        </ErrorBoundary>
      </FocusScope>
    </div>
  );
}

const styles = stylex.create({
  fitDivision: { width: '100%' },
  desktopSidebar: {
    height: '100%',
    transitionProperty: 'box-shadow',
    transitionDuration: '150ms',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  overlaySidebar: {
    height: '100%',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderColor: 'hsl(var(--sidebar-border) / 1)',
    boxShadow: 'var(--shadow-xl)',
  },
  /** The settings route's single pane, under the window drag strip. */
  settingsPane: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
  },
  /** The content pane shrinks beside the sidebar and clips its own viewport. */
  content: {
    position: 'relative',
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
  },
  /** The layout root: the sidebar's plane, with the content beside it. */
  root: { position: 'relative' },
  /** The sidebar's own column, slid out of view when it is closed. */
  sidebarColumn: {
    position: 'relative',
    zIndex: 10,
    height: '100%',
    flexShrink: 0,
  },
});
