import { cn } from '@/lib/utils';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import { sidebarSurface } from './sidebar-surface';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';
/**
 * The parts of a task row that were Tailwind. The row's own box, ink and
 * fills come from sidebarSurface; these are the pieces around it.
 */
const taskStyles = stylex.create({
  /** A group: the label row and the conversations under it. */
  groupStack: { display: 'flex', flexDirection: 'column', gap: themeSpace[0.5] },
  groupSpacingCollapsed: { marginBottom: { default: themeSpace[1], ':last-child': 0 } },
  groupSpacing: { marginBottom: { default: themeSpace[2.5], ':last-child': 0 } },
  groupRow: { display: 'flex', alignItems: 'center', height: themeSpace[7] },
  groupHeader: {
    position: 'relative',
    display: 'flex',
    height: themeSpace[7],
    width: '100%',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
    textAlign: 'left',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The group's own mark, left-anchored on the toggle's centre line. */
  groupMark: {
    position: 'absolute',
    left: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    width: themeSpace[4],
    height: themeSpace[4],
    transitionProperty: 'opacity',
    transitionDuration: themeDuration[100],
    transitionTimingFunction: themeEasing['in-out'],
  },
  groupChevron: {
    position: 'absolute',
    left: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    width: themeSpace[4],
    height: themeSpace[4],
    transitionProperty: 'opacity, translate, scale, rotate',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing.out,
  },
  groupChevronTrailing: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: 'currentcolor',
    transitionProperty: 'opacity, translate, scale, rotate',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing.out,
  },
  groupChevronCollapsed: { rotate: '-90deg' },
  groupChevronOpen: { rotate: '0deg' },
  groupName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  groupToggle: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The group's new-task button, revealed on hover. */
  groupNewButton: {
    marginLeft: 'auto',
    display: 'inline-flex',
    height: themeSpace[6],
    width: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.sm,
    transitionProperty: 'opacity, background-color, color',
    transitionDuration: themeDuration[100],
    transitionTimingFunction: themeEasing['in-out'],
    opacity: 0,
    pointerEvents: 'none',
    backgroundColor: { default: 'transparent', ':hover': themeColors.sidebarHover },
    color: {
      default: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
      ':hover': themeColors.sidebarHoverForeground,
    },
    // The Tailwind `focus-visible:ring-2 focus-visible:ring-sidebar-ring/40`
    // this button used to carry declared a full box-shadow in the utilities
    // layer, which erased the app's global inset focus ring, and the app
    // forces Tailwind's own ring transparent — so the button showed NO focus
    // indicator of its own. Keep that: no resting shadow, and no focus
    // shadow.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  /** The drag handle's own box. */
  dragHandle: {
    display: 'inline-flex',
    height: themeSpace[6],
    width: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.sm,
    transitionProperty: 'opacity, background-color, color',
    transitionDuration: themeDuration[100],
    transitionTimingFunction: themeEasing['in-out'],
    opacity: 0,
    pointerEvents: 'none',
    backgroundColor: { default: 'transparent', ':hover': themeColors.sidebarHover },
    color: {
      default: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
      ':hover': themeColors.sidebarHoverForeground,
    },
    cursor: { default: 'grab', ':active': 'grabbing' },
    // The Tailwind `focus-visible:ring-2 focus-visible:ring-sidebar-ring/40`
    // this handle used to carry declared a full box-shadow in the utilities
    // layer, which erased the app's global inset focus ring, and the app
    // forces Tailwind's own ring transparent — so the handle showed NO focus
    // indicator of its own. Keep that: no resting shadow, and no focus
    // shadow.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  /** The row's body: the title and, under it, the meta line. */
  rowContent: { display: 'flex', minWidth: 0, alignItems: 'center', gap: themeSpace[1.5] },
  titleRow: { display: 'flex', alignItems: 'center', gap: themeSpace[1] },
  /** A title the row owns: one clipped line, regular weight. */
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
  },
  /** The stretched link that covers the row. */
  anchor: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    borderRadius: themeRadius.md,
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  /** A child that must escape the stretched link to keep its own pointer events. */
  raised: { position: 'relative', zIndex: 20 },
  /** The row that shows the rest of a group. */
  showMore: {
    display: 'flex',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[2],
    textAlign: 'left',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: { default: 'transparent', ':hover': themeColors.sidebarHover },
    color: {
      default: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
      ':hover': themeColors.sidebarHoverForeground,
    },
    // The Tailwind `focus-visible:ring-2 focus-visible:ring-sidebar-ring/40`
    // this row used to carry declared a full box-shadow in the utilities
    // layer, which erased the app's global inset focus ring, and the app
    // forces Tailwind's own ring transparent — so the row showed NO focus
    // indicator of its own. Keep that: no resting shadow, and no focus
    // shadow.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  toggleBox: {
    display: 'flex',
    height: themeSpace[4],
    width: themeSpace[4],
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallGlyph: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
  archiveIcon: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  archiveAction: {
    backgroundColor: themeColors.sidebarHover,
    color: themeColors.sidebarHoverForeground,
  },
  listStack: { display: 'flex', flexDirection: 'column' },
  // These declarations read the app variables at the row, including scoped overrides.
  time: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 'calc(var(--spacing) * 1)',
  },
  timeText: { userSelect: 'none', fontVariantNumeric: 'tabular-nums' },
  flexOne: { flex: '1' },
  noShrink: { flexShrink: 0 },
  taskRows: { display: 'flex', flexDirection: 'column', gap: '1px' },
  pointer: { cursor: 'pointer' },
  defaultCursor: { cursor: 'default' },
  activeGroupBorder: {
    borderColor: 'color-mix(in oklab, hsl(var(--sidebar-ring) / 1) 30%, transparent)',
  },
  repoHeaderWeight: { fontWeight: 'var(--font-weight-medium)' },
  rowBox: { position: 'relative', width: '100%', textAlign: 'left' },
  pinGlyph: {
    width: 'calc(var(--spacing) * 3)',
    height: 'calc(var(--spacing) * 3)',
    flexShrink: 0,
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted) / 1) 80%, transparent)',
  },
  restIcons: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 1.5)' },
  raisedRest: { zIndex: 20 },
  chatTime: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--tw-leading, var(--text-xs--line-height))',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  timeInk: { color: 'hsl(var(--muted-foreground) / 1)' },
  repoRest: {
    userSelect: 'none',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted) / 1) 80%, transparent)',
  },
  repoWidth: { width: '100%' },
  repoDragging: { opacity: 0.6 },
  emptyHeader: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  renameInput: {
    minWidth: 0,
    width: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--sidebar-ring) / 1) 40%, transparent)',
    borderRadius: 'var(--radius-sm)',
    paddingInline: 'calc(var(--spacing) * 1)',
    marginInline: 'calc(var(--spacing) * -1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--tw-leading, var(--text-sm--line-height))',
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
  },

  /** A list's header row: the action sits at the list's end. */
  listHeader: {
    display: 'flex',
    height: themeSpace[7],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  /** The chevron is hidden until the row is hovered. */
  chevronHidden: { opacity: 0 },
  chevronShown: { opacity: 1 },
  /** The group mark rests a step quieter than the label. */
  markDimmed: { opacity: 0.8 },
  /** A row's own hairline edge: a transparent border that a focus ring can
      replace without moving anything. */
  rowBorder: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
  },
});

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
  Pencil,
  Pin,
  PinOff,
  Plus,
  Users,
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
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@lody/ui/tooltip';
import { ContextMenu } from '@lody/ui/context-menu';
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
  SidebarSessionTitleText,
  SessionMergeablePill,
  SIDEBAR_GROUP_LABEL_CLASS,
  SIDEBAR_GROUP_LABEL_COLOR_CLASS,
  SIDEBAR_ROW_TEXT_CLASS,
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
    <span className={clsx(stylex.props(taskStyles.time).className, className)}>
      <span {...stylex.props(taskStyles.timeText)}>{relativeTime}</span>
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
  // The same two rungs as the session list: a repo ("loro-dev/loro") is a row
  // (row type, medium, the row ink from `sidebarSurface.row`) and "Chats" is the
  // shared group label.
  const isRepoHeader = group.kind === 'repo';
  const headerBaseColorClass = isRepoHeader ? undefined : SIDEBAR_GROUP_LABEL_COLOR_CLASS;
  const headerTypographyClass = isRepoHeader
    ? clsx(SIDEBAR_ROW_TEXT_CLASS, stylex.props(taskStyles.repoHeaderWeight).className)
    : SIDEBAR_GROUP_LABEL_CLASS;
  const headerToggleHoverClass = isRepoHeader ? undefined : 'hover:text-sidebar-foreground';

  return (
    <div
      className={clsx(
        stylex.props(taskStyles.groupStack).className,
        stylex.props(group.collapsed ? taskStyles.groupSpacingCollapsed : taskStyles.groupSpacing)
          .className
      )}
    >
      <div className={clsx('group', stylex.props(taskStyles.groupRow).className)}>
        <div
          role={canNavigate || canToggle ? 'button' : undefined}
          tabIndex={canNavigate || canToggle ? 0 : -1}
          data-id={`group:${group.key}`}
          data-scope-item="row"
          data-sidebar-group-key={group.key}
          className={clsx(
            stylex.props(
              taskStyles.groupHeader,
              showActiveGroupState && taskStyles.activeGroupBorder,
              showActiveGroupState || canNavigate || canToggle
                ? taskStyles.pointer
                : taskStyles.defaultCursor
            ).className,
            headerTypographyClass,
            stylex.props(
              sidebarSurface.row,
              showActiveGroupState
                ? sidebarSurface.selected
                : canNavigate && !isMobile && isRepoHeader && sidebarSurface.hover
            ).className,
            showActiveGroupState
              ? undefined
              : canNavigate
                ? headerBaseColorClass
                : canToggle
                  ? cn(headerBaseColorClass, !isMobile && headerToggleHoverClass)
                  : headerBaseColorClass
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
              {...stylex.props(taskStyles.groupToggle)}
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
                className={clsx(
                  // Left-anchored (not centered in the 20px button) so its left edge
                  // lines up with the session rows' leading status slot below.
                  stylex.props(taskStyles.groupMark).className,
                  // Mobile: chevron is always shown so the owner avatar must hide
                  // permanently to avoid the two icons overlapping.
                  stylex.props(
                    canToggle && isMobile ? taskStyles.chevronHidden : taskStyles.markDimmed
                  ).className,
                  canToggle && 'group-hover:opacity-0'
                )}
              />
              {canToggle && (
                <ChevronDown
                  className={clsx(
                    stylex.props(
                      taskStyles.groupChevron,
                      group.collapsed
                        ? taskStyles.groupChevronCollapsed
                        : taskStyles.groupChevronOpen
                    ).className,
                    stylex.props(isMobile ? taskStyles.chevronShown : taskStyles.chevronHidden)
                      .className,
                    'group-hover:opacity-100'
                  )}
                />
              )}
            </button>
          ) : null}
          <span {...stylex.props(taskStyles.groupName)}>{group.label}</span>
          {!showGroupHeaderIcon && canToggle ? (
            <ChevronDown
              className={clsx(
                stylex.props(
                  taskStyles.groupChevronTrailing,
                  group.collapsed ? taskStyles.groupChevronCollapsed : taskStyles.groupChevronOpen
                ).className,
                stylex.props(
                  group.collapsed || isMobile ? taskStyles.chevronShown : taskStyles.chevronHidden
                ).className,
                'group-hover:opacity-100'
              )}
              aria-hidden="true"
            />
          ) : null}
          <span {...stylex.props(taskStyles.flexOne)} aria-hidden="true" />
        </div>

        {resolvedTrailingContent}

        {canCreateNew && (
          <button
            type="button"
            className={clsx(
              stylex.props(taskStyles.groupNewButton).className,
              'group-hover:opacity-100 group-hover:pointer-events-auto'
            )}
            aria-label="New task"
            onClick={() => onNew?.(group.repoFullName ?? undefined)}
          >
            <Plus {...stylex.props(taskStyles.smallGlyph)} />
          </button>
        )}

        {headerAction ? <div {...stylex.props(taskStyles.noShrink)}>{headerAction}</div> : null}
      </div>

      {!group.collapsed && (
        <div {...stylex.props(taskStyles.taskRows)}>
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
                    className={clsx(stylex.props(taskStyles.renameInput).className, extraClassName)}
                  />
                ) : (
                  <SidebarSessionTitleText
                    sessionId={task.taskId}
                    selected={showSelectedState}
                    className={clsx(stylex.props(taskStyles.titleText).className, extraClassName)}
                  >
                    {task.title}
                  </SidebarSessionTitleText>
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
                    'group',
                    stylex.props(taskStyles.rowBox).className,
                    // Both chat and repo rows are a single line now; the repo row's
                    // low-signal metadata (time / repo / branch / PR) moves to the
                    // desktop hover info card so both organize modes read equally compact.
                    stylex.props(
                      sidebarSurface.row,
                      sidebarSurface.snug,
                      showSelectedState
                        ? sidebarSurface.selected
                        : isSelectable && !isMobile && sidebarSurface.hover
                    ).className,
                    stylex.props(taskStyles.rowBorder).className,
                    // Keyboard-only focus ring. Plain :focus-within also matches
                    // after a mouse click (the overlay <a> keeps focus), which
                    // left a permanent inset ring on the selected row that read
                    // as a misplaced border.
                    useAnchor &&
                      'has-[a:focus-visible]:outline-hidden has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-sidebar-ring/40',
                    stylex.props(isSelectable ? taskStyles.pointer : taskStyles.defaultCursor)
                      .className
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
                      {...stylex.props(taskStyles.anchor)}
                      onClick={handleAnchorClick}
                    />
                  ) : null}
                  <div {...stylex.props(taskStyles.rowContent)}>
                    <SessionRowLeadingSlot
                      showMenuButton={hasMenuActions}
                      menuLabel={moreActionsLabel}
                    />
                    <div
                      className={clsx(
                        stylex.props(taskStyles.titleRow).className,
                        SIDEBAR_ROW_TEXT_CLASS,
                        stylex.props(
                          sidebarSurface.title,
                          showSelectedState && sidebarSurface.titleSelected
                        ).className,
                        useAnchor && isEditingTitle && stylex.props(taskStyles.raised).className
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
                        <Pin aria-hidden="true" {...stylex.props(taskStyles.pinGlyph)} />
                      ) : null}
                      {renderTitle()}
                    </div>
                    {/* Keep PR at the right edge. Line totals stay in the hover card. */}
                    <SidebarRowEndSlot
                      sessionId={task.taskId}
                      isWaitingPermission={task.isWaitingPermission}
                      isWorking={task.isWorking}
                      hasUnreadMessages={task.hasUnreadMessages}
                      restIcon={
                        isChatTask ? (
                          <span
                            {...stylex.props(
                              taskStyles.restIcons,
                              useAnchor && taskStyles.raisedRest
                            )}
                          >
                            <TaskRowTime
                              relativeTime={relativeTime}
                              className={stylex.props(taskStyles.chatTime).className}
                            />
                            {task.sharing ? <SessionSharingIndicator state={task.sharing} /> : null}
                          </span>
                        ) : hasPr ||
                          showMergeablePill ||
                          isMobile ||
                          task.sharing?.visibility === 'private' ? (
                          <span
                            {...stylex.props(
                              taskStyles.restIcons,
                              taskStyles.repoRest,
                              useAnchor && taskStyles.raisedRest
                            )}
                          >
                            {isMobile ? (
                              <TaskRowTime
                                relativeTime={relativeTime}
                                className={stylex.props(taskStyles.timeInk).className}
                              />
                            ) : null}
                            {showMergeablePill ? <SessionMergeablePill /> : null}
                            {hasPr ? (
                              <SessionPrIcon
                                compact
                                prStatus={prStatus}
                                prCiState={task.prCiState}
                              />
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
                <ContextMenu.Root key={task.taskId}>
                  <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
                  <ContextMenu.Content className="min-w-[180px]">
                    {onOpenPullRequest && prUrl ? (
                      <>
                        <ContextMenu.Item
                          icon={GitPullRequest}
                          onClick={() => {
                            onOpenPullRequest({
                              taskId: task.taskId,
                              repoFullName: group.repoFullName,
                              prUrl,
                              prNumber,
                            });
                          }}
                        >
                          {contextMenuLabels.openPr}
                        </ContextMenu.Item>
                        {onRenameTask ||
                        onTogglePinTask ||
                        onArchiveTask ||
                        onCopySessionUrl ||
                        task.branchName ? (
                          <ContextMenu.Separator />
                        ) : null}
                      </>
                    ) : null}
                    {onRenameTask ? (
                      <ContextMenu.Item
                        icon={Pencil}
                        onClick={() => {
                          beginRename(task.taskId, task.title);
                        }}
                      >
                        {contextMenuLabels.rename}
                      </ContextMenu.Item>
                    ) : null}
                    {onTogglePinTask ? (
                      <ContextMenu.Item
                        icon={task.isPinned ? PinOff : Pin}
                        onClick={() => {
                          onTogglePinTask(task.taskId, !task.isPinned);
                        }}
                      >
                        {task.isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
                      </ContextMenu.Item>
                    ) : null}
                    {onArchiveTask ? (
                      <ContextMenu.Item
                        icon={Archive}
                        onClick={() => {
                          onArchiveTask(task.taskId);
                        }}
                      >
                        {contextMenuLabels.archive}
                      </ContextMenu.Item>
                    ) : null}
                    {(onRenameTask || onTogglePinTask || onArchiveTask) &&
                    (onCopySessionUrl || task.branchName) ? (
                      <ContextMenu.Separator />
                    ) : null}
                    {onCopySessionUrl ? (
                      <ContextMenu.Item
                        icon={Link2}
                        onClick={() => {
                          onCopySessionUrl(task.taskId);
                        }}
                      >
                        {contextMenuLabels.copyUrl}
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
                          onShareSessionWithTeam?.(task.taskId);
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
                    {task.branchName ? (
                      <ContextMenu.Item
                        icon={GitBranch}
                        onClick={() => {
                          void navigator.clipboard.writeText(task.branchName).catch(() => {});
                        }}
                      >
                        {contextMenuLabels.copyBranch}
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
                      icon: <Archive {...stylex.props(taskStyles.archiveIcon)} />,
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
              className={stylex.props(taskStyles.showMore).className}
              aria-label={toggleListLabel}
              onClick={() => onToggleFullList?.(group.key)}
            >
              <span {...stylex.props(taskStyles.toggleBox)} aria-hidden="true" />
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
      className={clsx(
        stylex.props(taskStyles.dragHandle).className,
        'group-hover:opacity-100 group-hover:pointer-events-auto'
      )}
      aria-label="Reorder repo"
      {...attributes}
      {...listeners}
    >
      <GripVertical {...stylex.props(taskStyles.smallGlyph)} />
    </button>
  ) : null;
  const trailingContent = dragHandle;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...stylex.props(taskStyles.repoWidth, isDragging && taskStyles.repoDragging)}
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
      <div {...stylex.props(taskStyles.listStack)}>
        {headerAction ? <div {...stylex.props(taskStyles.listHeader)}>{headerAction}</div> : null}
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
      return <div {...stylex.props(taskStyles.emptyHeader)}>{headerAction}</div>;
    }
    return null;
  }

  return (
    <Tooltip.Provider>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={repoIds} strategy={verticalListSortingStrategy}>
          <div className={clsx(stylex.props(taskStyles.listStack).className, className)}>
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
    </Tooltip.Provider>
  );
});
