import { memo, useEffect, useRef, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { space, radius } from '@lody/ui/tokens/scales.stylex';
import { tabPillStyles } from '../shared/tab-pill-strip';
import {
  FileDiff,
  Files,
  GitPullRequest,
  MessageSquare,
  MonitorPlay,
  Plus,
  Smartphone,
  X,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { FileIcon } from '@/components/icons/file-icons';
import { useHorizontalWheelScroll } from '@/hooks/use-horizontal-wheel-scroll';
import { ScrollArea } from '@/ui/scroll-area';
import { Menu } from '@/ui/menu';
import { cn } from '@/lib/utils';
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';

export type SessionSidePanelTabItem = {
  id: string;
  label: string;
  kind: 'files' | 'changes' | 'pr' | 'browser' | 'ios-simulator' | 'session' | 'file' | 'diff';
  filePath?: string;
  closeable?: boolean;
  dirty?: boolean;
  saving?: boolean;
  conflict?: boolean;
  pending?: boolean;
  disabled?: boolean;
};

export type SessionSidePanelOption = Omit<SessionSidePanelTabItem, 'id' | 'kind'> & {
  id: 'files' | 'changes' | 'pr' | 'browser' | 'ios-simulator' | 'side-session';
  kind: 'files' | 'changes' | 'pr' | 'browser' | 'ios-simulator' | 'session';
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

const pulse = stylex.keyframes({ '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.5 } });

const styles = stylex.create({
  emptyState: {
    containerName: 'empty-panel',
    containerType: 'inline-size',
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[6],
  },
  emptyContent: {
    width: '100%',
    maxWidth: '20rem',
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    fontWeight: 500,
    color: 'hsl(var(--foreground))',
  },
  emptyGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(1, minmax(0, 1fr))',
      '@container empty-panel (min-width: 320px)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: space[2],
    marginTop: '16px',
  },
  emptyAction: {
    display: 'flex',
    minHeight: '40px',
    alignItems: 'center',
    gap: space[2],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.7)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: {
      default: 'hsl(var(--background))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--hover))',
      },
      ':disabled:hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--background))',
      },
    },
    paddingInline: space[3],
    textAlign: 'left',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    color: {
      default: 'hsl(var(--foreground))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--hover-foreground))',
      },
      ':disabled:hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--foreground))',
      },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    outline: {
      default: null,
      ':focus-visible': {
        default: 'none',
        '@media (forced-colors: active)': '2px solid transparent',
      },
    },
    outlineOffset: {
      default: null,
      ':focus-visible': {
        default: null,
        '@media (forced-colors: active)': '2px',
      },
    },
    '--tw-ring-color': {
      default: null,
      ':focus-visible': 'hsl(var(--ring) / 0.4)',
    },
    '--tw-ring-shadow': {
      default: null,
      ':focus-visible':
        'var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentColor)',
    },
    boxShadow: {
      default: null,
      ':focus-visible':
        'var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)',
    },
    cursor: {
      default: null,
      ':disabled': 'not-allowed',
    },
    opacity: {
      default: null,
      ':disabled': 0.45,
    },
  },
  emptyActionLabel: {
    minWidth: 0,
  },
  container: {
    containerName: 'side-tabs',
    containerType: 'inline-size',
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: space[1],
    paddingInline: '8px',
  },
  viewport: {
    minWidth: 0,
    flex: 1,
  },
  tabList: {
    display: 'flex',
    width: 'max-content',
    minWidth: '100%',
    height: '40px',
    alignItems: 'center',
    gap: space[1.5],
  },
  tab: {
    position: 'relative',
    display: 'flex',
    height: '28px',
    maxWidth: {
      default: '180px',
      '@container side-tabs (width < 420px)': '175px',
    },
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1.5],
    borderRadius: 'var(--radius-md)',
    cursor: 'default',
    fontSize: '0.9em',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  tabPadded: {
    paddingInline: space[3],
  },
  tabCompact: {
    paddingInline: '8px',
  },
  tabBusy: {
    cursor: 'wait',
    opacity: 0.7,
  },
  iconSlot: {
    flexShrink: 0,
  },
  tabLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  monoLabel: {
    fontFamily: 'var(--font-mono)',
  },
  dirtyMark: {
    width: '6px',
    height: '6px',
    flexShrink: 0,
    borderRadius: radius.full,
  },
  conflictMark: {
    backgroundColor: 'hsl(var(--status-danger))',
  },
  savingMark: {
    backgroundColor: 'hsl(var(--status-info))',
    animationName: pulse,
    animationDuration: '2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  dirtyWarningMark: {
    backgroundColor: 'hsl(var(--status-warning))',
  },
  closeButton: {
    marginInlineStart: 'auto',
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    padding: '2px',
    transitionProperty: 'opacity, background-color, color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: {
      default: null,
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--muted-foreground) / 0.1)',
      },
    },
    color: {
      default: null,
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--tab-hover-foreground))',
      },
    },
  },
  closeInactive: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':where([role="tab"]):hover')]: {
        default: null,
        '@media (hover: hover)': 1,
      },
    },
  },
  closeVisible: {
    opacity: 1,
  },
  closeIcon: {
    width: '12px',
    height: '12px',
  },
  tabGlyph: {
    width: '14px',
    height: '14px',
  },
  tabGlyphDimmed: {
    width: '14px',
    height: '14px',
    opacity: 0.7,
  },
  addGlyph: {
    width: '16px',
    height: '16px',
  },
  slot: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
  },
  addButton: {
    display: 'flex',
    width: '28px',
    height: '28px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-md)',
    color: {
      default: 'hsl(var(--muted-foreground))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--hover-foreground))',
      },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: {
      default: null,
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--hover))',
      },
      ':disabled:hover': {
        default: null,
        '@media (hover: hover)': 'transparent',
      },
    },
    outline: {
      default: null,
      ':focus-visible': {
        default: 'none',
        '@media (forced-colors: active)': '2px solid transparent',
      },
    },
    outlineOffset: {
      default: null,
      ':focus-visible': {
        default: null,
        '@media (forced-colors: active)': '2px',
      },
    },
    '--tw-ring-color': {
      default: null,
      ':focus-visible': 'hsl(var(--ring) / 0.4)',
    },
    '--tw-ring-shadow': {
      default: null,
      ':focus-visible':
        'var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentColor)',
    },
    boxShadow: {
      default: null,
      ':focus-visible':
        'var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)',
    },
    cursor: {
      default: null,
      ':disabled': 'default',
    },
    opacity: {
      default: null,
      ':disabled': 0.35,
    },
  },
});

function SidePanelTabIcon({ tab }: { tab: SessionSidePanelTabItem }) {
  if (tab.pending) {
    return <Spinner className="h-3.5 w-3.5 opacity-70" />;
  }
  switch (tab.kind) {
    case 'files':
      return <Files {...stylex.props(styles.tabGlyphDimmed)} />;
    case 'changes':
    case 'diff':
      return <FileDiff {...stylex.props(styles.tabGlyphDimmed)} />;
    case 'pr':
      return <GitPullRequest {...stylex.props(styles.tabGlyphDimmed)} />;
    case 'browser':
      return <MonitorPlay {...stylex.props(styles.tabGlyphDimmed)} />;
    case 'ios-simulator':
      return <Smartphone {...stylex.props(styles.tabGlyphDimmed)} />;
    case 'session':
      return <MessageSquare {...stylex.props(styles.tabGlyphDimmed)} />;
    case 'file':
      return tab.filePath ? (
        <FileIcon filePath={tab.filePath} {...stylex.props(styles.tabGlyph)} />
      ) : (
        <Files {...stylex.props(styles.tabGlyphDimmed)} />
      );
  }

  return null;
}

export function SessionSidePanelEmptyState({
  panels,
  onPanelOpen,
  title,
}: {
  panels: SessionSidePanelOption[];
  onPanelOpen: (panelId: SessionSidePanelOption['id']) => void;
  title: string;
}) {
  return (
    <div {...stylex.props(styles.emptyState)}>
      <div {...stylex.props(styles.emptyContent)}>
        <div {...stylex.props(styles.emptyTitle)}>{title}</div>
        <div {...stylex.props(styles.emptyGrid)}>
          {panels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              disabled={panel.disabled}
              {...stylex.props(styles.emptyAction)}
              onClick={() => onPanelOpen(panel.id)}
            >
              <SidePanelTabIcon tab={panel} />
              <span {...stylex.props(styles.emptyActionLabel)}>{panel.label}</span>
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
  const viewportRef = useHorizontalWheelScroll();

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  return (
    <div className={cn(stylex.props(styles.container).className, windowDragClass, className)}>
      <ScrollArea
        scrollableX
        horizontalOnly
        viewportRef={viewportRef}
        className={stylex.props(styles.viewport).className}
        // Compact overlay bar: default horizontal track is too tall in this h-11 strip.
        horizontalScrollbarClassName="h-1 border-0 p-0"
        horizontalScrollbarThumbClassName="bg-[hsl(var(--scrollbar-thumb)/0.35)] hover:bg-[hsl(var(--scrollbar-thumb-hover)/0.5)]"
      >
        <div role="tablist" {...stylex.props(styles.tabList)}>
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
                  stylex.props(
                    stylex.defaultMarker(),
                    styles.tab,
                    tab.closeable ? styles.tabPadded : styles.tabCompact,
                    active ? tabPillStyles.active : tabPillStyles.inactive,
                    busy && styles.tabBusy
                  ).className,
                  WINDOW_DRAG_EXEMPT_CLASS
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
                <span {...stylex.props(styles.iconSlot)}>
                  <SidePanelTabIcon tab={tab} />
                </span>
                {saveStateLabel ? (
                  <span
                    {...stylex.props(
                      styles.dirtyMark,
                      tab.conflict
                        ? styles.conflictMark
                        : tab.saving
                          ? styles.savingMark
                          : styles.dirtyWarningMark
                    )}
                    aria-hidden="true"
                  />
                ) : null}
                <span
                  {...stylex.props(
                    styles.tabLabel,
                    tab.closeable &&
                      (tab.kind === 'file' || tab.kind === 'diff') &&
                      styles.monoLabel
                  )}
                >
                  {tab.label}
                </span>
                {tab.closeable ? (
                  <button
                    type="button"
                    disabled={busy}
                    {...stylex.props(
                      styles.closeButton,
                      active ? styles.closeVisible : styles.closeInactive
                    )}
                    aria-label={closeTabLabel(tab.label)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!busy) onTabClose(tab.id);
                    }}
                  >
                    <X {...stylex.props(styles.closeIcon)} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {moreSlot ? (
        <div className={cn(stylex.props(styles.slot).className, WINDOW_DRAG_EXEMPT_CLASS)}>
          {moreSlot}
        </div>
      ) : null}
      <Menu.Root>
        <Menu.Trigger
          render={
            <button
              type="button"
              disabled={availablePanels.length === 0}
              aria-label={addPanelLabel}
              className={cn(stylex.props(styles.addButton).className, WINDOW_DRAG_EXEMPT_CLASS)}
            >
              <Plus {...stylex.props(styles.addGlyph)} />
            </button>
          }
        >
          <button
            type="button"
            disabled={availablePanels.length === 0}
            aria-label={addPanelLabel}
            className={cn(stylex.props(styles.addButton).className, WINDOW_DRAG_EXEMPT_CLASS)}
          >
            <Plus {...stylex.props(styles.addGlyph)} />
          </button>
        </Menu.Trigger>
        <Menu.Content align="end" className="min-w-40">
          {availablePanels.map((panel) => (
            <Menu.Item
              key={panel.id}
              icon={<SidePanelTabIcon tab={panel} />}
              disabled={panel.disabled}
              onClick={() => onPanelOpen(panel.id)}
            >
              {panel.label}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Root>
      {endSlot ? (
        <div className={cn(stylex.props(styles.slot).className, WINDOW_DRAG_EXEMPT_CLASS)}>
          {endSlot}
        </div>
      ) : null}
    </div>
  );
});
