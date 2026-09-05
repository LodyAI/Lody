import { cn } from '@/lib/utils';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Archive,
  ChevronDown,
  GitBranch,
  GitPullRequest,
  GripVertical,
  Link2,
  Loader2,
  LockKeyhole,
  Mail,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Users,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { TooltipProvider } from '@/ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/ui/context-menu';
import type {
  LocalProjectHistoryProvider,
  MachineId,
  PrStatus,
  SessionId,
  SessionPullRequestCiState,
  SessionPullRequestReadiness,
} from '@lody/shared';
import {
  ONLY_CHATS_KEY,
  sidebarCollapsedOpenedBySessionsAtom,
  sidebarShowFullListAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
} from '@/atoms/focus-layer';
import {
  buildOpenedBySessionTree,
  countOpenedByTreeRoots,
  hasOpenedByTreeNesting,
  normalizeSessionRowId,
  pinnedFirstRootRank,
  type OpenedBySessionTreeNode,
} from '@/lib/session-opened-by-tree';
import { startSessionMentionDrag } from '@/lib/session-mention-drag';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import { useIsMobile } from '@/hooks/use-mobile';
import { useStableNow } from '@/hooks/use-stable-now';
import { formatCompactRelativeTime, type RelativeTimeValue } from '@/lib/format-relative-time';
import {
  GitHubOwnerIcon,
  SessionPrIcon,
  SessionRowAuthorAvatar,
  SessionRowLeadingSlot,
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SessionMergeablePill,
  SessionOpenedByTreeRow,
  SessionRowOpenedByMenuItems,
  SidebarListSkeleton,
  buildSessionRowOpenedByTreeSlot,
} from '@/components/sidebar-row-shared';
import { SessionInfoHoverCard } from '@/components/session-info-hover-card';
import type { SessionSharingState } from '@/lib/session-sharing';
import {
  RenameSessionDialogView,
  type RenameSessionDialogTarget,
} from '@/components/sessions/rename-session-dialog';

export type { PrStatus };

export type SessionListRowOwner = {
  name?: string | null;
  image?: string | null;
};

export type SessionListRow = {
  sessionId: string;
  title: string;
  /**
   * PRECISE opener: the Session that created/opened this one
   * (`SessionMeta.openedBySessionId`). Presentation-only provenance; it is NOT
   * `parentSessionId` and must never be treated as one. Drives "Go to Opener
   * Session", so it keeps pointing at the exact opener even when that opener is
   * a child Tab with no sidebar row. Navigation pairs it with
   * `openedByRowSessionId` to open the root route and restore this exact Tab.
   * See `@/lib/session-opened-by-tree`.
   */
  openedBySessionId?: string | null;
  /**
   * Sidebar row this one nests under — the opener's ROOT Session when the
   * opener is a child Tab (child Tabs have no sidebar row), otherwise the opener
   * itself. This is the route half of child-Tab navigation as well as the
   * nesting target; it never replaces the precise provenance id. Resolved by
   * `buildSidebarOpenerRowResolver` in `sessions/session-list-rows.ts`.
   * Falls back to `openedBySessionId` when the caller did not resolve it.
   */
  openedByRowSessionId?: string | null;
  /** Machine the session runs on; the sidebar resolves it to `machineName`. */
  machineId?: MachineId;
  /** Resolved machine display name, surfaced in the desktop hover info card. */
  machineName?: string | null;
  repoFullName?: string | null;
  branchName: string;
  prUrl?: string | null;
  prNumber?: number | null;
  prStatus?: PrStatus | null;
  prCiState?: SessionPullRequestCiState | null;
  prReadiness?: SessionPullRequestReadiness | null;
  latestMessageAt: Date | number | string;
  addedLines: number;
  deletedLines: number;
  isWorking: boolean;
  hasUnreadMessages: boolean;
  isOffline: boolean;
  isWaitingPermission: boolean;
  isPinned?: boolean;
  isWorktree?: boolean;
  externalHistoryProvider?: LocalProjectHistoryProvider | null;
  owner?: SessionListRowOwner | null;
  sharing?: SessionSharingState;
};

export type SessionListRepoState = {
  repoFullName: string;
  collapsed: boolean;
};

export type SessionListRepoMove = {
  activeRepoFullName: string;
  overRepoFullName: string;
  fromIndex: number;
  toIndex: number;
  nextRepos: SessionListRepoState[];
};

export type SessionListPullRequestOpen = {
  sessionId: string;
  repoFullName: string | null;
  prUrl: string;
  prNumber: number | null;
};

export type SessionListProps = {
  sessions: SessionListRow[];
  repos: SessionListRepoState[];
  isLoading?: boolean;
  chatsCollapsed?: boolean;
  selectedSessionId?: string | null;
  /** Group key that should be highlighted (e.g. repo fullname or '__only_chats__') */
  activeGroupKey?: string | null;
  className?: string;
  onSelect?: (sessionId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  /** Navigate to a root Session while restoring the precise child Tab. */
  onNavigateSessionTab?: (sessionId: string, tabSessionId: string) => void;
  onToggleRepoCollapsed?: (repoFullName: string) => void;
  onToggleChatsCollapsed?: () => void;
  onArchiveSession?: (sessionId: string) => void;
  onMarkSessionUnread?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, nextTitle: string) => void | Promise<void>;
  /** Toggle pin state for a session. Receives the next desired state (true = pin, false = unpin). */
  onTogglePinSession?: (sessionId: string, nextPinned: boolean) => void;
  /**
   * Copy a shareable URL for the session. The parent owns URL construction so the
   * sidebar component can stay agnostic about workspace slugs and origins.
   */
  onCopySessionUrl?: (sessionId: string) => void;
  /** Open the share-with-team confirmation for a private session. */
  onShareSessionWithTeam?: (sessionId: string) => void;
  onNew?: (repoFullName?: string) => void;
  onMoveRepo?: (move: SessionListRepoMove) => void;
  onOpenPullRequest?: (request: SessionListPullRequestOpen) => void;
  /** Navigate to new session page with the given repo pre-selected (or chat mode if undefined) */
  onNavigateToNewSession?: (repoFullName?: string) => void;
  /**
   * Returns an internal href for a session row. When provided, rows render as real anchors
   * so middle-click and Cmd/Ctrl-click open in a new tab. Plain left-click still routes
   * through `onSelectSession` for SPA navigation. Return undefined to disable anchor mode
   * (e.g. on Electron where there is no browser tab concept yet).
   */
  getSessionHref?: (sessionId: string) => string | undefined;
  /**
   * Always-visible action rendered at the right end of the FIRST group's
   * header row (desktop sidebar filter trigger). Also rendered in a standalone
   * row above the loading skeleton so the control stays reachable.
   */
  headerAction?: ReactNode;
};

export type SessionRowGroup = {
  key: string;
  label: string;
  kind: 'repo' | 'chat';
  repoFullName: string | null;
  collapsed: boolean;
  sessions: SessionListRow[];
};

export const MAX_VISIBLE_SESSIONS = 5;

/** Tree accessors shared by the renderer and the keyboard navigation model. */
export const SESSION_ROW_OPENED_BY_TREE_ACCESSORS = {
  getId: (session: SessionListRow) => session.sessionId,
  getOpenedBySessionId: (session: SessionListRow) =>
    session.openedByRowSessionId ?? session.openedBySessionId ?? null,
} as const;

/**
 * Group ranking key. Matches `sortSessionRowsByLatestMessage` (pinned first,
 * then latest activity) so the tree's root ranking cannot undo that order.
 */
function sessionRowRootRank(session: SessionListRow): number {
  return pinnedFirstRootRank(getSortKey(session), session.isPinned);
}

/** Stable identity for a collapsed group's (absent) rows. */
const EMPTY_TREE_NODES: OpenedBySessionTreeNode<SessionListRow>[] = [];

/**
 * Rows a group renders, in render order, with their "opened by" tree geometry.
 * The preview cap counts TOP-LEVEL rows only, so a collapsed preview never
 * splits an opener from the Sessions it opened.
 */
export function getVisibleSessionGroupTree(
  group: SessionRowGroup,
  whetherShowFullList: boolean,
  collapsedOpenedBySessionIds?: Record<string, boolean>
): OpenedBySessionTreeNode<SessionListRow>[] {
  return buildOpenedBySessionTree(group.sessions, {
    ...SESSION_ROW_OPENED_BY_TREE_ACCESSORS,
    isCollapsed: (openerId) => collapsedOpenedBySessionIds?.[openerId] === true,
    rootRank: sessionRowRootRank,
    ...(whetherShowFullList ? {} : { maxRoots: MAX_VISIBLE_SESSIONS }),
  });
}

export function getVisibleSessionGroupRows(
  group: SessionRowGroup,
  whetherShowFullList: boolean,
  collapsedOpenedBySessionIds?: Record<string, boolean>
): SessionListRow[] {
  return getVisibleSessionGroupTree(group, whetherShowFullList, collapsedOpenedBySessionIds).map(
    (node) => node.item
  );
}

/** True when the group has more TOP-LEVEL rows than the compact preview shows. */
export function sessionGroupOverflowsPreview(group: SessionRowGroup): boolean {
  return (
    countOpenedByTreeRoots(group.sessions, SESSION_ROW_OPENED_BY_TREE_ACCESSORS) >
    MAX_VISIBLE_SESSIONS
  );
}

function normalizeRepoFullName(value: SessionListRow['repoFullName']): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function normalizePrUrl(value: SessionListRow['prUrl']): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function parseGitHubPrNumber(url: string): number | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function toDate(value: SessionListRow['latestMessageAt']): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getSortKey(session: SessionListRow): number {
  const date = toDate(session.latestMessageAt);
  return date ? date.getTime() : 0;
}

export function sortSessionRowsByLatestMessage(sessions: SessionListRow[]): SessionListRow[] {
  return [...sessions].sort((a, b) => {
    // Pinned sessions stay above the rest, so users can keep work-in-progress
    // chats anchored at the top regardless of when they were last touched.
    const aPinned = a.isPinned ? 1 : 0;
    const bPinned = b.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const byTime = getSortKey(b) - getSortKey(a);
    if (byTime !== 0) return byTime;
    const byTitle = a.title.localeCompare(b.title);
    if (byTitle !== 0) return byTitle;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

export function buildGroups(
  sessions: SessionListRow[],
  repos: SessionListRepoState[],
  chatsCollapsed: boolean,
  chatsLabel: string = 'Chats'
): SessionRowGroup[] {
  const sessionsByRepo = new Map<string, SessionListRow[]>();
  const onlyChats: SessionListRow[] = [];

  for (const session of sessions) {
    const repoFullName = normalizeRepoFullName(session.repoFullName);
    if (!repoFullName) {
      onlyChats.push(session);
      continue;
    }
    const list = sessionsByRepo.get(repoFullName);
    if (list) list.push(session);
    else sessionsByRepo.set(repoFullName, [session]);
  }

  const ordered: SessionRowGroup[] = [];

  if (onlyChats.length) {
    ordered.push({
      key: ONLY_CHATS_KEY,
      label: chatsLabel,
      kind: 'chat',
      repoFullName: null,
      collapsed: chatsCollapsed,
      sessions: sortSessionRowsByLatestMessage(onlyChats),
    });
  }

  const seen = new Set<string>();
  for (const repo of repos) {
    const repoName = repo.repoFullName.trim();
    if (!repoName) continue;
    seen.add(repoName);
    const repoSessions = sessionsByRepo.get(repoName);
    if (!repoSessions || repoSessions.length === 0) continue;
    ordered.push({
      key: repoName,
      label: repoName,
      kind: 'repo',
      repoFullName: repoName,
      collapsed: repo.collapsed,
      sessions: sortSessionRowsByLatestMessage(repoSessions),
    });
  }

  const remainingRepos = [...sessionsByRepo.keys()]
    .filter((repoFullName) => !seen.has(repoFullName))
    .sort((a, b) => a.localeCompare(b));
  for (const repoFullName of remainingRepos) {
    const repoSessions = sessionsByRepo.get(repoFullName);
    if (!repoSessions || repoSessions.length === 0) continue;
    ordered.push({
      key: repoFullName,
      label: repoFullName,
      kind: 'repo',
      repoFullName,
      collapsed: false,
      sessions: sortSessionRowsByLatestMessage(repoSessions),
    });
  }

  return ordered;
}

function reconcileShowFullListByGroups(
  current: Record<string, boolean>,
  groups: SessionRowGroup[]
): Record<string, boolean> {
  let next: Record<string, boolean> | null = null;

  for (const group of groups) {
    const previousValue = current[group.key] ?? false;
    const nextValue = group.collapsed ? false : previousValue;

    if (current[group.key] !== nextValue) {
      next ??= { ...current };
      next[group.key] = nextValue;
    }
  }

  return next ?? current;
}

// The worktree marker icon is intentionally not rendered here. SessionList only
// receives GitHub-bound or pure-chat sessions (local-project sessions are
// filtered out at the call site in loro-app-sidebar.tsx), and every GitHub
// session is a worktree by construction — so an inline icon on every row in
// the GitHub group is redundant noise. Local-project sessions get the icon
// elsewhere in LocalProjectSessionItem, where it's a meaningful distinction.
function SessionRowTime({
  latestMessageAt,
  className,
}: {
  latestMessageAt: RelativeTimeValue;
  className?: string;
}) {
  // Self-ticking on the shared minute timer: a tick re-renders only this label
  // instead of every row that used to receive `now` from the list root.
  const now = useStableNow();
  const relativeTime = formatCompactRelativeTime(latestMessageAt, now);
  return (
    <span className={cn('inline-flex items-center justify-end gap-1', className)}>
      <span className="select-none tabular-nums">{relativeTime}</span>
    </span>
  );
}

/**
 * Shallow-compares two props objects while ignoring `ignoredKeys`. Used by the
 * selection-scoped `memo` comparators below.
 */
export function shallowEqualExceptKeys<P extends object>(
  prev: P,
  next: P,
  ignoredKeys: ReadonlySet<string>
): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (ignoredKeys.has(key)) continue;
    if (!Object.is(prev[key as keyof P], next[key as keyof P])) return false;
  }
  return true;
}

const SELECTION_PROP_KEYS: ReadonlySet<string> = new Set(['selectedSessionId']);

/**
 * `memo` equality for sidebar session groups: a `selectedSessionId` change only
 * re-renders the group(s) containing the previously or newly selected row —
 * a session switch no longer re-renders every group in the list. All other
 * props fall back to identity comparison.
 */
function sessionGroupPropsEqual<
  P extends { selectedSessionId?: string | null; group: SessionRowGroup },
>(prev: P, next: P): boolean {
  if (!shallowEqualExceptKeys(prev, next, SELECTION_PROP_KEYS)) return false;
  if (prev.selectedSessionId === next.selectedSessionId) return true;
  const contains = (id: string | null | undefined) =>
    id != null && next.group.sessions.some((session) => session.sessionId === id);
  return !contains(prev.selectedSessionId) && !contains(next.selectedSessionId);
}

type SessionGroupSectionProps = {
  group: SessionRowGroup;
  selectedSessionId?: string | null;
  activeGroupKey?: string | null;
  whetherShowFullList: boolean;
  onSelectSession?: (sessionId: string) => void;
  onNavigateSessionTab?: (sessionId: string, tabSessionId: string) => void;
  onToggleRepoCollapsed?: (repoFullName: string) => void;
  onToggleChatsCollapsed?: () => void;
  onArchiveSession?: (sessionId: string) => void;
  onMarkSessionUnread?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, nextTitle: string) => void | Promise<void>;
  onTogglePinSession?: (sessionId: string, nextPinned: boolean) => void;
  onCopySessionUrl?: (sessionId: string) => void;
  onShareSessionWithTeam?: (sessionId: string) => void;
  onNew?: (repoFullName?: string) => void;
  onNavigateToNewSession?: (repoFullName?: string) => void;
  onOpenPullRequest?: (request: SessionListPullRequestOpen) => void;
  onToggleFullList?: (groupKey: string) => void;
  /** Opener session ids whose opened Sessions are hidden. */
  collapsedOpenedBySessionIds: Record<string, boolean>;
  onToggleOpenedBySessions?: (openerSessionId: string) => void;
  getSessionHref?: (sessionId: string) => string | undefined;
  dragHandle?: ReactNode;
  archiveTooltipLabel: string;
  archiveActionLabel: string;
  archiveConfirmLabel: string;
  contextMenuLabels: ContextMenuLabels;
  isMobile: boolean;
  trailingContent?: ReactNode;
  /**
   * Always-visible action at the right end of the header row, after the
   * hover-revealed trailing/"+" affordances. Lives outside the clickable
   * header area so activating it never toggles/navigates the group.
   */
  headerAction?: ReactNode;
};

export type ContextMenuLabels = {
  openPr: string;
  rename: string;
  pin: string;
  unpin: string;
  archive: string;
  markUnread: string;
  copyUrl: string;
  shareWithTeam: string;
  onlyOwnerCanShare: string;
  registerDeviceToShare: string;
  loadingSharing: string;
  copyBranch: string;
  goToOpenerSession: string;
};

const SessionGroupSection = memo(function SessionGroupSection({
  group,
  selectedSessionId,
  activeGroupKey,
  whetherShowFullList,
  onSelectSession,
  onNavigateSessionTab,
  onToggleRepoCollapsed,
  onToggleChatsCollapsed,
  onArchiveSession,
  onMarkSessionUnread,
  onRenameSession,
  onTogglePinSession,
  onCopySessionUrl,
  onShareSessionWithTeam,
  onNew,
  onNavigateToNewSession,
  onOpenPullRequest,
  onToggleFullList,
  collapsedOpenedBySessionIds,
  onToggleOpenedBySessions,
  getSessionHref,
  dragHandle,
  archiveTooltipLabel,
  archiveActionLabel,
  archiveConfirmLabel,
  contextMenuLabels,
  isMobile,
  trailingContent,
  headerAction,
}: SessionGroupSectionProps) {
  const { t } = useTranslation();
  const moreActionsLabel = t('sessions.moreActions', 'More actions');
  const showGroupHeaderIcon = group.kind === 'repo';
  const [renameTarget, setRenameTarget] = useState<RenameSessionDialogTarget | null>(null);
  const beginRename = useCallback((sessionId: string, currentTitle: string) => {
    setRenameTarget({ sessionId: sessionId as SessionId, initialTitle: currentTitle });
  }, []);
  const isActiveGroup = activeGroupKey === group.key;
  const showActiveGroupState = isActiveGroup && !isMobile;
  const canToggle =
    group.kind === 'repo'
      ? typeof onToggleRepoCollapsed === 'function'
      : typeof onToggleChatsCollapsed === 'function';
  const canNavigate = typeof onNavigateToNewSession === 'function';
  const canCreateNew = typeof onNew === 'function';
  const handleToggleGroup = () => {
    if (!canToggle) return;
    if (group.kind === 'repo' && group.repoFullName) {
      onToggleRepoCollapsed?.(group.repoFullName);
      return;
    }
    if (group.kind === 'chat') onToggleChatsCollapsed?.();
  };
  const handleNavigate = () => {
    onNavigateToNewSession?.(group.repoFullName ?? undefined);
  };

  const isSelectable = typeof onSelectSession === 'function';
  // whetherShowFullList keeps each group in a compact preview by default (latest N),
  // and only reveals the full list after the user explicitly expands it. The cap
  // counts TOP-LEVEL rows, so an opener never gets separated from the Sessions
  // it opened.
  //
  // `group` is a fresh object on every sidebar data change (live status, new
  // message), so without a memo these O(n) resolutions would re-run at
  // agent-activity frequency just to show five rows. A collapsed group renders
  // nothing, so it skips them entirely.
  const { canToggleFullList, visibleNodes, showTreeGutter } = useMemo(() => {
    if (group.collapsed) {
      return { canToggleFullList: false, visibleNodes: EMPTY_TREE_NODES, showTreeGutter: false };
    }
    const nodes = getVisibleSessionGroupTree(
      group,
      whetherShowFullList,
      collapsedOpenedBySessionIds
    );
    return {
      canToggleFullList: sessionGroupOverflowsPreview(group),
      visibleNodes: nodes,
      // Only a group that actually contains an MCP-opened Session enables the
      // tree wrapper. Within it, unrelated top-level rows keep flat geometry.
      showTreeGutter: hasOpenedByTreeNesting(nodes),
    };
  }, [collapsedOpenedBySessionIds, group, whetherShowFullList]);
  const toggleListLabel = whetherShowFullList
    ? t('sessions.showLess', 'Show less')
    : t('sessions.showAll', 'Show all ({{count}})', { count: group.sessions.length });
  const resolvedTrailingContent = trailingContent ?? (group.collapsed ? null : dragHandle);
  // Repo group labels (e.g. "loro-dev/loro") name concrete content, but dark-mode
  // resting chrome should still recede behind the conversation. Hover and active
  // states restore full contrast. "Chats" uses the full muted token (same as
  // SidebarSectionHeader) — not an extra /55 fade on top of muted.
  const headerBaseColorClass =
    group.kind === 'repo'
      ? 'text-sidebar-foreground dark:text-sidebar-foreground/75'
      : 'text-sidebar-foreground-muted';
  // Typography splits with color: repo headers read as content (xs semibold),
  // the "Chats" header reads as section chrome (13px medium) so
  // section labels visually recede from titles at a glance.
  const headerTypographyClass =
    group.kind === 'repo' ? 'text-xs font-semibold' : 'text-[13px] font-medium';
  const headerToggleHoverClass =
    group.kind === 'repo' ? 'hover:text-sidebar-hover-foreground' : 'hover:text-sidebar-foreground';

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5',
        group.collapsed ? 'mb-1 last:mb-0' : 'mb-2.5 last:mb-0'
      )}
    >
      <div className="group flex h-7 items-center">
        <div
          role={canNavigate || canToggle ? 'button' : undefined}
          tabIndex={canNavigate || canToggle ? 0 : -1}
          data-id={`group:${group.key}`}
          data-scope-item="row"
          data-sidebar-group-key={group.key}
          className={cn(
            'relative flex h-7 w-full select-none items-center gap-1 rounded-md px-2 text-left',
            'border border-transparent',
            'min-w-0 flex-1 transition-colors',
            headerTypographyClass,
            showActiveGroupState
              ? 'cursor-pointer border-sidebar-ring/30 bg-sidebar-selection text-sidebar-selection-foreground hover:bg-sidebar-selection'
              : canNavigate
                ? cn(
                    'cursor-pointer bg-transparent',
                    headerBaseColorClass,
                    !isMobile && 'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground'
                  )
                : canToggle
                  ? cn(
                      'cursor-pointer bg-transparent',
                      headerBaseColorClass,
                      !isMobile && headerToggleHoverClass
                    )
                  : cn('cursor-default bg-transparent', headerBaseColorClass)
          )}
          onClick={canNavigate ? handleNavigate : handleToggleGroup}
          onKeyDown={
            canNavigate
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleNavigate();
                  }
                }
              : canToggle
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleToggleGroup();
                    }
                  }
                : undefined
          }
        >
          {showGroupHeaderIcon ? (
            <button
              type="button"
              className="relative flex h-5 w-5 shrink-0 items-center justify-center"
              onClick={
                canToggle
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleToggleGroup();
                    }
                  : undefined
              }
            >
              <GitHubOwnerIcon
                repoFullName={group.repoFullName}
                className={cn(
                  // Left-anchored (not centered in the 20px button) so its left edge
                  // lines up with the session rows' leading status slot below.
                  'absolute left-0 top-1/2 -translate-y-1/2 h-3.5 w-3.5 transition-opacity duration-100',
                  // Mobile: chevron is always shown so the owner avatar must hide
                  // permanently to avoid the two icons overlapping.
                  canToggle && isMobile
                    ? 'opacity-0'
                    : cn('opacity-80', canToggle && 'group-hover:opacity-0')
                )}
              />
              {canToggle && (
                <ChevronDown
                  className={cn(
                    'absolute left-0 top-1/2 -translate-y-1/2 h-4 w-4',
                    'transition-[opacity,translate,scale] duration-150 ease-out',
                    isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    group.collapsed ? '-rotate-90' : 'rotate-0'
                  )}
                />
              )}
            </button>
          ) : null}
          <span className="min-w-0 truncate text-left">{group.label}</span>
          {!showGroupHeaderIcon && canToggle ? (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-current',
                'transition-[opacity,translate,scale] duration-150 ease-out',
                group.collapsed || isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                // Chats is a top-level sidebar section, so its collapsed chevron
                // stays visible without hover.
                group.collapsed ? '-rotate-90' : 'rotate-0'
              )}
              aria-hidden="true"
            />
          ) : null}
          <span className="flex-1" aria-hidden="true" />
        </div>

        {resolvedTrailingContent}

        {canCreateNew && (
          <button
            type="button"
            className={cn(
              'ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm',
              'text-sidebar-foreground-muted/80 transition-[opacity,background-color,color] duration-100',
              'opacity-0 pointer-events-none',
              'group-hover:opacity-100 group-hover:pointer-events-auto',
              'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40'
            )}
            aria-label="New session"
            onClick={() => onNew?.(group.repoFullName ?? undefined)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}

        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>

      {!group.collapsed && (
        <div className="flex flex-col gap-px">
          {visibleNodes.map((node) => {
            const session = node.item;
            const openerSessionId = normalizeSessionRowId(session.openedBySessionId);
            const openerRootSessionId =
              normalizeSessionRowId(session.openedByRowSessionId) ?? openerSessionId;
            const isSelected = session.sessionId === selectedSessionId;
            const showSelectedState = isSelected && !isMobile;
            const prUrl = normalizePrUrl(session.prUrl);
            const prNumber =
              typeof session.prNumber === 'number' && Number.isFinite(session.prNumber)
                ? session.prNumber
                : prUrl
                  ? parseGitHubPrNumber(prUrl)
                  : null;
            const prStatus = session.prStatus ?? 'open';
            const hasPr = Boolean(prUrl);
            const hasChanges = session.addedLines !== 0 || session.deletedLines !== 0;
            // A merged/closed PR can leave a stale "clean/mergeable" record
            // in `pullRequestState` (the webhook sets status='merged' but
            // can't clear that field, and the poller stops observing terminal
            // PRs). Gate the pill on the PR still being live.
            const isMergeable =
              hasPr &&
              session.prReadiness === 'y' &&
              prStatus !== 'merged' &&
              prStatus !== 'closed';
            const showMergeablePill = isMergeable && !isSelected;
            const canArchive = typeof onArchiveSession === 'function';
            const canMarkUnread =
              typeof onMarkSessionUnread === 'function' && !session.hasUnreadMessages;
            const showInlineArchive = canArchive && !isMobile;
            const isChatSession = group.kind === 'chat';
            // Copy URL stays available for private sessions (the link still
            // works for the owner); sharing is a separate menu item shown only
            // while the conversation isn't team-visible.
            const shareMenuState = !session.sharing
              ? null
              : session.sharing.visibility === 'unknown'
                ? 'loading'
                : session.sharing.visibility === 'team'
                  ? null
                  : session.sharing.privateReason === 'machine-not-registered'
                    ? 'unregistered'
                    : session.sharing.canManage
                      ? 'share'
                      : 'owner-only';
            // Stretched-link pattern: a transparent absolute `<a>` overlays the row so
            // browsers can handle middle/Cmd-click natively (open in new tab). Plain left
            // click is intercepted via preventDefault and routed through onSelectSession for
            // SPA navigation; modified clicks fall through untouched.
            //
            // Rejected alternatives:
            //   - Wrap row content directly in `<a>`: nested interactive elements (the
            //     archive button, PR badge, branch-name copy) break the no-`<a>`-in-`<a>`
            //     rule and make accessibility/right-click fragile.
            //   - `pointer-events: none` on `<a>` + handlers on parent: kills native middle-
            //     click new-tab behavior, since the browser only triggers it when the click
            //     event actually reaches the anchor.
            //
            // The overlay sits at z-10; tooltip-bearing or otherwise interactive children
            // (archive button wrapper, PR badge, BranchName, OwnerAvatar) escape above it
            // with `relative z-20` so their hover/click events still fire. Any new
            // interactive child added inside an anchored row needs the same treatment.
            const sessionHref = isSelectable ? getSessionHref?.(session.sessionId) : undefined;
            const useAnchor = typeof sessionHref === 'string' && sessionHref.length > 0;
            const renderTitle = (extraClassName?: string) => (
              <span className={cn('truncate', extraClassName)}>{session.title}</span>
            );
            const handleAnchorClick = useAnchor
              ? (event: ReactMouseEvent<HTMLAnchorElement>) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  ) {
                    return;
                  }
                  event.preventDefault();
                  onSelectSession?.(session.sessionId);
                }
              : undefined;
            // Mobile keeps swipe-to-archive as the only row gesture; the context
            // menu (and its ⋯ button) is desktop-only. Computed before the row so
            // the leading slot can show the ⋯ affordance.
            const canGoToOpener = Boolean(openerSessionId && isSelectable);
            const openedByTreeSlot = buildSessionRowOpenedByTreeSlot(
              node,
              t,
              onToggleOpenedBySessions
                ? () => onToggleOpenedBySessions(session.sessionId)
                : undefined
            );
            const openedByOpener = openedByTreeSlot?.kind === 'opener' ? openedByTreeSlot : null;
            const canToggleOpenedSessions = openedByOpener !== null;
            const hasStandardMenuActions = Boolean(
              onRenameSession ||
              onTogglePinSession ||
              onArchiveSession ||
              canMarkUnread ||
              onCopySessionUrl ||
              shareMenuState ||
              session.branchName ||
              canGoToOpener ||
              (onOpenPullRequest && prUrl)
            );
            const hasMenuActions = !isMobile && (hasStandardMenuActions || canToggleOpenedSessions);
            const row = (
              <div
                key={session.sessionId}
                role={!useAnchor && isSelectable ? 'button' : undefined}
                tabIndex={!useAnchor && isSelectable ? 0 : undefined}
                aria-disabled={!isSelectable ? true : undefined}
                aria-current={isSelected ? 'page' : undefined}
                data-id={`session:${session.sessionId}`}
                data-scope-item="row"
                data-sidebar-session-id={session.sessionId}
                // Drag a conversation onto a chat surface to mention it there.
                draggable
                onDragStart={(event) =>
                  startSessionMentionDrag(event, {
                    sessionId: session.sessionId,
                    title: session.title,
                  })
                }
                className={cn(
                  'group relative w-full rounded-md text-left',
                  // Both chat and repo rows are a single line now; the repo row's
                  // low-signal metadata (time / repo / branch / PR) moves to the
                  // desktop hover info card so both organize modes read equally compact.
                  'px-2 py-1',
                  'border border-transparent bg-transparent',
                  !showSelectedState &&
                    isSelectable &&
                    !isMobile &&
                    'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
                  showSelectedState &&
                    'border-sidebar-foreground/10 bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/10',
                  // Keyboard-only focus ring. Plain :focus-within also matches
                  // after a mouse click (the overlay <a> keeps focus), which
                  // left a permanent inset ring on the selected row that read
                  // as a misplaced border.
                  useAnchor &&
                    'has-[a:focus-visible]:outline-hidden has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-sidebar-ring/40',
                  !isSelectable && 'cursor-default',
                  isSelectable && 'cursor-pointer'
                )}
                onClick={
                  useAnchor
                    ? undefined
                    : () => {
                        if (!isSelectable) return;
                        onSelectSession?.(session.sessionId);
                      }
                }
                onKeyDown={
                  useAnchor
                    ? undefined
                    : (e) => {
                        if (!isSelectable) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectSession?.(session.sessionId);
                        }
                      }
                }
              >
                {useAnchor && sessionHref ? (
                  <a
                    href={sessionHref}
                    aria-label={session.title}
                    // The overlay anchor covers the row, so it is what a drag
                    // starts on; left draggable it would drag its link instead.
                    draggable={false}
                    className="absolute inset-0 z-10 rounded-md focus:outline-hidden focus-visible:shadow-none"
                    onClick={handleAnchorClick}
                  />
                ) : null}
                <div className="flex min-w-0 items-center gap-1.5">
                  <SessionRowLeadingSlot
                    isWaitingPermission={session.isWaitingPermission}
                    isWorking={session.isWorking}
                    hasUnreadMessages={session.hasUnreadMessages}
                    showMenuButton={hasMenuActions}
                    menuLabel={moreActionsLabel}
                    openedByTree={openedByTreeSlot}
                  />
                  <div
                    className={cn(
                      'min-w-0 flex-1 flex items-center gap-1 truncate text-sm',
                      showSelectedState
                        ? 'text-sidebar-selection-foreground'
                        : 'text-sidebar-foreground dark:text-sidebar-foreground/75'
                    )}
                    // Double-click to rename is scoped to the title only, so it can't
                    // be triggered by double-clicking the Archive confirm button.
                    onDoubleClick={(e) => {
                      if (typeof onRenameSession !== 'function') return;
                      e.preventDefault();
                      e.stopPropagation();
                      beginRename(session.sessionId, session.title);
                    }}
                  >
                    <SessionRowAuthorAvatar author={session.owner} />
                    {session.isPinned ? (
                      <Pin
                        aria-hidden="true"
                        className="h-3 w-3 shrink-0 text-sidebar-foreground-muted/80"
                      />
                    ) : null}
                    {renderTitle()}
                  </div>
                  {/* Keep PR at the right edge, with All Changes totals immediately before it. */}
                  <SidebarRowEndSlot
                    restIcon={
                      isChatSession ? (
                        <span className={cn('flex items-center gap-1.5', useAnchor && 'z-20')}>
                          <SessionRowTime
                            latestMessageAt={session.latestMessageAt}
                            className="text-xs text-muted-foreground"
                          />
                        </span>
                      ) : hasPr || hasChanges || showMergeablePill || isMobile ? (
                        <span
                          className={cn(
                            'flex select-none items-center gap-1.5 text-[11px] tabular-nums text-sidebar-foreground-muted/80',
                            useAnchor && 'z-20'
                          )}
                        >
                          {isMobile ? (
                            <SessionRowTime
                              latestMessageAt={session.latestMessageAt}
                              className="text-muted-foreground"
                            />
                          ) : null}
                          {showMergeablePill ? (
                            <SessionMergeablePill />
                          ) : hasChanges && !isMergeable ? (
                            <span className="flex items-center gap-1">
                              <span className="text-code-added">+{session.addedLines}</span>
                              <span className="text-code-removed">-{session.deletedLines}</span>
                            </span>
                          ) : null}
                          {hasPr ? (
                            <SessionPrIcon prStatus={prStatus} prCiState={session.prCiState} />
                          ) : null}
                        </span>
                      ) : undefined
                    }
                    archive={
                      showInlineArchive ? (
                        <SidebarRowArchiveButton
                          label={archiveTooltipLabel}
                          confirmLabel={archiveConfirmLabel}
                          onConfirm={() => onArchiveSession?.(session.sessionId)}
                        />
                      ) : undefined
                    }
                  />
                </div>
              </div>
            );
            // Desktop repo rows get a hover info card wrapping the whole row/menu.
            const showInfoCard = !isMobile;
            const menuRow = hasMenuActions ? (
              <ContextMenu key={session.sessionId}>
                <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                <ContextMenuContent className="min-w-[180px]">
                  <SessionRowOpenedByMenuItems
                    opener={openedByOpener}
                    separateToggle={hasStandardMenuActions}
                    goToOpener={
                      canGoToOpener && openerSessionId
                        ? () => {
                            if (onNavigateSessionTab && openerRootSessionId) {
                              onNavigateSessionTab(openerRootSessionId, openerSessionId);
                              return;
                            }
                            onSelectSession?.(openerSessionId);
                          }
                        : undefined
                    }
                    goToOpenerLabel={contextMenuLabels.goToOpenerSession}
                  />
                  {onOpenPullRequest && prUrl ? (
                    <>
                      <ContextMenuItem
                        onSelect={() => {
                          onOpenPullRequest({
                            sessionId: session.sessionId,
                            repoFullName: group.repoFullName,
                            prUrl,
                            prNumber,
                          });
                        }}
                      >
                        <GitPullRequest />
                        {contextMenuLabels.openPr}
                      </ContextMenuItem>
                      {onRenameSession ||
                      onTogglePinSession ||
                      onArchiveSession ||
                      canMarkUnread ||
                      onCopySessionUrl ||
                      session.branchName ? (
                        <ContextMenuSeparator />
                      ) : null}
                    </>
                  ) : null}
                  {onRenameSession ? (
                    <ContextMenuItem
                      onSelect={() => {
                        beginRename(session.sessionId, session.title);
                      }}
                    >
                      <Pencil />
                      {contextMenuLabels.rename}
                    </ContextMenuItem>
                  ) : null}
                  {onTogglePinSession ? (
                    <ContextMenuItem
                      onSelect={() => {
                        onTogglePinSession(session.sessionId, !session.isPinned);
                      }}
                    >
                      {session.isPinned ? <PinOff /> : <Pin />}
                      {session.isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
                    </ContextMenuItem>
                  ) : null}
                  {canMarkUnread ? (
                    <ContextMenuItem
                      onSelect={() => {
                        onMarkSessionUnread?.(session.sessionId);
                      }}
                    >
                      <Mail />
                      {contextMenuLabels.markUnread}
                    </ContextMenuItem>
                  ) : null}
                  {onArchiveSession ? (
                    <ContextMenuItem
                      onSelect={() => {
                        onArchiveSession(session.sessionId);
                      }}
                    >
                      <Archive />
                      {contextMenuLabels.archive}
                    </ContextMenuItem>
                  ) : null}
                  {(onRenameSession || onTogglePinSession || onArchiveSession || canMarkUnread) &&
                  (onCopySessionUrl || session.branchName) ? (
                    <ContextMenuSeparator />
                  ) : null}
                  {onCopySessionUrl ? (
                    <ContextMenuItem
                      onSelect={() => {
                        onCopySessionUrl(session.sessionId);
                      }}
                    >
                      <Link2 />
                      {contextMenuLabels.copyUrl}
                    </ContextMenuItem>
                  ) : null}
                  {shareMenuState ? (
                    <ContextMenuItem
                      disabled={shareMenuState !== 'share'}
                      onSelect={() => {
                        onShareSessionWithTeam?.(session.sessionId);
                      }}
                    >
                      {shareMenuState === 'share' ? (
                        <Users />
                      ) : shareMenuState === 'loading' ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <LockKeyhole />
                      )}
                      {shareMenuState === 'share'
                        ? contextMenuLabels.shareWithTeam
                        : shareMenuState === 'unregistered'
                          ? contextMenuLabels.registerDeviceToShare
                          : shareMenuState === 'owner-only'
                            ? contextMenuLabels.onlyOwnerCanShare
                            : contextMenuLabels.loadingSharing}
                    </ContextMenuItem>
                  ) : null}
                  {session.branchName ? (
                    <ContextMenuItem
                      onSelect={() => {
                        void navigator.clipboard.writeText(session.branchName).catch(() => {});
                      }}
                    >
                      <GitBranch />
                      {contextMenuLabels.copyBranch}
                    </ContextMenuItem>
                  ) : null}
                </ContextMenuContent>
              </ContextMenu>
            ) : (
              row
            );

            // The hover info card (right side) carries the time / repo / branch / PR /
            // diff pulled out of the now single-line row. It is a hoverable card, so the
            // branch is copyable and the PR opens on click.
            const desktopRow = showInfoCard ? (
              <SessionInfoHoverCard
                key={session.sessionId}
                kind={isChatSession ? 'chat' : 'github'}
                author={session.owner ?? undefined}
                title={session.title}
                isWorktree={session.isWorktree}
                latestMessageAt={session.latestMessageAt}
                repoFullName={group.repoFullName}
                machineName={session.machineName}
                branchName={session.branchName}
                prStatus={hasPr ? prStatus : undefined}
                prCiState={session.prCiState}
                prNumber={prNumber}
                prUrl={prUrl}
                onOpenPullRequest={
                  onOpenPullRequest && prUrl
                    ? () =>
                        onOpenPullRequest({
                          sessionId: session.sessionId,
                          repoFullName: group.repoFullName,
                          prUrl,
                          prNumber,
                        })
                    : undefined
                }
                addedLines={hasChanges ? session.addedLines : undefined}
                deletedLines={hasChanges ? session.deletedLines : undefined}
                sharing={session.sharing}
              >
                {menuRow}
              </SessionInfoHoverCard>
            ) : (
              menuRow
            );

            const rowContent =
              !canArchive || !isMobile ? (
                desktopRow
              ) : (
                <SwipeActionRow
                  key={session.sessionId}
                  enabled={isMobile}
                  className="rounded-md"
                  contentClassName="bg-sidebar"
                  actions={[
                    {
                      key: 'archive',
                      label: archiveActionLabel,
                      ariaLabel: archiveTooltipLabel,
                      icon: <Archive className="h-4 w-4" />,
                      hideLabel: group.kind === 'chat',
                      className: 'bg-sidebar-hover text-sidebar-hover-foreground',
                      onClick: () => onArchiveSession?.(session.sessionId),
                    },
                  ]}
                  onCommit={() => onArchiveSession?.(session.sessionId)}
                >
                  {menuRow}
                </SwipeActionRow>
              );

            return (
              <SessionOpenedByTreeRow
                key={session.sessionId}
                depth={node.depth}
                gutter={showTreeGutter}
              >
                {rowContent}
              </SessionOpenedByTreeRow>
            );
          })}
          {canToggleFullList && (
            <button
              type="button"
              data-id={`show-more:${group.key}`}
              data-scope-item="row"
              data-sidebar-show-more={group.key}
              className={cn(
                'flex select-none items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-sidebar-foreground-muted/80',
                'transition-colors',
                'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40'
              )}
              aria-label={toggleListLabel}
              onClick={() => onToggleFullList?.(group.key)}
            >
              <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true" />
              <span>{toggleListLabel}</span>
            </button>
          )}
        </div>
      )}
      <RenameSessionDialogView
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRename={(sessionId, nextTitle) => onRenameSession?.(sessionId, nextTitle)}
      />
    </div>
  );
}, sessionGroupPropsEqual);

const SortableRepoGroupSection = memo(function SortableRepoGroupSection({
  group,
  canReorderRepos,
  ...props
}: Omit<SessionGroupSectionProps, 'dragHandle' | 'trailingContent'> & {
  group: SessionRowGroup & { kind: 'repo'; repoFullName: string };
  canReorderRepos: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.key, disabled: !canReorderRepos });

  const constrainedTransform = transform
    ? {
        ...transform,
        x: 0,
        scaleX: 1,
        scaleY: 1,
      }
    : null;

  const style = {
    transform: CSS.Transform.toString(constrainedTransform),
    transition,
  };

  const dragHandle = canReorderRepos ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm',
        'text-sidebar-foreground-muted/80 transition-[opacity,background-color,color] duration-100',
        'opacity-0 pointer-events-none',
        'group-hover:opacity-100 group-hover:pointer-events-auto',
        'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
        'cursor-grab active:cursor-grabbing'
      )}
      aria-label="Reorder repo"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  ) : null;
  const trailingContent = dragHandle;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('w-full', isDragging && 'opacity-60')}
      data-repo-full-name={group.repoFullName}
    >
      <SessionGroupSection
        {...props}
        group={group}
        dragHandle={dragHandle}
        trailingContent={trailingContent}
      />
    </div>
  );
}, sessionGroupPropsEqual);

export const SessionList = memo(function SessionList({
  sessions,
  repos,
  isLoading = false,
  chatsCollapsed = false,
  selectedSessionId,
  activeGroupKey,
  className,
  onSelect,
  onSelectSession,
  onNavigateSessionTab,
  onToggleRepoCollapsed,
  onToggleChatsCollapsed,
  onArchiveSession,
  onMarkSessionUnread,
  onRenameSession,
  onTogglePinSession,
  onCopySessionUrl,
  onShareSessionWithTeam,
  onNew,
  onMoveRepo,
  onOpenPullRequest,
  onNavigateToNewSession,
  getSessionHref,
  headerAction,
}: SessionListProps) {
  const { t } = useTranslation();
  const archiveTooltipLabel = t('sessions.archive', 'Archive session');
  const archiveActionLabel = t('archive.title', 'Archive');
  const archiveConfirmLabel = t('common.confirm', 'Confirm');
  const contextMenuLabels: ContextMenuLabels = useMemo(
    () => ({
      openPr: t('sessions.contextMenu.openPr', 'Open Pull Request'),
      rename: t('sessions.contextMenu.rename', 'Rename'),
      pin: t('sessions.contextMenu.pin', 'Pin Session'),
      unpin: t('sessions.contextMenu.unpin', 'Unpin Session'),
      archive: t('sessions.contextMenu.archive', 'Archive Session'),
      markUnread: t('sessions.contextMenu.markUnread', 'Mark as unread'),
      copyUrl: t('sessions.contextMenu.copyUrl', 'Copy Session URL'),
      shareWithTeam: t('sessions.sharing.shareWithTeam', 'Share with team…'),
      onlyOwnerCanShare: t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share'),
      registerDeviceToShare: t(
        'sessions.sharing.registerDeviceToShare',
        'Register this device before sharing'
      ),
      loadingSharing: t('sessions.sharing.loadingAction', 'Checking sharing…'),
      copyBranch: t('sessions.contextMenu.copyBranch', 'Copy Current Branch'),
      goToOpenerSession: t('sessions.contextMenu.goToOpenerSession', 'Go to Opener Session'),
    }),
    [t]
  );
  const isMobile = useIsMobile();
  const chatsGroupLabel = t('sessions.chats', 'Chats');
  const groups = useMemo(
    () => buildGroups(sessions, repos, chatsCollapsed, chatsGroupLabel),
    [sessions, repos, chatsCollapsed, chatsGroupLabel]
  );
  const [whetherShowFullListByGroup, setWhetherShowFullListByGroup] =
    useAtom(sidebarShowFullListAtom);
  const collapsedOpenedBySessionIds = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const handleToggleOpenedBySessions = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);
  const handleSelect = onSelect ?? onSelectSession;
  const repoIds = useMemo(
    () => groups.filter((group) => group.kind === 'repo').map((group) => group.key),
    [groups]
  );
  const canReorderRepos = typeof onMoveRepo === 'function' && repoIds.length > 1;
  const repoStateByFullName = useMemo(() => {
    const map = new Map<string, SessionListRepoState>();
    for (const repo of repos) {
      const repoFullName = repo.repoFullName.trim();
      if (!repoFullName) continue;
      map.set(repoFullName, { repoFullName, collapsed: repo.collapsed });
    }
    return map;
  }, [repos]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleToggleFullList = useCallback(
    (groupKey: string) => {
      setWhetherShowFullListByGroup((prev) => {
        return { ...prev, [groupKey]: !prev[groupKey] };
      });
    },
    [setWhetherShowFullListByGroup]
  );

  const resolvedShowFullListByGroup = useMemo(
    () => reconcileShowFullListByGroups(whetherShowFullListByGroup, groups),
    [whetherShowFullListByGroup, groups]
  );

  useLayoutEffect(() => {
    setWhetherShowFullListByGroup((prev) => {
      return reconcileShowFullListByGroups(prev, groups);
    });
  }, [groups, setWhetherShowFullListByGroup]);

  if (isLoading && sessions.length === 0) {
    return (
      <div className="flex flex-col">
        {headerAction ? (
          <div className="flex h-7 shrink-0 items-center justify-end">{headerAction}</div>
        ) : null}
        <SidebarListSkeleton className={className} />
      </div>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    if (!canReorderRepos) return;
    const overId = event.over?.id;
    if (!overId) return;

    const activeRepoFullName = String(event.active.id);
    const overRepoFullName = String(overId);
    if (activeRepoFullName === overRepoFullName) return;

    const fromIndex = repoIds.indexOf(activeRepoFullName);
    const toIndex = repoIds.indexOf(overRepoFullName);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextRepoFullNames = arrayMove(repoIds, fromIndex, toIndex);
    const nextRepos: SessionListRepoState[] = nextRepoFullNames.map((repoFullName) => {
      const existing = repoStateByFullName.get(repoFullName);
      return existing ?? { repoFullName, collapsed: false };
    });

    onMoveRepo?.({ activeRepoFullName, overRepoFullName, fromIndex, toIndex, nextRepos });
  };

  if (!groups.length) {
    // Keep the header action reachable even when every group filtered out.
    if (headerAction) {
      return <div className="flex h-7 shrink-0 items-center justify-end">{headerAction}</div>;
    }
    return null;
  }

  return (
    <TooltipProvider>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={repoIds} strategy={verticalListSortingStrategy}>
          <div className={cn('flex flex-col', className)}>
            {groups.map((group, groupIndex) => {
              const whetherShowFullList = resolvedShowFullListByGroup[group.key] ?? false;
              const groupHeaderAction = groupIndex === 0 ? headerAction : undefined;
              if (group.kind === 'repo' && group.repoFullName) {
                return (
                  <SortableRepoGroupSection
                    key={group.key}
                    group={group as SessionRowGroup & { kind: 'repo'; repoFullName: string }}
                    canReorderRepos={canReorderRepos}
                    headerAction={groupHeaderAction}
                    selectedSessionId={selectedSessionId}
                    activeGroupKey={activeGroupKey}
                    whetherShowFullList={whetherShowFullList}
                    onSelectSession={handleSelect}
                    onNavigateSessionTab={onNavigateSessionTab}
                    onToggleRepoCollapsed={onToggleRepoCollapsed}
                    onToggleChatsCollapsed={onToggleChatsCollapsed}
                    onArchiveSession={onArchiveSession}
                    onMarkSessionUnread={onMarkSessionUnread}
                    onRenameSession={onRenameSession}
                    onTogglePinSession={onTogglePinSession}
                    onCopySessionUrl={onCopySessionUrl}
                    onShareSessionWithTeam={onShareSessionWithTeam}
                    onNew={onNew}
                    onNavigateToNewSession={onNavigateToNewSession}
                    onOpenPullRequest={onOpenPullRequest}
                    onToggleFullList={handleToggleFullList}
                    collapsedOpenedBySessionIds={collapsedOpenedBySessionIds}
                    onToggleOpenedBySessions={handleToggleOpenedBySessions}
                    getSessionHref={getSessionHref}
                    archiveTooltipLabel={archiveTooltipLabel}
                    archiveActionLabel={archiveActionLabel}
                    archiveConfirmLabel={archiveConfirmLabel}
                    contextMenuLabels={contextMenuLabels}
                    isMobile={isMobile}
                  />
                );
              }

              return (
                <SessionGroupSection
                  key={group.key}
                  group={group}
                  headerAction={groupHeaderAction}
                  selectedSessionId={selectedSessionId}
                  activeGroupKey={activeGroupKey}
                  whetherShowFullList={whetherShowFullList}
                  onSelectSession={handleSelect}
                  onNavigateSessionTab={onNavigateSessionTab}
                  onToggleRepoCollapsed={onToggleRepoCollapsed}
                  onToggleChatsCollapsed={onToggleChatsCollapsed}
                  onArchiveSession={onArchiveSession}
                  onMarkSessionUnread={onMarkSessionUnread}
                  onRenameSession={onRenameSession}
                  onTogglePinSession={onTogglePinSession}
                  onCopySessionUrl={onCopySessionUrl}
                  onShareSessionWithTeam={onShareSessionWithTeam}
                  onNew={onNew}
                  onNavigateToNewSession={onNavigateToNewSession}
                  onOpenPullRequest={onOpenPullRequest}
                  onToggleFullList={handleToggleFullList}
                  collapsedOpenedBySessionIds={collapsedOpenedBySessionIds}
                  onToggleOpenedBySessions={handleToggleOpenedBySessions}
                  getSessionHref={getSessionHref}
                  archiveTooltipLabel={archiveTooltipLabel}
                  archiveActionLabel={archiveActionLabel}
                  archiveConfirmLabel={archiveConfirmLabel}
                  contextMenuLabels={contextMenuLabels}
                  isMobile={isMobile}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  );
});
