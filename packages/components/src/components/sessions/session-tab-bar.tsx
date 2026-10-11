import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { space, radius } from '@lody/ui/tokens/scales.stylex';
import { tabPillStyles } from '../shared/tab-pill-strip';
import { Plus, X, History, Undo2, FileDiff, Hand, ArchiveRestore } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { cn } from '@/lib/utils';
import { WINDOW_DRAG_EXEMPT_CLASS, useWindowDragRegionClass } from '@/ui/window-drag-region';
import { getSessionLaunchConfigLegacyFields, type SessionId, type SessionMeta } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { WORKSPACE_FOCUS_SCOPES } from '@/atoms/focus-layer';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { Tooltip } from '@lody/ui/tooltip';
import { useListKeyboardNavigation } from '@/ui/focus-scope';
import { ScrollArea } from '@/ui/scroll-area';
import { Popover } from '@lody/ui/popover';
import { AgentIcon } from '@/components/icons/agent-icon';
import { FileIcon } from '@/components/icons/file-icons';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { type DraftSessionTab, getDraftTabLabel } from '@/lib/session-draft-tabs';
import {
  closedSessionHasUnreadMessages,
  sessionHasUnreadMessages,
} from '@/lib/session-read-receipt';
import { isArchivedOutsideWorkspace, isSessionTabClosed } from '@/lib/session-tab-url';
import { AdaptiveTabStrip, AdaptiveTabStripItem } from './adaptive-tab-strip';
import { SESSION_PAGE_CONTAINER_CLASS } from './session-conversation-page';
import {
  armSessionMentionDrag,
  clearSessionMentionDrag,
  isPointOverSessionMentionDropLayer,
  startSessionMentionDrag,
} from '@/lib/session-mention-drag';

/** A viewer tab item (file or diff) displayed in the tab bar. */
export interface ViewerTabItem {
  id: string;
  type: 'file' | 'diff';
  label: string;
  filePath?: string;
  dirty?: boolean;
  saving?: boolean;
  conflict?: boolean;
}

type SessionTabBarVariant = 'mixed' | 'session' | 'viewer';
type MaybePromiseVoid = void | Promise<void>;

interface SessionTabBarProps {
  variant?: SessionTabBarVariant;
  parentSession: SessionMeta;
  childSessions: SessionMeta[];
  draftTabs: DraftSessionTab[];
  archivedChildSessions: SessionMeta[];
  activeTabSessionId: string;
  onTabSelect: (tabId: string) => MaybePromiseVoid;
  onNewTab: () => MaybePromiseVoid;
  onTabRename?: (sessionId: SessionId, title: string) => MaybePromiseVoid;
  onTabClose?: (tabId: string) => MaybePromiseVoid;
  onTabRestore?: (sessionId: SessionId) => MaybePromiseVoid;
  /** Unified tab order (session + viewer tab IDs). Called when any tabs are reordered via DnD. */
  onTabReorder?: (orderedTabIds: string[]) => void;
  /** Persisted unified tab order — determines display order of all sortable tabs. */
  tabOrder?: string[];
  /** Viewer tabs (file/diff) to display alongside session tabs */
  viewerTabs?: ViewerTabItem[];
  /** Currently active viewer tab id, or null if a session tab is active */
  activeViewerTabId?: string | null;
  /** Called when a viewer tab is selected */
  onViewerTabSelect?: (tabId: string) => MaybePromiseVoid;
  /** Called when a viewer tab is closed */
  onViewerTabClose?: (tabId: string) => MaybePromiseVoid;
  /** Optional element rendered at the far right of the tab bar. */
  rightSlot?: React.ReactNode;
  /** Optional element rendered before the tab list (e.g. sidebar expand). */
  leftSlot?: React.ReactNode;
  /** Extra classes on the bar root (e.g. macOS traffic-light inset). */
  className?: string;
  /**
   * Dropping a session tab onto the conversation inserts a mention of it.
   * Parent tabs use HTML5 drag; child session tabs share the strip's pointer
   * drag (horizontal drop on another tab still reorders).
   */
  onMentionSession?: (sessionId: string) => void;
}

const savingPulse = stylex.keyframes({ '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.5 } });

const styles = stylex.create({
  tab: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    minWidth: 0,
    height: '32px',
    alignItems: 'center',
    gap: space[1.5],
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 'var(--radius-md)',
    paddingInline: space[3],
    fontSize: '0.9em',
    cursor: 'default',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  soloTab: {
    color: 'hsl(var(--tab-active-foreground))',
  },
  tabIconSlot: {
    display: 'inline-flex',
    width: '12px',
    height: '12px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waitingIcon: {
    width: '12px',
    height: '12px',
    color: 'hsl(var(--status-warning))',
  },
  closedUnreadMark: {
    display: 'block',
  },
  unreadDot: {
    width: '8px',
    height: '8px',
    borderRadius: radius.full,
    backgroundColor: 'hsl(var(--primary))',
  },
  agentIcon: {
    width: '12px',
    height: '12px',
    opacity: 0.6,
  },
  compactIcon: { width: '12px', height: '12px' },
  iconContainer: { flexShrink: 0 },
  editInput: {
    width: '100%',
    minWidth: 0,
    backgroundColor: 'transparent',
    outline: {
      default: 'none',
      '@media (forced-colors: active)': '2px solid transparent',
    },
    outlineOffset: {
      default: null,
      '@media (forced-colors: active)': '2px',
    },
    fontSize: '0.9em',
  },
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tabInlineAction: {
    marginInlineStart: 'auto',
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    padding: '2px',
    opacity: {
      default: 0.7,
      ':hover': {
        default: null,
        '@media (hover: hover)': 1,
      },
    },
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
  hiddenAction: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':where([role="tab"]):hover')]: {
        default: null,
        '@media (hover: hover)': 1,
      },
    },
  },
  visibleAction: {
    opacity: 1,
  },
  closeGlyph: {
    width: '12px',
    height: '12px',
  },
  saveMark: {
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
    animationName: savingPulse,
    animationDuration: '2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  dirtyWarningMark: {
    backgroundColor: 'hsl(var(--status-warning))',
  },
  monoLabel: {
    fontFamily: 'var(--font-mono)',
  },
  barAction: {
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
    },
  },
  barActionRelative: {
    position: 'relative',
  },
  actionGlyph: {
    width: '16px',
    height: '16px',
  },
  bar: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    backgroundColor: 'hsl(var(--background))',
  },
  leadingSlot: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    paddingInlineStart: '12px',
  },
  leadingSlotRegular: {
    paddingInlineEnd: '8px',
  },
  trailingCluster: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
  },
  adaptiveStrip: {
    height: '44px',
    maxHeight: '100%',
  },
  popoverHeader: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border))',
    paddingInline: space[3],
    paddingBlock: '8px',
  },
  popoverTitle: {
    fontSize: '0.8em',
    fontWeight: 500,
    color: 'hsl(var(--popover-foreground) / 0.7)',
  },
  popoverList: {
    paddingBlock: '4px',
  },
  closedRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: '6px',
    textAlign: 'left',
    fontSize: '0.9em',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: {
      default: null,
      ':hover': {
        default: null,
        '@media (hover: hover)': 'hsl(var(--hover) / 0.6)',
      },
    },
  },
  closedStatus: {
    flexShrink: 0,
    color: 'hsl(var(--popover-foreground) / 0.65)',
  },
  closedLabel: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  closedTime: {
    flexShrink: 0,
    color: 'hsl(var(--popover-foreground) / 0.65)',
  },
  closedActionIcon: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    color: 'hsl(var(--popover-foreground) / 0.7)',
  },
  closedUnreadDot: {
    position: 'absolute',
    top: '4px',
    right: '4px',
    display: 'block',
    width: '8px',
    height: '8px',
    borderRadius: radius.full,
    backgroundColor: 'hsl(var(--primary))',
  },
  popoverScroll: {
    maxHeight: '15rem',
  },
});

function clientPointFromDragEnd(event: DragEndEvent): { x: number; y: number } | null {
  const source = event.activatorEvent;
  if (
    !source ||
    !('clientX' in source) ||
    !('clientY' in source) ||
    typeof source.clientX !== 'number' ||
    typeof source.clientY !== 'number'
  ) {
    return null;
  }
  return { x: source.clientX + event.delta.x, y: source.clientY + event.delta.y };
}

function getTabLabel(
  session: SessionMeta,
  isParent: boolean,
  defaultTitle: string,
  t?: (key: string, fallback: string) => string
): string {
  if (session.title?.trim()) return session.title.trim();
  if (isParent) return defaultTitle;
  return t?.('sessions.tabs.newTab', 'New Tab') ?? 'New Tab';
}

function formatRelativeTime(
  dateValue: number | string | undefined,
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string
): string {
  if (!dateValue) return '--';
  const date = typeof dateValue === 'number' ? new Date(dateValue) : new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return '--';
  const diffMs = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t('sessions.tabs.justNow', 'just now');
  if (minutes < 60) return t('sessions.tabs.minutesAgo', '{{count}}m ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('sessions.tabs.hoursAgo', '{{count}}h ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('sessions.tabs.daysAgo', '{{count}}d ago', { count: days });
}

/** Shared tab content renderer (used by both parent tab and sortable child tabs). */
function TabContent({
  session,
  defaultTitle,
  isActive,
  isEditing,
  isParent,
  editDraft,
  inputRef,
  onTabSelect,
  onTabRename,
  onTabClose,
  setEditDraft,
  setEditingTabId,
  commitRename,
  cancelRename,
  solo,
  html5MentionDrag = false,
  t,
}: {
  session: SessionMeta;
  defaultTitle: string;
  isActive: boolean;
  isEditing: boolean;
  isParent: boolean;
  solo: boolean;
  /** Parent tab is not in the dnd-kit strip, so it starts an HTML5 mention drag. */
  html5MentionDrag?: boolean;
  editDraft: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onTabSelect: (tabId: string) => MaybePromiseVoid;
  onTabRename?: (sessionId: SessionId, title: string) => MaybePromiseVoid;
  onTabClose?: (tabId: string) => MaybePromiseVoid;
  setEditDraft: (v: string) => void;
  setEditingTabId: (v: SessionId | null) => void;
  commitRename: () => void;
  cancelRename: () => void;
  t: (key: string, fallback: string) => string;
}) {
  const liveStatus = useAtomValue(sessionLiveStatusAtomFamily(session.id));
  const isWorking = liveStatus != null;
  const isWaiting = liveStatus?.type === 'requestPermission';
  /* A background sub-session tab is the only place its new output is announced:
     child tabs get no sidebar row of their own, so without this the finished
     answer stays invisible until the user happens to click the tab. Suppressed
     on the ACTIVE tab because that surface is the one clearing unread — the dot
     would be a flash between the click and the read receipt landing. */
  const isUnread = !isActive && sessionHasUnreadMessages(session);
  const label = getTabLabel(session, isParent, defaultTitle, t);
  // A lone tab has no close button: there is nothing to switch to, and closing
  // it would only swap the conversation for an empty draft.
  const showClose = onTabClose && !isEditing && !solo;
  const tabId = `session-tab-${session.id}`;
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(session.agentConfigId));
  const iconEnv = agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env;

  return (
    <div
      id={tabId}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-id={`session-tab:${session.id}`}
      data-scope-item="row"
      aria-label={label}
      draggable={html5MentionDrag && !isEditing}
      onDragStart={
        html5MentionDrag && !isEditing
          ? (event) => {
              startSessionMentionDrag(event, { sessionId: session.id, title: label });
            }
          : undefined
      }
      className={cn(
        stylex.props(
          stylex.defaultMarker(),
          styles.tab,
          solo ? styles.soloTab : isActive ? tabPillStyles.active : tabPillStyles.inactive
        ).className,
        !solo && WINDOW_DRAG_EXEMPT_CLASS
      )}
      onClick={() => {
        if (!isEditing) void onTabSelect(session.id);
      }}
      onKeyDown={(event) => {
        if (isEditing) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onTabSelect(session.id);
        }
      }}
      onDoubleClick={() => {
        if (onTabRename) {
          setEditDraft(session.title?.trim() || '');
          setEditingTabId(session.id);
        }
      }}
    >
      {/* ONE status slot, priority-ordered `waiting > working > unread > agent`,
          matching the sidebar row and the mobile tab sheet. `isWaiting` must be
          tested BEFORE `isWorking`: a permission request is also live presence,
          so the busy spinner would otherwise swallow the one state that needs
          the user. Waiting is the sidebar's `Hand`, NOT a dot: `--primary` and
          `--status-warning` are both amber in the shipped themes, so an amber
          waiting dot beside a primary unread dot read as the same marker.
          Fixed 12px box so every state keeps the label on the same pixel. */}
      <span {...stylex.props(styles.tabIconSlot)}>
        {isWaiting ? (
          <Hand {...stylex.props(styles.waitingIcon)} />
        ) : isWorking ? (
          <Spinner className="h-3 w-3 text-tab-active-accent" />
        ) : isUnread ? (
          <span
            data-session-tab-unread=""
            {...stylex.props(styles.unreadDot)}
            aria-label={t('sessions.unreadMessages', 'Unread messages')}
          />
        ) : (
          <AgentIcon
            cliType={session.cliType}
            agentType={session.agentType}
            env={iconEnv}
            {...stylex.props(styles.agentIcon)}
          />
        )}
      </span>
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (isImeComposingKeyboardEvent(e)) return;
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') cancelRename();
          }}
          {...stylex.props(styles.editInput)}
        />
      ) : (
        <span {...stylex.props(styles.truncate)}>{label}</span>
      )}
      {showClose && (
        <button
          type="button"
          {...stylex.props(styles.tabInlineAction, styles.hiddenAction)}
          onClick={(e) => {
            e.stopPropagation();
            void onTabClose?.(session.id);
          }}
          aria-label={t('sessions.tabs.closeTab', 'Close tab')}
        >
          <X {...stylex.props(styles.closeGlyph)} />
        </button>
      )}
    </div>
  );
}

function SessionAgentIcon({ session, className }: { session: SessionMeta; className?: string }) {
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(session.agentConfigId));
  return (
    <AgentIcon
      cliType={session.cliType}
      agentType={session.agentType}
      env={agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env}
      className={className}
    />
  );
}

function DraftTabContent({
  draft,
  isActive,
  onSelect,
  onClose,
  t,
  solo,
}: {
  draft: DraftSessionTab;
  isActive: boolean;
  solo: boolean;
  onSelect: (tabId: string) => MaybePromiseVoid;
  onClose?: (tabId: string) => MaybePromiseVoid;
  t: (key: string, fallback: string) => string;
}) {
  const showClose = onClose && !solo;
  const label = getDraftTabLabel(draft, t('sessions.tabs.newTab', 'New Tab'));
  const tabId = `draft-tab-${draft.id}`;
  // Drafts carry no env snapshot of their own; resolve the chosen config so the
  // brand icon matches what the created session will show.
  const draftAgentConfig = useAtomValue(getAgentMetaByIdAtomFamily(draft.agentConfigId));

  return (
    <div
      id={tabId}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-id={`draft-tab:${draft.id}`}
      data-scope-item="row"
      aria-label={label}
      className={cn(
        stylex.props(
          stylex.defaultMarker(),
          styles.tab,
          solo ? styles.soloTab : isActive ? tabPillStyles.active : tabPillStyles.inactive
        ).className,
        !solo && WINDOW_DRAG_EXEMPT_CLASS
      )}
      onClick={() => {
        void onSelect(draft.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onSelect(draft.id);
        }
      }}
    >
      <span {...stylex.props(styles.iconContainer)}>
        <AgentIcon
          cliType={draft.cliType}
          agentType={draft.agentType}
          brandId={draftAgentConfig?.brandId}
          env={draftAgentConfig?.env}
          {...stylex.props(styles.agentIcon)}
        />
      </span>
      <span {...stylex.props(styles.truncate)}>{label}</span>
      {showClose && (
        <button
          type="button"
          {...stylex.props(
            styles.tabInlineAction,
            isActive ? styles.visibleAction : styles.hiddenAction
          )}
          onClick={(event) => {
            event.stopPropagation();
            void onClose(draft.id);
          }}
          aria-label={t('sessions.tabs.closeTab', 'Close tab')}
        >
          <X {...stylex.props(styles.closeGlyph)} />
        </button>
      )}
    </div>
  );
}

/** Viewer tab content renderer (file/diff tabs). */
function ViewerTabContent({
  tab,
  isActive,
  onSelect,
  onClose,
  t,
  solo,
}: {
  tab: ViewerTabItem;
  isActive: boolean;
  solo: boolean;
  onSelect: (tabId: string) => MaybePromiseVoid;
  onClose?: (tabId: string) => MaybePromiseVoid;
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string;
}) {
  const showClose = onClose && !solo;
  const tabId = `viewer-tab-${tab.id}`;
  const saveStateLabel = tab.saving
    ? t('sessions.fileViewer.tabSaving', 'Saving')
    : tab.conflict
      ? t('sessions.fileViewer.tabSaveProblem', 'Save needs attention')
      : tab.dirty
        ? t('sessions.fileViewer.tabUnsaved', 'Unsaved changes')
        : null;

  return (
    <div
      id={tabId}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-id={`viewer-tab:${tab.id}`}
      data-scope-item="row"
      aria-label={saveStateLabel ? `${tab.label}, ${saveStateLabel}` : tab.label}
      className={cn(
        stylex.props(
          stylex.defaultMarker(),
          styles.tab,
          solo ? styles.soloTab : isActive ? tabPillStyles.active : tabPillStyles.inactive
        ).className,
        !solo && WINDOW_DRAG_EXEMPT_CLASS
      )}
      onClick={() => {
        void onSelect(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onSelect(tab.id);
        }
      }}
    >
      <span {...stylex.props(styles.iconContainer)}>
        {tab.type === 'file' && tab.filePath ? (
          <FileIcon filePath={tab.filePath} {...stylex.props(styles.compactIcon)} />
        ) : (
          <FileDiff {...stylex.props(styles.agentIcon)} />
        )}
      </span>
      {saveStateLabel ? (
        <span
          {...stylex.props(
            styles.saveMark,
            tab.conflict
              ? styles.conflictMark
              : tab.saving
                ? styles.savingMark
                : styles.dirtyWarningMark
          )}
          title={saveStateLabel}
          aria-hidden="true"
        />
      ) : null}
      <span {...stylex.props(styles.truncate, styles.monoLabel)}>{tab.label}</span>
      {showClose && (
        <button
          type="button"
          {...stylex.props(
            styles.tabInlineAction,
            isActive ? styles.visibleAction : styles.hiddenAction
          )}
          onClick={(e) => {
            e.stopPropagation();
            void onClose(tab.id);
          }}
          aria-label={t('sessions.fileViewer.closeTab', 'Close {{fileName}}', {
            fileName: tab.label,
          })}
        >
          <X {...stylex.props(styles.closeGlyph)} />
        </button>
      )}
    </div>
  );
}

/** Sortable DnD wrapper — used for both session and viewer tabs. */
function SortableDndWrapper({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, y: 0, scaleX: 1, scaleY: 1 } : null
    ),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  };

  return (
    <AdaptiveTabStripItem itemId={id} ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </AdaptiveTabStripItem>
  );
}

/** Union type for items in the unified sortable list. */
type SortableItemData =
  | { kind: 'session'; session: SessionMeta }
  | { kind: 'draft'; draft: DraftSessionTab }
  | { kind: 'viewer'; tab: ViewerTabItem };

export const SessionTabBar = memo(function SessionTabBar({
  variant = 'mixed',
  parentSession,
  childSessions,
  draftTabs,
  archivedChildSessions,
  activeTabSessionId,
  onTabSelect,
  onNewTab,
  onTabRename,
  onTabClose,
  onTabRestore,
  onTabReorder,
  tabOrder,
  viewerTabs,
  activeViewerTabId,
  onViewerTabSelect,
  onViewerTabClose,
  rightSlot,
  leftSlot,
  className,
  onMentionSession,
}: SessionTabBarProps) {
  const { t } = useTranslation();
  const windowDragClass = useWindowDragRegionClass();
  useListKeyboardNavigation({ scopeId: WORKSPACE_FOCUS_SCOPES.sessionConversation });
  const defaultTitle = t('sessions.untitled', 'Untitled session');
  const showSessionTabs = variant !== 'viewer';
  const workspaceArchived = parentSession.isArchived === true;
  const showParentTab = showSessionTabs && !isSessionTabClosed(parentSession, workspaceArchived);
  const showViewerTabs = variant !== 'session';
  // An archived workspace is review-only: no new conversation until Restore.
  const showNewTabButton = variant !== 'viewer' && !workspaceArchived;
  const showArchivedTabs = variant !== 'viewer';
  const [editingTabId, setEditingTabId] = useState<SessionId | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null) as React.RefObject<HTMLInputElement>;

  // Build a unified sorted list of the tabs shown in this bar.
  const sortableItems = useMemo(() => {
    const sessionMap = showSessionTabs
      ? new Map<string, SortableItemData>(
          childSessions
            .filter((s) => !isSessionTabClosed(s, workspaceArchived))
            .map((s) => [s.id, { kind: 'session', session: s }])
        )
      : new Map<string, SortableItemData>();
    const draftMap = showSessionTabs
      ? new Map<string, SortableItemData>(
          draftTabs.map((draft) => [draft.id, { kind: 'draft', draft }])
        )
      : new Map<string, SortableItemData>();
    const viewerMap = showViewerTabs
      ? new Map<string, SortableItemData>(
          (viewerTabs ?? []).map((tab) => [tab.id, { kind: 'viewer', tab }])
        )
      : new Map<string, SortableItemData>();

    const result: { id: string; data: SortableItemData }[] = [];
    const seen = new Set<string>();

    // Items in persisted order first
    if (tabOrder) {
      for (const id of tabOrder) {
        if (seen.has(id)) continue;
        const sessionItem = sessionMap.get(id);
        if (sessionItem) {
          result.push({ id, data: sessionItem });
          seen.add(id);
          continue;
        }
        const draftItem = draftMap.get(id);
        if (draftItem) {
          result.push({ id, data: draftItem });
          seen.add(id);
          continue;
        }
        const viewerItem = viewerMap.get(id);
        if (viewerItem) {
          result.push({ id, data: viewerItem });
          seen.add(id);
        }
      }
    }

    // Then remaining items not yet in the order
    for (const [id, data] of sessionMap) {
      if (!seen.has(id)) result.push({ id, data });
    }
    for (const [id, data] of draftMap) {
      if (!seen.has(id)) result.push({ id, data });
    }
    for (const [id, data] of viewerMap) {
      if (!seen.has(id)) result.push({ id, data });
    }

    return result;
  }, [
    childSessions,
    draftTabs,
    showSessionTabs,
    showViewerTabs,
    tabOrder,
    viewerTabs,
    workspaceArchived,
  ]);

  const sortableIds = useMemo(() => sortableItems.map((i) => i.id), [sortableItems]);
  const sessionIdByTabId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of sortableItems) {
      if (item.data.kind === 'session') map.set(item.id, item.data.session.id);
    }
    return map;
  }, [sortableItems]);

  // A lone tab spans the whole row, so it drops the active fill — a full-width
  // pill would paint the entire bar and break the one-canvas rule.
  const soloTab = (showParentTab ? 1 : 0) + sortableItems.length === 1;

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId, inputRef]);

  const commitRename = useCallback(() => {
    if (!editingTabId || !onTabRename) return;
    const trimmed = editDraft.trim();
    if (trimmed) {
      void onTabRename(editingTabId, trimmed);
    }
    setEditingTabId(null);
  }, [editingTabId, editDraft, onTabRename]);

  const cancelRename = useCallback(() => {
    setEditingTabId(null);
  }, []);

  // DnD: require 5px movement before drag starts to avoid interfering with click
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const sessionId = sessionIdByTabId.get(String(event.active.id));
      if (sessionId) armSessionMentionDrag(sessionId);
    },
    [sessionIdByTabId]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeId = String(active.id);
      const overId = over ? String(over.id) : null;
      const point = clientPointFromDragEnd(event);
      // Tab droppables stay the closest collision even when the pointer is in
      // the conversation below, so mention wins whenever the pointer is there.
      const droppedOnConversation =
        point != null && isPointOverSessionMentionDropLayer(point.x, point.y);
      const draggedSessionId = sessionIdByTabId.get(activeId);
      if (droppedOnConversation) {
        if (draggedSessionId) onMentionSession?.(draggedSessionId);
      } else if (
        overId != null &&
        activeId !== overId &&
        sortableIds.includes(activeId) &&
        sortableIds.includes(overId)
      ) {
        const oldIndex = sortableIds.indexOf(activeId);
        const newIndex = sortableIds.indexOf(overId);
        onTabReorder?.(arrayMove(sortableIds, oldIndex, newIndex));
      }
      clearSessionMentionDrag();
    },
    [onMentionSession, onTabReorder, sessionIdByTabId, sortableIds]
  );

  const handleDragCancel = useCallback(() => {
    clearSessionMentionDrag();
  }, []);

  const sharedTabProps = {
    defaultTitle,
    editDraft,
    inputRef,
    onTabSelect,
    onTabRename,
    onTabClose,
    setEditDraft,
    setEditingTabId,
    commitRename,
    cancelRename,
    solo: soloTab,
    t: t as (key: string, fallback: string) => string,
  };

  // In mixed mode, an active viewer tab deselects the session tabs.
  const hasActiveViewerTab = variant === 'mixed' && !!activeViewerTabId;
  const visibleTabIds = useMemo(
    () => (showParentTab ? [parentSession.id, ...sortableIds] : sortableIds),
    [parentSession.id, showParentTab, sortableIds]
  );
  const activeTabId =
    showViewerTabs && activeViewerTabId
      ? activeViewerTabId
      : showSessionTabs
        ? activeTabSessionId
        : null;

  const newTabButton = showNewTabButton ? (
    <button
      type="button"
      className={cn(stylex.props(styles.barAction).className, WINDOW_DRAG_EXEMPT_CLASS)}
      onClick={() => {
        void onNewTab();
      }}
      aria-label={t('sessions.tabs.newTab', 'New tab')}
    >
      <Plus {...stylex.props(styles.actionGlyph)} />
    </button>
  ) : null;

  return (
    <div
      className={cn(
        SESSION_PAGE_CONTAINER_CLASS,
        stylex.props(styles.bar).className,
        windowDragClass,
        className
      )}
    >
      {leftSlot ? (
        <div
          className={cn(
            stylex.props(styles.leadingSlot, !soloTab && styles.leadingSlotRegular).className,
            WINDOW_DRAG_EXEMPT_CLASS
          )}
        >
          {leftSlot}
        </div>
      ) : null}
      <AdaptiveTabStrip
        itemIds={visibleTabIds}
        activeItemId={activeTabId}
        role="tablist"
        aria-label={t('sessions.tabs.label', 'Session tabs')}
        // max-h-full keeps the strip inside a padded h-11 bar (macOS row pad).
        className={stylex.props(styles.adaptiveStrip).className}
        // A little more than the 6px tab gap, so the first tab reads as part of
        // the strip rather than attached to the sidebar edge.
        paddingLeft={8}
        paddingRight={8}
      >
        {showParentTab && (
          <AdaptiveTabStripItem itemId={parentSession.id}>
            <TabContent
              session={parentSession}
              isActive={!hasActiveViewerTab && parentSession.id === activeTabSessionId}
              isEditing={editingTabId === parentSession.id}
              isParent={true}
              html5MentionDrag={!soloTab}
              {...sharedTabProps}
            />
          </AdaptiveTabStripItem>
        )}
        {/* All sortable tabs (child sessions + viewer tabs) — unified DnD */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
            {sortableItems.map((item) =>
              item.data.kind === 'session' ? (
                <SortableDndWrapper key={item.id} id={item.id}>
                  <TabContent
                    session={item.data.session}
                    isActive={!hasActiveViewerTab && item.data.session.id === activeTabSessionId}
                    isEditing={editingTabId === item.data.session.id}
                    isParent={false}
                    {...sharedTabProps}
                  />
                </SortableDndWrapper>
              ) : item.data.kind === 'draft' ? (
                <SortableDndWrapper key={item.id} id={item.id}>
                  <DraftTabContent
                    draft={item.data.draft}
                    isActive={!hasActiveViewerTab && item.data.draft.id === activeTabSessionId}
                    solo={soloTab}
                    onSelect={onTabSelect}
                    onClose={onTabClose}
                    t={t as (key: string, fallback: string) => string}
                  />
                </SortableDndWrapper>
              ) : (
                <SortableDndWrapper key={item.id} id={item.id}>
                  <ViewerTabContent
                    tab={item.data.tab}
                    isActive={activeViewerTabId === item.data.tab.id}
                    solo={soloTab}
                    onSelect={onViewerTabSelect ?? (() => {})}
                    onClose={onViewerTabClose}
                    t={t}
                  />
                </SortableDndWrapper>
              )
            )}
          </SortableContext>
        </DndContext>
      </AdaptiveTabStrip>
      {/* Pinned right cluster: new-tab, then the archived-tabs history (only
          when closed tabs exist), then the caller's toolbar ("…" etc.). */}
      <div className={cn(stylex.props(styles.trailingCluster).className, WINDOW_DRAG_EXEMPT_CLASS)}>
        {newTabButton}
        {showArchivedTabs && archivedChildSessions.length > 0 && onTabRestore && (
          <ClosedTabsPopover
            archivedSessions={archivedChildSessions}
            workspaceArchived={workspaceArchived}
            onRestore={onTabRestore}
          />
        )}
        {rightSlot}
      </div>
    </div>
  );
});

export function ClosedTabsPopover({
  archivedSessions,
  workspaceArchived,
  onRestore,
}: {
  archivedSessions: SessionMeta[];
  /** Reopening a tab never unarchives; only archived children of a live workspace restore. */
  workspaceArchived: boolean;
  onRestore: (sessionId: SessionId) => MaybePromiseVoid;
}) {
  const { t } = useTranslation();
  const sorted = useMemo(
    () => [...archivedSessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [archivedSessions]
  );
  const hasUnread = archivedSessions.some(closedSessionHasUnreadMessages);
  const triggerLabel = t('sessions.tabs.closedTabs', 'Closed conversations');

  return (
    <Popover.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Popover.Trigger
              render={
                <button
                  type="button"
                  className={cn(
                    stylex.props(styles.barAction, styles.barActionRelative).className,
                    WINDOW_DRAG_EXEMPT_CLASS
                  )}
                  aria-label={
                    hasUnread
                      ? `${triggerLabel}: ${t('sessions.unreadMessages', 'Unread messages')}`
                      : triggerLabel
                  }
                >
                  <History {...stylex.props(styles.actionGlyph)} />
                  {hasUnread ? (
                    <span
                      aria-hidden
                      data-closed-tabs-unread=""
                      {...stylex.props(styles.closedUnreadDot)}
                    />
                  ) : null}
                </button>
              }
            />
          }
        />
        <Tooltip.Content side="bottom">
          {t('sessions.tabs.closedTabs', 'Closed conversations')}
        </Tooltip.Content>
      </Tooltip.Root>
      <Popover.Content align="end" className="w-72 p-0" sideOffset={4}>
        <div {...stylex.props(styles.popoverHeader)}>
          <p {...stylex.props(styles.popoverTitle)}>
            {t('sessions.tabs.closedTabs', 'Closed conversations')}
          </p>
        </div>
        <ScrollArea viewportClassName={stylex.props(styles.popoverScroll).className}>
          <div {...stylex.props(styles.popoverList)}>
            {sorted.map((session) => {
              const label = session.title?.trim() || t('sessions.tabs.newTab', 'New Tab');
              const time = formatRelativeTime(session.lastMessageAt ?? session.createdAt, t);
              const restoresArchive = isArchivedOutsideWorkspace(session, workspaceArchived);
              const ActionIcon = restoresArchive ? ArchiveRestore : Undo2;
              const actionLabel = restoresArchive
                ? t('archive.restore', 'Restore session')
                : t('sessions.tabs.reopenTab', 'Reopen conversation');
              return (
                <button
                  key={session.id}
                  type="button"
                  {...stylex.props(styles.closedRow)}
                  onClick={() => {
                    void onRestore(session.id);
                  }}
                  aria-label={`${actionLabel}: ${label}`}
                >
                  <span {...stylex.props(styles.closedStatus)}>
                    <ClosedConversationStatus session={session} />
                  </span>
                  <span {...stylex.props(styles.closedLabel)}>{label}</span>
                  <span {...stylex.props(styles.closedTime)}>{time}</span>
                  <ActionIcon {...stylex.props(styles.closedActionIcon)} />
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </Popover.Content>
    </Popover.Root>
  );
}

function ClosedConversationStatus({ session }: { session: SessionMeta }) {
  const { t } = useTranslation();
  const status = useAtomValue(sessionLiveStatusAtomFamily(session.id));
  if (status?.type === 'requestPermission')
    return (
      <Hand
        {...stylex.props(styles.waitingIcon)}
        aria-label={t('sessions.waitingPermission', 'Waiting for permission')}
      />
    );
  if (status) return <Spinner className="h-3 w-3" />;
  if (closedSessionHasUnreadMessages(session))
    return (
      <span
        {...stylex.props(styles.unreadDot, styles.closedUnreadMark)}
        aria-label={t('sessions.unreadMessages', 'Unread messages')}
      />
    );
  return (
    <SessionAgentIcon session={session} className={stylex.props(styles.compactIcon).className} />
  );
}
