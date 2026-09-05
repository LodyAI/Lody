import {
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { cn } from '@/lib/utils';
import { WINDOW_DRAG_EXEMPT_CLASS, WINDOW_DRAG_HEADER_CLASS } from '@/ui/window-drag-region';
import { useElectronFullscreen } from '@/lib/electron';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Kbd } from '@/ui/kbd';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { commands, formatKeyBinding, type ShortcutCommandId } from '@/lib/commands';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { ScrollArea } from '@/ui/scroll-area';
import {
  Archive,
  ListTodo,
  BookOpen,
  Bug,
  CircleHelp,
  Github,
  SquarePen,
  Link2,
  Loader2,
  MessageSquareMore,
  PanelLeft,
  Plus,
  Settings,
  Users,
} from 'lucide-react';
import {
  SessionList,
  type SessionListProps,
  type SessionListPullRequestOpen,
  type SessionListRow,
} from './session-list';
import {
  SidebarUpdatedSessionList,
  type SidebarUpdatedBucketKey,
  type SidebarUpdatedItem,
  type SidebarUpdatedSessionListLabels,
} from './sidebar-updated-session-list';
import { SidebarFilterPopover, type SidebarFilterLabels } from './sidebar-filter-popover';
import { WorkspaceAvatar } from './workspace-avatar';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import { useIsMobile } from '@/hooks/use-mobile';
import { useStableNow } from '@/hooks/use-stable-now';

export type LoroSidebarNavKey = 'home' | 'archive' | 'tasks';

export type LoroSidebarChatScope = 'my' | 'team';
export type LoroSidebarOrganizeMode = SidebarOrganizeMode;

export type LoroSidebarWorkspace = {
  id: string;
  name: string;
  logo?: string | null;
  /** Paid plan tier for the Plus/Enterprise badge; null/undefined = free. */
  planTier?: 'plus' | 'enterprise' | null;
};

export type LoroSidebarRepoItemDelta = {
  add: number;
  del: number;
};

export type LoroSidebarRepoItem = {
  id: string;
  title: string;
  ageLabel?: string;
  lineChange?: LoroSidebarRepoItemDelta;
  isSelected?: boolean;
};

export type LoroSidebarRepoSection = {
  id: string;
  repoFullName: string;
  items: LoroSidebarRepoItem[];
};

export type LoroSidebarChatItem = {
  id: string;
  title: string;
  ageLabel?: string;
  isUnread?: boolean;
};

export type LoroSidebarLabels = {
  home: string;
  tasks: string;
  newTask: string;
  docs: string;
  joinCommunity: string;
  feedback: string;
  bugReport: string;
  myChats: string;
  teamChats: string;
  onlyChats: string;
  switchWorkspace: string;
  createWorkspace: string;
  inviteMembers: string;
  connectGithubRepo: string;
  planPlus: string;
  planEnterprise: string;
  pinned: string;
  connectionLoading: string;
  connectionReconnecting: string;
  connectionOffline: string;
  workspaceSyncing: string;
  filter: SidebarFilterLabels;
  updated: SidebarUpdatedSessionListLabels;
};

export interface LoroSidebarProps {
  className?: string;

  workspaceName: string;
  userEmail: string;
  workspaces: LoroSidebarWorkspace[];
  currentWorkspaceId: string;
  /**
   * Whether the workspace identity opens the switch/create menu. Platforms
   * without the `multiWorkspace` capability render the identity as a static
   * nameplate so the unavailable product concept has no mouse or keyboard
   * affordance.
   */
  workspaceSwitcherEnabled?: boolean;
  connectionUiState?: 'online' | 'loading' | 'offline' | 'reconnecting';
  /**
   * The network may already be online while the target workspace runtime and
   * metadata are still converging. Keep that scoped readiness visible in the
   * workspace identity instead of incorrectly presenting it as ready.
   */
  workspaceSyncing?: boolean;
  isElectron?: boolean;
  isElectronMacOS?: boolean;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;

  activeNav?: LoroSidebarNavKey | null;

  topContent?: ReactNode;
  /** Reserves the filter trigger's space in the first visible section header. */
  desktopFilterPlaceholder?: ReactNode;
  /**
   * In-flow content rendered after {@link sessionListProps} inside the scroll
   * viewport (workspace mode only). LoroAppSidebar uses this to place the Chats
   * section below the GitHub Worktrees list so Chats reads as the last section.
   */
  afterSessionListContent?: ReactNode;
  bottomFloatingContent?: ReactNode;

  repoSections?: LoroSidebarRepoSection[];
  chats?: LoroSidebarChatItem[];
  sessionListProps?: SessionListProps;

  /**
   * How sidebar contents are grouped. 'workspace' (default) keeps the existing Chats /
   * Local Projects / GitHub Worktrees layout. 'updated' renders {@link updatedItems} as
   * a single flat recency-sorted "Chats" list — when 'updated' is selected,
   * {@link topContent} and {@link sessionListProps} are not rendered.
   */
  organizeMode?: LoroSidebarOrganizeMode;
  /** Current chat scope (My Tasks / All Tasks). Surfaced in the footer filter popover. */
  chatScope?: LoroSidebarChatScope;
  /** Items rendered when {@link organizeMode} is 'updated'. */
  updatedItems?: SidebarUpdatedItem[];
  /** Pinned sessions rendered as a dedicated section above every organize mode. */
  pinnedItems?: SidebarUpdatedItem[];
  /** Whether the dedicated pinned section is collapsed. */
  pinnedSectionCollapsed?: boolean;
  /** Selected item id used to highlight a row in 'updated' mode. */
  updatedSelectedItemId?: string | null;
  /** Per-bucket collapse state for the 'updated' organize mode. */
  updatedBucketsCollapsed?: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  /**
   * Per-bucket "show all" state for the 'updated' organize mode. Buckets above
   * the threshold default to a compact preview; this map records which buckets
   * the user has expanded.
   */
  updatedShowFullBuckets?: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  /**
   * Loading state for the 'updated' organize mode. When true and there are no
   * items yet, the list renders a skeleton instead of the empty state — keeps
   * the visual contract aligned with `SessionList.isLoading` in Workspace mode.
   */
  updatedIsLoading?: boolean;
  onOrganizeModeChange?: (mode: LoroSidebarOrganizeMode) => void;
  onChatScopeChange?: (scope: LoroSidebarChatScope) => void;
  onSelectUpdatedItem?: (id: string, tabSessionId?: string) => void;
  onTogglePinnedSection?: () => void;
  onToggleUpdatedBucket?: (key: SidebarUpdatedBucketKey) => void;
  onToggleUpdatedShowFullBucket?: (key: SidebarUpdatedBucketKey) => void;
  /**
   * Archive a session from the 'updated' organize mode. Mirrors `sessionListProps.onArchiveSession`
   * so both organize modes share the same destination handler.
   */
  onArchiveUpdatedItem?: (id: string) => void;
  /** Mark a read session unread in the desktop Updated/Pinned lists. */
  onMarkUpdatedItemUnread?: (id: string) => void;
  /** Rename an Updated row through the shared Rename Chat dialog. */
  onRenameUpdatedItem?: (id: string, nextTitle: string) => void | Promise<void>;
  /** Toggle pin for an Updated row. Mirrors `sessionListProps.onTogglePinSession`. */
  onToggleUpdatedItemPinned?: (id: string, nextPinned: boolean) => void;
  /** Copy session URL for an Updated row. Mirrors `sessionListProps.onCopySessionUrl`. */
  onCopyUpdatedItemUrl?: (id: string) => void;
  /** Share an Updated row with the team. Mirrors `sessionListProps.onShareSessionWithTeam`. */
  onShareUpdatedItemWithTeam?: (id: string) => void;
  /** Open PR for a github Updated row. Mirrors `sessionListProps.onOpenPullRequest`. */
  onOpenUpdatedItemPullRequest?: (request: SessionListPullRequestOpen) => void;
  getUpdatedItemHref?: (id: string) => string | undefined;

  labels?: Partial<LoroSidebarLabels>;

  onWorkspaceSelected?: (workspaceId: string) => void;
  onCreateWorkspaceClicked?: () => void;
  onInviteClicked?: () => void;
  onLinkRepoClicked?: () => void;
  onHomeClicked?: () => void;
  onArchiveClicked?: () => void;
  onTasksClicked?: () => void;
  /** Capture a task without leaving where you are. Also gated by `showTasks`. */
  onNewTaskClicked?: () => void;
  /**
   * Whether the Tasks entry exists at all. Defaults to false so a caller that
   * forgets it hides the beta rather than leaking it — see
   * `tasksFeatureEnabledAtom`.
   */
  showTasks?: boolean;
  onSettingsClicked?: () => void;
  onDocsClicked?: () => void;
  onJoinCommunityClicked?: () => void;
  onFeedbackClicked?: () => void;
  onBugReportClicked?: () => void;
  onChatScopeChanged?: (scope: LoroSidebarChatScope) => void;
  onWidthChange?: (width: number) => void;
  /**
   * When true, the sidebar renders nothing (fully hidden). Mobile ignores this —
   * mobile uses the drawer instead. Drag-to-collapse and the workspace-row
   * hover button both fire `onRequestCollapse` to set this externally.
   */
  collapsed?: boolean;
  /**
   * Fired when the user requests collapsing the sidebar (drag past threshold,
   * hover-reveal button on the workspace row, or keyboard shortcut at parent).
   */
  onRequestCollapse?: () => void;
}

/**
 * Drag the resize edge to the LEFT so the unclamped width drops below this
 * value -> the sidebar collapses. Matches VSCode's drag-to-collapse behavior.
 */
const COLLAPSE_DRAG_THRESHOLD = 160;

const defaultLabels: LoroSidebarLabels = {
  home: 'Home',
  tasks: 'Tasks',
  newTask: 'New task',
  docs: 'Docs',
  joinCommunity: 'Join community',
  feedback: 'Feedback',
  bugReport: 'Report bug',
  myChats: 'My Tasks',
  teamChats: 'All Tasks',
  onlyChats: 'Chats',
  switchWorkspace: 'Switch workspace',
  createWorkspace: 'Create workspace',
  inviteMembers: 'Invite members',
  connectGithubRepo: 'Connect GitHub repo',
  planPlus: 'Plus',
  planEnterprise: 'Enterprise',
  pinned: 'Pinned',
  connectionLoading: 'Loading',
  connectionReconnecting: 'Reconnecting',
  connectionOffline: 'Offline',
  workspaceSyncing: 'Syncing workspace…',
  filter: {
    triggerAriaLabel: 'Filter sidebar',
    organizeHeading: 'Organize',
    showHeading: 'Show',
    organizeWorkspace: 'Workspace',
    organizeUpdated: 'Updated',
    showMyTasks: 'My Tasks',
    showAllTasks: 'All Tasks',
  },
  updated: {
    heading: 'Chats',
    emptyTitle: 'Nothing yet',
    emptyDescription: 'Start a chat or open a worktree to see it here.',
  },
};

const PINNED_BUCKETS_COLLAPSED: Partial<Record<SidebarUpdatedBucketKey, boolean>> = {
  all: true,
};

const defaultRepoSections: LoroSidebarRepoSection[] = [
  {
    id: 'repo-1',
    repoFullName: 'loro-dev/loro',
    items: [
      {
        id: 'task-1',
        title: 'Browser notifications',
        ageLabel: '1d',
        lineChange: { add: 123, del: 912 },
        isSelected: true,
      },
      {
        id: 'task-2',
        title: 'Flock meta persistence',
        ageLabel: '2d',
        lineChange: { add: 456, del: 12 },
      },
      {
        id: 'task-3',
        title: 'Why frontend crash',
        ageLabel: '1w',
      },
    ],
  },
  {
    id: 'repo-2',
    repoFullName: 'loro-dev/lody',
    items: [
      {
        id: 'task-4',
        title: 'Fix Data Persistence Issue',
        ageLabel: '10m',
        lineChange: { add: 456, del: 12 },
      },
      {
        id: 'task-5',
        title: 'Delete outdated comments',
        ageLabel: '12m',
        lineChange: { add: 0, del: 172 },
      },
    ],
  },
];

const defaultChats: LoroSidebarChatItem[] = [
  { id: 'chat-1', title: 'Temperature of the sun', ageLabel: '1h', isUnread: true },
  { id: 'chat-2', title: 'How to design workflow', ageLabel: '2h', isUnread: true },
];

function ageLabelToDate(label: string | undefined, now: Date): Date {
  if (!label) return now;

  const match = label.trim().match(/^(\d+)(mo|[mhdwy])$/);
  if (!match) return now;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return now;

  const unit = match[2];
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  const deltaMs =
    unit === 'm'
      ? amount * minuteMs
      : unit === 'h'
        ? amount * hourMs
        : unit === 'd'
          ? amount * dayMs
          : unit === 'w'
            ? amount * 7 * dayMs
            : unit === 'mo'
              ? amount * 30 * dayMs
              : amount * 365 * dayMs;

  return new Date(now.getTime() - deltaMs);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function GlassSurface({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar/80 text-sidebar-foreground shadow-xs',
        className
      )}
    >
      <div className="relative">{children}</div>
    </div>
  );
}

function LineChangeBadge({ lineChange }: { lineChange: LoroSidebarRepoItemDelta }) {
  const addedText = `+${lineChange.add}`;
  const removedText = `-${lineChange.del}`;
  return (
    <div className="flex items-center gap-1 text-[11px] tabular-nums">
      <span className="text-code-added">{addedText}</span>
      <span className="text-code-removed">{removedText}</span>
    </div>
  );
}

type WorkspaceIdentityStatus = 'loading' | 'reconnecting' | 'offline' | 'syncing';

function ConnectionPill({
  state,
  labels,
}: {
  state: WorkspaceIdentityStatus;
  labels: Pick<
    LoroSidebarLabels,
    'connectionLoading' | 'connectionReconnecting' | 'connectionOffline' | 'workspaceSyncing'
  >;
}) {
  const isLoading = state !== 'offline';
  const label =
    state === 'syncing'
      ? labels.workspaceSyncing
      : state === 'reconnecting'
        ? labels.connectionReconnecting
        : state === 'loading'
          ? labels.connectionLoading
          : labels.connectionOffline;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
        isLoading
          ? 'bg-sidebar-hover text-sidebar-foreground-muted'
          : 'bg-status-danger/[0.12] text-status-danger ring-1 ring-status-danger/20'
      )}
      aria-label={label}
      data-workspace-status={state}
    >
      {isLoading ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-status-danger" aria-hidden />
      )}
      <span>{label}</span>
    </span>
  );
}

type IconButtonProps = {
  active?: boolean;
  className?: string;
  label: string;
  children: ReactNode;
} & Omit<
  ComponentPropsWithoutRef<typeof Button>,
  'variant' | 'size' | 'children' | 'className' | 'type'
>;

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { active = false, className, label, children, ...buttonProps }: IconButtonProps,
  ref
) {
  const isMobile = useIsMobile();
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      className={cn(getLoroSidebarFooterIconButtonClassName(isMobile, active), className)}
      {...buttonProps}
    >
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  );
});

/**
 * The live binding for a command, formatted for this platform, or null when the
 * command is unbound (or not registered — Storybook, or the Tasks beta off).
 * Read from the registry rather than `COMMAND_SHORTCUTS` so a rebound key is
 * what the tooltip teaches.
 */
function useCommandShortcutLabel(id: ShortcutCommandId): string | null {
  const binding = useSyncExternalStore(
    (onChange) => commands.subscribe(onChange),
    // A string, not the array: `getKeybindingsFor` allocates, and an unstable
    // snapshot would re-render forever.
    () => commands.getKeybindingsFor(id)[0] ?? '',
    () => ''
  );
  return binding ? formatKeyBinding(binding) : null;
}

/**
 * Quick capture from the Tasks row. Writing a task down has to stay cheaper
 * than starting a chat, so the entry sits where you already are instead of
 * behind a navigation; the tooltip is where its shortcut gets taught.
 */
function SidebarNewTaskButton({ label, onClick }: { label: string; onClick: () => void }) {
  const shortcut = useCommandShortcutLabel('tasks.quickAdd');
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-sidebar-foreground-muted',
              'transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
              'outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring/40'
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-1.5">
          <span>{label}</span>
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function NavButton({
  active,
  label,
  icon,
  onClick,
  badge,
  action,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  /** Optional trailing count. Omitted (not zero-rendered) when there is nothing to report. */
  badge?: number;
  /**
   * Trailing control (e.g. Tasks' quick-add `+`). A sibling of the row button,
   * never a child: a button inside a button is invalid markup, and the browser
   * would route the click to the row underneath it.
   */
  action?: ReactNode;
}) {
  return (
    <div className="relative flex w-full items-center">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'group flex w-full select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-hidden transition',
          'focus-visible:ring-1 focus-visible:ring-sidebar-ring/30',
          active
            ? 'bg-sidebar-selection text-sidebar-selection-foreground'
            : 'text-sidebar-foreground dark:text-sidebar-foreground/75 hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
          // Keep the label clear of the trailing control instead of letting it
          // truncate under it.
          action && 'pr-8'
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-current">
          {icon}
        </span>
        <span className="truncate">{label}</span>
        {badge !== undefined && badge > 0 ? (
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </button>
      {action ? <span className="absolute right-1 flex items-center">{action}</span> : null}
    </div>
  );
}

export function getLoroSidebarFooterClassName(isMobile: boolean): string {
  return cn(
    'flex shrink-0 items-center justify-between border-t',
    isMobile
      ? 'pl-[calc(6px+var(--safe-area-left))] pr-[calc(12px+var(--safe-area-right))] pt-1 pb-2'
      : 'px-1.5 py-1',
    'border-sidebar-border'
  );
}

export function getLoroSidebarFooterIconButtonClassName(isMobile: boolean, active = false): string {
  return cn(
    isMobile ? 'h-12 w-12 rounded-xl [&_svg]:h-5 [&_svg]:w-5' : 'h-7 w-7 rounded-md',
    'transition-colors focus-visible:ring-1 focus-visible:ring-sidebar-ring/40',
    active
      ? 'bg-sidebar-selection text-sidebar-selection-foreground'
      : 'text-sidebar-foreground dark:text-sidebar-foreground-muted hover:bg-sidebar-hover hover:text-sidebar-hover-foreground'
  );
}

export const LoroSidebar = memo(function LoroSidebar({
  className,
  workspaceName,
  userEmail,
  workspaces,
  currentWorkspaceId,
  workspaceSwitcherEnabled = true,
  connectionUiState,
  workspaceSyncing = false,
  isElectron = false,
  isElectronMacOS = false,
  defaultWidth = 280,
  minWidth = 240,
  maxWidth = 420,
  activeNav = null,
  topContent,
  desktopFilterPlaceholder,
  afterSessionListContent,
  bottomFloatingContent,
  repoSections = defaultRepoSections,
  chats = defaultChats,
  sessionListProps,
  organizeMode = 'workspace',
  chatScope = 'my',
  updatedItems,
  pinnedItems,
  pinnedSectionCollapsed = false,
  updatedSelectedItemId,
  updatedBucketsCollapsed,
  updatedShowFullBuckets,
  updatedIsLoading = false,
  onOrganizeModeChange,
  onChatScopeChange,
  onSelectUpdatedItem,
  onTogglePinnedSection,
  onToggleUpdatedBucket,
  onToggleUpdatedShowFullBucket,
  onArchiveUpdatedItem,
  onMarkUpdatedItemUnread,
  onRenameUpdatedItem,
  onToggleUpdatedItemPinned,
  onCopyUpdatedItemUrl,
  onShareUpdatedItemWithTeam,
  onOpenUpdatedItemPullRequest,
  getUpdatedItemHref,
  labels,
  onWorkspaceSelected,
  onCreateWorkspaceClicked,
  onInviteClicked,
  onLinkRepoClicked,
  onHomeClicked,
  onArchiveClicked,
  onTasksClicked,
  onNewTaskClicked,
  showTasks = false,
  onSettingsClicked,
  onDocsClicked,
  onJoinCommunityClicked,
  onFeedbackClicked,
  onBugReportClicked,
  onWidthChange,
  collapsed = false,
  onRequestCollapse,
}: LoroSidebarProps) {
  const isMobile = useIsMobile();
  const isElectronFullscreen = useElectronFullscreen();
  const mergedLabels: LoroSidebarLabels = {
    ...defaultLabels,
    ...labels,
    filter: { ...defaultLabels.filter, ...(labels?.filter ?? {}) },
    updated: { ...defaultLabels.updated, ...(labels?.updated ?? {}) },
  };
  const now = useStableNow();
  const resolvedMinWidth = useMemo(() => Math.max(160, minWidth), [minWidth]);
  const resolvedMaxWidth = useMemo(
    () => Math.max(resolvedMinWidth + 40, maxWidth),
    [resolvedMinWidth, maxWidth]
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clamp(defaultWidth, resolvedMinWidth, resolvedMaxWidth)
  );
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef({ pointerId: -1, startX: 0, startWidth: 0 });

  useEffect(() => {
    setSidebarWidth(clamp(defaultWidth, resolvedMinWidth, resolvedMaxWidth));
  }, [defaultWidth, resolvedMinWidth, resolvedMaxWidth]);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: sidebarWidth,
      };
      setIsResizing(true);
    },
    [isMobile, sidebarWidth]
  );

  const handleResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      const { pointerId, startX, startWidth } = resizeStateRef.current;
      if (pointerId !== event.pointerId) return;
      const rawWidth = startWidth + (event.clientX - startX);
      if (onRequestCollapse && rawWidth < COLLAPSE_DRAG_THRESHOLD) {
        // VSCode-style: dragging past the threshold collapses immediately and ends drag.
        resizeStateRef.current.pointerId = -1;
        setIsResizing(false);
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Ignore release errors when pointer capture is already gone.
        }
        onRequestCollapse();
        return;
      }
      const nextWidth = clamp(rawWidth, resolvedMinWidth, resolvedMaxWidth);
      setSidebarWidth(nextWidth);
      onWidthChange?.(nextWidth);
    },
    [isMobile, resolvedMinWidth, resolvedMaxWidth, onWidthChange, onRequestCollapse]
  );

  const handleResizeEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      const { pointerId } = resizeStateRef.current;
      if (pointerId !== event.pointerId) return;
      resizeStateRef.current.pointerId = -1;
      setIsResizing(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore release errors when pointer capture is already gone.
      }
    },
    [isMobile]
  );
  const fallbackChatSessions: SessionListRow[] = chats.map((chat) => ({
    sessionId: chat.id,
    title: chat.title,
    repoFullName: null,
    branchName: '',
    prUrl: null,
    latestMessageAt: ageLabelToDate(chat.ageLabel, now),
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: Boolean(chat.isUnread),
    isOffline: false,
    isWaitingPermission: false,
  }));
  const resolvedChatsSessionListProps: SessionListProps | null = fallbackChatSessions.length
    ? { sessions: fallbackChatSessions, repos: [] }
    : null;
  const sessionListClassName = sessionListProps?.className;
  const chatsSessionListClassName = resolvedChatsSessionListProps?.className;
  if (!isMobile && collapsed) {
    return null;
  }

  // This instance never moves between section headers: only its same-sized
  // placeholder moves. That keeps an open popover open across organize changes.
  const desktopFilterNode = !isMobile ? (
    <SidebarFilterPopover
      organize={organizeMode}
      scope={chatScope}
      onOrganizeChange={onOrganizeModeChange}
      onScopeChange={onChatScopeChange}
      labels={mergedLabels.filter}
      side="bottom"
      align="end"
      triggerClassName="h-5 w-5 [&_svg]:h-3.5 [&_svg]:w-3.5"
    />
  ) : null;
  const sectionHeaderFilterPlaceholder = !isMobile
    ? (desktopFilterPlaceholder ?? <span aria-hidden="true" className="block h-5 w-5" />)
    : null;
  const hasPinnedItems = Boolean(pinnedItems?.length);
  const workspaceIdentityStatus: WorkspaceIdentityStatus | null =
    connectionUiState && connectionUiState !== 'online'
      ? connectionUiState
      : workspaceSyncing
        ? 'syncing'
        : null;
  const workspaceIdentity = (
    <>
      <WorkspaceAvatar
        workspace={{
          name: workspaceName,
          logo: workspaces.find((ws) => ws.id === currentWorkspaceId)?.logo,
        }}
        className="h-5 w-5 text-[10px]"
        fallbackClassName="bg-sidebar-hover/60 text-sidebar-foreground"
      />
      <span className="min-w-0 flex flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{workspaceName}</span>
        {workspaceIdentityStatus ? (
          <ConnectionPill state={workspaceIdentityStatus} labels={mergedLabels} />
        ) : null}
      </span>
    </>
  );
  const windowDrag = isElectron && !isElectronFullscreen;
  const workspaceIdentityClassName = cn(
    'grid w-full min-w-0 select-none grid-cols-[20px_1fr_16px] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
    isMobile ? 'h-9' : 'h-8',
    'text-sidebar-foreground dark:text-sidebar-foreground/75',
    workspaceSwitcherEnabled &&
      'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:bg-sidebar-hover'
  );

  return (
    <div
      // No overflow-hidden here: the resize sash extends past the right border
      // so its hit area straddles the edge; the inner content div clips instead.
      className={cn(
        'relative h-full select-none rounded-2xl border-x',
        // Linear-like: soft cool wash + hairline edge, not a heavy gray slab.
        'border-sidebar-border/70 bg-sidebar text-sidebar-foreground shadow-[0_1px_2px_hsl(0_0%_0%/0.03)]',
        className
      )}
      style={
        isMobile
          ? undefined
          : { width: sidebarWidth, minWidth: resolvedMinWidth, maxWidth: resolvedMaxWidth }
      }
    >
      {!isMobile && (
        // VSCode-style sash: a 12px pointer hit area straddling the border
        // (6px inside + 6px outside, so hovering ON or just past the edge
        // still triggers); the visible affordance is a thin 2px line covering
        // the border itself. Slight hover delay so it doesn't flash when the
        // cursor merely passes over the edge.
        <div
          className={cn(
            'absolute -right-1.5 top-0 z-20 h-full w-3 cursor-col-resize bg-transparent',
            // Line spans only the border's straight segment (card corners are
            // 12px rounded), with soft rounded ends.
            'after:absolute after:right-[5px] after:top-3 after:bottom-3 after:w-[2px]',
            'after:rounded-full after:bg-transparent after:transition-colors after:duration-150',
            isResizing
              ? 'after:bg-sidebar-ring/70'
              : 'hover:after:bg-sidebar-ring/50 hover:after:delay-150'
          )}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
      )}

      <div
        className={cn(
          'relative flex h-full flex-col overflow-hidden rounded-[inherit]',
          !isMobile && 'p-[2px]'
        )}
      >
        <div
          className={cn(
            'group/sidebar-header relative flex items-center justify-between gap-2',
            isMobile
              ? 'pl-[calc(12px+var(--safe-area-left))] pr-[calc(12px+var(--safe-area-right))] pt-[calc(12px+var(--safe-area-top))]'
              : isElectronMacOS
                ? 'h-[72px] px-1.5 pt-7'
                : 'h-11 px-1.5',
            windowDrag && WINDOW_DRAG_HEADER_CLASS
          )}
        >
          {workspaceSwitcherEnabled ? (
            <DropdownMenu modal={!isMobile}>
              <div className="min-w-0 flex-1">
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      workspaceIdentityClassName,
                      windowDrag && WINDOW_DRAG_EXEMPT_CLASS
                    )}
                    data-workspace-switcher-trigger
                    data-workspace-syncing={workspaceSyncing ? 'true' : 'false'}
                    aria-busy={workspaceSyncing || undefined}
                  >
                    {workspaceIdentity}
                  </button>
                </DropdownMenuTrigger>
              </div>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="text-xs font-normal">{userEmail}</DropdownMenuLabel>
                <DropdownMenuSeparator />

                {workspaces.length > 0 ? (
                  <>
                    <DropdownMenuLabel className="text-xs font-medium">
                      {mergedLabels.switchWorkspace}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={currentWorkspaceId}
                      onValueChange={(value) => onWorkspaceSelected?.(value)}
                    >
                      {workspaces.map((ws) => (
                        <DropdownMenuRadioItem key={ws.id} value={ws.id} className="gap-2">
                          <WorkspaceAvatar
                            workspace={{ name: ws.name, logo: ws.logo }}
                            className="h-5 w-5 shrink-0 text-[10px]"
                          />
                          <span className="min-w-0 truncate">{ws.name}</span>
                          {ws.planTier ? (
                            <Badge
                              variant="secondary"
                              className="ml-auto shrink-0 px-1.5 py-0 text-[10px]"
                            >
                              {ws.planTier === 'enterprise'
                                ? mergedLabels.planEnterprise
                                : mergedLabels.planPlus}
                            </Badge>
                          ) : null}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                  </>
                ) : null}

                <DropdownMenuItem onSelect={() => onCreateWorkspaceClicked?.()}>
                  <Plus className="h-4 w-4" />
                  {mergedLabels.createWorkspace}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onInviteClicked?.()}>
                  <Users className="h-4 w-4" />
                  {mergedLabels.inviteMembers}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onLinkRepoClicked?.()}>
                  <Link2 className="h-4 w-4" />
                  {mergedLabels.connectGithubRepo}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="min-w-0 flex-1">
              <div className={workspaceIdentityClassName} data-workspace-identity>
                {workspaceIdentity}
              </div>
            </div>
          )}
          {/* Collapse toggle anchored to the header's top-right corner.
              `top-2` centers the h-7 button inside the standard h-11 header.
              On macOS Electron the header is taller (`h-[72px] pt-7`) and its
              top sits 11px below the window top (card `mt-2` + 1px border +
              inner `p-[2px]`); `-top-0.5` then puts the button center at
              11 - 2 + 14 = 23px, exactly on the traffic-light centerline
              (`trafficLightPosition.y` 16 + 7px radius in
              apps/electron/src/main/window.ts) — and level with the
              collapsed-state expand button (`top-[9px]` in
              web-chat-landing-screen.tsx), so the control stays put across
              collapse/expand. */}
          {!isMobile && onRequestCollapse ? (
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={() => onRequestCollapse()}
              className={cn(
                'absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-md',
                isElectronMacOS ? '-top-0.5' : 'top-2',
                'text-sidebar-foreground-muted hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
                windowDrag && WINDOW_DRAG_EXEMPT_CLASS,
                isElectron
                  ? 'focus-visible:outline-hidden'
                  : 'opacity-0 pointer-events-none group-hover/sidebar-header:opacity-100 group-hover/sidebar-header:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-hidden transition-opacity duration-100'
              )}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        <div
          className={cn(
            // `gap-px` keeps New chat / Tasks from painting as one fused block
            // when both are selected-adjacent or hover-highlighted.
            'flex flex-col gap-px',
            isMobile
              ? 'mt-2 pl-[calc(12px+var(--safe-area-left))] pr-[calc(12px+var(--safe-area-right))]'
              : '-mt-1 px-1.5'
          )}
        >
          <NavButton
            active={activeNav === 'home'}
            label={mergedLabels.home}
            icon={<SquarePen className="h-4 w-4" />}
            onClick={onHomeClicked}
          />
          {/* Tasks sits with New Chat rather than in the bottom icon rail: it is a
             primary destination, and the rail reads as utilities (docs, feedback,
             settings). Still gated — see `showTasks`. */}
          {showTasks ? (
            <NavButton
              active={activeNav === 'tasks'}
              label={mergedLabels.tasks}
              icon={<ListTodo className="h-4 w-4" />}
              onClick={onTasksClicked}
              action={
                onNewTaskClicked ? (
                  <SidebarNewTaskButton label={mergedLabels.newTask} onClick={onNewTaskClicked} />
                ) : undefined
              }
            />
          ) : null}
        </div>

        <ScrollArea
          className={cn(
            'min-h-0 flex-1',
            isMobile ? 'mt-4 pb-[calc(12px+env(safe-area-inset-bottom,0px))]' : 'mt-2'
          )}
          scrollbarClassName={!isMobile ? 'w-2 p-px' : undefined}
          scrollbarThumbClassName={
            !isMobile
              ? 'bg-[hsl(var(--muted-foreground)/0.35)] hover:bg-[hsl(var(--muted-foreground)/0.45)] active:bg-[hsl(var(--muted-foreground)/0.55)]'
              : undefined
          }
          // The horizontal gutter must live on the *viewport*, not the ScrollArea
          // root. Radix's viewport is the scroll/clip container; with rows at
          // `w-full` and the gutter on the root, the selected row's 1px `outline`
          // (painted outside the box) sits flush against the viewport's clip edge
          // and gets shaved on the left/right — only the sides, since the viewport
          // scrolls vertically. Padding the viewport insets the rows from that clip
          // edge so the highlight outline renders fully. Geometry/scrollbar position
          // are unchanged (the absolutely-positioned scrollbar tracks the root edge).
          viewportClassName={cn(
            isMobile
              ? 'pl-[calc(12px+env(safe-area-inset-left,0px))] pr-[calc(12px+env(safe-area-inset-right,0px))]'
              : 'pl-1.5 pr-2.5 pb-3'
          )}
        >
          <div className="relative">
            {!isMobile && desktopFilterNode ? (
              <div className="pointer-events-none absolute right-[9px] top-1 z-10 flex h-7 items-center">
                <div className="pointer-events-auto flex">{desktopFilterNode}</div>
              </div>
            ) : null}
            {hasPinnedItems ? (
              <div className={cn('pt-1', pinnedSectionCollapsed ? 'pb-1' : 'pb-3')}>
                <SidebarUpdatedSessionList
                  items={pinnedItems ?? []}
                  now={now}
                  isMobile={isMobile}
                  showPinnedIcon={false}
                  selectedItemId={updatedSelectedItemId ?? null}
                  collapsedBuckets={pinnedSectionCollapsed ? PINNED_BUCKETS_COLLAPSED : undefined}
                  labels={{
                    heading: mergedLabels.pinned,
                    emptyTitle: mergedLabels.updated.emptyTitle,
                    emptyDescription: mergedLabels.updated.emptyDescription,
                  }}
                  onSelectItem={onSelectUpdatedItem}
                  onToggleBucket={onTogglePinnedSection}
                  toggleBucketLabel={mergedLabels.pinned}
                  onArchiveItem={onArchiveUpdatedItem}
                  onMarkItemUnread={onMarkUpdatedItemUnread}
                  onRenameItem={onRenameUpdatedItem}
                  onTogglePinItem={onToggleUpdatedItemPinned}
                  onCopyItemUrl={onCopyUpdatedItemUrl}
                  onShareItemWithTeam={onShareUpdatedItemWithTeam}
                  onOpenPullRequest={onOpenUpdatedItemPullRequest}
                  getItemHref={getUpdatedItemHref}
                  headerAction={sectionHeaderFilterPlaceholder ?? undefined}
                />
              </div>
            ) : null}
            {organizeMode === 'updated' ? (
              // Design intent: 'updated' mode is a flat firehose of recent
              // sessions. It deliberately drops Workspace-mode structure
              // (per-repo groups with collapse/reorder, per-project headers
              // with rename/remove, per-group "+" new-session affordance,
              // GitHub Worktrees / Local Projects section headers). Users who
              // need that structure switch back via the footer popover; the
              // sidebar-state.sidebarOrganizeModeAtom persists the choice.
              // Per-row actions (rename, pin, archive, copy URL, copy branch,
              // open PR) are wired through the props below so the two modes
              // are at parity for individual sessions even though section-
              // level affordances diverge.
              !hasPinnedItems || updatedIsLoading || Boolean(updatedItems?.length) ? (
                <div className={hasPinnedItems ? undefined : 'pt-1'}>
                  <SidebarUpdatedSessionList
                    items={updatedItems ?? []}
                    now={now}
                    isMobile={isMobile}
                    isLoading={updatedIsLoading}
                    selectedItemId={updatedSelectedItemId ?? null}
                    labels={mergedLabels.updated}
                    collapsedBuckets={updatedBucketsCollapsed}
                    showFullBuckets={updatedShowFullBuckets}
                    onSelectItem={onSelectUpdatedItem}
                    onToggleBucket={onToggleUpdatedBucket}
                    onToggleFullBucket={onToggleUpdatedShowFullBucket}
                    onArchiveItem={onArchiveUpdatedItem}
                    onMarkItemUnread={onMarkUpdatedItemUnread}
                    onRenameItem={onRenameUpdatedItem}
                    onTogglePinItem={onToggleUpdatedItemPinned}
                    onCopyItemUrl={onCopyUpdatedItemUrl}
                    onShareItemWithTeam={onShareUpdatedItemWithTeam}
                    onOpenPullRequest={onOpenUpdatedItemPullRequest}
                    getItemHref={getUpdatedItemHref}
                    headerAction={
                      hasPinnedItems ? undefined : (sectionHeaderFilterPlaceholder ?? undefined)
                    }
                  />
                </div>
              ) : null
            ) : (
              <>
                {/* pb-1 (not pb-3): the last topContent item is the GitHub
                  Worktrees section header, whose repo list renders just below
                  as the sibling SessionList — the header must hug its content. */}
                {topContent ? (
                  <div className={cn(hasPinnedItems ? 'pb-1' : 'pt-1 pb-1')}>{topContent}</div>
                ) : null}
                {sessionListProps ? (
                  <SessionList
                    {...sessionListProps}
                    className={sessionListClassName}
                    headerAction={
                      topContent || hasPinnedItems
                        ? sessionListProps.headerAction
                        : (sessionListProps.headerAction ??
                          sectionHeaderFilterPlaceholder ??
                          undefined)
                    }
                  />
                ) : null}
                {afterSessionListContent}
              </>
            )}
            {organizeMode === 'workspace' && !topContent && !sessionListProps ? (
              <div className="space-y-3 pt-1">
                {repoSections.map((section, sectionIndex) => (
                  <div key={section.id} className="space-y-2">
                    <div className="flex items-center gap-2 px-1 text-[12px] font-medium text-sidebar-foreground-muted">
                      <Github className="h-3.5 w-3.5" />
                      <span className="truncate">{section.repoFullName}</span>
                      {sectionIndex === 0 && sectionHeaderFilterPlaceholder ? (
                        <span className="ml-auto shrink-0">{sectionHeaderFilterPlaceholder}</span>
                      ) : null}
                    </div>

                    <GlassSurface className="p-1">
                      <ul className="space-y-1">
                        {section.items.map((item) => (
                          <li key={item.id}>
                            <div
                              className={cn(
                                'flex items-center gap-2 rounded-lg px-2 py-2 text-[12px]',
                                item.isSelected
                                  ? 'bg-sidebar-selection text-sidebar-selection-foreground'
                                  : 'text-sidebar-foreground-muted hover:bg-sidebar-hover hover:text-sidebar-hover-foreground'
                              )}
                            >
                              <span className="h-2 w-2 rounded-full bg-sidebar-border" />
                              <span className="min-w-0 flex-1 truncate">{item.title}</span>
                              {item.ageLabel ? (
                                <span className="shrink-0 text-[11px] text-sidebar-foreground-muted">
                                  {item.ageLabel}
                                </span>
                              ) : null}
                              {item.lineChange ? (
                                <span className="shrink-0">
                                  <LineChangeBadge lineChange={item.lineChange} />
                                </span>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </GlassSurface>
                  </div>
                ))}

                <div className="pt-2">
                  {resolvedChatsSessionListProps ? (
                    <SessionList
                      {...resolvedChatsSessionListProps}
                      className={chatsSessionListClassName}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </ScrollArea>

        {bottomFloatingContent ? (
          <div
            className={cn(
              'pointer-events-none absolute z-10',
              isMobile
                ? 'bottom-12 left-[calc(16px+var(--safe-area-left))] '
                : 'bottom-[44px] left-3 right-3'
            )}
          >
            <div className="pointer-events-auto">{bottomFloatingContent}</div>
          </div>
        ) : null}

        <div className={getLoroSidebarFooterClassName(isMobile)}>
          <div className="flex items-center gap-1">
            <IconButton label="Settings" onClick={onSettingsClicked}>
              <Settings className="h-4 w-4" />
            </IconButton>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Help">
                  <CircleHelp className="h-4 w-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-[140px]">
                <DropdownMenuItem onSelect={() => onDocsClicked?.()}>
                  <BookOpen className="h-4 w-4" />
                  {mergedLabels.docs}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onJoinCommunityClicked?.()}>
                  <Users className="h-4 w-4" />
                  {mergedLabels.joinCommunity}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onFeedbackClicked?.()}>
                  <MessageSquareMore className="h-4 w-4" />
                  {mergedLabels.feedback}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onBugReportClicked?.()}>
                  <Bug className="h-4 w-4" />
                  {mergedLabels.bugReport}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <IconButton label="Archive" active={activeNav === 'archive'} onClick={onArchiveClicked}>
              <Archive className="h-4 w-4" />
            </IconButton>
          </div>

          {isMobile ? (
            <SidebarFilterPopover
              organize={organizeMode}
              scope={chatScope}
              onOrganizeChange={onOrganizeModeChange}
              onScopeChange={onChatScopeChange}
              labels={mergedLabels.filter}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});

LoroSidebar.displayName = 'LoroSidebar';
