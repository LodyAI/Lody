import { type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useLocation } from '@tanstack/react-router';
import { LoroAppSidebar } from './loro-app-sidebar';
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

// LoroSidebar's default expanded width (see loro-sidebar.tsx `defaultWidth`);
// `sidebarLastWidthAtom` stores 0 until the user resizes, so fall back to this.
const DEFAULT_SIDEBAR_WIDTH = 280;

// Compact overlay width: the standard 18rem drawer, capped so it never
// covers the whole window on the narrowest desktops.
const COMPACT_SIDEBAR_OVERLAY_WIDTH = 'min(18rem,85vw)';

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

  // Slide the sidebar in/out horizontally on collapse/expand. Animating
  // `marginLeft` (not width/transform) both slides the panel off the left edge —
  // clipped by this row's `overflow-hidden` — and reclaims the flex space so the
  // content pane grows to fill. AnimatePresence keeps the sidebar mounted for
  // the exit slide, then unmounts it. marginLeft stays 0 while expanded, so live
  // resize never fights the animation.
  const sidebarSlideWidth = sidebarLastWidth > 0 ? sidebarLastWidth : DEFAULT_SIDEBAR_WIDTH;
  const slideTransition = {
    duration: shouldReduceMotion ? 0 : 0.22,
    ease: [0.32, 0.72, 0, 1] as const,
  };

  return (
    <div className={cn(getWebWorkspaceLayoutRootClassName(), 'relative')}>
      {/* presenceAffectsLayout gives the presence context a new value on every
          render, which re-propagated it through the whole sidebar (~29k fibers)
          on each session switch. Neither branch animates `layout`. */}
      {compact ? (
        // Compact desktop: the navigation sidebar floats over the content as
        // a dismissible sheet instead of taking a column it can no longer
        // afford. Scrim click records a real collapse (persisted), matching
        // every other close path; compact auto-hide uses the separate
        // suppressed flag so widening restores the sidebar instead.
        <AnimatePresence initial={false} presenceAffectsLayout={false}>
          {sidebarVisible && [
            <motion.div
              key="app-sidebar-scrim"
              aria-hidden="true"
              className="absolute inset-0 z-30 bg-black/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.15 }}
              onClick={() => setSidebarCollapsed(true)}
            />,
            <motion.div
              key="app-sidebar-overlay"
              className="absolute inset-y-0 left-0 z-40"
              style={{ width: COMPACT_SIDEBAR_OVERLAY_WIDTH }}
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={slideTransition}
            >
              <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
                <LoroAppSidebar
                  overlay
                  className="h-full border-r border-sidebar-border shadow-xl"
                />
              </ErrorBoundary>
            </motion.div>,
          ]}
        </AnimatePresence>
      ) : (
        <AnimatePresence initial={false} presenceAffectsLayout={false}>
          {sidebarVisible && (
            <motion.div
              key="app-sidebar"
              className="h-full shrink-0"
              initial={{ marginLeft: -sidebarSlideWidth }}
              animate={{ marginLeft: 0 }}
              exit={{ marginLeft: -sidebarSlideWidth }}
              transition={slideTransition}
            >
              <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
                <LoroAppSidebar className="h-full transition-shadow duration-150" />
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      )}
      <FocusScope
        id={WORKSPACE_FOCUS_SCOPES.content}
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
