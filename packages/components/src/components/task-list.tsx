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
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useAtom } from 'jotai';
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
  SessionPullRequestCiState,
  SessionPullRequestReadiness,
} from '@lody/shared';
import { ONLY_CHATS_KEY, sidebarShowFullListAtom } from '@/atoms/focus-layer';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import { useIsMobile } from '@/hooks/use-mobile';
import { useStableNow } from '@/hooks/use-stable-now';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import {
  GitHubOwnerIcon,
  SessionPrIcon,
  SessionRowLeadingSlot,
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SidebarListSkeleton,
  SessionMergeablePill,
} from '@/components/sidebar-row-shared';
import { SessionInfoHoverCard } from '@/components/session-info-hover-card';
import { SessionSharingIndicator } from '@/components/session-sharing';
import type { SessionSharingState } from '@/lib/session-sharing';

export type { PrStatus };

export type TaskListTaskOwner = {
  name?: string | null;
  image?: string | null;
};

export type TaskListTask = {
  taskId: string;
  title: string;
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
  owner?: TaskListTaskOwner | null;
  sharing?: SessionSharingState;
};

export type TaskListRepoState = {
  repoFullName: string;
  collapsed: boolean;
};

export type TaskListRepoMove = {
  activeRepoFullName: string;
  overRepoFullName: string;
  fromIndex: number;
  toIndex: number;
  nextRepos: TaskListRepoState[];
};

export type TaskListPullRequestOpen = {
  taskId: string;
  repoFullName: string | null;
  prUrl: string;
  prNumber: number | null;
};

export type TaskListProps = {
  tasks: TaskListTask[];
  repos: TaskListRepoState[];
  isLoading?: boolean;
  chatsCollapsed?: boolean;
  selectedTaskId?: string | null;
  /** Group key that should be highlighted (e.g. repo fullname or '__only_chats__') */
  activeGroupKey?: string | null;
  className?: string;
  onSelect?: (taskId: string) => void;
  onSelectTask?: (taskId: string) => void;
  onToggleRepoCollapsed?: (repoFullName: string) => void;
  onToggleChatsCollapsed?: () => void;
  onArchiveTask?: (taskId: string) => void;
  onRenameTask?: (taskId: string, nextTitle: string) => void;
  /** Toggle pin state for a task. Receives the next desired state (true = pin, false = unpin). */
  onTogglePinTask?: (taskId: string, nextPinned: boolean) => void;
  /**
   * Copy a shareable URL for the session. The parent owns URL construction so the
   * sidebar component can stay agnostic about workspace slugs and origins.
   */
  onCopySessionUrl?: (taskId: string) => void;
  /** Open the share-with-team confirmation for a private session. */
  onShareSessionWithTeam?: (taskId: string) => void;
  onNew?: (repoFullName?: string) => void;
  onMoveRepo?: (move: TaskListRepoMove) => void;
  onOpenPullRequest?: (request: TaskListPullRequestOpen) => void;
  /** Navigate to new session page with the given repo pre-selected (or chat mode if undefined) */
  onNavigateToNewSession?: (repoFullName?: string) => void;
  /**
   * Returns an internal href for a task row. When provided, rows render as real anchors
   * so middle-click and Cmd/Ctrl-click open in a new tab. Plain left-click still routes
   * through `onSelectTask` for SPA navigation. Return undefined to disable anchor mode
   * (e.g. on Electron where there is no browser tab concept yet).
   */
  getTaskHref?: (taskId: string) => string | undefined;
  /**
   * Always-visible action rendered at the right end of the FIRST group's
   * header row (desktop sidebar filter trigger). Also rendered in a standalone
   * row above the loading skeleton so the control stays reachable.
   */
  headerAction?: ReactNode;
};

export type TaskGroup = {
  key: string;
  label: string;
  kind: 'repo' | 'chat';
  repoFullName: string | null;
  collapsed: boolean;
  tasks: TaskListTask[];
};

export const MAX_VISIBLE_TASKS = 5;

export function getVisibleTaskGroupTasks(
  group: TaskGroup,
  whetherShowFullList: boolean
): TaskListTask[] {
  return whetherShowFullList ? group.tasks : group.tasks.slice(0, MAX_VISIBLE_TASKS);
}

function normalizeRepoFullName(value: TaskListTask['repoFullName']): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function normalizePrUrl(value: TaskListTask['prUrl']): string | null {
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

function toDate(value: TaskListTask['latestMessageAt']): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getSortKey(task: TaskListTask): number {
  const date = toDate(task.latestMessageAt);
  return date ? date.getTime() : 0;
}

export function sortTasksByLatestMessage(tasks: TaskListTask[]): TaskListTask[] {
  return [...tasks].sort((a, b) => {
    // Pinned sessions stay above the rest, so users can keep work-in-progress
    // chats anchored at the top regardless of when they were last touched.
    const aPinned = a.isPinned ? 1 : 0;
    const bPinned = b.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const byTime = getSortKey(b) - getSortKey(a);
    if (byTime !== 0) return byTime;
    const byTitle = a.title.localeCompare(b.title);
    if (byTitle !== 0) return byTitle;
    return a.taskId.localeCompare(b.taskId);
  });
}

export function buildGroups(
  tasks: TaskListTask[],
  repos: TaskListRepoState[],
  chatsCollapsed: boolean
): TaskGroup[] {
  const tasksByRepo = new Map<string, TaskListTask[]>();
  const onlyChats: TaskListTask[] = [];

  for (const task of tasks) {
    const repoFullName = normalizeRepoFullName(task.repoFullName);
    if (!repoFullName) {
      onlyChats.push(task);
      continue;
    }
    const list = tasksByRepo.get(repoFullName);
    if (list) list.push(task);
    else tasksByRepo.set(repoFullName, [task]);
  }

  const ordered: TaskGroup[] = [];

  if (onlyChats.length) {
    ordered.push({
      key: ONLY_CHATS_KEY,
      label: 'Chats',
      kind: 'chat',
      repoFullName: null,
      collapsed: chatsCollapsed,
      tasks: sortTasksByLatestMessage(onlyChats),
    });
  }

  const seen = new Set<string>();
  for (const repo of repos) {
    const repoName = repo.repoFullName.trim();
    if (!repoName) continue;
    seen.add(repoName);
    const repoTasks = tasksByRepo.get(repoName);
    if (!repoTasks || repoTasks.length === 0) continue;
    ordered.push({
      key: repoName,
      label: repoName,
      kind: 'repo',
      repoFullName: repoName,
      collapsed: repo.collapsed,
      tasks: sortTasksByLatestMessage(repoTasks),
    });
  }

  const remainingRepos = [...tasksByRepo.keys()]
    .filter((repoFullName) => !seen.has(repoFullName))
    .sort((a, b) => a.localeCompare(b));
  for (const repoFullName of remainingRepos) {
    const repoTasks = tasksByRepo.get(repoFullName);
    if (!repoTasks || repoTasks.length === 0) continue;
    ordered.push({
      key: repoFullName,
      label: repoFullName,
      kind: 'repo',
      repoFullName,
      collapsed: false,
      tasks: sortTasksByLatestMessage(repoTasks),
    });
  }

  return ordered;
}

function reconcileShowFullListByGroups(
  current: Record<string, boolean>,
  groups: TaskGroup[]
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

// The worktree marker icon is intentionally not rendered here. TaskList only
// receives GitHub-bound or pure-chat sessions (local-project sessions are
// filtered out at the call site in loro-app-sidebar.tsx), and every GitHub
// session is a worktree by construction — so an inline icon on every row in
// the GitHub group is redundant noise. Local-project sessions get the icon
// elsewhere in LocalProjectSessionItem, where it's a meaningful distinction.
function TaskRowTime({ relativeTime, className }: { relativeTime: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-end gap-1', className)}>
      <span className="select-none tabular-nums">{relativeTime}</span>
    </span>
  );
}

type TaskGroupSectionProps = {
  group: TaskGroup;
  now: Date;
  selectedTaskId?: string | null;
  activeGroupKey?: string | null;
  whetherShowFullList: boolean;
  onSelectTask?: (taskId: string) => void;
  onToggleRepoCollapsed?: (repoFullName: string) => void;
  onToggleChatsCollapsed?: () => void;
  onArchiveTask?: (taskId: string) => void;
  onRenameTask?: (taskId: string, nextTitle: string) => void;
  onTogglePinTask?: (taskId: string, nextPinned: boolean) => void;
  onCopySessionUrl?: (taskId: string) => void;
  onShareSessionWithTeam?: (taskId: string) => void;
  onNew?: (repoFullName?: string) => void;
  onNavigateToNewSession?: (repoFullName?: string) => void;
  onOpenPullRequest?: (request: TaskListPullRequestOpen) => void;
  onToggleFullList?: (groupKey: string) => void;
  getTaskHref?: (taskId: string) => string | undefined;
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
  copyUrl: string;
  shareWithTeam: string;
  onlyOwnerCanShare: string;
  registerDeviceToShare: string;
  loadingSharing: string;
  copyBranch: string;
};

const TaskGroupSection = memo(function TaskGroupSection({
  group,
  now,
  selectedTaskId,
  activeGroupKey,
  whetherShowFullList,
  onSelectTask,
  onToggleRepoCollapsed,
  onToggleChatsCollapsed,
  onArchiveTask,
  onRenameTask,
  onTogglePinTask,
  onCopySessionUrl,
  onShareSessionWithTeam,
  onNew,
  onNavigateToNewSession,
  onOpenPullRequest,
  onToggleFullList,
  getTaskHref,
  dragHandle,
  archiveTooltipLabel,
  archiveActionLabel,
  archiveConfirmLabel,
  contextMenuLabels,
  isMobile,
  trailingContent,
  headerAction,
}: TaskGroupSectionProps) {
  const { t } = useTranslation();
  const moreActionsLabel = t('sessions.moreActions', 'More actions');
  const showGroupHeaderIcon = group.kind === 'repo';
  // Inline rename: the row owns its own editing state so the menu and
  // double-click can both flip it on without lifting state to the parent.
  // Rejected alternatives:
  //   - Modal dialog: extra click and keyboard hop, doesn't match the
  //     user's request to edit "directly on the session item".
  //   - Lifting state to TaskList: reorders/selection invalidate the row's
  //     local draft mid-typing.
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  // Guards against double-finalization. When the user presses Escape or Enter
  // we tear down the input synchronously, which fires a blur on the unmounting
  // element — that blur invokes the previous render's onBlur closure with the
  // still-typed draftTitle, which would otherwise commit a cancelled rename.
  // A ref (not state) is required: the guard must be visible synchronously to
  // the blur handler that fires during the same commit phase as the unmount.
  const renameFinalizedRef = useRef(false);
  const beginRename = useCallback((taskId: string, currentTitle: string) => {
    renameFinalizedRef.current = false;
    setEditingTaskId(taskId);
    setDraftTitle(currentTitle);
  }, []);
  const cancelRename = useCallback(() => {
    renameFinalizedRef.current = true;
    setEditingTaskId(null);
    setDraftTitle('');
  }, []);
  const commitRename = useCallback(
    (taskId: string, originalTitle: string) => {
      if (renameFinalizedRef.current) return;
      renameFinalizedRef.current = true;
      const next = draftTitle.replace(/[\r\n]+/g, ' ').trim();
      if (next && next !== originalTitle.trim()) {
        onRenameTask?.(taskId, next);
      }
      setEditingTaskId(null);
      setDraftTitle('');
    },
    [draftTitle, onRenameTask]
  );
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

  const isSelectable = typeof onSelectTask === 'function';
  // whetherShowFullList keeps each group in a compact preview by default (latest N),
  // and only reveals the full list after the user explicitly expands it.
  const canToggleFullList = group.tasks.length > MAX_VISIBLE_TASKS;
  const visibleTasks = getVisibleTaskGroupTasks(group, whetherShowFullList);
  const shouldShowExpandCollapse = canToggleFullList;
  const toggleListLabel = whetherShowFullList
    ? t('sessions.showLess', 'Show less')
    : t('sessions.showAll', 'Show all ({{count}})', { count: group.tasks.length });
  const resolvedTrailingContent = trailingContent ?? (group.collapsed ? null : dragHandle);
  // Repo group labels (e.g. "loro-dev/loro") name concrete content, but dark-mode
  // resting chrome should still recede behind the conversation. Hover and active
  // states restore full contrast; "Chats" stays at the quieter section-label tone.
  const headerBaseColorClass =
    group.kind === 'repo'
      ? 'text-sidebar-foreground dark:text-sidebar-foreground/75'
      : 'text-sidebar-foreground-muted/55';
  // Typography splits with color: repo headers read as content (xs semibold),
  // the "Chats" header reads as section chrome (13px medium) so
  // section labels visually recede from titles at a glance.
  const headerTypographyClass =
    group.kind === 'repo' ? 'text-xs font-semibold' : 'text-[13px] font-medium';
  const headerToggleHoverClass =
    group.kind === 'repo'
      ? 'hover:text-sidebar-hover-foreground'
      : 'hover:text-sidebar-foreground-muted';

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
            aria-label="New task"
            onClick={() => onNew?.(group.repoFullName ?? undefined)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}

        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>

      {!group.collapsed && (
        <div className="flex flex-col gap-px">
          {visibleTasks.length > 0 &&
            visibleTasks.map((task) => {
              const isSelected = task.taskId === selectedTaskId;
              const showSelectedState = isSelected && !isMobile;
              const relativeTime = formatCompactRelativeTime(task.latestMessageAt, now);
              const prUrl = normalizePrUrl(task.prUrl);
              const prNumber =
                typeof task.prNumber === 'number' && Number.isFinite(task.prNumber)
                  ? task.prNumber
                  : prUrl
                    ? parseGitHubPrNumber(prUrl)
                    : null;
              const prStatus = task.prStatus ?? 'open';
              const hasPr = Boolean(prUrl);
              const hasChanges = task.addedLines !== 0 || task.deletedLines !== 0;
              const isMergeable = hasPr && task.prReadiness === 'y';
              const showMergeablePill = isMergeable && !isSelected;
              const canArchive = typeof onArchiveTask === 'function';
              const showInlineArchive = canArchive && !isMobile;
              const isChatTask = group.kind === 'chat';
              // Copy URL stays available for private sessions (the link still
              // works for the owner); sharing is a separate menu item shown only
              // while the conversation isn't team-visible.
              const shareMenuState = !task.sharing
                ? null
                : task.sharing.visibility === 'unknown'
                  ? 'loading'
                  : task.sharing.visibility === 'team'
                    ? null
                    : task.sharing.privateReason === 'machine-not-registered'
                      ? 'unregistered'
                      : task.sharing.canManage
                        ? 'share'
                        : 'owner-only';
              // Stretched-link pattern: a transparent absolute `<a>` overlays the row so
              // browsers can handle middle/Cmd-click natively (open in new tab). Plain left
              // click is intercepted via preventDefault and routed through onSelectTask for
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
              const isEditingTitle = editingTaskId === task.taskId;
              const taskHref =
                isSelectable && !isEditingTitle ? getTaskHref?.(task.taskId) : undefined;
              const useAnchor = typeof taskHref === 'string' && taskHref.length > 0;
              const renderTitle = (extraClassName?: string) =>
                isEditingTitle ? (
                  <input
                    type="text"
                    autoFocus
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename(task.taskId, task.title);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelRename();
                      }
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(task.taskId, task.title)}
                    onFocus={(e) => e.currentTarget.select()}
                    className={cn(
                      'min-w-0 w-full truncate bg-transparent outline-hidden',
                      'border border-sidebar-ring/40 rounded-sm px-1 -mx-1',
                      'text-sm',
                      extraClassName
                    )}
                  />
                ) : (
                  <span className={cn('truncate', extraClassName)}>{task.title}</span>
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
                    onSelectTask?.(task.taskId);
                  }
                : undefined;
              // Mobile keeps swipe-to-archive as the only row gesture; the context
              // menu (and its ⋯ button) is desktop-only. Computed before the row so
              // the leading slot can show the ⋯ affordance.
              const hasMenuActions =
                !isMobile &&
                Boolean(
                  onRenameTask ||
                  onTogglePinTask ||
                  onArchiveTask ||
                  onCopySessionUrl ||
                  shareMenuState ||
                  task.branchName ||
                  (onOpenPullRequest && prUrl)
                );
              const row = (
                <div
                  key={task.taskId}
                  role={!useAnchor && isSelectable ? 'button' : undefined}
                  tabIndex={!useAnchor && isSelectable ? 0 : undefined}
                  aria-disabled={!isSelectable ? true : undefined}
                  aria-current={isSelected ? 'page' : undefined}
                  data-id={`session:${task.taskId}`}
                  data-scope-item="row"
                  data-sidebar-session-id={task.taskId}
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
                          if (isEditingTitle) return;
                          onSelectTask?.(task.taskId);
                        }
                  }
                  onKeyDown={
                    useAnchor
                      ? undefined
                      : (e) => {
                          if (!isSelectable) return;
                          if (isEditingTitle) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectTask?.(task.taskId);
                          }
                        }
                  }
                >
                  {useAnchor && taskHref ? (
                    <a
                      href={taskHref}
                      aria-label={task.title}
                      className="absolute inset-0 z-10 rounded-md focus:outline-hidden focus-visible:shadow-none"
                      onClick={handleAnchorClick}
                    />
                  ) : null}
                  <div className="flex min-w-0 items-center gap-1.5">
                    <SessionRowLeadingSlot
                      isWaitingPermission={task.isWaitingPermission}
                      isWorking={task.isWorking}
                      hasUnreadMessages={task.hasUnreadMessages}
                      showMenuButton={hasMenuActions}
                      menuLabel={moreActionsLabel}
                    />
                    <div
                      className={cn(
                        'min-w-0 flex-1 flex items-center gap-1 truncate text-sm',
                        showSelectedState
                          ? 'text-sidebar-selection-foreground'
                          : 'text-sidebar-foreground dark:text-sidebar-foreground/75',
                        useAnchor && isEditingTitle && 'relative z-20'
                      )}
                      // Double-click to rename is scoped to the title only, so it can't
                      // be triggered by double-clicking the Archive confirm button.
                      onDoubleClick={(e) => {
                        if (typeof onRenameTask !== 'function' || isEditingTitle) return;
                        e.preventDefault();
                        e.stopPropagation();
                        beginRename(task.taskId, task.title);
                      }}
                    >
                      {task.isPinned ? (
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
                        isChatTask ? (
                          <span className={cn('flex items-center gap-1.5', useAnchor && 'z-20')}>
                            <TaskRowTime
                              relativeTime={relativeTime}
                              className="text-xs text-muted-foreground"
                            />
                            {task.sharing ? <SessionSharingIndicator state={task.sharing} /> : null}
                          </span>
                        ) : hasPr ||
                          hasChanges ||
                          showMergeablePill ||
                          isMobile ||
                          task.sharing?.visibility === 'private' ? (
                          <span
                            className={cn(
                              'flex select-none items-center gap-1.5 text-[11px] tabular-nums text-sidebar-foreground-muted/80',
                              useAnchor && 'z-20'
                            )}
                          >
                            {isMobile ? (
                              <TaskRowTime
                                relativeTime={relativeTime}
                                className="text-muted-foreground"
                              />
                            ) : null}
                            {showMergeablePill ? (
                              <SessionMergeablePill />
                            ) : hasChanges && !isMergeable ? (
                              <span className="flex items-center gap-1">
                                <span className="text-code-added">+{task.addedLines}</span>
                                <span className="text-code-removed">-{task.deletedLines}</span>
                              </span>
                            ) : null}
                            {hasPr ? (
                              <SessionPrIcon prStatus={prStatus} prCiState={task.prCiState} />
                            ) : null}
                            {task.sharing ? <SessionSharingIndicator state={task.sharing} /> : null}
                          </span>
                        ) : undefined
                      }
                      archive={
                        showInlineArchive ? (
                          <SidebarRowArchiveButton
                            label={archiveTooltipLabel}
                            confirmLabel={archiveConfirmLabel}
                            onConfirm={() => onArchiveTask?.(task.taskId)}
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
                <ContextMenu key={task.taskId}>
                  <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                  <ContextMenuContent className="min-w-[180px]">
                    {onOpenPullRequest && prUrl ? (
                      <>
                        <ContextMenuItem
                          onSelect={() => {
                            onOpenPullRequest({
                              taskId: task.taskId,
                              repoFullName: group.repoFullName,
                              prUrl,
                              prNumber,
                            });
                          }}
                        >
                          <GitPullRequest />
                          {contextMenuLabels.openPr}
                        </ContextMenuItem>
                        {onRenameTask ||
                        onTogglePinTask ||
                        onArchiveTask ||
                        onCopySessionUrl ||
                        task.branchName ? (
                          <ContextMenuSeparator />
                        ) : null}
                      </>
                    ) : null}
                    {onRenameTask ? (
                      <ContextMenuItem
                        onSelect={() => {
                          beginRename(task.taskId, task.title);
                        }}
                      >
                        <Pencil />
                        {contextMenuLabels.rename}
                      </ContextMenuItem>
                    ) : null}
                    {onTogglePinTask ? (
                      <ContextMenuItem
                        onSelect={() => {
                          onTogglePinTask(task.taskId, !task.isPinned);
                        }}
                      >
                        {task.isPinned ? <PinOff /> : <Pin />}
                        {task.isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
                      </ContextMenuItem>
                    ) : null}
                    {onArchiveTask ? (
                      <ContextMenuItem
                        onSelect={() => {
                          onArchiveTask(task.taskId);
                        }}
                      >
                        <Archive />
                        {contextMenuLabels.archive}
                      </ContextMenuItem>
                    ) : null}
                    {(onRenameTask || onTogglePinTask || onArchiveTask) &&
                    (onCopySessionUrl || task.branchName) ? (
                      <ContextMenuSeparator />
                    ) : null}
                    {onCopySessionUrl ? (
                      <ContextMenuItem
                        onSelect={() => {
                          onCopySessionUrl(task.taskId);
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
                          onShareSessionWithTeam?.(task.taskId);
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
                    {task.branchName ? (
                      <ContextMenuItem
                        onSelect={() => {
                          void navigator.clipboard.writeText(task.branchName).catch(() => {});
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
                  key={task.taskId}
                  kind={isChatTask ? 'chat' : 'github'}
                  author={task.owner ?? undefined}
                  title={task.title}
                  isWorktree={task.isWorktree}
                  latestMessageAt={task.latestMessageAt}
                  now={now}
                  repoFullName={group.repoFullName}
                  machineName={task.machineName}
                  branchName={task.branchName}
                  prStatus={hasPr ? prStatus : undefined}
                  prCiState={task.prCiState}
                  prNumber={prNumber}
                  prUrl={prUrl}
                  onOpenPullRequest={
                    onOpenPullRequest && prUrl
                      ? () =>
                          onOpenPullRequest({
                            taskId: task.taskId,
                            repoFullName: group.repoFullName,
                            prUrl,
                            prNumber,
                          })
                      : undefined
                  }
                  addedLines={hasChanges ? task.addedLines : undefined}
                  deletedLines={hasChanges ? task.deletedLines : undefined}
                  sharing={task.sharing}
                >
                  {menuRow}
                </SessionInfoHoverCard>
              ) : (
                menuRow
              );

              if (!canArchive || !isMobile) {
                return desktopRow;
              }

              return (
                <SwipeActionRow
                  key={task.taskId}
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
                      onClick: () => onArchiveTask?.(task.taskId),
                    },
                  ]}
                  onCommit={() => onArchiveTask?.(task.taskId)}
                >
                  {menuRow}
                </SwipeActionRow>
              );
            })}
          {shouldShowExpandCollapse && (
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
    </div>
  );
});

function SortableRepoGroupSection({
  group,
  canReorderRepos,
  ...props
}: Omit<TaskGroupSectionProps, 'dragHandle' | 'trailingContent'> & {
  group: TaskGroup & { kind: 'repo'; repoFullName: string };
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
      <TaskGroupSection
        {...props}
        group={group}
        dragHandle={dragHandle}
        trailingContent={trailingContent}
      />
    </div>
  );
}

export const TaskList = memo(function TaskList({
  tasks,
  repos,
  isLoading = false,
  chatsCollapsed = false,
  selectedTaskId,
  activeGroupKey,
  className,
  onSelect,
  onSelectTask,
  onToggleRepoCollapsed,
  onToggleChatsCollapsed,
  onArchiveTask,
  onRenameTask,
  onTogglePinTask,
  onCopySessionUrl,
  onShareSessionWithTeam,
  onNew,
  onMoveRepo,
  onOpenPullRequest,
  onNavigateToNewSession,
  getTaskHref,
  headerAction,
}: TaskListProps) {
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
      copyUrl: t('sessions.contextMenu.copyUrl', 'Copy Session URL'),
      shareWithTeam: t('sessions.sharing.shareWithTeam', 'Share with team…'),
      onlyOwnerCanShare: t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share'),
      registerDeviceToShare: t(
        'sessions.sharing.registerDeviceToShare',
        'Register this device before sharing'
      ),
      loadingSharing: t('sessions.sharing.loadingAction', 'Checking sharing…'),
      copyBranch: t('sessions.contextMenu.copyBranch', 'Copy Current Branch'),
    }),
    [t]
  );
  const isMobile = useIsMobile();
  const groups = useMemo(
    () => buildGroups(tasks, repos, chatsCollapsed),
    [tasks, repos, chatsCollapsed]
  );
  const now = useStableNow();
  const [whetherShowFullListByGroup, setWhetherShowFullListByGroup] =
    useAtom(sidebarShowFullListAtom);
  const handleSelect = onSelect ?? onSelectTask;
  const repoIds = useMemo(
    () => groups.filter((group) => group.kind === 'repo').map((group) => group.key),
    [groups]
  );
  const canReorderRepos = typeof onMoveRepo === 'function' && repoIds.length > 1;
  const repoStateByFullName = useMemo(() => {
    const map = new Map<string, TaskListRepoState>();
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

  if (isLoading && tasks.length === 0) {
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
    const nextRepos: TaskListRepoState[] = nextRepoFullNames.map((repoFullName) => {
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
                    group={group as TaskGroup & { kind: 'repo'; repoFullName: string }}
                    canReorderRepos={canReorderRepos}
                    headerAction={groupHeaderAction}
                    now={now}
                    selectedTaskId={selectedTaskId}
                    activeGroupKey={activeGroupKey}
                    whetherShowFullList={whetherShowFullList}
                    onSelectTask={handleSelect}
                    onToggleRepoCollapsed={onToggleRepoCollapsed}
                    onToggleChatsCollapsed={onToggleChatsCollapsed}
                    onArchiveTask={onArchiveTask}
                    onRenameTask={onRenameTask}
                    onTogglePinTask={onTogglePinTask}
                    onCopySessionUrl={onCopySessionUrl}
                    onShareSessionWithTeam={onShareSessionWithTeam}
                    onNew={onNew}
                    onNavigateToNewSession={onNavigateToNewSession}
                    onOpenPullRequest={onOpenPullRequest}
                    onToggleFullList={handleToggleFullList}
                    getTaskHref={getTaskHref}
                    archiveTooltipLabel={archiveTooltipLabel}
                    archiveActionLabel={archiveActionLabel}
                    archiveConfirmLabel={archiveConfirmLabel}
                    contextMenuLabels={contextMenuLabels}
                    isMobile={isMobile}
                  />
                );
              }

              return (
                <TaskGroupSection
                  key={group.key}
                  group={group}
                  headerAction={groupHeaderAction}
                  now={now}
                  selectedTaskId={selectedTaskId}
                  activeGroupKey={activeGroupKey}
                  whetherShowFullList={whetherShowFullList}
                  onSelectTask={handleSelect}
                  onToggleRepoCollapsed={onToggleRepoCollapsed}
                  onToggleChatsCollapsed={onToggleChatsCollapsed}
                  onArchiveTask={onArchiveTask}
                  onRenameTask={onRenameTask}
                  onTogglePinTask={onTogglePinTask}
                  onCopySessionUrl={onCopySessionUrl}
                  onShareSessionWithTeam={onShareSessionWithTeam}
                  onNew={onNew}
                  onNavigateToNewSession={onNavigateToNewSession}
                  onOpenPullRequest={onOpenPullRequest}
                  onToggleFullList={handleToggleFullList}
                  getTaskHref={getTaskHref}
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
