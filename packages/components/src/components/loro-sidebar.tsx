import { useTranslation } from 'react-i18next';
import { isElectronRenderer, isMacOSElectronRenderer } from '@/lib/electron';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/ui/context-menu';
import { isNewWindowClick, openDesktopWindow } from '@/lib/desktop-window';
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
import {
  WINDOW_DRAG_EXEMPT_CLASS,
  WINDOW_DRAG_HEADER_CLASS,
  useMacTrafficLightRowPadClass,
} from '@/ui/window-drag-region';
import { useElectronFullscreen } from '@/lib/electron';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Kbd } from '@/ui/kbd';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { commands, formatKeyBinding, type ShortcutCommandId } from '@/lib/commands';
import { setCommandPaletteOpen } from '@/lib/commands/palette-state';
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
  AppWindow,
  Archive,
  BookOpen,
  Bug,
  CircleHelp,
  ClipboardList,
  Github,
  SquarePen,
  Link2,
  ListFilter,
  MessageSquareMore,
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { Spinner } from '@/ui/spinner';
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

export type LoroSidebarNavKey = 'home' | 'archive';

export type LoroSidebarChatScope = 'my' | 'team';
export type LoroSidebarOrganizeMode = SidebarOrganizeMode;

export type LoroSidebarWorkspace = {
  id: string;
  slug?: string;
  name: string;
  logo?: string | null;
  /** Paid plan tier for the Plus/Enterprise badge; null/undefined = free. */
  planTier?: 'plus' | 'enterprise' | null;
  /** Member count, when known (the active workspace). Shown in the switcher header. */
  memberCount?: number | null;
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
  planFree: string;
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
  /** The filter trigger element rendered in-flow on the first visible section
      header. Caller-owned so its open state survives remounting between slots. */
  desktopFilterAction?: ReactNode;
  /**
   * In-flow content rendered after {@link sessionListProps} inside the scroll
   * viewport (workspace mode only). LoroAppSidebar uses this to place the Chats
   * section below the GitHub Worktrees list so Chats reads as the last section.
   * When present without top or pinned content, that section owns the desktop
   * filter action; the preceding list must not mount a second fallback action.
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
  /** Whether Updated-mode rows show their project mark and name below the title. */
  showUpdatedProjectNames?: boolean;
  onShowUpdatedProjectNamesChange?: (next: boolean) => void;
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
  planFree: 'Free',
  pinned: 'Pinned',
  connectionLoading: 'Loading',
  connectionReconnecting: 'Reconnecting',
  connectionOffline: 'Offline',
  workspaceSyncing: 'Syncing workspace…',
  filter: {
    triggerAriaLabel: 'Filter sidebar',
    organizeHeading: 'View',
    showHeading: 'Tasks',
    organizeProject: 'Project',
    organizeUpdated: 'Updated',
    updatedProjectNames: 'Show Project',
    updatedProjectNamesUnavailable: 'Available in Updated view',
    showMyTasks: 'My Tasks',
    showAllTasks: 'All Tasks',
    emptyMyTasks: 'No tasks match this view',
    emptyMyTasksHint: 'Try showing every task in this workspace.',
    emptyAllTasks: 'No tasks yet',
    emptyAllTasksHint: 'Tasks in this workspace will appear here.',
    showAllTasksAction: 'Show all tasks',
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
        <Spinner className="h-3 w-3 shrink-0" aria-hidden />
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
 * command is unbound (or not registered). Read from the registry rather than
 * `COMMAND_SHORTCUTS` so a rebound key is what the tooltip teaches.
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

type NavigationAvailability = {
  canGoBack: boolean;
  canGoForward: boolean;
};

type WindowNavigation = {
  canGoBack: boolean;
  canGoForward: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

const readNavigationAvailability = (): NavigationAvailability => {
  const navigation = (window as Window & { navigation?: WindowNavigation }).navigation;
  if (navigation && typeof navigation.canGoBack === 'boolean') {
    return { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward };
  }
  return {
    canGoBack: window.history.length > 1,
    canGoForward: false,
  };
};

let navigationAvailabilitySnapshot: NavigationAvailability = {
  canGoBack: false,
  canGoForward: false,
};

const getNavigationAvailabilitySnapshot = (): NavigationAvailability => {
  const next = readNavigationAvailability();
  if (
    next.canGoBack === navigationAvailabilitySnapshot.canGoBack &&
    next.canGoForward === navigationAvailabilitySnapshot.canGoForward
  ) {
    return navigationAvailabilitySnapshot;
  }
  navigationAvailabilitySnapshot = next;
  return next;
};

const subscribeNavigationAvailability = (onStoreChange: () => void) => {
  window.addEventListener('popstate', onStoreChange);
  const navigation = (window as Window & { navigation?: WindowNavigation }).navigation;
  navigation?.addEventListener('currententrychange', onStoreChange);
  navigation?.addEventListener('navigate', onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    navigation?.removeEventListener('currententrychange', onStoreChange);
    navigation?.removeEventListener('navigate', onStoreChange);
  };
};

function useNavigationAvailability(): NavigationAvailability {
  return useSyncExternalStore(
    subscribeNavigationAvailability,
    getNavigationAvailabilitySnapshot,
    () => navigationAvailabilitySnapshot
  );
}

function SidebarHeaderIconButton({
  label,
  shortcut,
  onClick,
  className,
  disabled = false,
  compact = false,
  children,
}: {
  label: string;
  shortcut?: string | null;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md outline-hidden',
        compact ? 'h-5 w-5' : 'h-7 w-7',
        disabled
          ? 'cursor-default text-sidebar-foreground-muted/40'
          : 'text-sidebar-foreground-muted hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-1 focus-visible:ring-sidebar-ring/40',
        className
      )}
    >
      {children}
    </button>
  );
  if (disabled) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-1.5">
        <span>{label}</span>
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
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
          'group flex w-full select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.9em] outline-hidden transition',
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
          <span className="ml-auto shrink-0 text-[0.8em] tabular-nums text-muted-foreground">
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
    'flex shrink-0 items-center justify-between border-t-[0.5px]',
    isMobile
      ? 'pl-[calc(6px+var(--safe-area-left))] pr-[calc(12px+var(--safe-area-right))] pt-1 pb-2'
      : 'px-1.5 py-1',
    'border-sidebar-border'
  );
}

export function getLoroSidebarFooterIconButtonClassName(isMobile: boolean, active = false): string {
  return cn(
    isMobile
      ? 'h-12 w-12 rounded-xl [&_svg]:h-5 [&_svg]:w-5'
      : 'h-6 w-6 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5',
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
  isElectronMacOS: _isElectronMacOS = false,
  defaultWidth = 280,
  minWidth = 240,
  maxWidth = 420,
  activeNav = null,
  topContent,
  desktopFilterAction,
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
  showUpdatedProjectNames = true,
  onShowUpdatedProjectNamesChange,
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
  const macTrafficLightRowPadClass = useMacTrafficLightRowPadClass();
  const { t } = useTranslation();
  const collapseShortcut = useCommandShortcutLabel('sidebar.toggle');
  const backShortcut = useCommandShortcutLabel('nav.back');
  const forwardShortcut = useCommandShortcutLabel('nav.forward');
  const { canGoBack, canGoForward } = useNavigationAvailability();
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

  // The filter trigger is a normal in-flow action on whichever section header
  // is first — the row's items-center keeps it aligned, so no overlay or
  // placeholder. The caller supplies the element with lifted open state so
  // remounting the one instance at a new slot keeps an open popover open; the
  // local fallback covers direct uses (e.g. stories) that do not pass one.
  const sectionHeaderFilterAction = !isMobile
    ? (desktopFilterAction ?? (
        <SidebarFilterPopover
          organize={organizeMode}
          scope={chatScope}
          onOrganizeChange={onOrganizeModeChange}
          onScopeChange={onChatScopeChange}
          showUpdatedProjectNames={showUpdatedProjectNames}
          onShowUpdatedProjectNamesChange={onShowUpdatedProjectNamesChange}
          labels={mergedLabels.filter}
          side="bottom"
          align="end"
          triggerClassName="h-5 w-5 [&_svg]:h-4 [&_svg]:w-4"
        />
      ))
    : null;
  const hasPinnedItems = Boolean(pinnedItems?.length);
  const isWorkspaceEmpty =
    organizeMode === 'workspace' &&
    !topContent &&
    !hasPinnedItems &&
    !afterSessionListContent &&
    !sessionListProps?.isLoading;
  const workspaceEmptyState = isWorkspaceEmpty ? (
    <div
      className="flex flex-col items-center px-6 pb-5 pt-7 text-center"
      data-sidebar-empty-state={chatScope}
    >
      <div className="flex size-9 items-center justify-center rounded-xl bg-sidebar-accent text-sidebar-foreground-muted ring-1 ring-inset ring-sidebar-border/60">
        {chatScope === 'my' ? (
          <ListFilter className="size-4" strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <ClipboardList className="size-4" strokeWidth={1.8} aria-hidden="true" />
        )}
      </div>
      <p className="mt-3 max-w-[220px] text-[13px] font-medium leading-5 text-sidebar-foreground">
        {chatScope === 'my' ? mergedLabels.filter.emptyMyTasks : mergedLabels.filter.emptyAllTasks}
      </p>
      <p className="mt-0.5 max-w-[220px] text-xs leading-[18px] text-sidebar-foreground-muted">
        {chatScope === 'my'
          ? mergedLabels.filter.emptyMyTasksHint
          : mergedLabels.filter.emptyAllTasksHint}
      </p>
      {chatScope === 'my' && onChatScopeChange ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 h-7 rounded-full border-sidebar-border bg-sidebar px-3 text-xs font-medium text-sidebar-foreground shadow-none hover:bg-sidebar-hover hover:text-sidebar-hover-foreground"
          onClick={() => onChatScopeChange('team')}
        >
          <Users className="mr-1.5 size-3.5" strokeWidth={1.8} aria-hidden="true" />
          {mergedLabels.filter.showAllTasksAction}
        </Button>
      ) : null}
    </div>
  ) : undefined;
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
    'flex w-full min-w-0 select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.9em]',
    isMobile ? 'h-9' : 'h-8',
    'text-sidebar-foreground dark:text-sidebar-foreground/75',
    workspaceSwitcherEnabled &&
      'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:bg-sidebar-hover'
  );
  const currentWorkspace = workspaces.find((ws) => ws.id === currentWorkspaceId);
  const getPlanLabel = (planTier: LoroSidebarWorkspace['planTier']) =>
    planTier === 'enterprise'
      ? mergedLabels.planEnterprise
      : planTier === 'plus'
        ? mergedLabels.planPlus
        : mergedLabels.planFree;
  const newWindowHint = t('workspace.openInNewWindowHint', {
    key: isMacOSElectronRenderer() ? '⌘' : 'Ctrl',
  });
  const renderWorkspaceControl = (menuSide: 'top' | 'bottom') =>
    workspaceSwitcherEnabled ? (
      <DropdownMenu modal={!isMobile}>
        <div className="min-w-0 flex-1">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(workspaceIdentityClassName, windowDrag && WINDOW_DRAG_EXEMPT_CLASS)}
              data-workspace-switcher-trigger
              data-workspace-syncing={workspaceSyncing ? 'true' : 'false'}
              aria-busy={workspaceSyncing || undefined}
            >
              {workspaceIdentity}
            </button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="start" side={menuSide} className="w-64">
          <DropdownMenuLabel className="normal-case text-xs font-normal tracking-normal">
            {userEmail}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {currentWorkspace ? (
            <>
              <div className="flex min-w-0 items-center gap-2.5 px-2 py-2" data-current-workspace>
                <WorkspaceAvatar
                  workspace={{ name: currentWorkspace.name, logo: currentWorkspace.logo }}
                  className="h-9 w-9 shrink-0 rounded-lg text-sm"
                  fallbackClassName="rounded-lg"
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[0.95em] font-medium leading-tight text-foreground">
                    {currentWorkspace.name}
                  </span>
                  <span className="truncate text-xs leading-tight text-muted-foreground">
                    {typeof currentWorkspace.memberCount === 'number'
                      ? t('workspace.switcher.planAndMembers', {
                          plan: getPlanLabel(currentWorkspace.planTier),
                          count: currentWorkspace.memberCount,
                        })
                      : t('workspace.switcher.plan', {
                          plan: getPlanLabel(currentWorkspace.planTier),
                        })}
                  </span>
                </div>
              </div>
              <DropdownMenuSeparator />
            </>
          ) : null}

          {workspaces.length > 0 ? (
            <>
              <DropdownMenuLabel className="text-xs font-medium">
                {mergedLabels.switchWorkspace}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={currentWorkspaceId}
                onValueChange={(value) => onWorkspaceSelected?.(value)}
              >
                {/* Local provider: hosts may render the sidebar without a root one. */}
                <TooltipProvider delayDuration={400}>
                  {workspaces.map((ws) => {
                    const workspaceSlug = ws.slug;
                    const row = (
                      <DropdownMenuRadioItem
                        key={ws.id}
                        value={ws.id}
                        indicator="check"
                        className="gap-2"
                        onClickCapture={(event) => {
                          if (!workspaceSlug || !isNewWindowClick(event)) return;
                          if (openDesktopWindow(undefined, workspaceSlug)) {
                            event.preventDefault();
                            event.stopPropagation();
                          }
                        }}
                      >
                        <WorkspaceAvatar
                          workspace={{ name: ws.name, logo: ws.logo }}
                          className="h-5 w-5 shrink-0 text-[10px]"
                        />
                        <span className="min-w-0 truncate">{ws.name}</span>
                        {ws.planTier ? (
                          <Badge
                            variant="secondary"
                            className="ml-auto shrink-0 border-transparent bg-foreground/[0.06] px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                          >
                            {ws.planTier === 'enterprise'
                              ? mergedLabels.planEnterprise
                              : mergedLabels.planPlus}
                          </Badge>
                        ) : null}
                      </DropdownMenuRadioItem>
                    );

                    if (!isElectronRenderer() || !workspaceSlug) return row;

                    const contextTrigger = <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>;
                    return (
                      <ContextMenu key={ws.id}>
                        {ws.id === currentWorkspaceId ? (
                          contextTrigger
                        ) : (
                          // Other workspaces explain the modifier-click on hover,
                          // beside the row. Tooltip and ContextMenu roots render no
                          // DOM, so both triggers' props land on the row element.
                          <Tooltip>
                            <TooltipTrigger asChild>{contextTrigger}</TooltipTrigger>
                            <TooltipContent side="right" sideOffset={8}>
                              {newWindowHint}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <ContextMenuContent>
                          <ContextMenuItem
                            onSelect={() => {
                              openDesktopWindow(undefined, workspaceSlug);
                            }}
                          >
                            <AppWindow />
                            {t('workspace.openInNewWindow')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </TooltipProvider>
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
    );

  return (
    <div
      // No overflow-hidden here: the resize sash extends past the right border
      // so its hit area straddles the edge; the inner content div clips instead.
      className={cn('relative h-full select-none bg-sidebar text-sidebar-foreground', className)}
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
            // 2px line covers the panel's `border-r` for the full height.
            'after:absolute after:right-[5px] after:top-0 after:bottom-0 after:w-[2px]',
            'after:bg-transparent after:transition-colors after:duration-150',
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

      <div className="relative flex h-full flex-col overflow-hidden">
        <div
          className={cn(
            'group/sidebar-header relative flex items-center justify-between gap-2',
            isMobile
              ? 'pl-[calc(12px+var(--safe-area-left))] pr-[calc(12px+var(--safe-area-right))] pt-[calc(12px+var(--safe-area-top))]'
              : cn('h-11 px-1.5', macTrafficLightRowPadClass),
            windowDrag && WINDOW_DRAG_HEADER_CLASS
          )}
        >
          {isMobile ? (
            renderWorkspaceControl('bottom')
          ) : isElectron ? (
            <span className="min-w-0 flex-1" />
          ) : (
            <span
              aria-label="Lody"
              className="select-none px-2 text-[18px] font-semibold leading-none tracking-[-0.03em] text-sidebar-foreground"
              style={{ fontFamily: 'var(--font-wordmark)' }}
            >
              Lody
            </span>
          )}
          {!isMobile ? (
            <TooltipProvider delayDuration={400}>
              <div
                className={cn(
                  'ml-auto flex shrink-0 items-center',
                  windowDrag && WINDOW_DRAG_EXEMPT_CLASS
                )}
              >
                {onRequestCollapse ? (
                  <SidebarHeaderIconButton
                    label={t('commands.sidebar.toggle', 'Toggle Sidebar')}
                    shortcut={collapseShortcut}
                    onClick={() => onRequestCollapse()}
                    className={
                      isElectron
                        ? 'focus-visible:outline-hidden'
                        : 'opacity-0 pointer-events-none group-hover/sidebar-header:opacity-100 group-hover/sidebar-header:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity duration-100'
                    }
                  >
                    <PanelLeft className="h-4 w-4" />
                  </SidebarHeaderIconButton>
                ) : null}
                <SidebarHeaderIconButton
                  compact
                  disabled={!canGoBack}
                  label={t('commands.nav.back', 'Back')}
                  shortcut={backShortcut}
                  onClick={() => {
                    if (!canGoBack) return;
                    if (!commands.execute('nav.back')) window.history.back();
                  }}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </SidebarHeaderIconButton>
                <SidebarHeaderIconButton
                  compact
                  disabled={!canGoForward}
                  label={t('commands.nav.forward', 'Forward')}
                  shortcut={forwardShortcut}
                  onClick={() => {
                    if (!canGoForward) return;
                    if (!commands.execute('nav.forward')) window.history.forward();
                  }}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </SidebarHeaderIconButton>
              </div>
            </TooltipProvider>
          ) : null}
        </div>

        <div
          className={cn(
            // `gap-px` keeps navigation rows from painting as one fused block
            // when both are selected-adjacent or hover-highlighted.
            'flex flex-col gap-px',
            isMobile
              ? 'mt-2 pl-[calc(12px+var(--safe-area-left))] pr-[calc(12px+var(--safe-area-right))]'
              : 'px-1.5'
          )}
        >
          <NavButton
            active={activeNav === 'home'}
            label={mergedLabels.home}
            icon={<SquarePen className="h-4 w-4" />}
            onClick={onHomeClicked}
          />
          <NavButton
            active={false}
            label={t('common.search', 'Search')}
            icon={<Search className="h-4 w-4" />}
            onClick={() => setCommandPaletteOpen(true)}
          />
        </div>

        <ScrollArea
          className={cn(
            'min-h-0 flex-1',
            isMobile ? 'mt-4 pb-[calc(12px+env(safe-area-inset-bottom,0px))]' : 'mt-2'
          )}
          // Overlay only while the list is scrolling. Radix defaults to `hover`,
          // which paints the thumb as soon as the pointer enters the sidebar.
          type="scroll"
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
              : 'px-1.5 pb-3'
          )}
        >
          <div className="relative">
            {hasPinnedItems ? (
              <div className={cn('pt-1', pinnedSectionCollapsed ? 'pb-1' : 'pb-3')}>
                <SidebarUpdatedSessionList
                  items={pinnedItems ?? []}
                  now={now}
                  isMobile={isMobile}
                  showPinnedIcon={false}
                  showProjectContext={organizeMode === 'updated' && showUpdatedProjectNames}
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
                  headerAction={sectionHeaderFilterAction ?? undefined}
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
                    showProjectContext={showUpdatedProjectNames}
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
                      hasPinnedItems ? undefined : (sectionHeaderFilterAction ?? undefined)
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
                    emptyState={workspaceEmptyState}
                    headerAction={
                      topContent || hasPinnedItems || afterSessionListContent
                        ? sessionListProps.headerAction
                        : (sessionListProps.headerAction ?? sectionHeaderFilterAction ?? undefined)
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
                    <div className="flex items-center gap-2 px-1 text-[0.9em] font-medium text-sidebar-foreground-muted">
                      <Github className="h-3.5 w-3.5" />
                      <span className="truncate">{section.repoFullName}</span>
                      {sectionIndex === 0 && sectionHeaderFilterAction ? (
                        <span className="ml-auto shrink-0">{sectionHeaderFilterAction}</span>
                      ) : null}
                    </div>

                    <GlassSurface className="p-1">
                      <ul className="space-y-1">
                        {section.items.map((item) => (
                          <li key={item.id}>
                            <div
                              className={cn(
                                'flex items-center gap-2 rounded-lg px-2 py-2 text-[0.9em]',
                                item.isSelected
                                  ? 'bg-sidebar-selection text-sidebar-selection-foreground'
                                  : 'text-sidebar-foreground-muted hover:bg-sidebar-hover hover:text-sidebar-hover-foreground'
                              )}
                            >
                              <span className="h-2 w-2 rounded-full bg-sidebar-border" />
                              <span className="min-w-0 flex-1 truncate">{item.title}</span>
                              {item.ageLabel ? (
                                <span className="shrink-0 text-[0.75em] text-sidebar-foreground-muted">
                                  {item.ageLabel}
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
          {!isMobile ? renderWorkspaceControl('top') : null}
          <div className={cn('flex items-center gap-1', !isMobile && 'ml-auto shrink-0 gap-2')}>
            <IconButton label="Settings" onClick={onSettingsClicked}>
              <Settings strokeWidth={1.5} />
            </IconButton>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Help">
                  <CircleHelp strokeWidth={1.5} />
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
              <Archive strokeWidth={1.5} />
            </IconButton>
          </div>

          {isMobile ? (
            <SidebarFilterPopover
              organize={organizeMode}
              scope={chatScope}
              onOrganizeChange={onOrganizeModeChange}
              onScopeChange={onChatScopeChange}
              showUpdatedProjectNames={showUpdatedProjectNames}
              onShowUpdatedProjectNamesChange={onShowUpdatedProjectNamesChange}
              labels={mergedLabels.filter}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});

LoroSidebar.displayName = 'LoroSidebar';
