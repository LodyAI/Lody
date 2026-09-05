import { memo, useEffect, useRef, type ReactNode } from 'react';
import {
  FileDiff,
  Files,
  GitPullRequest,
  Loader2,
  MessageSquare,
  MonitorPlay,
  Plus,
  X,
} from 'lucide-react';
import { FileIcon } from '@/components/icons/file-icons';
import { ScrollArea } from '@/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';

export type SessionSidePanelTabItem = {
  id: string;
  label: string;
  kind: 'files' | 'changes' | 'pr' | 'browser' | 'session' | 'file' | 'diff';
  filePath?: string;
  closeable?: boolean;
  dirty?: boolean;
  saving?: boolean;
  conflict?: boolean;
  pending?: boolean;
  disabled?: boolean;
};

export type SessionSidePanelOption = Omit<SessionSidePanelTabItem, 'id' | 'kind'> & {
  id: 'files' | 'changes' | 'pr' | 'browser' | 'side-session';
  kind: 'files' | 'changes' | 'pr' | 'browser' | 'session';
};

const SIDE_SESSION_PANEL_PREFIX = 'side-session:';

export const getSideSessionPanelTabId = (sessionId: string): string =>
  `${SIDE_SESSION_PANEL_PREFIX}${sessionId}`;

export const parseSideSessionPanelTabId = (tabId: string): string | null =>
  tabId.startsWith(SIDE_SESSION_PANEL_PREFIX)
    ? tabId.slice(SIDE_SESSION_PANEL_PREFIX.length)
    : null;

export const isViewerTabId = (tabId: string): boolean =>
  tabId.startsWith('file:') || tabId.startsWith('diff:');

export type SidePanelTabSelection = {
  activeSidebarTabId: string | null;
  activeSideSessionId: string | null;
  activeViewerTabId: string | null;
};

/**
 * Resolves the complete right-panel selection in one step. Fixed panels, side
 * chats, and viewers share one surface, so activating one must clear the other
 * two even when the activation came from content rather than the tab strip.
 */
export function getSidePanelTabSelection(tabId: string | null): SidePanelTabSelection {
  if (tabId !== null && isViewerTabId(tabId)) {
    return {
      activeSidebarTabId: null,
      activeSideSessionId: null,
      activeViewerTabId: tabId,
    };
  }

  const sideSessionId = tabId === null ? null : parseSideSessionPanelTabId(tabId);
  if (sideSessionId) {
    return {
      activeSidebarTabId: null,
      activeSideSessionId: sideSessionId,
      activeViewerTabId: null,
    };
  }

  return {
    activeSidebarTabId: tabId,
    activeSideSessionId: null,
    activeViewerTabId: null,
  };
}

export function getSideChatLauncherState(args: {
  providerSupportsFork: boolean;
  machineOffline: boolean;
}): 'hidden' | 'disabled' | 'enabled' {
  if (!args.providerSupportsFork) return 'hidden';
  if (args.machineOffline) return 'disabled';
  return 'enabled';
}

export function getSidePanelTabCloseFallback(
  tabIds: readonly string[],
  closingTabId: string
): string | null {
  const closingIndex = tabIds.indexOf(closingTabId);
  if (closingIndex === -1) {
    return null;
  }
  return tabIds[closingIndex - 1] ?? tabIds[closingIndex + 1] ?? null;
}

export function getSidePanelTabStateAfterClose(
  tabIds: readonly string[],
  closingTabId: string
): { fallbackTabId: string | null; sidebarOpen: boolean } {
  if (!tabIds.includes(closingTabId)) {
    return { fallbackTabId: null, sidebarOpen: true };
  }
  const fallbackTabId = getSidePanelTabCloseFallback(tabIds, closingTabId);
  return { fallbackTabId, sidebarOpen: fallbackTabId !== null };
}

type SessionSidePanelTabBarProps = {
  tabs: SessionSidePanelTabItem[];
  activeTabId: string | null;
  /** Panels not yet open; omit/empty disables the + menu (e.g. landing preview). */
  availablePanels?: SessionSidePanelOption[];
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onPanelOpen?: (panelId: SessionSidePanelOption['id']) => void;
  addPanelLabel?: string;
  closeTabLabel: (tabLabel: string) => string;
  /** Sits immediately left of the + button; empty for tabs with no actions. */
  moreSlot?: ReactNode;
  endSlot?: ReactNode;
  className?: string;
};

const TAB_CLASS = `group relative flex h-7 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md text-[13px] transition-colors ${WINDOW_DRAG_EXEMPT_CLASS}`;
// Soft cool-gray pills on the white side panel (Linear-like), not heavy slate washes.
const ACTIVE_TAB_CLASS =
  'bg-foreground/[0.08] text-tab-active-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)]';
const INACTIVE_TAB_CLASS =
  'bg-foreground/[0.035] text-tab-inactive-foreground hover:bg-foreground/[0.06] hover:text-tab-hover-foreground';

function SidePanelTabIcon({ tab }: { tab: SessionSidePanelTabItem }) {
  if (tab.pending) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin opacity-70" />;
  }
  switch (tab.kind) {
    case 'files':
      return <Files className="h-3.5 w-3.5 opacity-70" />;
    case 'changes':
    case 'diff':
      return <FileDiff className="h-3.5 w-3.5 opacity-70" />;
    case 'pr':
      return <GitPullRequest className="h-3.5 w-3.5 opacity-70" />;
    case 'browser':
      return <MonitorPlay className="h-3.5 w-3.5 opacity-70" />;
    case 'session':
      return <MessageSquare className="h-3.5 w-3.5 opacity-70" />;
    case 'file':
      return tab.filePath ? (
        <FileIcon filePath={tab.filePath} className="h-3.5 w-3.5" />
      ) : (
        <Files className="h-3.5 w-3.5 opacity-70" />
      );
  }

  return null;
}

export function SessionSidePanelEmptyState({
  panels,
  onPanelOpen,
  title,
  description,
}: {
  panels: SessionSidePanelOption[];
  onPanelOpen: (panelId: SessionSidePanelOption['id']) => void;
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-xs text-center">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {panels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              disabled={panel.disabled}
              className="grid h-10 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md border border-border/70 bg-background px-3 text-left text-sm text-foreground transition-colors hover:bg-hover hover:text-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-background disabled:hover:text-foreground"
              onClick={() => onPanelOpen(panel.id)}
            >
              <SidePanelTabIcon tab={panel} />
              <span className="truncate">{panel.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export const SessionSidePanelTabBar = memo(function SessionSidePanelTabBar({
  tabs,
  activeTabId,
  availablePanels = [],
  onTabSelect,
  onTabClose,
  onPanelOpen = () => undefined,
  addPanelLabel = 'Add panel',
  closeTabLabel,
  moreSlot,
  endSlot,
  className,
}: SessionSidePanelTabBarProps) {
  const windowDragClass = useWindowDragRegionClass();
  const activeTabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  return (
    <div className={cn('flex min-w-0 items-center gap-1 px-2', windowDragClass, className)}>
      <ScrollArea
        scrollableX
        horizontalOnly
        className="min-w-0 flex-1"
        // Compact overlay bar: default horizontal track is too tall in this h-11 strip.
        horizontalScrollbarClassName="h-1 border-0 p-0"
        horizontalScrollbarThumbClassName="bg-[hsl(var(--scrollbar-thumb)/0.35)] hover:bg-[hsl(var(--scrollbar-thumb-hover)/0.5)]"
      >
        <div role="tablist" className="flex h-11 w-max min-w-full items-center gap-1.5">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            // A tab busy with its own lifecycle work (e.g. a side chat being
            // closed) is non-interactive until that work settles.
            const busy = tab.pending || tab.disabled;
            const saveStateLabel = tab.saving
              ? 'saving'
              : tab.conflict
                ? 'conflict'
                : tab.dirty
                  ? 'dirty'
                  : null;
            return (
              <div
                key={tab.id}
                ref={active ? activeTabRef : undefined}
                role="tab"
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                className={cn(
                  TAB_CLASS,
                  tab.closeable ? 'px-3' : 'px-2',
                  active ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS,
                  busy && 'cursor-wait opacity-70'
                )}
                onClick={() => {
                  if (!busy) onTabSelect(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (!busy) onTabSelect(tab.id);
                  }
                }}
              >
                <span className="shrink-0">
                  <SidePanelTabIcon tab={tab} />
                </span>
                {saveStateLabel ? (
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      tab.conflict
                        ? 'bg-status-danger'
                        : tab.saving
                          ? 'animate-pulse bg-status-info'
                          : 'bg-status-warning'
                    )}
                    aria-hidden="true"
                  />
                ) : null}
                <span
                  className={cn(
                    'truncate',
                    tab.closeable && (tab.kind === 'file' || tab.kind === 'diff') && 'font-mono'
                  )}
                >
                  {tab.label}
                </span>
                {tab.closeable ? (
                  <button
                    type="button"
                    disabled={busy}
                    className={cn(
                      'ml-auto shrink-0 rounded-sm p-0.5 transition-[opacity,background-color,color]',
                      'hover:bg-muted-foreground/10 hover:text-tab-hover-foreground',
                      active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    )}
                    aria-label={closeTabLabel(tab.label)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!busy) onTabClose(tab.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {moreSlot ? (
        <div className={cn('flex shrink-0 items-center', WINDOW_DRAG_EXEMPT_CLASS)}>{moreSlot}</div>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={availablePanels.length === 0}
            aria-label={addPanelLabel}
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent',
              WINDOW_DRAG_EXEMPT_CLASS
            )}
          >
            <Plus className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {availablePanels.map((panel) => (
            <DropdownMenuItem
              key={panel.id}
              className="gap-2"
              disabled={panel.disabled}
              onSelect={() => onPanelOpen(panel.id)}
            >
              <SidePanelTabIcon tab={panel} />
              <span>{panel.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {endSlot ? (
        <div className={cn('flex shrink-0 items-center', WINDOW_DRAG_EXEMPT_CLASS)}>{endSlot}</div>
      ) : null}
    </div>
  );
});
