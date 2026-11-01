import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { LayoutGroup, MotionConfig, motion, useDragControls } from 'framer-motion';
import { colors, shadow, sheen } from '@lody/ui/tokens/colors.stylex';
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
import { ScrollArea } from '@lody/ui/scroll-area';
import { Menu } from '@/ui/menu';
import { cn } from '@/lib/utils';
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';

export type SessionSidePanelTabItem = {
  id: string;
  label: string;
  kind:
    | 'files'
    | 'changes'
    | 'pr'
    | 'browser'
    | 'ios-simulator'
    | 'android-emulator'
    | 'session'
    | 'file'
    | 'diff';
  filePath?: string;
  closeable?: boolean;
  dirty?: boolean;
  saving?: boolean;
  conflict?: boolean;
  pending?: boolean;
  disabled?: boolean;
};

export type SessionSidePanelOption = Omit<SessionSidePanelTabItem, 'id' | 'kind'> & {
  id:
    | 'files'
    | 'changes'
    | 'pr'
    | 'browser'
    | 'ios-simulator'
    | 'android-emulator'
    | 'side-session';
  kind: 'files' | 'changes' | 'pr' | 'browser' | 'ios-simulator' | 'android-emulator' | 'session';
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

/** Two tab ids drawn as one group and shown side by side, in display order. */
export type SidePanelTabSplit = readonly [string, string];

/**
 * Only device previews pair up: each is a fixed-aspect screen that wastes most
 * of a wide panel on its own, and comparing iOS with Android is the use case.
 */
export const isSplittableSidePanelTabKind = (kind: SessionSidePanelTabItem['kind']): boolean =>
  kind === 'ios-simulator' || kind === 'android-emulator';

/** How far past its group a dragged member must travel before it detaches. */
const SPLIT_DETACH_MARGIN_PX = 16;

type TabSpan = { id: string; left: number; right: number };

export type SidePanelTabDropIntent =
  | { kind: 'split'; split: SidePanelTabSplit }
  | { kind: 'unsplit'; tabId: string }
  | null;

/**
 * What releasing a dragged tab at `pointerX` would do. A standalone tab dropped
 * onto a splittable tab joins it on the side it was dropped on; a group member
 * dragged across its partner swaps sides, and one dragged clear of the group
 * leaves it. Anywhere else the drop is a no-op and the tab snaps back.
 */
export function resolveSidePanelTabDropIntent(args: {
  draggedTabId: string;
  pointerX: number;
  split: SidePanelTabSplit | null;
  /** Splittable standalone tabs, excluding the dragged one. */
  targets: readonly TabSpan[];
  /** The group's span; required when the dragged tab is a member. */
  group: { left: number; right: number } | null;
}): SidePanelTabDropIntent {
  const { draggedTabId, pointerX, split, targets, group } = args;
  if (split?.includes(draggedTabId)) {
    if (!group) return null;
    if (
      pointerX < group.left - SPLIT_DETACH_MARGIN_PX ||
      pointerX > group.right + SPLIT_DETACH_MARGIN_PX
    ) {
      return { kind: 'unsplit', tabId: draggedTabId };
    }
    const partnerId = split[0] === draggedTabId ? split[1] : split[0];
    const middle = (group.left + group.right) / 2;
    const next: SidePanelTabSplit =
      pointerX < middle ? [draggedTabId, partnerId] : [partnerId, draggedTabId];
    return next[0] === split[0] ? null : { kind: 'split', split: next };
  }
  const target = targets.find(
    (span) => span.id !== draggedTabId && pointerX >= span.left && pointerX <= span.right
  );
  if (!target) return null;
  return {
    kind: 'split',
    split:
      pointerX < (target.left + target.right) / 2
        ? [draggedTabId, target.id]
        : [target.id, draggedTabId],
  };
}

/** The split only stands while both of its tabs are still in the strip. */
export function getEffectiveSidePanelTabSplit(
  split: SidePanelTabSplit | null,
  tabIds: readonly string[]
): SidePanelTabSplit | null {
  if (!split || split[0] === split[1]) return null;
  return tabIds.includes(split[0]) && tabIds.includes(split[1]) ? split : null;
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
  /** Tabs drawn as one group; omit to disable drag-to-split entirely. */
  split?: SidePanelTabSplit | null;
  /** A drop paired two tabs (or swapped a pair); `draggedTabId` moved. */
  onTabsSplit?: (split: SidePanelTabSplit, draggedTabId: string) => void;
  /** A group member was dragged out of its group. */
  onTabUnsplit?: (tabId: string) => void;
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
  tabDraggable: {
    touchAction: 'pan-y',
    userSelect: 'none',
  },
  tabDragging: {
    boxShadow: '0 4px 14px -4px rgb(0 0 0 / 0.28)',
  },
  tabDropTarget: {
    boxShadow: 'inset 0 0 0 1.5px hsl(var(--ring) / 0.75)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--ring)) 14%, transparent)',
  },
  // A split pair reads as one tab holding two: `@lody/ui`'s tab-strip tray
  // with the focused member as its one raised key.
  group: {
    position: 'relative',
    display: 'flex',
    height: '32px',
    flexShrink: 0,
    alignItems: 'center',
    gap: '2px',
    padding: '2px',
    borderRadius: 'calc(var(--radius-md) + 2px)',
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  groupInactive: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--foreground)) 3.5%, transparent)',
  },
  groupActive: {
    backgroundColor: colors.trayBackground,
  },
  groupDetaching: {
    boxShadow: 'inset 0 0 0 1px hsl(var(--border))',
    backgroundColor: 'transparent',
  },
  groupMember: {
    height: '26px',
  },
  groupMemberFocused: {
    backgroundColor: colors.trayRaised,
    backgroundImage: sheen.raised,
    boxShadow: shadow.raised,
    color: colors.label,
  },
  groupMemberBackground: {
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--foreground)) 4%, transparent)',
      },
    },
    color: colors.label,
  },
  groupMemberIdle: {
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--foreground)) 4%, transparent)',
      },
    },
    color: {
      default: 'hsl(var(--tab-inactive-foreground))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--tab-hover-foreground))',
      },
    },
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
    case 'android-emulator':
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

const TAB_LAYOUT_TRANSITION = {
  layout: { type: 'spring', stiffness: 520, damping: 42, mass: 0.8 },
  default: { duration: 0.18, ease: [0.4, 0, 0.2, 1] },
} as const;

const isSameDropIntent = (a: SidePanelTabDropIntent, b: SidePanelTabDropIntent): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind === 'unsplit') return b.kind === 'unsplit' && a.tabId === b.tabId;
  if (b.kind === 'unsplit') return false;
  return a.split[0] === b.split[0] && a.split[1] === b.split[1];
};

type SidePanelTabProps = {
  tab: SessionSidePanelTabItem;
  active: boolean;
  /** Member styling inside a split group; null for a standalone tab. */
  groupRole: 'focused' | 'background' | 'idle' | null;
  draggable: boolean;
  dragging: boolean;
  dropTarget: boolean;
  closeTabLabel: (tabLabel: string) => string;
  registerElement: (element: HTMLDivElement | null) => void;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onDragMove: (pointerX: number) => void;
  onDragEnd: (pointerX: number) => void;
};

function SidePanelTab({
  tab,
  active,
  groupRole,
  draggable,
  dragging,
  dropTarget,
  closeTabLabel,
  registerElement,
  onSelect,
  onClose,
  onDragMove,
  onDragEnd,
}: SidePanelTabProps) {
  const dragControls = useDragControls();
  // A drag ends with a click on the same element; swallow that one.
  const suppressClickRef = useRef(false);
  // A tab busy with its own lifecycle work (e.g. a side chat being closed) is
  // non-interactive until that work settles.
  const busy = tab.pending || tab.disabled;
  const saveStateLabel = tab.saving
    ? 'saving'
    : tab.conflict
      ? 'conflict'
      : tab.dirty
        ? 'dirty'
        : null;
  const pillStyle =
    groupRole === 'focused'
      ? styles.groupMemberFocused
      : groupRole === 'background'
        ? styles.groupMemberBackground
        : groupRole === 'idle'
          ? styles.groupMemberIdle
          : active
            ? tabPillStyles.active
            : tabPillStyles.inactive;

  return (
    <motion.div
      ref={registerElement}
      layout="position"
      layoutId={tab.id}
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      drag={draggable ? 'x' : false}
      dragControls={dragControls}
      dragListener={false}
      dragSnapToOrigin
      dragMomentum={false}
      whileDrag={{ scale: 1.04, zIndex: 2 }}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (!draggable || busy || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button')) return;
        dragControls.start(event);
      }}
      onDrag={(event) => {
        if ('clientX' in event) onDragMove(event.clientX);
      }}
      onDragEnd={(event) => {
        suppressClickRef.current = true;
        requestAnimationFrame(() => {
          suppressClickRef.current = false;
        });
        if ('clientX' in event) onDragEnd(event.clientX);
      }}
      className={cn(
        stylex.props(
          stylex.defaultMarker(),
          styles.tab,
          tab.closeable ? styles.tabPadded : styles.tabCompact,
          pillStyle,
          groupRole !== null && styles.groupMember,
          draggable && styles.tabDraggable,
          dragging && styles.tabDragging,
          dropTarget && styles.tabDropTarget,
          busy && styles.tabBusy
        ).className,
        WINDOW_DRAG_EXEMPT_CLASS
      )}
      onClick={() => {
        if (suppressClickRef.current) return;
        if (!busy) onSelect(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (!busy) onSelect(tab.id);
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
          tab.closeable && (tab.kind === 'file' || tab.kind === 'diff') && styles.monoLabel
        )}
      >
        {tab.label}
      </span>
      {tab.closeable ? (
        <button
          type="button"
          disabled={busy}
          {...stylex.props(styles.closeButton, active ? styles.closeVisible : styles.closeInactive)}
          aria-label={closeTabLabel(tab.label)}
          onClick={(event) => {
            event.stopPropagation();
            if (!busy) onClose(tab.id);
          }}
        >
          <X {...stylex.props(styles.closeIcon)} />
        </button>
      ) : null}
    </motion.div>
  );
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
  split = null,
  onTabsSplit,
  onTabUnsplit,
  moreSlot,
  endSlot,
  className,
}: SessionSidePanelTabBarProps) {
  const windowDragClass = useWindowDragRegionClass();
  const layoutGroupId = useId();
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const tabElementsRef = useRef(new Map<string, HTMLDivElement>());
  const groupRef = useRef<HTMLDivElement>(null);
  const viewportRef = useHorizontalWheelScroll();
  const [drag, setDrag] = useState<{
    tabId: string;
    intent: SidePanelTabDropIntent;
  } | null>(null);

  const effectiveSplit = getEffectiveSidePanelTabSplit(
    split,
    tabs.map((tab) => tab.id)
  );
  const splittableTabCount = tabs.filter((tab) => isSplittableSidePanelTabKind(tab.kind)).length;
  const splitEnabled = Boolean(onTabsSplit && onTabUnsplit) && splittableTabCount >= 2;
  const dropIntent = drag?.intent ?? null;
  const dropTargetId =
    drag && dropIntent?.kind === 'split' && !effectiveSplit?.includes(drag.tabId)
      ? dropIntent.split.find((id) => id !== drag.tabId)
      : undefined;

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const resolveIntent = (tabId: string, pointerX: number): SidePanelTabDropIntent => {
    const targets: { id: string; left: number; right: number }[] = [];
    for (const tab of tabs) {
      if (!isSplittableSidePanelTabKind(tab.kind) || effectiveSplit?.includes(tab.id)) continue;
      const rect = tabElementsRef.current.get(tab.id)?.getBoundingClientRect();
      if (rect) targets.push({ id: tab.id, left: rect.left, right: rect.right });
    }
    const groupRect = groupRef.current?.getBoundingClientRect() ?? null;
    return resolveSidePanelTabDropIntent({
      draggedTabId: tabId,
      pointerX,
      split: effectiveSplit,
      targets,
      group: groupRect ? { left: groupRect.left, right: groupRect.right } : null,
    });
  };

  const getTabProps = (tab: SessionSidePanelTabItem): Omit<SidePanelTabProps, 'groupRole'> => {
    const active = tab.id === activeTabId;
    return {
      tab,
      active,
      draggable: splitEnabled && isSplittableSidePanelTabKind(tab.kind) && !tab.pending,
      dragging: drag?.tabId === tab.id,
      dropTarget: dropTargetId === tab.id,
      closeTabLabel,
      registerElement: (element) => {
        if (element) tabElementsRef.current.set(tab.id, element);
        else tabElementsRef.current.delete(tab.id);
        if (active) activeTabRef.current = element;
      },
      onSelect: onTabSelect,
      onClose: onTabClose,
      onDragMove: (pointerX) => {
        const intent = resolveIntent(tab.id, pointerX);
        setDrag((current) =>
          current?.tabId === tab.id && isSameDropIntent(current.intent, intent)
            ? current
            : { tabId: tab.id, intent }
        );
      },
      onDragEnd: (pointerX) => {
        const intent = resolveIntent(tab.id, pointerX);
        setDrag(null);
        if (intent?.kind === 'split') onTabsSplit?.(intent.split, tab.id);
        else if (intent?.kind === 'unsplit') onTabUnsplit?.(intent.tabId);
      },
    };
  };

  return (
    <div className={cn(stylex.props(styles.container).className, windowDragClass, className)}>
      <ScrollArea
        axis="horizontal"
        compact
        viewportRef={viewportRef}
        className={stylex.props(styles.viewport).className}
      >
        <MotionConfig reducedMotion="user" transition={TAB_LAYOUT_TRANSITION}>
          <LayoutGroup id={layoutGroupId}>
            <div role="tablist" {...stylex.props(styles.tabList)}>
              {tabs.map((tab) => {
                if (effectiveSplit?.includes(tab.id)) {
                  // The group renders where its first member sits in strip order.
                  if (
                    tab.id !== tabs.find((candidate) => effectiveSplit.includes(candidate.id))?.id
                  )
                    return null;
                  const groupActive = effectiveSplit.includes(activeTabId ?? '');
                  return (
                    <motion.div
                      key="split-group"
                      ref={groupRef}
                      role="group"
                      layout="position"
                      initial={{ opacity: 0.6, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      data-side-panel-tab-split=""
                      {...stylex.props(
                        styles.group,
                        groupActive ? styles.groupActive : styles.groupInactive,
                        dropIntent?.kind === 'unsplit' && styles.groupDetaching
                      )}
                    >
                      {effectiveSplit.map((memberId) => {
                        const member = tabs.find((candidate) => candidate.id === memberId);
                        if (!member) return null;
                        return (
                          <SidePanelTab
                            key={member.id}
                            {...getTabProps(member)}
                            groupRole={
                              !groupActive
                                ? 'idle'
                                : member.id === activeTabId
                                  ? 'focused'
                                  : 'background'
                            }
                          />
                        );
                      })}
                    </motion.div>
                  );
                }
                return <SidePanelTab key={tab.id} {...getTabProps(tab)} groupRole={null} />;
              })}
            </div>
          </LayoutGroup>
        </MotionConfig>
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
