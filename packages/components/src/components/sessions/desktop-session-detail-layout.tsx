import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/ui/resizable';

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
   * unreadable at the default panel width.
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
    previousSidebarOpenRef.current = sidebarOpen;

    if (sidebarOpen) {
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
  }, [sidebarOpen, sidebarMinWidthRequest, sidebarMinWidthToPercent]);

  // The sidebar is already open when the request arrives (e.g. the PR tab
  // takes over the empty state): apply it in place. Declared after the expand
  // effect so an expand triggered in the same commit consumes the request
  // first and this effect stands down.
  useLayoutEffect(() => {
    if (!sidebarMinWidthRequest || !sidebarOpen) return;
    if (sidebarMinWidthRequest.seq === lastConsumedSidebarRequestSeqRef.current) return;
    lastConsumedSidebarRequestSeqRef.current = sidebarMinWidthRequest.seq;
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    const percent = sidebarMinWidthToPercent(sidebarMinWidthRequest.minWidthPx);
    if (percent == null) return;
    panel.resize(Math.max(panel.getSize(), percent));
  }, [sidebarMinWidthRequest, sidebarOpen, sidebarMinWidthToPercent]);

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
          <div className="flex h-full flex-col bg-background">
            {topBar}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-hidden">{chatSurfaces}</div>
              {terminalDock}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle
          disabled={!sidebarOpen}
          // Invisible at rest; hover/drag paints a 2px accent line that
          // covers the side panel CARD's left border — the card is inset
          // `mx-2` from this 1px layout handle (see desktopSecondaryPanel
          // in session-detail.tsx), so a line centered on the handle would
          // float in the gutter instead of lighting up the visible edge.
          // left-[9px] = handle 1px + 8px card margin. hitAreaMargins
          // widened so hovering ON the card border also triggers.
          hitAreaMargins={{ coarse: 15, fine: 12 }}
          onDragging={setIsResizing}
          className={cn(
            'bg-transparent transition-opacity',
            sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
            'after:left-[9px] after:w-[2px] after:translate-x-0',
            // Vertically clamp to the card border's STRAIGHT segment: the
            // card is inset mt-2/mb-2 and rounded-xl (12px), so a full
            // height line would overshoot past the rounded corners.
            'after:inset-y-auto after:top-5 after:bottom-5 after:rounded-full',
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
          defaultSize={sidebarOpen ? defaultSizes.sidebar : 0}
          minSize={10}
          collapsedSize={0}
          collapsible
          onCollapse={() => {
            if (sidebarOpen) onSidebarCollapse();
          }}
          className={cn('bg-background', !isResizing && 'transition-[flex-grow,min-width]')}
          style={{
            minWidth: sidebarOpen ? 280 : 0,
            // While dragging, kill the transition entirely. Removing only the
            // transition-property class is not enough: transition-property
            // defaults to `all`, so the inline duration alone would animate
            // every flex-grow update and make the drag lag behind the pointer.
            transitionDuration: isResizing ? '0ms' : transitionDuration,
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          <motion.div
            className={cn('h-full', !sidebarOpen && 'invisible pointer-events-none')}
            initial={false}
            animate={{ x: sidebarOpen ? 0 : '100%' }}
            aria-hidden={!sidebarOpen}
            transition={{
              duration: animatesSidebar ? 0.22 : 0,
              ease: [0.32, 0.72, 0, 1],
            }}
          >
            {secondaryPanel}
          </motion.div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {deleteConfirmDialog}
    </div>
  );
}
