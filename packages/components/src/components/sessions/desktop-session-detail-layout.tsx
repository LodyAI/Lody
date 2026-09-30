import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/ui/resizable';
import { FocusScope } from '@/ui/focus-scope';
import { useIsCompactDesktop } from '@/hooks/use-mobile';
import { WORKSPACE_FOCUS_SCOPES } from '@/atoms';

export type DesktopSessionDetailLayoutProps = {
  defaultSizes: {
    main: number;
    sidebar: number;
  };
  /** Single merged top row: session tabs + right-side window controls. */
  topBar: ReactNode;
  chatSurfaces: ReactNode;
  terminalDock: ReactNode;
  secondaryPanel: ReactNode;
  sidebarOpen: boolean;
  onSidebarCollapse: () => void;
  deleteConfirmDialog: ReactNode;
  /**
   * One-shot "open the sidebar at least this wide" request, identified by an
   * ever-increasing `seq`. Raising only: an already-wider panel keeps its
   * size, and the request is dropped when the window is too narrow to spare
   * it (see MAIN_COLUMN_MIN_WIDTH_PX). Used by the PR tab, whose content is
   * unreadable at the default panel width. Inert under the compact overlay,
   * which already gives the panel the full window width.
   */
  sidebarMinWidthRequest?: { seq: number; minWidthPx: number } | null;
  /**
   * Bumped by the parent whenever `sidebarOpen` changes because panel state was
   * RESTORED — a session switch, or the `?pr=` deep link landing once the PR
   * resolves — rather than because the user asked for it.
   *
   * A restore renders straight to the target size instead of replaying the
   * expand/collapse transition. `flex-grow`/`min-width` are layout properties,
   * so animating them runs a full style → layout → paint → compositing pass
   * every frame for the whole detail tree; a trace of two session switches
   * spent ~400ms of near-saturated main thread per switch on exactly that, for
   * an animation the user never asked for. User-driven toggles still animate.
   */
  sidebarRestoreSeq?: number;
};

/** The conversation column keeps at least this much width when a sidebar
 *  min-width request is honored; below that the request is dropped. */
const MAIN_COLUMN_MIN_WIDTH_PX = 500;

export function DesktopSessionDetailLayout({
  defaultSizes,
  topBar,
  chatSurfaces,
  terminalDock,
  secondaryPanel,
  sidebarOpen,
  onSidebarCollapse,
  deleteConfirmDialog,
  sidebarMinWidthRequest,
  sidebarRestoreSeq = 0,
}: DesktopSessionDetailLayoutProps) {
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const groupWrapperRef = useRef<HTMLDivElement>(null);
  const lastSidebarSizeRef = useRef(defaultSizes.sidebar);
  const previousSidebarOpenRef = useRef(sidebarOpen);
  const lastConsumedSidebarRequestSeqRef = useRef(0);
  const [isResizing, setIsResizing] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const [appliedRestoreSeq, setAppliedRestoreSeq] = useState(sidebarRestoreSeq);
  const isRestoringSidebar = appliedRestoreSeq !== sidebarRestoreSeq;
  /* Compact desktop renders the side panel as an overlay over the chat
     column, so the resizable split is parked: the panel stays collapsed and
     `sidebarOpen` remains true underneath, letting the split come back at its
     remembered size when the window widens again. */
  const compact = useIsCompactDesktop();
  const splitSidebarOpen = sidebarOpen && !compact;

  /** px → panel-group percent, or null when the window is too narrow to spare
   *  the width (the conversation column would drop below its floor). */
  const sidebarMinWidthToPercent = useCallback((minWidthPx: number): number | null => {
    const groupWidth = groupWrapperRef.current?.getBoundingClientRect().width ?? 0;
    if (groupWidth < minWidthPx + MAIN_COLUMN_MIN_WIDTH_PX) return null;
    return (minWidthPx / groupWidth) * 100;
  }, []);

  useLayoutEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;

    const wasOpen = previousSidebarOpenRef.current;
    previousSidebarOpenRef.current = splitSidebarOpen;

    if (splitSidebarOpen) {
      if (!wasOpen) {
        let target = lastSidebarSizeRef.current;
        // A pending min-width request raises the restored size — never lowers.
        if (
          sidebarMinWidthRequest &&
          sidebarMinWidthRequest.seq !== lastConsumedSidebarRequestSeqRef.current
        ) {
          lastConsumedSidebarRequestSeqRef.current = sidebarMinWidthRequest.seq;
          const percent = sidebarMinWidthToPercent(sidebarMinWidthRequest.minWidthPx);
          if (percent != null) target = Math.max(target, percent);
        }
        panel.resize(target);
      }
      return;
    }

    if (wasOpen) {
      const currentSize = panel.getSize();
      if (currentSize > 0) {
        lastSidebarSizeRef.current = currentSize;
      }
    }
    panel.collapse();
  }, [splitSidebarOpen, sidebarMinWidthRequest, sidebarMinWidthToPercent]);

  // The sidebar is already open when the request arrives (e.g. the PR tab
  // takes over the empty state): apply it in place. Declared after the expand
  // effect so an expand triggered in the same commit consumes the request
  // first and this effect stands down.
  useLayoutEffect(() => {
    if (!sidebarMinWidthRequest || !splitSidebarOpen) return;
    if (sidebarMinWidthRequest.seq === lastConsumedSidebarRequestSeqRef.current) return;
    lastConsumedSidebarRequestSeqRef.current = sidebarMinWidthRequest.seq;
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    const percent = sidebarMinWidthToPercent(sidebarMinWidthRequest.minWidthPx);
    if (percent == null) return;
    panel.resize(Math.max(panel.getSize(), percent));
  }, [sidebarMinWidthRequest, splitSidebarOpen, sidebarMinWidthToPercent]);

  // Re-arm the transition only once the browser has rendered a frame with it
  // suppressed. `panel.resize()` reaches the DOM through a PanelGroup state
  // update, so restoring the duration any earlier can land in the SAME style
  // recalc as the new `flex-grow` — and the restore would animate after all.
  useEffect(() => {
    if (!isRestoringSidebar) return undefined;
    const frame = requestAnimationFrame(() => setAppliedRestoreSeq(sidebarRestoreSeq));
    return () => cancelAnimationFrame(frame);
  }, [isRestoringSidebar, sidebarRestoreSeq]);

  const animatesSidebar = !shouldReduceMotion && !isRestoringSidebar;
  const transitionDuration = animatesSidebar ? '220ms' : '0ms';

  return (
    <div ref={groupWrapperRef} className="relative h-full w-full">
      <ResizablePanelGroup
        direction="horizontal"
        className="h-full w-full"
        autoSaveId="session-detail-panels"
      >
        <ResizablePanel
          id="chat"
          order={1}
          defaultSize={defaultSizes.main}
          minSize={15}
          className="min-w-[280px]"
        >
          <FocusScope
            id={WORKSPACE_FOCUS_SCOPES.sessionConversation}
            data-lody-action-scope="conversation"
            className="group/close-scope flex h-full flex-col bg-background"
          >
            {topBar}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-hidden">{chatSurfaces}</div>
              {terminalDock}
              {/* Compact desktop: the side panel takes over the region below
                  the top bar instead of splitting it — a 280px+280px split no
                  longer fits. The split panel above stays collapsed so the
                  open state (and its remembered width) survives un-compact. */}
              {compact && sidebarOpen && (
                <div className="absolute inset-0 z-10 flex flex-col bg-background">
                  <FocusScope id={WORKSPACE_FOCUS_SCOPES.sessionSidePanel} className="h-full">
                    {secondaryPanel}
                  </FocusScope>
                </div>
              )}
            </div>
          </FocusScope>
        </ResizablePanel>

        <ResizableHandle
          disabled={!splitSidebarOpen}
          // Invisible at rest; hover/drag paints a 2px accent line that
          // covers the side panel's left hairline (see desktopSecondaryPanel
          // in session-detail.tsx).
          hitAreaMargins={{ coarse: 15, fine: 12 }}
          onDragging={setIsResizing}
          className={cn(
            'bg-transparent transition-opacity',
            splitSidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
            'after:left-0 after:w-[2px] after:translate-x-0',
            'after:inset-y-0 after:top-0 after:bottom-0',
            'after:transition-colors after:duration-150',
            'data-[resize-handle-state=hover]:after:bg-sidebar-ring/50',
            'data-[resize-handle-state=hover]:after:delay-150',
            'data-[resize-handle-state=drag]:after:bg-sidebar-ring/70'
          )}
          style={{ transitionDuration }}
        />
        <ResizablePanel
          ref={sidebarPanelRef}
          id="sidebar"
          order={2}
          defaultSize={splitSidebarOpen ? defaultSizes.sidebar : 0}
          minSize={10}
          collapsedSize={0}
          collapsible
          onCollapse={() => {
            // Only a user drag below the fold counts as a collapse request —
            // the compact overlay collapses this panel imperatively and must
            // not rewrite `sidebarOpen`.
            if (splitSidebarOpen) onSidebarCollapse();
          }}
          className={cn('bg-background', !isResizing && 'transition-[flex-grow,min-width]')}
          style={{
            minWidth: splitSidebarOpen ? 280 : 0,
            // While dragging, kill the transition entirely. Removing only the
            // transition-property class is not enough: transition-property
            // defaults to `all`, so the inline duration alone would animate
            // every flex-grow update and make the drag lag behind the pointer.
            transitionDuration: isResizing ? '0ms' : transitionDuration,
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          {/* Compact + open renders the panel in the overlay above instead,
              so this host mounts it only when the split owns it — including
              compact + closed, where the collapsed panel must stay mounted. */}
          {(!compact || !sidebarOpen) && (
            <motion.div
              className={cn('h-full', !splitSidebarOpen && 'invisible pointer-events-none')}
              initial={false}
              animate={{ x: splitSidebarOpen ? 0 : '100%' }}
              aria-hidden={!splitSidebarOpen}
              transition={{
                duration: animatesSidebar ? 0.22 : 0,
                ease: [0.32, 0.72, 0, 1],
              }}
            >
              <FocusScope id={WORKSPACE_FOCUS_SCOPES.sessionSidePanel} className="h-full">
                {secondaryPanel}
              </FocusScope>
            </motion.div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
      {deleteConfirmDialog}
    </div>
  );
}
