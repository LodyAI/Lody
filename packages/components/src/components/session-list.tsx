import { isElectronRenderer } from '@/lib/electron';
import { openSessionOnModifiedClick } from '@/lib/desktop-window';
import { SessionWindowMenuItem } from './session-window-menu-item';
import { cn } from '@/lib/utils';
import * as stylex from '@stylexjs/stylex';
import { SIDEBAR_ROW_LINE_CLASS, sidebarSurface } from './sidebar-surface';
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
  LockKeyhole,
  Mail,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Users,
  Folders,
  MoreHorizontal,
  SquarePen,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@lody/ui/tooltip';
import { ContextMenu } from '@lody/ui/context-menu';
import type {
  LocalProjectHistoryProvider,
  MachineId,
  PrStatus,
  SessionHistoryBackendKind,
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
import { sidebarShowBranchNamesAtom } from '@/atoms/sidebar-state';
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
  SIDEBAR_HOVER_ACTION_CLASS,
  SIDEBAR_MENU_TRIGGER_OPEN_CLASS,
  SIDEBAR_ROW_LIST_CLASS,
  SIDEBAR_GROUP_LABEL_CLASS,
  SIDEBAR_ROW_TEXT_CLASS,
  SIDEBAR_CAPTION_TEXT_CLASS,
  SidebarSessionMetaLine,
  SIDEBAR_GROUP_LABEL_COLOR_CLASS,
  SidebarGroupActivityMark,
  SIDEBAR_UNSENT_TITLE_CLASS,
  summarizeSidebarGroupActivity,
  type SidebarGroupActivity,
  useSessionUnsentNewConversation,
  withSessionSendStates,
} from '@/components/sidebar-row-shared';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
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
  historyBackend?: SessionHistoryBackendKind;
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
  /**
   * The Project group a multi-repository Session belongs to, from its frozen
   * `projectRun` snapshot. Such a row is grouped under the group, never under
   * the repository its legacy `repoFullName` projection names.
   */
  projectGroup?: { id: string; name: string } | null;
};

export type SessionListRepoState = {
  repoFullName: string;
  collapsed: boolean;
};

/** A Project group shown even before it has a conversation, so one can be started. */
export type SessionListProjectGroupState = {
  projectId: string;
  name: string;
  collapsed: boolean;
};

export const getProjectGroupSessionGroupKey = (projectId: string): string =>
  `projectGroup:${projectId}`;

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
  /** Project groups in display order; their rows are matched by `projectGroup.id`. */
  projectGroups?: SessionListProjectGroupState[];
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
  onToggleProjectGroupCollapsed?: (groupKey: string) => void;
  onNewInProjectGroup?: (projectId: string) => void;
  /** Opens the group's editor; the group row's ⋯ menu offers it. */
  onOpenProjectGroupSettings?: (projectId: string) => void;
  onArchiveProjectGroupChats?: (sessionIds: string[]) => void;
  /** Reorders Project groups; receives every listed group id in its new order. */
  onMoveProjectGroup?: (projectIds: string[]) => void;
  /** A GitHub repository row's "Edit project…": the editor seeded with it. */
  onEditRepoProject?: (repoFullName: string) => void;
  onArchiveRepoChats?: (sessionIds: string[]) => void;
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
  /** Content rendered below the standalone header action when no groups remain. */
  emptyState?: ReactNode;
};

export type SessionRowGroup = {
  key: string;
  label: string;
  kind: 'repo' | 'chat' | 'projectGroup';
  repoFullName: string | null;
  /** Set for `projectGroup` groups. */
  projectId?: string;
  /** A deleted Project group still listing its conversations: nothing to edit or start. */
  projectGroupRemoved?: boolean;
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
  chatsLabel: string = 'Chats',
  projectGroups: readonly SessionListProjectGroupState[] = []
): SessionRowGroup[] {
  const sessionsByRepo = new Map<string, SessionListRow[]>();
  const onlyChats: SessionListRow[] = [];
  const sessionsByProjectGroup = new Map<string, SessionListRow[]>();
  const removedProjectGroupNames = new Map<string, string>();

  for (const session of sessions) {
    if (session.projectGroup) {
      const id = session.projectGroup.id;
      const list = sessionsByProjectGroup.get(id);
      if (list) list.push(session);
      else sessionsByProjectGroup.set(id, [session]);
      removedProjectGroupNames.set(id, session.projectGroup.name);
      continue;
    }
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

  // Defined groups come first and stay listed while empty: the header is where
  // a conversation in the group starts. A deleted group keeps its
  // conversations under the name their snapshot recorded.
  for (const group of projectGroups) {
    removedProjectGroupNames.delete(group.projectId);
    ordered.push({
      key: getProjectGroupSessionGroupKey(group.projectId),
      label: group.name,
      kind: 'projectGroup',
      repoFullName: null,
      projectId: group.projectId,
      collapsed: group.collapsed,
      sessions: sortSessionRowsByLatestMessage(sessionsByProjectGroup.get(group.projectId) ?? []),
    });
  }
  for (const [projectId, name] of [...removedProjectGroupNames].sort((a, b) =>
    a[1].localeCompare(b[1])
  )) {
    ordered.push({
      key: getProjectGroupSessionGroupKey(projectId),
      label: name,
      kind: 'projectGroup',
      repoFullName: null,
      projectId,
      projectGroupRemoved: true,
      collapsed: false,
      sessions: sortSessionRowsByLatestMessage(sessionsByProjectGroup.get(projectId) ?? []),
    });
  }

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
  onToggleProjectGroupCollapsed?: (groupKey: string) => void;
  onNewInProjectGroup?: (projectId: string) => void;
  /** Opens the group's editor; the group row's ⋯ menu offers it. */
  onOpenProjectGroupSettings?: (projectId: string) => void;
  onArchiveProjectGroupChats?: (sessionIds: string[]) => void;
  /** Reorders Project groups; receives every listed group id in its new order. */
  onMoveProjectGroup?: (projectIds: string[]) => void;
  /** A GitHub repository row's "Edit project…": the editor seeded with it. */
  onEditRepoProject?: (repoFullName: string) => void;
  onArchiveRepoChats?: (sessionIds: string[]) => void;
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

type SessionGroupRowProps = Pick<
  SessionGroupSectionProps,
  | 'onSelectSession'
  | 'onNavigateSessionTab'
  | 'onArchiveSession'
  | 'onMarkSessionUnread'
  | 'onRenameSession'
  | 'onTogglePinSession'
  | 'onCopySessionUrl'
  | 'onShareSessionWithTeam'
  | 'onOpenPullRequest'
  | 'onToggleOpenedBySessions'
  | 'getSessionHref'
  | 'archiveTooltipLabel'
  | 'archiveActionLabel'
  | 'archiveConfirmLabel'
  | 'contextMenuLabels'
  | 'isMobile'
> & {
  node: OpenedBySessionTreeNode<SessionListRow>;
  isSelected: boolean;
  groupKind: SessionRowGroup['kind'];
  groupRepoFullName: SessionRowGroup['repoFullName'];
  showTreeGutter: boolean;
  /** The previous visible row is a top-level one, so this child is the first under its opener. */
  followsOpener: boolean;
  moreActionsLabel: string;
  beginRename: (sessionId: string, currentTitle: string) => void;
};

function measureSidebarSessionTitle(row: HTMLElement, isMobile: boolean) {
  if (isMobile) return;
  const title = row.querySelector<HTMLElement>('[data-sidebar-session-title]');
  if (!title) return;
  const distance = title.scrollWidth - title.clientWidth;
  if (distance <= 8) {
    row.removeAttribute('data-sidebar-title-overflow');
    return;
  }
  row.setAttribute('data-sidebar-title-overflow', 'true');
  title.style.setProperty('--sidebar-title-distance', `${-distance}px`);
  title.style.setProperty('--sidebar-title-duration', `${Math.max(3.8, 2.4 + distance / 30)}s`);
}

function getSidebarSessionTitleOffset(title: HTMLElement) {
  const transform = getComputedStyle(title).transform;
  return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
}

function setSidebarSessionTitleSwipeOffset(
  row: HTMLElement,
  title: HTMLElement,
  distance: number,
  offset: number
) {
  row.setAttribute('data-sidebar-title-overflow', 'true');
  row.setAttribute('data-sidebar-title-swiping', 'true');
  title.style.setProperty('--sidebar-title-distance', `${-distance}px`);
  title.style.setProperty('--sidebar-title-duration', `${Math.max(3.8, 2.4 + distance / 30)}s`);
  title.style.setProperty(
    '--sidebar-title-swipe-offset',
    `${Math.max(-distance, Math.min(0, offset))}px`
  );
}

/**
 * One session row of a group. Memoized on its own props so a selection change
 * re-renders only the previously and newly selected rows: a group can hold
 * hundreds of rows, each with a hover card, context menu and tooltip, and
 * re-rendering all of them was most of a session switch's render cost.
 */
const SessionGroupRow = memo(function SessionGroupRow({
  node,
  isSelected,
  groupKind,
  groupRepoFullName,
  showTreeGutter,
  followsOpener,
  isMobile,
  moreActionsLabel,
  beginRename,
  onSelectSession,
  onNavigateSessionTab,
  onArchiveSession,
  onMarkSessionUnread,
  onRenameSession,
  onTogglePinSession,
  onCopySessionUrl,
  onShareSessionWithTeam,
  onOpenPullRequest,
  onToggleOpenedBySessions,
  getSessionHref,
  archiveTooltipLabel,
  archiveActionLabel,
  archiveConfirmLabel,
  contextMenuLabels,
}: SessionGroupRowProps) {
  const titleSwipeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffset: number;
    distance: number;
    started: boolean;
  } | null>(null);
  const suppressTitleClickRef = useRef(false);
  const { t } = useTranslation();
  const isSelectable = typeof onSelectSession === 'function';
  const session = node.item;
  const openerSessionId = normalizeSessionRowId(session.openedBySessionId);
  const openerRootSessionId =
    normalizeSessionRowId(session.openedByRowSessionId) ?? openerSessionId;
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
    hasPr && session.prReadiness === 'y' && prStatus !== 'merged' && prStatus !== 'closed';
  const showMergeablePill = isMergeable && !isSelected;
  const canArchive = typeof onArchiveSession === 'function';
  const canMarkUnread = typeof onMarkSessionUnread === 'function' && !session.hasUnreadMessages;
  const showInlineArchive = canArchive && !isMobile;
  const isChatSession = groupKind === 'chat';
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
  const isUnsent = useSessionUnsentNewConversation(session.sessionId);
  const renderTitle = (extraClassName?: string) => (
    <span className="sidebar-session-title-clip min-w-0 flex-1" data-sidebar-title-clip>
      <span
        className={cn(
          'sidebar-session-title block max-w-full truncate font-normal',
          isUnsent && !showSelectedState && SIDEBAR_UNSENT_TITLE_CLASS,
          extraClassName
        )}
        data-sidebar-session-title
      >
        {session.title}
      </span>
    </span>
  );
  const lineBoxClassName = cn('flex shrink-0 items-center', SIDEBAR_ROW_LINE_CLASS);
  const handleAnchorClick = useAnchor
    ? (event: ReactMouseEvent<HTMLAnchorElement>) => {
        if (openSessionOnModifiedClick(event, session.sessionId)) return;
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
  const baseOpenedByTreeSlot = buildSessionRowOpenedByTreeSlot(
    node,
    t,
    onToggleOpenedBySessions ? () => onToggleOpenedBySessions(session.sessionId) : undefined
  );
  // Desktop repo rows that are not nested carry a second line (branch and time),
  // so the first child's trunk has to climb past it to reach its opener's
  // chevron. Chats, nested children, mobile rows and rows whose branch detail
  // line is turned off stay one line.
  const showBranchNames = useAtomValue(sidebarShowBranchNamesAtom);
  const showMetaLine =
    showBranchNames && !isMobile && !isChatSession && baseOpenedByTreeSlot?.kind !== 'child';
  const openedByTreeSlot =
    baseOpenedByTreeSlot?.kind === 'child' && !isMobile && !isChatSession
      ? {
          ...baseOpenedByTreeSlot,
          isFirstChild: followsOpener,
          tallOpener: followsOpener && showBranchNames,
        }
      : baseOpenedByTreeSlot;
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
      data-sidebar-session-row
      data-sidebar-session-id={session.sessionId}
      // Drag a conversation onto a chat surface to mention it there.
      draggable
      onDragStart={(event) =>
        titleSwipeRef.current?.started
          ? event.preventDefault()
          : startSessionMentionDrag(event, {
              sessionId: session.sessionId,
              title: session.title,
            })
      }
      className={cn(
        'group relative w-full text-left',
        // A desktop repo row is two lines (title, then branch and time); chats,
        // nested children and every mobile row stay one. The rest of the metadata (repo /
        // PR / line totals) stays in the desktop hover info card.
        // Hover marks the row with its fill only; the title keeps its color.
        stylex.props(
          sidebarSurface.row,
          showMetaLine ? sidebarSurface.tall : sidebarSurface.snug,
          showSelectedState
            ? sidebarSurface.selected
            : isSelectable && !isMobile && sidebarSurface.hover
        ).className,
        'border border-transparent',
        // Keyboard-only focus ring. Plain :focus-within also matches
        // after a mouse click (the overlay <a> keeps focus), which
        // left a permanent inset ring on the selected row that read
        // as a misplaced border.
        useAnchor &&
          'has-[a:focus-visible]:outline-hidden has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-sidebar-ring/40',
        !isSelectable && 'cursor-default',
        isSelectable && 'cursor-pointer'
      )}
      onMouseOver={(event) => {
        if (!event.currentTarget.hasAttribute('data-sidebar-title-measured')) {
          event.currentTarget.setAttribute('data-sidebar-title-measured', 'true');
          measureSidebarSessionTitle(event.currentTarget, isMobile);
        }
      }}
      onWheel={(event) => {
        const rowElement = event.currentTarget;
        const clip = rowElement.querySelector<HTMLElement>('[data-sidebar-title-clip]');
        const title = rowElement.querySelector<HTMLElement>('[data-sidebar-session-title]');
        if (!clip || !title) return;
        const bounds = clip.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          return;
        }

        const delta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
        if (Math.abs(delta) < 1) return;
        if (!rowElement.hasAttribute('data-sidebar-title-overflow')) {
          measureSidebarSessionTitle(rowElement, false);
        }
        const distance = Math.abs(
          Number.parseFloat(title.style.getPropertyValue('--sidebar-title-distance'))
        );
        if (!Number.isFinite(distance) || distance <= 8) return;
        const offset = getSidebarSessionTitleOffset(title) - delta;
        setSidebarSessionTitleSwipeOffset(rowElement, title, distance, offset);
        event.preventDefault();
      }}
      onMouseLeave={(event) => {
        if (!titleSwipeRef.current?.started) {
          event.currentTarget.removeAttribute('data-sidebar-title-measured');
          event.currentTarget.removeAttribute('data-sidebar-title-overflow');
          event.currentTarget.removeAttribute('data-sidebar-title-swiping');
          event.currentTarget
            .querySelector<HTMLElement>('[data-sidebar-session-title]')
            ?.style.removeProperty('--sidebar-title-swipe-offset');
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const rowElement = event.currentTarget;
        const clip = rowElement.querySelector<HTMLElement>('[data-sidebar-title-clip]');
        const title = rowElement.querySelector<HTMLElement>('[data-sidebar-session-title]');
        if (!clip || !title) return;
        const bounds = clip.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          return;
        }

        const distance = Math.max(0, title.scrollWidth - clip.clientWidth);
        if (distance <= 8) return;
        const offset = getSidebarSessionTitleOffset(title);
        titleSwipeRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startOffset: Math.max(-distance, Math.min(0, offset)),
          distance,
          started: false,
        };
      }}
      onPointerMove={(event) => {
        const swipe = titleSwipeRef.current;
        if (!swipe || swipe.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - swipe.startX;
        const deltaY = event.clientY - swipe.startY;
        if (!swipe.started) {
          if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 5) return;
          if (Math.abs(deltaY) >= Math.abs(deltaX)) {
            titleSwipeRef.current = null;
            return;
          }

          swipe.started = true;
          const title = event.currentTarget.querySelector<HTMLElement>(
            '[data-sidebar-session-title]'
          );
          if (title) {
            setSidebarSessionTitleSwipeOffset(
              event.currentTarget,
              title,
              swipe.distance,
              swipe.startOffset
            );
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }

        event.preventDefault();
        const title = event.currentTarget.querySelector<HTMLElement>(
          '[data-sidebar-session-title]'
        );
        if (!title) return;
        setSidebarSessionTitleSwipeOffset(
          event.currentTarget,
          title,
          swipe.distance,
          swipe.startOffset + deltaX
        );
      }}
      onPointerUp={(event) => {
        const swipe = titleSwipeRef.current;
        if (swipe?.pointerId !== event.pointerId) return;
        if (swipe.started) {
          suppressTitleClickRef.current = true;
          window.setTimeout(() => {
            suppressTitleClickRef.current = false;
          }, 0);
          if (!event.currentTarget.matches(':hover')) {
            event.currentTarget.removeAttribute('data-sidebar-title-overflow');
            event.currentTarget.removeAttribute('data-sidebar-title-swiping');
          }
        }
        titleSwipeRef.current = null;
      }}
      onPointerCancel={(event) => {
        const swipe = titleSwipeRef.current;
        if (swipe?.started) {
          event.currentTarget.removeAttribute('data-sidebar-title-overflow');
          event.currentTarget.removeAttribute('data-sidebar-title-swiping');
        }
        titleSwipeRef.current = null;
        suppressTitleClickRef.current = false;
      }}
      onClickCapture={(event) => {
        if (!suppressTitleClickRef.current) return;
        suppressTitleClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onFocus={(event) => {
        event.currentTarget.setAttribute('data-sidebar-title-measured', 'true');
        measureSidebarSessionTitle(event.currentTarget, isMobile);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.matches(':hover')) {
          event.currentTarget.removeAttribute('data-sidebar-title-measured');
          event.currentTarget.removeAttribute('data-sidebar-title-overflow');
        }
      }}
      onClick={
        useAnchor
          ? undefined
          : (event) => {
              if (!isSelectable) return;
              if (openSessionOnModifiedClick(event, session.sessionId)) return;
              onSelectSession?.(session.sessionId);
            }
      }
      onKeyDown={
        useAnchor
          ? undefined
          : (e) => {
              // Nested controls (such as the opened-session disclosure) own their
              // keyboard activation. Selecting the row here would navigate before
              // the control receives its native click.
              if (e.currentTarget !== e.target) return;
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
      <div
        className={cn(
          'flex min-w-0',
          showMetaLine ? 'items-start' : 'items-center',
          isMobile ? 'gap-1.5' : 'gap-2'
        )}
      >
        {/* On a two-line row the leading and end slots sit in a box one title line
            tall, so they stay on the title line; otherwise the box disappears. */}
        <div className={showMetaLine ? lineBoxClassName : 'contents'}>
          <SessionRowLeadingSlot
            showMenuButton={hasMenuActions}
            menuLabel={moreActionsLabel}
            openedByTree={openedByTreeSlot}
          />
        </div>
        <div className={showMetaLine ? 'flex min-w-0 flex-1 flex-col gap-1' : 'contents'}>
          <div
            className={cn(
              // Body role: conversation titles match prose in every organize mode.
              'flex items-center gap-1',
              SIDEBAR_ROW_TEXT_CLASS,
              stylex.props(sidebarSurface.title, showSelectedState && sidebarSurface.titleSelected)
                .className
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
          {showMetaLine ? (
            <SidebarSessionMetaLine
              branchName={session.branchName}
              latestMessageAt={session.latestMessageAt}
            />
          ) : null}
        </div>
        {/* Keep PR at the right edge. Line totals stay in the hover card. */}
        <div className={showMetaLine ? lineBoxClassName : 'contents'}>
          <SidebarRowEndSlot
            sessionId={session.sessionId}
            isWaitingPermission={session.isWaitingPermission}
            isWorking={session.isWorking}
            hasUnreadMessages={session.hasUnreadMessages}
            restIcon={
              isChatSession ? (
                <span className={cn('flex items-center gap-1.5', useAnchor && 'z-20')}>
                  <SessionRowTime
                    latestMessageAt={session.latestMessageAt}
                    className={cn(SIDEBAR_CAPTION_TEXT_CLASS, 'text-muted-foreground')}
                  />
                </span>
              ) : hasPr || showMergeablePill || isMobile ? (
                <span
                  className={cn(
                    SIDEBAR_CAPTION_TEXT_CLASS,
                    'flex select-none items-center gap-1.5 tabular-nums text-sidebar-foreground-muted/80',
                    useAnchor && 'z-20'
                  )}
                >
                  {isMobile ? (
                    <SessionRowTime
                      latestMessageAt={session.latestMessageAt}
                      className="text-muted-foreground"
                    />
                  ) : null}
                  {showMergeablePill ? <SessionMergeablePill /> : null}
                  {hasPr ? (
                    <SessionPrIcon compact prStatus={prStatus} prCiState={session.prCiState} />
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
    </div>
  );
  // Desktop repo rows get a hover info card wrapping the whole row/menu.
  const showInfoCard = !isMobile;
  const menuRow = hasMenuActions ? (
    <ContextMenu.Root key={session.sessionId}>
      <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      <ContextMenu.Content className="min-w-[180px]">
        <SessionRowOpenedByMenuItems
          opener={openedByOpener}
          goToOpenerLabel={contextMenuLabels.goToOpenerSession}
        />
        {onTogglePinSession ? (
          <ContextMenu.Item
            icon={session.isPinned ? PinOff : Pin}
            onClick={() => {
              onTogglePinSession(session.sessionId, !session.isPinned);
            }}
          >
            {session.isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
          </ContextMenu.Item>
        ) : null}
        {canMarkUnread ? (
          <ContextMenu.Item
            icon={Mail}
            onClick={() => {
              onMarkSessionUnread?.(session.sessionId);
            }}
          >
            {contextMenuLabels.markUnread}
          </ContextMenu.Item>
        ) : null}
        {onRenameSession ? (
          <ContextMenu.Item
            icon={Pencil}
            onClick={() => {
              beginRename(session.sessionId, session.title);
            }}
          >
            {contextMenuLabels.rename}
          </ContextMenu.Item>
        ) : null}
        {(openedByOpener || onTogglePinSession || canMarkUnread || onRenameSession) &&
        (onCopySessionUrl || session.branchName || shareMenuState) ? (
          <ContextMenu.Separator />
        ) : null}
        {onCopySessionUrl ? (
          <ContextMenu.Item
            icon={Link2}
            onClick={() => {
              onCopySessionUrl(session.sessionId);
            }}
          >
            {contextMenuLabels.copyUrl}
          </ContextMenu.Item>
        ) : null}
        {session.branchName ? (
          <ContextMenu.Item
            icon={GitBranch}
            onClick={() => {
              void navigator.clipboard.writeText(session.branchName).catch(() => {});
            }}
          >
            {contextMenuLabels.copyBranch}
          </ContextMenu.Item>
        ) : null}
        {shareMenuState ? (
          <ContextMenu.Item
            disabled={shareMenuState !== 'share'}
            icon={
              shareMenuState === 'share' ? (
                Users
              ) : shareMenuState === 'loading' ? (
                <Spinner size="small" label={null} />
              ) : (
                LockKeyhole
              )
            }
            onClick={() => {
              onShareSessionWithTeam?.(session.sessionId);
            }}
          >
            {shareMenuState === 'share'
              ? contextMenuLabels.shareWithTeam
              : shareMenuState === 'unregistered'
                ? contextMenuLabels.registerDeviceToShare
                : shareMenuState === 'owner-only'
                  ? contextMenuLabels.onlyOwnerCanShare
                  : contextMenuLabels.loadingSharing}
          </ContextMenu.Item>
        ) : null}
        {(openedByOpener ||
          onTogglePinSession ||
          canMarkUnread ||
          onRenameSession ||
          onCopySessionUrl ||
          session.branchName ||
          shareMenuState) &&
        ((onOpenPullRequest && prUrl) ||
          (canGoToOpener && openerSessionId) ||
          isElectronRenderer()) ? (
          <ContextMenu.Separator />
        ) : null}
        {onOpenPullRequest && prUrl ? (
          <ContextMenu.Item
            icon={GitPullRequest}
            onClick={() => {
              onOpenPullRequest({
                sessionId: session.sessionId,
                repoFullName: groupRepoFullName,
                prUrl,
                prNumber,
              });
            }}
          >
            {contextMenuLabels.openPr}
          </ContextMenu.Item>
        ) : null}
        <SessionRowOpenedByMenuItems
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
        <SessionWindowMenuItem sessionId={session.sessionId} />
        {(openedByOpener ||
          onTogglePinSession ||
          canMarkUnread ||
          onRenameSession ||
          onCopySessionUrl ||
          session.branchName ||
          shareMenuState ||
          (onOpenPullRequest && prUrl) ||
          (canGoToOpener && openerSessionId) ||
          isElectronRenderer()) &&
        onArchiveSession ? (
          <ContextMenu.Separator />
        ) : null}
        {onArchiveSession ? (
          <ContextMenu.Item
            icon={Archive}
            onClick={() => {
              onArchiveSession(session.sessionId);
            }}
          >
            {contextMenuLabels.archive}
          </ContextMenu.Item>
        ) : null}
      </ContextMenu.Content>
    </ContextMenu.Root>
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
      repoFullName={groupRepoFullName}
      machineName={session.machineName}
      historyBackend={session.historyBackend}
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
                repoFullName: groupRepoFullName,
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
            hideLabel: groupKind === 'chat',
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
    <SessionOpenedByTreeRow key={session.sessionId} depth={node.depth} gutter={showTreeGutter}>
      {rowContent}
    </SessionOpenedByTreeRow>
  );
});

/**
 * A Project group's row, built like a local project's: the group mark turns
 * into the fold chevron on hover, the row starts a conversation in the group,
 * and the hover controls are the same ⋯ / new chat / drag handle in the same
 * places. The ⋯ opens the row's own context menu.
 */
function ProjectGroupHeaderRow({
  group,
  selected,
  isMobile,
  activity,
  dragHandle,
  onToggle,
  onNew,
  onOpenSettings,
  onArchiveChats,
  headerAction,
}: {
  group: SessionRowGroup;
  selected: boolean;
  isMobile: boolean;
  activity: SidebarGroupActivity | null;
  dragHandle?: ReactNode;
  onToggle?: () => void;
  onNew?: () => void;
  onOpenSettings?: () => void;
  onArchiveChats?: (sessionIds: string[]) => void;
  headerAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionIds = useMemo(() => group.sessions.map((row) => row.sessionId), [group.sessions]);
  const showMenu = !isMobile && (Boolean(onOpenSettings) || Boolean(onArchiveChats));
  const showNew = !isMobile && Boolean(onNew);
  const activate = onNew ?? onToggle;

  const row = (
    <div
      role={activate ? 'button' : undefined}
      tabIndex={activate ? 0 : -1}
      aria-label={group.label}
      aria-current={selected ? 'page' : undefined}
      data-id={`group:${group.key}`}
      data-scope-item="row"
      data-sidebar-group-key={group.key}
      data-menu-open={menuOpen ? '' : undefined}
      className={cn(
        'group relative w-full rounded-md px-2 py-1 text-left',
        'border border-transparent bg-transparent',
        !selected &&
          !isMobile &&
          'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground',
        selected && 'border-sidebar-ring/30 bg-sidebar-selection hover:bg-sidebar-selection',
        SIDEBAR_ROW_TEXT_CLASS,
        'flex min-w-0 flex-1 select-none items-center gap-2 font-normal transition-colors',
        activate ? 'cursor-pointer' : 'cursor-default',
        selected ? 'text-sidebar-selection-foreground' : 'text-sidebar-row-foreground'
      )}
      onClick={activate}
      onKeyDown={(event) => {
        if (!activate || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        activate();
      }}
    >
      <button
        type="button"
        className="relative -mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
        aria-label={t('common.toggle', 'Toggle')}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle?.();
        }}
      >
        <Folders
          aria-hidden="true"
          className={cn(
            'absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-current transition-opacity duration-100',
            isMobile ? 'opacity-0' : 'group-hover:opacity-0'
          )}
        />
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-current',
            'transition-[opacity,translate,scale,rotate] duration-100',
            isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            group.collapsed ? '-rotate-90' : 'rotate-0'
          )}
        />
      </button>
      <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
      {showMenu || showNew || dragHandle ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {showMenu ? (
            <button
              type="button"
              className={cn(SIDEBAR_HOVER_ACTION_CLASS, SIDEBAR_MENU_TRIGGER_OPEN_CLASS)}
              aria-label={t('sessions.moreActions', 'More actions')}
              onClick={(event) => {
                // Open the row's own right-click menu from a left click.
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(
                  new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: Math.round(rect.left),
                    clientY: Math.round(rect.bottom),
                  })
                );
              }}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {showNew ? (
            <button
              type="button"
              className={SIDEBAR_HOVER_ACTION_CLASS}
              aria-label={t('sidebar.projectGroups.newChat', 'New chat in this project group')}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onNew?.();
              }}
            >
              <SquarePen className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {dragHandle}
        </div>
      ) : null}
      {activity ? <SidebarGroupActivityMark activity={activity} /> : null}
    </div>
  );

  return (
    <div className="group flex items-center">
      {showMenu ? (
        <ContextMenu.Root onOpenChange={setMenuOpen}>
          <ContextMenu.Trigger render={row} />
          <ContextMenu.Content className="min-w-[180px]">
            {onOpenSettings ? (
              <ContextMenu.Item icon={Folders} onClick={onOpenSettings}>
                {t('sidebar.projectGroups.settings', 'Edit project group')}
              </ContextMenu.Item>
            ) : null}
            {onArchiveChats ? (
              <ContextMenu.Item
                icon={Archive}
                disabled={sessionIds.length === 0}
                onClick={() => onArchiveChats(sessionIds)}
              >
                {t('sidebar.localProjects.archiveChats', 'Archive chats')}
              </ContextMenu.Item>
            ) : null}
          </ContextMenu.Content>
        </ContextMenu.Root>
      ) : (
        row
      )}
      {headerAction ? <div className="mr-2 shrink-0">{headerAction}</div> : null}
    </div>
  );
}

const SessionGroupSection = memo(function SessionGroupSection({
  group,
  selectedSessionId,
  activeGroupKey,
  whetherShowFullList,
  onSelectSession,
  onNavigateSessionTab,
  onToggleRepoCollapsed,
  onToggleChatsCollapsed,
  onToggleProjectGroupCollapsed,
  onNewInProjectGroup,
  onOpenProjectGroupSettings,
  onArchiveProjectGroupChats,
  onEditRepoProject,
  onArchiveRepoChats,
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
  const isProjectGroup = group.kind === 'projectGroup';
  // A repository row offers the menu a folder row does; touch has no hover menu.
  const repoMenuEnabled =
    group.kind === 'repo' &&
    Boolean(group.repoFullName) &&
    !isMobile &&
    (Boolean(onEditRepoProject) || Boolean(onArchiveRepoChats));
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const showGroupHeaderIcon = group.kind === 'repo' || isProjectGroup;
  const [renameTarget, setRenameTarget] = useState<RenameSessionDialogTarget | null>(null);
  const beginRename = useCallback((sessionId: string, currentTitle: string) => {
    setRenameTarget({ sessionId: sessionId as SessionId, initialTitle: currentTitle });
  }, []);
  const isActiveGroup = activeGroupKey === group.key;
  const showActiveGroupState = isActiveGroup && !isMobile;
  const canToggle =
    group.kind === 'repo'
      ? typeof onToggleRepoCollapsed === 'function'
      : isProjectGroup
        ? typeof onToggleProjectGroupCollapsed === 'function'
        : typeof onToggleChatsCollapsed === 'function';
  // A project group starts its conversations from its own handler; the repo
  // and chat navigation callbacks name a repository, which a group is not.
  const canNavigate = isProjectGroup
    ? typeof onNewInProjectGroup === 'function'
    : typeof onNavigateToNewSession === 'function';
  const canCreateNew = isProjectGroup
    ? typeof onNewInProjectGroup === 'function'
    : typeof onNew === 'function';
  const handleToggleGroup = () => {
    if (!canToggle) return;
    if (isProjectGroup) {
      onToggleProjectGroupCollapsed?.(group.key);
      return;
    }
    if (group.kind === 'repo' && group.repoFullName) {
      onToggleRepoCollapsed?.(group.repoFullName);
      return;
    }
    if (group.kind === 'chat') onToggleChatsCollapsed?.();
  };
  const handleNavigate = () => {
    if (isProjectGroup) {
      if (group.projectId) onNewInProjectGroup?.(group.projectId);
      return;
    }
    onNavigateToNewSession?.(group.repoFullName ?? undefined);
  };

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
  // A folded group still says whether anything inside it needs the user.
  const sendStates = useAtomValue(sessionSendStatesAtom);
  const collapsedActivity = useMemo(
    () =>
      group.collapsed
        ? summarizeSidebarGroupActivity(
            withSessionSendStates(group.sessions, (row) => row.sessionId, sendStates)
          )
        : null,
    [group.collapsed, group.sessions, sendStates]
  );
  const toggleListLabel = whetherShowFullList
    ? t('sessions.showLess', 'Show less')
    : t('sessions.showAll', 'Show all ({{count}})', { count: group.sessions.length });
  const resolvedTrailingContent = trailingContent ?? (group.collapsed ? null : dragHandle);
  // A repo ("loro-dev/loro") is a second-level row like a project: 14px
  // regular in the sidebar row color with a 16px avatar and a hover fill.
  // "Chats" is a top-level group label like a machine or GitHub Worktrees:
  // the shared group label type (small, bold, faint, no icon), no hover fill,
  // and it scrolls with its conversations.
  const isGroupLabel = group.kind === 'chat';
  // A repo row takes its ink from `sidebarSurface.row`.
  const headerBaseColorClass = isGroupLabel ? SIDEBAR_GROUP_LABEL_COLOR_CLASS : undefined;
  const headerTypographyClass = isGroupLabel
    ? SIDEBAR_GROUP_LABEL_CLASS
    : cn(SIDEBAR_ROW_TEXT_CLASS, 'font-medium');

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5',
        // Project groups stack like a machine's projects, 2px apart; repo
        // groups and Chats keep the wider group rhythm.
        isProjectGroup ? 'mb-0.5 last:mb-0' : getSidebarGroupSpacingClass(group.collapsed),
        // 16px above a top-level group (the repo groups before it end in 12px).
        isGroupLabel && 'mt-1 first:mt-0'
      )}
    >
      {isProjectGroup ? (
        <ProjectGroupHeaderRow
          group={group}
          selected={showActiveGroupState}
          isMobile={isMobile}
          activity={collapsedActivity}
          dragHandle={dragHandle}
          onToggle={canToggle ? handleToggleGroup : undefined}
          onNew={
            !group.projectGroupRemoved && group.projectId && onNewInProjectGroup
              ? () => onNewInProjectGroup(group.projectId!)
              : undefined
          }
          onOpenSettings={
            !group.projectGroupRemoved && group.projectId && onOpenProjectGroupSettings
              ? () => onOpenProjectGroupSettings(group.projectId!)
              : undefined
          }
          onArchiveChats={onArchiveProjectGroupChats}
          headerAction={headerAction}
        />
      ) : (
        <div className={cn('group flex items-center', isGroupLabel ? 'h-[26px]' : 'h-7')}>
          {(() => {
            const headerRow = (
              <div
                role={canNavigate || canToggle ? 'button' : undefined}
                tabIndex={canNavigate || canToggle ? 0 : -1}
                data-id={`group:${group.key}`}
                data-scope-item="row"
                data-sidebar-group-key={group.key}
                data-menu-open={repoMenuOpen ? '' : undefined}
                className={cn(
                  'relative flex w-full select-none items-center text-left',
                  isGroupLabel ? 'h-[26px] gap-1.5' : cn('h-7', isMobile ? 'gap-1' : 'gap-0.5'),
                  'border border-transparent',
                  'min-w-0 flex-1 transition-colors',
                  headerTypographyClass,
                  stylex.props(
                    sidebarSurface.row,
                    showActiveGroupState
                      ? sidebarSurface.selected
                      : canNavigate && !isMobile && !isGroupLabel && sidebarSurface.hover
                  ).className,
                  showActiveGroupState
                    ? 'cursor-pointer border-sidebar-ring/30'
                    : canNavigate
                      ? cn(
                          'cursor-pointer',
                          headerBaseColorClass,
                          !isMobile && isGroupLabel && 'hover:text-sidebar-foreground'
                        )
                      : canToggle
                        ? cn('cursor-pointer', headerBaseColorClass)
                        : cn('cursor-default', headerBaseColorClass)
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
                        'absolute left-0 top-1/2 -translate-y-1/2 h-4 w-4 transition-opacity duration-100',
                        // Mobile: chevron is always shown so the owner avatar must hide
                        // permanently to avoid the two icons overlapping.
                        canToggle && isMobile
                          ? 'opacity-0'
                          : cn(canToggle && 'group-hover:opacity-0')
                      )}
                    />
                    {canToggle && (
                      <ChevronDown
                        className={cn(
                          'absolute left-0 top-1/2 -translate-y-1/2 h-4 w-4',
                          'transition-[opacity,translate,scale,rotate] duration-150 ease-out',
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
                      'transition-[opacity,translate,scale,rotate] duration-150 ease-out',
                      group.collapsed || isMobile
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100',
                      // Chats is a top-level sidebar section, so its collapsed chevron
                      // stays visible without hover.
                      group.collapsed ? '-rotate-90' : 'rotate-0'
                    )}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="flex-1" aria-hidden="true" />
                {repoMenuEnabled ? (
                  <button
                    type="button"
                    className={cn(SIDEBAR_HOVER_ACTION_CLASS, SIDEBAR_MENU_TRIGGER_OPEN_CLASS)}
                    aria-label={moreActionsLabel}
                    onClick={(event) => {
                      // Open the row's own right-click menu from a left click.
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      event.currentTarget.dispatchEvent(
                        new MouseEvent('contextmenu', {
                          bubbles: true,
                          cancelable: true,
                          clientX: Math.round(rect.left),
                          clientY: Math.round(rect.bottom),
                        })
                      );
                    }}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                {collapsedActivity ? (
                  <SidebarGroupActivityMark activity={collapsedActivity} />
                ) : null}
              </div>
            );
            if (!repoMenuEnabled || !group.repoFullName) return headerRow;
            const repoFullName = group.repoFullName;
            return (
              <ContextMenu.Root onOpenChange={setRepoMenuOpen}>
                <ContextMenu.Trigger render={headerRow} />
                <ContextMenu.Content className="min-w-[180px]">
                  {onEditRepoProject ? (
                    <ContextMenu.Item
                      icon={Folders}
                      onClick={() => onEditRepoProject(repoFullName)}
                    >
                      {t('sidebar.localProjects.editProject', 'Edit project…')}
                    </ContextMenu.Item>
                  ) : null}
                  {onArchiveRepoChats ? (
                    <ContextMenu.Item
                      icon={Archive}
                      disabled={group.sessions.length === 0}
                      onClick={() => onArchiveRepoChats(group.sessions.map((row) => row.sessionId))}
                    >
                      {t('sidebar.localProjects.archiveChats', 'Archive chats')}
                    </ContextMenu.Item>
                  ) : null}
                </ContextMenu.Content>
              </ContextMenu.Root>
            );
          })()}

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

          {headerAction ? <div className="mr-2 shrink-0">{headerAction}</div> : null}
        </div>
      )}
      {!group.collapsed && (
        <div className={SIDEBAR_ROW_LIST_CLASS}>
          {visibleNodes.map((node, nodeIndex) => (
            <SessionGroupRow
              key={node.item.sessionId}
              node={node}
              isSelected={node.item.sessionId === selectedSessionId}
              groupKind={group.kind}
              groupRepoFullName={group.repoFullName}
              showTreeGutter={showTreeGutter}
              followsOpener={visibleNodes[nodeIndex - 1]?.depth === 0}
              isMobile={isMobile}
              moreActionsLabel={moreActionsLabel}
              beginRename={beginRename}
              onSelectSession={onSelectSession}
              onNavigateSessionTab={onNavigateSessionTab}
              onArchiveSession={onArchiveSession}
              onMarkSessionUnread={onMarkSessionUnread}
              onRenameSession={onRenameSession}
              onTogglePinSession={onTogglePinSession}
              onCopySessionUrl={onCopySessionUrl}
              onShareSessionWithTeam={onShareSessionWithTeam}
              onOpenPullRequest={onOpenPullRequest}
              onToggleOpenedBySessions={onToggleOpenedBySessions}
              getSessionHref={getSessionHref}
              archiveTooltipLabel={archiveTooltipLabel}
              archiveActionLabel={archiveActionLabel}
              archiveConfirmLabel={archiveConfirmLabel}
              contextMenuLabels={contextMenuLabels}
            />
          ))}
          {canToggleFullList && (
            <button
              type="button"
              data-id={`show-more:${group.key}`}
              data-scope-item="row"
              data-sidebar-show-more={group.key}
              className={cn(
                // Same height as a conversation row (3px padding + 1px borders + 18px line).
                SIDEBAR_CAPTION_TEXT_CLASS,
                'flex h-[26px] select-none items-center gap-2 rounded-md px-2 text-left text-sidebar-foreground-muted/80',
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

/**
 * A Project group that can be dragged within its section. The handle sits
 * among the row's hover controls, where a local project keeps its own.
 */
const SortableProjectGroupSection = memo(function SortableProjectGroupSection({
  group,
  canReorder,
  ...props
}: Omit<SessionGroupSectionProps, 'dragHandle' | 'trailingContent'> & {
  canReorder: boolean;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.key, disabled: !canReorder });
  const constrainedTransform = transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null;
  const dragHandle = canReorder ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      className={cn(SIDEBAR_HOVER_ACTION_CLASS, 'cursor-grab touch-none active:cursor-grabbing')}
      aria-label={t('sidebar.projectGroups.reorder', 'Reorder project group')}
      {...attributes}
      {...listeners}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(constrainedTransform), transition }}
      className={cn('w-full', 'mb-0.5 last:mb-0', isDragging && 'z-10 opacity-60')}
    >
      <SessionGroupSection {...props} group={group} dragHandle={dragHandle} />
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
      // The group spacing lives on this sortable wrapper: inside it the section
      // is always `:last-child`, so its own `last:mb-0` would erase the gap.
      className={cn(
        'w-full',
        getSidebarGroupSpacingClass(group.collapsed),
        isDragging && 'opacity-60'
      )}
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

/**
 * Space after a sidebar group (a repo, Chats, a machine's projects): 12px when
 * expanded, at least twice the 1–2px rhythm between rows inside a group, so
 * groups separate by space alone. Collapsed headers stack more tightly.
 */
export const getSidebarGroupSpacingClass = (collapsed: boolean | undefined) =>
  collapsed ? 'mb-1 last:mb-0' : 'mb-3 last:mb-0';

export const SessionList = memo(function SessionList({
  sessions,
  repos,
  projectGroups,
  onToggleProjectGroupCollapsed,
  onNewInProjectGroup,
  onOpenProjectGroupSettings,
  onArchiveProjectGroupChats,
  onMoveProjectGroup,
  onEditRepoProject,
  onArchiveRepoChats,
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
  emptyState,
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
    () => buildGroups(sessions, repos, chatsCollapsed, chatsGroupLabel, projectGroups),
    [sessions, repos, chatsCollapsed, chatsGroupLabel, projectGroups]
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
  // Only defined groups reorder; a deleted group's leftovers keep their place.
  const projectGroupKeys = useMemo(
    () =>
      groups
        .filter((group) => group.kind === 'projectGroup' && !group.projectGroupRemoved)
        .map((group) => group.key),
    [groups]
  );
  const canReorderProjectGroups =
    typeof onMoveProjectGroup === 'function' && projectGroupKeys.length > 1;
  const sortableIds = useMemo(() => [...repoIds, ...projectGroupKeys], [projectGroupKeys, repoIds]);
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
          <div className="flex h-7 shrink-0 items-center justify-end pr-2">{headerAction}</div>
        ) : null}
        <SidebarListSkeleton className={className} />
      </div>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id);
    if (projectGroupKeys.includes(activeKey)) {
      const overKey = event.over ? String(event.over.id) : null;
      const fromIndex = projectGroupKeys.indexOf(activeKey);
      const toIndex = overKey ? projectGroupKeys.indexOf(overKey) : -1;
      if (!canReorderProjectGroups || toIndex < 0 || fromIndex === toIndex) return;
      const keyToId = new Map(groups.map((group) => [group.key, group.projectId] as const));
      onMoveProjectGroup?.(
        arrayMove(projectGroupKeys, fromIndex, toIndex).flatMap((key) => {
          const id = keyToId.get(key);
          return id ? [id] : [];
        })
      );
      return;
    }
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
    if (headerAction || emptyState) {
      return (
        <div className="flex flex-col">
          {headerAction ? (
            <div className="flex h-7 shrink-0 items-center justify-end pr-2">{headerAction}</div>
          ) : null}
          {emptyState}
        </div>
      );
    }
    return null;
  }

  return (
    <Tooltip.Provider>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
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
                    onEditRepoProject={onEditRepoProject}
                    onArchiveRepoChats={onArchiveRepoChats}
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

              const GroupSection =
                group.kind === 'projectGroup' && !group.projectGroupRemoved
                  ? SortableProjectGroupSection
                  : SessionGroupSection;
              return (
                <GroupSection
                  key={group.key}
                  group={group}
                  canReorder={canReorderProjectGroups}
                  onToggleProjectGroupCollapsed={onToggleProjectGroupCollapsed}
                  onNewInProjectGroup={onNewInProjectGroup}
                  onOpenProjectGroupSettings={onOpenProjectGroupSettings}
                  onArchiveProjectGroupChats={onArchiveProjectGroupChats}
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
    </Tooltip.Provider>
  );
});
