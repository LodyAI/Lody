import {
  forwardRef,
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive,
  BellRing,
  CircleHelp,
  CircleCheckBig,
  Clock3,
  Download,
  FolderPlus,
  Folders,
  Github,
  ListTodo,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Monitor,
  MonitorSmartphone,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { MdChat, MdChecklist, MdComputer, MdFolderCopy } from 'react-icons/md';
import { FaGithub } from 'react-icons/fa';
import type { IconType } from 'react-icons';
import { isIOSRuntimeEnvironment } from '@/lib/native-platform';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import { CarbonSettingsAdjust } from '@/components/icons/carbon-settings-adjust';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import { type MobileConversationItem } from './mobile-project-screen';
import {
  MobileChatList,
  type MobileChatGroupBy,
  type MobileChatListSelectionLabels,
} from './mobile-chat-list';
import {
  MobileConnectionStatus,
  type MobileConnectionStatusLabels,
} from './mobile-connection-status';
import type { LodyConnectionUiState } from '@/atoms/control-connection';
import { MobileFilterPillBar, type FilterPill } from './mobile-filter-pill-bar';
import { MobileInitialLetterAvatar } from './mobile-initial-letter-avatar';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { WorkspaceAvatar } from '@/components/workspace-avatar';
import { MobileWorkspaceTabBar, type MobileBottomTabBarTabSpec } from './mobile-workspace-tabbar';

/* Lazy so the Tasks surface (board/list + detail graph) stays out of the
   mobile home chunk for the vast majority of users who never enable the
   Tasks beta — the tab only renders when `showTasksTab` is on. */
const TasksListBody = lazy(() =>
  import('../tasks/tasks-workspace').then((m) => ({ default: m.TasksListBody }))
);

function MobileReactIcon({
  icon: Icon,
  className,
  ariaHidden = true,
}: {
  icon: IconType;
  className?: string;
  ariaHidden?: boolean;
}) {
  /* Fill the sized wrapper — do NOT use size="1em". Tab buttons set
     `text-[0.72rem]` for the label, so 1em collapsed Material icons to ~12px. */
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center [&_svg]:h-full [&_svg]:w-full',
        className
      )}
      aria-hidden={ariaHidden}
    >
      <Icon />
    </span>
  );
}

/* Re-export so callers that already import `MobileChatGroupBy` from
   the home screen don't have to chase the type to its new module. */
export type { MobileChatGroupBy };

/* The mobile home dock surfaces up to four content tabs, ordered
   left → right: Inbox · Chat · Tasks · 项目. Inbox is available in
   multi-member workspaces and occupies the natural "home" position.
   Tasks only appears when the caller passes `showTasksTab` (the
   developer-mode Tasks beta gate). The 项目 tab merges Local + GitHub
   via an inner sub-tab; the 设置 surface lives in the header's gear
   button. */
export type MobileHomeTab = 'inbox' | 'chat' | 'projects' | 'tasks';

/* Sub-tab inside the "项目" tab. Drives both the heading + full list
   below the segmented selector. Persisted via `mobileHomeProjectsSubTabAtom`
   in atoms/mobile-home-state.ts so a Chat ↔ Projects round-trip lands the
   user back on the side they were last on. */
export type MobileProjectsSubTab = 'local' | 'github';

export type MobileHomeWorkspace = {
  id: string;
  name: string;
  avatarUrl?: string | null;
};

export type MobileHomeWorkspaceOption = MobileHomeWorkspace & {
  isActive?: boolean;
};

export type MobileHomeMachine = {
  id: string;
  name: string;
  isOnline: boolean;
  isPrivate?: boolean;
};

export type MobileInboxItem = {
  id: string;
  kind: 'session_completed' | 'permission_requested' | 'sharing_review';
  title: string;
  description: string;
  updatedAt: number;
  unread?: boolean;
  actionLabel?: string;
};

/* Copy for the first-run hint shown on the Chat tab when the workspace
   has no machines AND no conversations yet — i.e. the user installed the
   mobile app before ever launching the desktop client. The mobile app is
   a thin client (the agent runs on the user's own computer), so we show a
   short nudge to download + start the desktop client. Kept deliberately
   minimal — one line + a button. */
export type MobileHomeOnboardingLabels = {
  title?: string;
  description?: string;
  /** Primary CTA — opens the Lody download page. */
  downloadButton?: string;
};

export type MobileHomeLocalProject = {
  id: string;
  /** Machine that owns this project — used by the home screen to group
     projects under their machine section. */
  machineId: string;
  name: string;
  path: string;
  conversationCount: number;
  /** Latest message timestamp across all conversations under this
     project. Drives the trailing "5m / 2h / 3d" age label on the row.
     `null` / undefined renders no label. */
  latestMessageAt?: number | null;
  /** Number of conversations under this project that have new messages
     since the user last opened them. `0` / undefined hides the badge. */
  unreadCount?: number;
  /** Effective privacy: true when either the machine or project grant is private. */
  isPrivate?: boolean;
  /** Durable project-removal state. Pending rows stay visible but cannot open. */
  removalState?: 'removing' | 'waiting_for_device' | null;
};

export type MobileHomeGitHubRepository = {
  id: string;
  /** Short repo name (no owner prefix). Kept around for search / sort
     callers even though the row title is now rendered as
     `owner/name`. */
  name: string;
  /** `owner/name` — also used as the row's click target and title. */
  fullName: string;
  /** Owner handle (user or org). Drives the leading avatar lookup. */
  ownerHandle: string;
  /** Owner avatar URL. When null the row falls back to a generic github
     glyph in the leading slot. */
  ownerAvatarUrl?: string | null;
  /** Optional one-line repo description. Currently unused by the flat
     list (the row reserves a single line for `owner/name`), but kept on
     the type so search can match against it. */
  description?: string | null;
  /** Currently unused in the row UI (count badge was removed). Kept on
     the type so consumers can still surface it elsewhere (search,
     sort). */
  conversationCount?: number;
  /** Latest message timestamp for any conversation under this repo —
     drives the trailing semantic age label AND the list sort order
     (newest first). */
  latestMessageAt?: number | null;
  /** Number of conversations under this repo that have new messages
     since the user last opened them. `0` / undefined hides the badge. */
  unreadCount?: number;
};

/* Chat-tab rows reuse the `MobileConversationItem` shape used by the
   in-project conversation page (title + status + optional line counts
   + age on a single line). Re-export it here so consumers don't have
   to know that the type lives next door in `mobile-project-screen`. */
export type { MobileConversationItem };

/* Item in the "最近常用" horizontal strip. The strip used to live inside
   each tab (local / github) separately; after the Projects merge it
   lives at the top of the merged tab and shows a single sorted list of
   recent items across BOTH kinds. The strip render branches on `kind`
   so each item still shows the right avatar / caption format. Capped
   to ~6 by the caller. */
export type MobileHomeRecentLocalProject = {
  id: string;
  /** Project short name (no path prefix). */
  name: string;
  /** Path under the project's machine — shown as the small caption
     beneath the project name. */
  path: string;
  /** Machine name (shown as a secondary label, since the home tab no
     longer has a machine pill to disambiguate). */
  machineName?: string;
  /** Timestamp the caller uses to merge-sort with GitHub recents in
     the unified strip. Higher = more recent. */
  latestActivityAt?: number | null;
};

export type MobileHomeRecentRepo = {
  id: string;
  /** Repo short name (no owner prefix). */
  name: string;
  /** "owner/repo". Used as the click target. */
  fullName: string;
  /** GitHub org / user handle to show beneath the avatar. */
  ownerHandle: string;
  /** Owner avatar URL (org or user); falls back to the octocat glyph. */
  avatarUrl?: string | null;
  /** Timestamp the caller uses to merge-sort with Local recents in
     the unified strip. Higher = more recent. */
  latestActivityAt?: number | null;
};

/* Discriminated union for the merged-recents strip. The home screen
   keeps the original two arrays as separate props (for type clarity
   and minimal caller churn) and merges them on demand via
   `mergeRecentProjects`. */
export type MobileHomeRecentProject =
  | ({ kind: 'local' } & MobileHomeRecentLocalProject)
  | ({ kind: 'github' } & MobileHomeRecentRepo);

export type MobileHomeScreenLabels = {
  switchWorkspace?: string;
  /** Copy shown by the inline connection-status indicator in the home
     header's middle slot when the workspace's control connection is
     anything other than `'online'`. */
  connectionBanner?: MobileConnectionStatusLabels;
  /** Label for the leftmost "Inbox" tab in the bottom dock. */
  inboxTab?: string;
  /** Placeholder body shown inside the Inbox tab while the feature
     has no active notifications. */
  inboxPlaceholder?: string;
  inboxLoading?: string;
  inboxDismissAriaLabel?: string;
  privateLabel?: string;
  privateHelpAriaLabel?: string;
  privateHelpTitle?: string;
  privateHelpDescription?: string;
  privateHelpClose?: string;
  /** Label for the merged "项目" tab in the bottom dock. */
  projectsTab?: string;
  /** Sub-tab segmented selector labels inside the Projects tab. The
     same `localTab` / `githubTab` strings are reused. */
  localTab?: string;
  githubTab?: string;
  /** Header add-project action sheet: trigger/title + the two options
     (each with a short hint subtitle). */
  addProjectMenu?: string;
  addLocalProject?: string;
  addLocalProjectHint?: string;
  addGitHubRepository?: string;
  addGitHubRepositoryHint?: string;
  chatTab?: string;
  /** Label for the Tasks tab in the bottom dock. Only rendered when the
     caller also passes `showTasksTab`. */
  tasksTab?: string;
  settingsTab?: string;
  /** aria-label for the archive-toggle chip in the header. Toggles the
     Chat tab between active and archived conversations. */
  archiveToggleLabel?: string;
  /** aria-label for the chip after search that shows/hides the Chat
     filter pill bar (Team Tasks / Group / Filters). */
  filterBarToggleLabel?: string;
  /** Heading shown above the unified recents strip on the Projects
     tab. Defaults to "最近常用" when omitted. */
  recentProjectsHeading?: string;
  online?: string;
  offline?: string;
  projectRemoving?: string;
  projectRemovalWaiting?: string;
  /** Copy shown inside the pull-to-refresh indicator while the user is
     pulling down. Two states: below threshold = "pull more", at or
     past threshold = "release to refresh". Both fade in as the pull
     grows so the user gets a smooth on-ramp instead of a sudden text
     pop. */
  pullToRefresh?: string;
  releaseToRefresh?: string;
  /** Placeholder shown inside the header search input. Defaults to a
     contextual placeholder per tab ("搜索项目" / "搜索仓库" / "搜索对话")
     when omitted. */
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  clearSearchAriaLabel?: string;
  /** Heading above the recently-used strip on Local + GitHub tabs. */
  recentReposHeading?: string;
  recentLocalProjectsHeading?: string;
  /** Heading above the flat "all items" list on Local / GitHub tabs.
     Defaults to "全部项目" / "全部仓库" when omitted. Chat tab no longer
     renders an "全部对话" label above the flat list. */
  allLocalProjectsHeading?: string;
  allGitHubReposHeading?: string;
  /** @deprecated Chat list no longer shows a section heading in the
     active (non-archived) mode. Kept for call-site compatibility. */
  allChatsHeading?: string;
  /** Heading rendered above the Chat tab's list when the archive
     toggle is on. Falls back to "归档对话" when not provided. */
  archivedChatsHeading?: string;
  /** Copy for the multi-select toolbar + delete confirmation shown
     when the user long-presses a row in the archive view. See
     `MobileChatListSelectionLabels`. */
  archiveSelection?: MobileChatListSelectionLabels;
  /** Per-bucket headings used by the Chat tab's grouped view modes.
     Keys are the bucket ids each grouping mode produces. Missing
     entries fall back to the id itself. */
  chatGroupLabels?: Partial<Record<string, string>>;
  /** Empty-state message for the entire tab when nothing exists yet
     (no machines, no authorized repos, no chats). */
  emptyLocalProjects?: string;
  emptyGitHubProjects?: string;
  emptyChats?: string;
  /** First-run onboarding copy for the Chat tab, shown when the
     workspace has no machines AND no conversations (distinct from
     `emptyChats`, which assumes a machine already exists). Guides the
     user to download + launch the desktop client. */
  onboarding?: MobileHomeOnboardingLabels;
  /** Empty-state shown when active chat filters removed every
     conversation (distinct from `emptyChats`, which means none exist).
     Paired with the "Clear filters" button. */
  emptyFilteredChats?: string;
  /** Label for the "Clear filters" button rendered in the filtered
     empty state. */
  clearChatFilters?: string;
  /** Empty-state when search query matches nothing. */
  emptySearch?: string;
  /** ARIA label for the standalone new-conversation chip in the dock. */
  newChatAriaLabel?: string;
  conversationCount?: (count: number) => string;
};

export type MobileHomeScreenProps = {
  workspace: MobileHomeWorkspace;
  workspaceOptions?: MobileHomeWorkspaceOption[];
  machines: MobileHomeMachine[];
  inboxItems?: MobileInboxItem[];
  inboxLoading?: boolean;
  onInboxItemSelect?: (itemId: string) => void;
  onInboxItemDismiss?: (itemId: string) => void;
  /** Workspace control-connection state (mirrors the desktop sidebar's
     `lodyConnectionUiStateAtom`). Defaults to `'online'` (banner stays
     hidden) when the caller doesn't pass anything — keeps Storybook /
     legacy callers from having to thread it through. */
  connectionUiState?: LodyConnectionUiState;
  /** True while the workspace's first machine/session sync is still in
     flight on app launch. Mirrors the desktop chat-landing's
     `isInitialDataLoading`. Used to suppress the first-run onboarding
     takeover until we actually know the workspace is empty — otherwise a
     returning user would see a flash of "download the client" before their
     cached machines + chats hydrate. Defaults to `false`. */
  isInitialDataLoading?: boolean;
  /** Fired when the user pulls down past threshold at the top of the
     list. Caller drives the actual sync (typically
     `runtime.repo.sync()`); the home screen owns the gesture
     detection but lets the parent decide what "refresh" means. */
  onPullToRefresh?: () => Promise<void> | void;
  selectedTab: MobileHomeTab;
  /** Inbox only appears in workspaces with more than one member. */
  showInboxTab?: boolean;
  /** Shows the Tasks tab in the bottom dock (developer-mode Tasks beta
     gate). When false the tab is not rendered at all — as if never
     built — and a `selectedTab` of `'tasks'` falls back to Chat. */
  showTasksTab?: boolean;
  /** Active sub-tab inside the Projects tab. Required when `selectedTab`
     is 'projects'; ignored on the Chat tab. */
  selectedProjectsSubTab?: MobileProjectsSubTab;
  /** Fired when the user taps a segment in the Projects sub-tab
     selector. Caller is expected to persist the choice + update
     whatever downstream state needs the sub-tab (e.g. the composer's
     contextType). */
  onProjectsSubTabSelect?: (sub: MobileProjectsSubTab) => void;
  /** Header add-project dropdown actions (shown on the Projects tab, left of
     the settings gear): pick a folder, or open GitHub integration settings. */
  onAddLocalProject?: () => void;
  onAddGitHubRepository?: () => void;
  localProjects: MobileHomeLocalProject[];
  /** Recently active local projects — rendered as a horizontal strip
     at the top of the Local tab. Empty array hides the strip. */
  recentLocalProjects?: MobileHomeRecentLocalProject[];
  /** Flat list of all authorized GitHub repositories, sorted by the
     caller (newest activity first). The component does not regroup
     them by owner anymore; each row stands on its own. */
  githubRepositories: MobileHomeGitHubRepository[];
  /** Recently active repositories — rendered as a horizontal strip at
     the top of the GitHub tab. Empty array hides the strip. */
  recentGitHubRepos?: MobileHomeRecentRepo[];
  /** Every non-archived conversation in the workspace, sorted by the
     caller (newest first). Rendered as single-line rows (title +
     optional +/- / age) shared with the in-project page. */
  chats: MobileConversationItem[];
  /** Pills rendered above the Chat tab's list for filtering / view
     mode switching. When omitted no bar is mounted (the tab renders
     the same as before). */
  chatFilterPills?: ReadonlyArray<FilterPill>;
  /** Active grouping mode for the Chat tab. `none` (default) renders
     the chats as one flat newest-first list. Anything else inserts
     section headings between buckets. The caller passes the bucket
     labels via `labels.chatGroupLabels`. */
  chatGroupBy?: MobileChatGroupBy;
  /** True when active chat filters are narrowing the list. Drives the
     "Clear filters" affordance in the empty state (so an all-filtered-out
     list reads as "your filters hid everything", not "no conversations"). */
  hasActiveChatFilters?: boolean;
  /** Resets all chat filters to their default (show-everything) state.
     Wired to the empty-state "Clear filters" button. */
  onClearChatFilters?: () => void;
  labels?: MobileHomeScreenLabels;
  theme?: 'ios' | 'material';
  /** Tap on the workspace pill in the header — typically opens a
     bottom-sheet workspace switcher rendered by the parent. The pill
     itself no longer hosts an inline dropdown (the sheet handles
     create / invite actions too, which don't fit a dropdown well). */
  onWorkspaceMenuOpen?: () => void;
  /** Retained for callers that still drive selection externally (e.g.
     stories without the sheet). Most consumers should wire the sheet
     instead and select via that. */
  onWorkspaceSelect?: (workspaceId: string) => void;
  onTabSelect?: (tab: MobileHomeTab) => void;
  onLocalProjectSelect?: (projectId: string) => void;
  onGitHubRepositorySelect?: (repoFullName: string) => void;
  onChatSelect?: (chatId: string) => void;
  /** Pin / unpin a chat from the swipe-to-reveal drawer on its row.
     Receives the next pinned state so the handler doesn't have to
     re-derive the current state. */
  onChatTogglePin?: (chatId: string, nextPinned: boolean) => void;
  /** Archive a chat from the swipe-to-reveal drawer (or from the
     super-swipe). */
  onChatArchive?: (chatId: string) => void;
  /** Restore (un-archive) a chat from the swipe-to-reveal drawer shown
     on rows of the *archived* Chat list. */
  onChatRestore?: (chatId: string) => void;
  /** Hands a batch of chat ids to the parent for *permanent* deletion.
     Only invoked from the multi-select toolbar shown in the archive
     view's selection mode. The list itself owns the selection +
     confirmation UX; this prop only carries out the destructive
     action. */
  onChatPermanentDelete?: (chatIds: string[]) => void | Promise<void>;
  /** Fires when the gear chip in the top header is tapped. Navigates to
     the settings surface. */
  onSettingsOpen?: () => void;
  /** Fires when the standalone new-conversation chip in the bottom dock
     is tapped. Optional — when omitted the chip is not rendered. */
  onNewChat?: () => void;
  /** Fires when the user taps "Download Lody" in the first-run onboarding
     empty state (Chat tab, no machines + no chats). Typically opens the
     localized download page in the external browser. When omitted the
     onboarding still renders but the button is inert. */
  onDownloadClient?: () => void;
  /** When true, the Chat tab renders the *archived* conversations
     (instead of the active ones) and the content area is tinted with
     `bg-muted` to give the "everything here is archived" feel. The
     caller still owns the data — it just hands over the archived
     list via `chats` when this is true and the active list when it's
     false. */
  showArchived?: boolean;
  /** Fires when the user taps the Archive chip in the header. Only
     rendered when both this callback and the Chat tab are active. */
  onShowArchivedToggle?: () => void;
};

/* Home header workspace chip — shared `WorkspaceAvatar` so logo /
   first-letter fallback match the switcher sheet and desktop sidebar. */
function HomeWorkspaceAvatar({
  workspace,
  size = 'sm',
}: {
  workspace: MobileHomeWorkspace;
  size?: 'sm' | 'md';
}) {
  const sizeClass = size === 'sm' ? 'h-7 w-7 text-[0.72rem]' : 'h-9 w-9 text-[0.82rem]';
  return (
    <WorkspaceAvatar
      workspace={{ name: workspace.name, logo: workspace.avatarUrl }}
      className={sizeClass}
    />
  );
}

/* Floating pill (workspace chip / settings chip).
   Light: soft muted inset (card == white background, so no white
   shadow blobs). Dark: muted alone is too close to the canvas —
   add a hairline + slightly lifted white/10 fill so archive /
   settings / chips actually read as controls. */
const FloatingPill = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  function FloatingPill({ className, type = 'button', ...rest }, ref) {
    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        className={cn(
          'inline-flex shrink-0 items-center gap-2 rounded-full border border-border/50 bg-muted text-foreground',
          'dark:border-white/12 dark:bg-white/10',
          'transition-colors active:bg-muted/80 active:scale-[0.97] dark:active:bg-white/14',
          className
        )}
      />
    );
  }
);

/* Add-project action sheet launched from the Projects header. A bottom sheet
   with large, well-separated tap targets (rejected: a desktop-style dropdown —
   its items sat too close together on touch and read as out of place on
   mobile). Dismisses via swipe-down / backdrop tap (vaul). */
function AddProjectActionSheet({
  open,
  onOpenChange,
  onAddLocalProject,
  onAddGitHubRepository,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddLocalProject?: () => void;
  onAddGitHubRepository?: () => void;
  labels: MobileHomeScreenLabels;
}) {
  const options: Array<{
    key: string;
    icon: ReactNode;
    title: string;
    hint: string;
    onSelect: () => void;
  }> = [];
  if (onAddLocalProject) {
    options.push({
      key: 'local',
      icon: <FolderPlus className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />,
      title: labels.addLocalProject ?? '添加文件夹',
      hint: labels.addLocalProjectHint ?? '浏览机器目录，选择一个文件夹',
      onSelect: onAddLocalProject,
    });
  }
  if (onAddGitHubRepository) {
    options.push({
      key: 'github',
      icon: <Github className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />,
      title: labels.addGitHubRepository ?? '添加 GitHub 仓库',
      hint: labels.addGitHubRepositoryHint ?? '连接 GitHub 集成',
      onSelect: onAddGitHubRepository,
    });
  }

  const title = labels.addProjectMenu ?? '添加项目';

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-[max(1.25rem,var(--safe-area-bottom,0px))]">
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{title}</DrawerDescription>
        <div className="flex flex-col gap-2.5 px-4 pt-3">
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                onOpenChange(false);
                opt.onSelect();
              }}
              className="flex items-center gap-3.5 rounded-2xl bg-muted/40 px-4 py-3.5 text-left transition-colors active:bg-muted/70"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                {opt.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.95rem] font-semibold leading-tight">
                  {opt.title}
                </span>
                <span className="mt-0.5 block truncate text-[0.8rem] text-muted-foreground">
                  {opt.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function PrivateResourceHelpSheet({
  open,
  onOpenChange,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: MobileHomeScreenLabels;
}) {
  const title = labels.privateHelpTitle ?? 'Private resources are only visible to you';
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-[max(1.25rem,var(--safe-area-bottom,0px))]">
        <div className="flex flex-col items-center px-5 pb-2 pt-4 text-center">
          <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </span>
          <DrawerTitle className="text-base font-semibold text-foreground">{title}</DrawerTitle>
          <DrawerDescription className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {labels.privateHelpDescription ??
              'Private machines, local projects, and their conversations are hidden from teammates. Share a machine in device settings or a project in project settings.'}
          </DrawerDescription>
          <button
            type="button"
            className="mt-5 min-h-11 w-full max-w-sm rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground active:opacity-80"
            onClick={() => onOpenChange(false)}
          >
            {labels.privateHelpClose ?? 'Got it'}
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/* Compact semantic age label ("now", "5m", "2h", "3d", "2mo", "1y") used
   in the row's trailing slot. Mirrors `formatMobileAgeLabel` in
   chat-landing.tsx; duplicated here so the home component stays
   self-contained. */
function formatHomeRowAgeLabel(dateValue: number | string | undefined | null): string {
  if (dateValue == null) return '';
  const ts = typeof dateValue === 'number' ? dateValue : Date.parse(String(dateValue));
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/* Trailing-slot content for list rows on the Local + GitHub tabs.
   Stacks the semantic age label on top with an unread-count pill
   underneath — when there's nothing to show, the whole slot collapses
   to `null` so Konsta's row layout doesn't reserve extra width. */
function RowTrailingMeta({
  latestMessageAt,
  unreadCount,
}: {
  latestMessageAt?: number | null;
  unreadCount?: number;
}) {
  const ageLabel = formatHomeRowAgeLabel(latestMessageAt ?? null);
  const unread = unreadCount ?? 0;
  if (!ageLabel && unread === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-col items-end gap-1 self-center">
      {ageLabel ? (
        <span className="text-[0.7rem] tabular-nums text-muted-foreground">{ageLabel}</span>
      ) : null}
      {unread > 0 ? (
        <span className="inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-primary px-1.5 text-[0.68rem] font-semibold leading-none tabular-nums text-primary-foreground">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </span>
  );
}

/* Fast top→bottom exit for header search before the status/pull pill
   mounts. Keep short so the handoff still tracks the finger; longer
   values leave a blank band that feels laggy. Must match the CSS
   `duration-150` on the search slot (150ms). */
const HEADER_SEARCH_EXIT_MS = 150;

/* Header search input. Fills the chrome-row middle between the workspace
   avatar and trailing actions. Same surface as FloatingPill. */
function HeaderSearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearAriaLabel,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearAriaLabel: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'mobile-home-header-search flex h-9 w-full min-w-0 items-center gap-1.5 rounded-full border border-border/50 bg-muted px-3 text-foreground',
        'dark:border-white/12 dark:bg-white/10',
        'transition-colors focus-within:bg-muted/80 dark:focus-within:bg-white/14',
        className
      )}
    >
      <Search
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        enterKeyHint="search"
        /* Drop the browser's default focus border on type=search; the
           muted pill is the visual container. */
        className="min-w-0 flex-1 border-none bg-transparent text-[0.82rem] outline-none focus:outline-none focus:ring-0 placeholder:text-muted-foreground"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={clearAriaLabel}
          className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}

/* Chat-list filter toggle — lives on the first group heading's trailing
   edge (not next to search). Active tint when the pill bar is open; a
   small primary dot marks applied filters while the bar is collapsed. */
function ChatListFilterToggle({
  open,
  hasActiveFilters,
  ariaLabel,
  onToggle,
}: {
  open: boolean;
  hasActiveFilters: boolean;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={ariaLabel}
      aria-pressed={open}
      className={cn(
        'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
        'border-border/50 bg-muted text-muted-foreground',
        'dark:border-white/12 dark:bg-white/10',
        'transition-colors active:scale-[0.97]',
        'hover:bg-muted/80 hover:text-foreground dark:hover:bg-white/14',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30',
        open && 'border-primary/40 bg-primary/15 text-primary'
      )}
    >
      <CarbonSettingsAdjust className="h-4 w-4 text-current" aria-hidden="true" />
      {hasActiveFilters && !open ? (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
        />
      ) : null}
    </button>
  );
}

/* Small uppercase label used as a section heading. Visually matches
   the "最近常用" heading on the recents strip, but standalone (no
   horizontal scroll, no trailing chips). */
function AllItemsHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 pb-1 pt-3 text-[0.72rem] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function MachineStatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        online ? 'bg-status-success' : 'bg-muted-foreground/40'
      )}
      aria-hidden="true"
    />
  );
}

/* Initial-letter avatar lives in its own module so the in-project
   header can share the same look. */

/* Owner avatar for GitHub rows: real image when we have a URL,
   otherwise the github glyph on a neutral tile. */
function GhOwnerAvatar({ url, handle }: { url?: string | null; handle: string }) {
  if (url) {
    return (
      <CachedAvatarImg
        src={url}
        alt=""
        loading="lazy"
        className="h-10 w-10 shrink-0 rounded-xl object-cover"
      />
    );
  }
  return (
    <span
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/80"
      aria-label={handle}
    >
      <Github className="h-5 w-5" strokeWidth={1.6} aria-hidden="true" />
    </span>
  );
}

/* Rounded card surface that wraps the flat row list on each tab. */
function MobileHomeListShell({ children }: { children: ReactNode }) {
  return (
    <ul className="mx-3 overflow-hidden rounded-2xl border border-border/40 bg-card">{children}</ul>
  );
}

/* Single row in the flat home list. Slots:
   - `leading`: 40×40 avatar tile (initial letter / owner image / glyph)
   - `title` + optional `titleSuffix` on the same line (project name +
     light path; or `owner/repo` with no suffix)
   - optional `secondaryLine` underneath (machine meta for Local + Chat;
     empty for GitHub which is a single-line row)
   - `trailing`: time + unread badge (renders `RowTrailingMeta`)

   `last:border-b-0` lets the shell crop the final divider without a
   per-call special case. */
function MobileHomeListRow({
  leading,
  title,
  titleSuffix,
  secondaryLine,
  trailing,
  onClick,
  ariaLabel,
  wrapTitle = false,
  disabled = false,
}: {
  leading: ReactNode;
  title: ReactNode;
  titleSuffix?: ReactNode;
  secondaryLine?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
  /** Let the title wrap to show in full instead of truncating on one
     line. The `titleSuffix` then stays pinned (shrink-0) to the first
     line. Used by the local-projects list so long project names aren't
     clipped. */
  wrapTitle?: boolean;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          'flex w-full items-center gap-3 border-b border-border/40 px-3 py-2.5 text-left text-foreground',
          'last:border-b-0',
          'transition-colors active:bg-muted/40 hover:bg-muted/30',
          'focus-visible:outline-none focus-visible:bg-muted/40',
          'disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent disabled:active:bg-transparent'
        )}
      >
        {leading}
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn('flex min-w-0 gap-1.5', wrapTitle ? 'items-center' : 'items-baseline')}
          >
            <span
              className={cn(
                'text-[1.02rem] font-semibold leading-tight',
                wrapTitle ? 'min-w-0 break-words' : 'truncate'
              )}
            >
              {title}
            </span>
            {titleSuffix ? (
              <span
                className={cn(
                  'text-[0.78rem] font-normal leading-tight text-muted-foreground',
                  /* wrapTitle: the suffix (e.g. machine) takes the
                     remaining width to the row's right edge and truncates
                     only there — the node itself owns its truncation, so
                     no `truncate` here. Otherwise it's a plain inline
                     suffix that shrinks. */
                  wrapTitle ? 'min-w-0 flex-1' : 'min-w-0 truncate'
                )}
              >
                {titleSuffix}
              </span>
            ) : null}
          </span>
          {secondaryLine}
        </span>
        {trailing}
      </button>
    </li>
  );
}

/* Horizontal "最近常用" strip rendered at the top of the Local + GitHub
   tabs. Each card is a tap-to-enter rounded rectangle showing a
   leading visual (machine icon / owner avatar), the project or repo
   name, and a secondary caption (machine name / owner handle). The
   parent caps the list and sorts by recency. */
function RecentItemsRow<TItem extends { id: string }>({
  items,
  heading,
  onSelect,
  renderItem,
}: {
  items: TItem[];
  heading: ReactNode;
  onSelect: (item: TItem) => void;
  renderItem: (item: TItem) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mobile-home-recents pb-2 pt-3">
      <div className="px-5 pb-1 text-[0.72rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </div>
      <div className="hide-scrollbar flex items-stretch gap-2 overflow-x-auto px-5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              'inline-flex w-[10rem] shrink-0 items-center gap-2 rounded-2xl bg-card px-3 py-2 text-left text-foreground',
              'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-16px_rgba(0,0,0,0.12)]',
              'transition-transform active:scale-[0.97]'
            )}
          >
            {renderItem(item)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Build the bottom tabbar's tab list from the screen's labels. Lives
   at module scope (rather than inside `MobileHomeScreen`) so the spec
   doesn't get rebuilt unnecessarily — `labels` is identity-stable per
   render of the parent, and the tab callbacks are passed to
   `<MobileWorkspaceTabBar>` via plain props, not closures. */
function workspaceTabSpecs(
  labels: MobileHomeScreenLabels,
  showTasksTab = false,
  showInboxTab = false
): ReadonlyArray<MobileBottomTabBarTabSpec<MobileHomeTab>> {
  /* Icons at 24px (h-6) — the dock pill is h-14, so h-5/20px read as
     under-drawn next to the label. Material icons go through MobileReactIcon
     which fills this box (not 1em of the label's 0.72rem). */
  return [
    ...(showInboxTab
      ? [
          {
            key: 'inbox' as const,
            ios: <BellRing className="h-6 w-6" strokeWidth={1.75} />,
            material: <BellRing className="h-6 w-6" strokeWidth={1.75} />,
            label: labels.inboxTab ?? 'Inbox',
          },
        ]
      : []),
    {
      key: 'chat',
      ios: <MessageCircle className="h-6 w-6" strokeWidth={1.75} />,
      material: <MobileReactIcon icon={MdChat} className="h-6 w-6" />,
      label: labels.chatTab ?? 'Chat',
    },
    ...(showTasksTab
      ? [
          {
            key: 'tasks' as const,
            ios: <ListTodo className="h-6 w-6" strokeWidth={1.75} />,
            material: <MobileReactIcon icon={MdChecklist} className="h-6 w-6" />,
            label: labels.tasksTab ?? 'Tasks',
          },
        ]
      : []),
    {
      key: 'projects',
      ios: <Folders className="h-6 w-6" strokeWidth={1.75} />,
      material: <MobileReactIcon icon={MdFolderCopy} className="h-6 w-6" />,
      label: labels.projectsTab ?? '项目',
    },
  ];
}

/* Storybook / unconfigured callers see hard-coded Chinese fallbacks
   here — in production every caller threads through chat-landing,
   which supplies its own localized `labels.searchPlaceholder` (see
   the `useMemo` in chat-landing that picks the per-tab i18n key).
   Keep the fallbacks Chinese to match this repo's dev language; the
   i18n scanner can't reach inline literals like these because they
   aren't wrapped in `t()`. */
function defaultSearchPlaceholder(
  tab: MobileHomeTab,
  sub: MobileProjectsSubTab | undefined
): string {
  if (tab === 'inbox') return '搜索';
  if (tab === 'chat') return '搜索对话';
  if (sub === 'github') return '搜索仓库';
  return '搜索项目';
}

/* Merge the two recent arrays into a single newest-first sorted list,
   capped at `cap` items. Stable for items without `latestActivityAt`
   — they sink to the bottom in their input order. The discriminator
   `kind` is added here so the strip renderer can branch on it.

   We merge in the component (not the caller) so callers stay close to
   their data sources: each kind has different timestamp fields and
   different filtering rules, and forcing the caller to flatten would
   leak that logic to every consumer. The merge is cheap (O(n log n))
   and the inputs are already capped at ≤5 each. */
function mergeRecentProjects(
  local: MobileHomeRecentLocalProject[],
  github: MobileHomeRecentRepo[],
  cap = 6
): MobileHomeRecentProject[] {
  const tagged: MobileHomeRecentProject[] = [
    ...local.map((item) => ({ kind: 'local' as const, ...item })),
    ...github.map((item) => ({ kind: 'github' as const, ...item })),
  ];
  tagged.sort((left, right) => {
    const leftTs = left.latestActivityAt ?? -Infinity;
    const rightTs = right.latestActivityAt ?? -Infinity;
    return rightTs - leftTs;
  });
  return tagged.slice(0, cap);
}

/* Compact pill-segmented control for the Projects sub-tab.

   Design intent: read as a section-local filter that sits *with* the
   content, not as a heavy page-level mode switch. We get that by
   keeping it small, content-sized (not full-width), and left-aligned.
   The `layoutId`-driven thumb still gives the iOS-segmented feel —
   framer-motion animates both x AND width when the active segment
   changes, since the two labels render at different widths.

   Rejected alternatives:
   - Full-width half-and-half segments: visually equal to "primary
     navigation", crowds the page; the user explicitly asked for
     "小一点，更有设计感".
   - Underlined tabs: too quiet for this layer; the segments need to
     read as interactive switches, not section headings.
   - Reuse `MobileFilterPillBar`: that bar shows N independent chips
     where each is on/off — a 2-segment exclusive selector reads more
     clearly with a shared thumb than two separately-toggleable pills.

   Tokens: `bg-muted/50` for the track is intentionally lighter than
   the original `bg-muted/60` — a thinner pill needs less contrast to
   register as a single grouped control. The active thumb is plain
   `bg-card` (no shadow) since the pill itself is so compact a shadow
   would feel chunky at this scale. */
function ProjectsSubTabSelector({
  active,
  localLabel,
  githubLabel,
  onSelect,
  iosTheme,
}: {
  active: MobileProjectsSubTab;
  localLabel: string;
  githubLabel: string;
  onSelect: (sub: MobileProjectsSubTab) => void;
  iosTheme: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLButtonElement>(null);
  const githubRef = useRef<HTMLButtonElement>(null);
  const segments: Array<{
    key: MobileProjectsSubTab;
    label: string;
    icon: ReactNode;
    ref: { current: HTMLButtonElement | null };
  }> = [
    {
      key: 'local',
      label: localLabel,
      icon: iosTheme ? (
        <Monitor className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <MobileReactIcon icon={MdComputer} className="h-3.5 w-3.5" />
      ),
      ref: localRef,
    },
    {
      key: 'github',
      label: githubLabel,
      icon: iosTheme ? (
        <Github className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <MobileReactIcon icon={FaGithub} className="h-3.5 w-3.5" />
      ),
      ref: githubRef,
    },
  ];

  // Drive the active thumb with a *value* animation (x + width) rather than
  // framer-motion's `layoutId` layout animation. A layout animation re-measures
  // the thumb's on-screen box on every re-render and springs to correct any
  // delta — so while pull-to-refresh translates this whole subtree, each
  // `pullDistance` frame re-renders the selector, the thumb measures a new
  // screen position, and it visibly lags behind the content while "catching up".
  // Measuring the active button once per `active` change and animating x/width
  // keeps the same spring feel on tab-switch while staying immune to the
  // ancestor transform (rejected: keeping `layoutId` + memoizing the subtree —
  // `pullDistance` lives high in the tree and threading memo through is fragile).
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => {
      const btn = (active === 'local' ? localRef : githubRef).current;
      if (!btn) return;
      // getBoundingClientRect (border-box) instead of offsetLeft so the thumb's
      // `left: 0` (padding-box of the borderless list, which coincides with its
      // border-box) lines up with the measured offset.
      const listRect = list.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setThumb({ x: btnRect.left - listRect.left, width: btnRect.width });
    };
    measure();
    // Re-measure when the pill itself reflows (font swap, container resize). A
    // ResizeObserver fires on the list's own box change but NOT on an ancestor's
    // pull-to-refresh transform, so it keeps the thumb aligned without
    // reintroducing the lag the layout animation caused.
    return observeResizeOnAnimationFrame(list, () => measure());
  }, [active, localLabel, githubLabel, iosTheme]);

  return (
    <div className="mx-3 mb-2 mt-1 flex">
      <div
        ref={listRef}
        role="tablist"
        aria-label={localLabel + ' / ' + githubLabel}
        className="relative inline-flex rounded-full bg-muted/50 p-0.5"
      >
        {thumb ? (
          <motion.span
            aria-hidden="true"
            className="absolute bottom-0.5 left-0 top-0.5 rounded-full bg-card"
            initial={false}
            animate={{ x: thumb.x, width: thumb.width }}
            transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.65 }}
          />
        ) : null}
        {segments.map((seg) => {
          const isActive = seg.key === active;
          return (
            <button
              key={seg.key}
              ref={(button) => {
                seg.ref.current = button;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(seg.key)}
              className={cn(
                'relative z-10 rounded-full px-3 py-1 text-[0.78rem] font-medium transition-colors',
                isActive ? 'text-foreground' : 'text-muted-foreground active:text-foreground'
              )}
            >
              <span className="flex items-center gap-1.5">
                {seg.icon}
                {seg.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function normalizeForSearch(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

export function filterMobileInboxItems(
  items: readonly MobileInboxItem[],
  normalizedQuery: string
): MobileInboxItem[] {
  if (!normalizedQuery) return [...items];
  return items.filter(
    (item) =>
      normalizeForSearch(item.title).includes(normalizedQuery) ||
      normalizeForSearch(item.description).includes(normalizedQuery) ||
      normalizeForSearch(item.actionLabel).includes(normalizedQuery)
  );
}

export function MobileHomeScreen({
  workspace,
  workspaceOptions = [],
  machines,
  inboxItems = [],
  inboxLoading = false,
  onInboxItemSelect,
  onInboxItemDismiss,
  connectionUiState = 'online',
  isInitialDataLoading = false,
  onPullToRefresh,
  selectedTab,
  showInboxTab = false,
  showTasksTab = false,
  selectedProjectsSubTab = 'local',
  onProjectsSubTabSelect,
  onAddLocalProject,
  onAddGitHubRepository,
  localProjects,
  recentLocalProjects = [],
  githubRepositories,
  recentGitHubRepos = [],
  chats,
  chatFilterPills,
  chatGroupBy = 'project',
  hasActiveChatFilters = false,
  onClearChatFilters,
  labels = {},
  theme,
  onWorkspaceMenuOpen,
  onWorkspaceSelect: _onWorkspaceSelect,
  onTabSelect,
  onLocalProjectSelect,
  onGitHubRepositorySelect,
  onChatSelect,
  onChatTogglePin,
  onChatArchive,
  onChatRestore,
  onChatPermanentDelete,
  onSettingsOpen,
  onNewChat,
  onDownloadClient,
  showArchived = false,
  onShowArchivedToggle,
}: MobileHomeScreenProps) {
  /* `workspaceOptions` was the source for the inline workspace dropdown
     menu — that's now handled by `MobileWorkspaceSwitcherSheet` rendered
     by the parent. The prop stays on the type for backward compatibility
     but isn't consumed here anymore. */
  void workspaceOptions;

  /* Chat filter pill bar starts collapsed so the list chrome stays
     clean; the filter chip after search toggles it open. Session-local
     only (not persisted) — reopening the app lands on a quiet surface. */
  const [chatFiltersOpen, setChatFiltersOpen] = useState(false);

  /* Single search query across all tabs — the input lives in the header
     and stays visible regardless of tab. Resetting on tab change would
     surprise users who flick between tabs while searching for the same
     thing in both ("react" could match a project name AND a chat
     title). Persisting keeps the filter useful. */
  const [searchQuery, setSearchQuery] = useState('');
  // Controls the add-project action sheet launched from the Projects header.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [privateHelpOpen, setPrivateHelpOpen] = useState(false);
  /* Ref to the list-region scroll container — handed to
     `MobileWorkspaceTabBar` so the dock can collapse while the user
     scrolls. */
  const listScrollRef = useRef<HTMLDivElement>(null);
  /* Pull-to-refresh: when the list is at the top and the user
     pulls down past threshold, fire `onPullToRefresh`. The hook
     reports `isRefreshing` while the promise is in flight (fed into
     the header status pill so it shows "刷新中…" until the sync
     settles) and `pullDistance` during the gesture itself, which both
     translates the filter-pill bar + list down. The header runs a fast
     top→bottom search exit, then mounts the centered pull/status pill. */
  const {
    pullDistance,
    isRefreshing: isPullingRefresh,
    threshold: pullThreshold,
  } = usePullToRefresh({
    scrollRef: listScrollRef,
    onRefresh: () => onPullToRefresh?.() ?? Promise.resolve(),
    enabled: Boolean(onPullToRefresh),
  });
  const pullPastThreshold = pullDistance >= pullThreshold;
  const normalizedQuery = normalizeForSearch(searchQuery.trim());

  /* First-run onboarding: the user opened the mobile app before ever
     launching the desktop client, so the workspace has no machines and
     no conversations. The Chat tab is the default landing surface, so we
     surface a "download + start Lody on your computer" guide there instead
     of a bare "no conversations" line. Gated to the live Chat list (not
     the archive view, an active filter, or an in-progress search) so it
     only ever stands in for the genuine empty workspace. */
  const showChatOnboarding =
    selectedTab === 'chat' &&
    !isInitialDataLoading &&
    !showArchived &&
    !hasActiveChatFilters &&
    normalizedQuery.length === 0 &&
    machines.length === 0 &&
    chats.length === 0;

  /* Machine lookup table for the secondary line on Local + Chat rows.
     Each row carries a `machineId`; we resolve it to `{name, isOnline}`
     here rather than walking the array per row. */
  const machineLookup = useMemo(() => {
    const map = new Map<string, { name: string; isOnline: boolean; isPrivate?: boolean }>();
    for (const machine of machines) {
      map.set(machine.id, {
        name: machine.name,
        isOnline: machine.isOnline,
        isPrivate: machine.isPrivate,
      });
    }
    return map;
  }, [machines]);

  /* The Tasks tab only exists while the beta gate is on. If it flips off
     while the user is sitting on the tab (or a stale `selectedTab`
     arrives), fall back to Chat rather than rendering a featureless
     shell — gate-off must behave as if the tab were never built. */
  const tasksTabActive = showTasksTab && selectedTab === 'tasks';
  const effectiveSelectedTab: MobileHomeTab =
    selectedTab === 'tasks' && !showTasksTab ? 'chat' : selectedTab;

  const resolvedTheme: 'ios' | 'material' =
    theme ?? (isIOSRuntimeEnvironment() ? 'ios' : 'material');

  const searchPlaceholder =
    labels.searchPlaceholder ?? defaultSearchPlaceholder(selectedTab, selectedProjectsSubTab);

  /* Unified recents list for the Projects tab. Merged inside the
     component so callers stay close to their own per-kind data. The
     full list below stays per-sub-tab — only the recents are unified. */
  const recentProjectsMerged = useMemo(
    () => mergeRecentProjects(recentLocalProjects, recentGitHubRepos),
    [recentLocalProjects, recentGitHubRepos]
  );
  const searchAriaLabel = labels.searchAriaLabel ?? searchPlaceholder;
  const clearSearchAriaLabel = labels.clearSearchAriaLabel ?? 'Clear search';

  /* Status/pull owns the middle chrome while pulling, refreshing, or
     ambient connection needs attention. Search and status must never
     overlap: search exits first (fast top→bottom fade), then the pill
     mounts; on restore the pill unmounts immediately and search fades
     back in. */
  const wantStatusSlot =
    pullDistance > 0 ||
    isPullingRefresh ||
    connectionUiState === 'loading' ||
    connectionUiState === 'reconnecting' ||
    connectionUiState === 'offline';
  /* Keep search mounted for the exit transition; opacity/transform are
     driven by `searchOpaque`. Pill only mounts once `statusRevealed`. */
  const [searchOpaque, setSearchOpaque] = useState(() => !tasksTabActive && !wantStatusSlot);
  const [statusRevealed, setStatusRevealed] = useState(() => tasksTabActive || wantStatusSlot);
  useEffect(() => {
    let reveal: number | undefined;
    if (tasksTabActive) {
      setSearchOpaque(false);
      setStatusRevealed(true);
    } else if (wantStatusSlot) {
      /* Exit search first; reveal pill only after the fade finishes so
         the two never share the chrome band. */
      setSearchOpaque(false);
      setStatusRevealed(false);
      reveal = window.setTimeout(() => {
        setStatusRevealed(true);
      }, HEADER_SEARCH_EXIT_MS);
    } else {
      /* Restore: drop pill immediately (no crossfade overlap), then
         fade search back in on the next frame so the exit transition
         can reverse cleanly. */
      setStatusRevealed(false);
      setSearchOpaque(true);
    }
    return () => {
      if (reveal !== undefined) window.clearTimeout(reveal);
    };
  }, [tasksTabActive, wantStatusSlot]);

  /* Tab swipe was removed — conflicted with the row-level
     left-swipe-to-reveal-actions gesture on conversation rows. The
     dock tabbar at the bottom remains the only way to switch tabs. */

  return (
    /* No Konsta App wrapper anymore — the flat lists use plain
       Tailwind-styled rows. The `safe-areas` class still has to be
       here because Konsta's `pt-safe-*` / `ps-safe-*` / `pe-safe-*`
       utilities (used by the header below and by other mobile screens
       in this tree) only resolve the `--k-safe-area-*` vars when an
       ancestor opts in via this class — `<App safeAreas>` used to do
       it for us; now we do it directly. The class is just a CSS hook
       (from konsta/styles/safe-areas.css), no Konsta runtime needed. */
    <div className="mobile-home-app safe-areas relative h-full min-h-0 w-full text-foreground">
      {/* Column flex so the header + Chat-tab pill bar sit ABOVE the
         scroll region — keeps the vertical scrollbar contained to
         the list area instead of running through the chrome at the
         top. Mirrors the structure on MobileProjectScreen. */}
      <div className="mobile-home-shell relative flex h-full w-full flex-col bg-background">
        {/* Sticky header: safe-area padding outside the chrome row so the
           status/pull pill can center on the same h-9 band as the
           workspace / search / trailing controls — not the full header
           including `pt-safe` (that was pulling the pill into the notch). */}
        <header
          className={cn('mobile-home-glass relative z-30', 'pt-safe-2 pb-2 ps-safe-3 pe-safe-3')}
        >
          {/* Single chrome row: workspace | search (middle blank) |
             archive/settings. Search fills the gap at rest; on pull it
             does a fast top→bottom fade, then the status/pull pill
             mounts (never overlapping). Leading/trailing keep
             `relative z-10` so taps stay hittable under the pill overlay. */}
          <div className="relative flex h-9 w-full items-center gap-2">
            {/* Icon-only workspace identity. With a menu callback it is the
               switcher trigger; without one it remains a static nameplate. */}
            <div className="relative z-10 flex shrink-0 items-center justify-start">
              {onWorkspaceMenuOpen ? (
                <FloatingPill
                  className="h-9 w-9 items-center justify-center !gap-0"
                  aria-label={`${labels.switchWorkspace ?? 'Switch workspace'}: ${workspace.name}`}
                  aria-haspopup="dialog"
                  onClick={onWorkspaceMenuOpen}
                >
                  <HomeWorkspaceAvatar workspace={workspace} size="sm" />
                </FloatingPill>
              ) : (
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-border/50 bg-muted text-foreground dark:border-white/12 dark:bg-white/10"
                  data-workspace-identity
                >
                  <HomeWorkspaceAvatar workspace={workspace} size="sm" />
                </div>
              )}
            </div>

            {/* Search stays mounted so CSS can run the exit transition.
               Slot always occupies flex-1 so trailing discs don't jump. */}
            <div
              className={cn(
                'relative z-10 h-9 min-w-0 flex-1',
                /* Top→bottom handoff: fade + slight downward drift.
                   Duration matches HEADER_SEARCH_EXIT_MS (tailwind
                   duration-150 ≈ 150ms; keep the timeout in sync). */
                'transition-[opacity,transform] duration-150 ease-out',
                searchOpaque && !tasksTabActive
                  ? 'opacity-100 translate-y-0'
                  : 'pointer-events-none translate-y-1.5 opacity-0'
              )}
              aria-hidden={!searchOpaque || tasksTabActive}
            >
              {!tasksTabActive ? (
                <HeaderSearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder={searchPlaceholder}
                  ariaLabel={searchAriaLabel}
                  clearAriaLabel={clearSearchAriaLabel}
                />
              ) : null}
            </div>

            {/* Trailing header actions — same canvas liquid-glass discs as
               the in-session mobile header (`GlassIconButton`). */}
            <div className="relative z-10 flex shrink-0 items-center justify-end gap-2">
              {selectedTab === 'chat' && onShowArchivedToggle ? (
                <GlassIconButton
                  label={labels.archiveToggleLabel ?? '归档'}
                  onClick={onShowArchivedToggle}
                  className={cn(showArchived && 'text-primary')}
                >
                  <Archive className="h-5 w-5 text-current" aria-hidden="true" strokeWidth={1.75} />
                </GlassIconButton>
              ) : null}

              {selectedTab === 'projects' && (onAddLocalProject || onAddGitHubRepository) ? (
                <GlassIconButton
                  label={labels.addProjectMenu ?? '添加项目'}
                  onClick={() => setAddMenuOpen(true)}
                >
                  <Plus className="h-5 w-5 text-current" aria-hidden="true" strokeWidth={1.75} />
                </GlassIconButton>
              ) : null}

              {onSettingsOpen ? (
                <GlassIconButton label={labels.settingsTab ?? '设置'} onClick={onSettingsOpen}>
                  <Settings
                    className="h-5 w-5 text-current"
                    aria-hidden="true"
                    strokeWidth={1.75}
                  />
                </GlassIconButton>
              ) : null}
            </div>

            {/* Connection / pull status — horizontal center of the chrome
               row. Mounted only after search has finished exiting so the
               two never share the band. pointer-events-none so it never
               steals taps from workspace / trailing discs. */}
            {statusRevealed ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <MobileConnectionStatus
                  className="min-w-0 max-w-[min(100%,12rem)]"
                  state={connectionUiState}
                  refreshing={isPullingRefresh}
                  pull={
                    onPullToRefresh && pullDistance > 0
                      ? {
                          active: true,
                          pastThreshold: pullPastThreshold,
                          label: pullPastThreshold
                            ? (labels.releaseToRefresh ?? '释放刷新')
                            : (labels.pullToRefresh ?? '下拉刷新'),
                        }
                      : undefined
                  }
                  labels={labels.connectionBanner}
                />
              </div>
            ) : null}
          </div>
        </header>

        <AddProjectActionSheet
          open={addMenuOpen}
          onOpenChange={setAddMenuOpen}
          onAddLocalProject={onAddLocalProject}
          onAddGitHubRepository={onAddGitHubRepository}
          labels={labels}
        />
        <PrivateResourceHelpSheet
          open={privateHelpOpen}
          onOpenChange={setPrivateHelpOpen}
          labels={labels}
        />

        {/* Pull-driven content region. Filter pills + list share one
           `translate3d` so they move as a single compositor layer.
           The header stays put: search does a fast top→bottom exit,
           then the centered status pill mounts. */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* The chat/projects group stays MOUNTED (but `hidden`) while
             the Tasks tab is active: unmounting would drop the list
             scroll element the pull-to-refresh + dock-collapse listeners
             are bound to, and would reset the chat list's scroll
             position on every Tasks round-trip. */}
          <div
            className={cn('flex min-h-0 flex-1 flex-col', tasksTabActive && 'hidden')}
            style={
              pullDistance > 0
                ? {
                    transform: `translate3d(0, ${pullDistance}px, 0)`,
                    willChange: 'transform',
                  }
                : undefined
            }
          >
            {/* Chat-tab filter pill bar — toggled from the first group
               heading's trailing chip. Stays ABOVE the list scroll region
               (pinned) and rides pull-to-refresh with the list. */}
            <AnimatePresence initial={false}>
              {selectedTab === 'chat' &&
              chatFiltersOpen &&
              chatFilterPills &&
              chatFilterPills.length > 0 ? (
                <motion.div
                  key="chat-filter-pills"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <MobileFilterPillBar pills={chatFilterPills} />
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div
              ref={listScrollRef}
              className={cn(
                'mobile-home-list-region scrollbar-pro relative min-h-0 flex-1 overflow-y-auto pt-1 [scrollbar-gutter:auto]',
                'pb-[calc(var(--mobile-tabbar-height)+var(--k-safe-area-bottom,0px)+1rem)]'
              )}
            >
              {selectedTab === 'inbox' ? (
                <InboxTabView
                  label={labels.inboxTab ?? 'Inbox'}
                  placeholder={labels.inboxPlaceholder}
                  loadingLabel={labels.inboxLoading ?? 'Loading…'}
                  dismissAriaLabel={labels.inboxDismissAriaLabel ?? 'Dismiss'}
                  emptySearchLabel={labels.emptySearch ?? 'No matching results'}
                  items={inboxItems ?? []}
                  loading={inboxLoading}
                  query={normalizedQuery}
                  onSelect={onInboxItemSelect}
                  onDismiss={onInboxItemDismiss}
                />
              ) : null}

              {selectedTab === 'projects' ? (
                <ProjectsTabView
                  localProjects={localProjects}
                  githubRepositories={githubRepositories}
                  recentProjectsMerged={recentProjectsMerged}
                  selectedSubTab={selectedProjectsSubTab}
                  onSubTabSelect={(sub) => onProjectsSubTabSelect?.(sub)}
                  machineLookup={machineLookup}
                  hasMachines={machines.length > 0}
                  labels={labels}
                  query={normalizedQuery}
                  onLocalProjectSelect={onLocalProjectSelect}
                  onGitHubRepositorySelect={onGitHubRepositorySelect}
                  onPrivateHelp={() => setPrivateHelpOpen(true)}
                  iosTheme={resolvedTheme === 'ios'}
                />
              ) : null}

              {selectedTab === 'chat' ? (
                showChatOnboarding ? (
                  <MobileHomeOnboarding
                    labels={labels.onboarding ?? {}}
                    onDownloadClient={onDownloadClient}
                  />
                ) : (
                  <ChatsFlatView
                    chats={chats}
                    groupBy={chatGroupBy}
                    labels={labels}
                    query={normalizedQuery}
                    onSelect={onChatSelect}
                    onTogglePin={onChatTogglePin}
                    onArchive={onChatArchive}
                    onRestore={onChatRestore}
                    archived={showArchived}
                    onPermanentDelete={showArchived ? onChatPermanentDelete : undefined}
                    hasActiveFilters={hasActiveChatFilters}
                    onClearFilters={onClearChatFilters}
                    firstGroupTrailing={
                      chatFilterPills && chatFilterPills.length > 0 ? (
                        <ChatListFilterToggle
                          open={chatFiltersOpen}
                          hasActiveFilters={hasActiveChatFilters}
                          ariaLabel={labels.filterBarToggleLabel ?? '过滤器'}
                          onToggle={() => setChatFiltersOpen((open) => !open)}
                        />
                      ) : undefined
                    }
                    onPrivateHelp={() => setPrivateHelpOpen(true)}
                  />
                )
              ) : null}
            </div>
          </div>

          {/* Tasks tab: the shared All Tasks body (inbox + list) fills the
             content region under the home header, dock still visible.
             `embedded` skips BaseHeader's safe-area / drawer menu so we
             don't double-stack chrome under the home header. The home
             search row stays hidden (it only filters chats/projects).
             Tapping a card routes to full-screen `/tasks/$taskId`. */}
          {tasksTabActive ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <Suspense fallback={null}>
                <TasksListBody mobile embedded />
              </Suspense>
            </div>
          ) : null}
        </div>

        {/* Shared workspace tabbar (chat / tasks / projects) + the
            optional separate new-chat chip. The 设置 surface is reached
            via the gear button in the top header, so it's no longer one
            of the bottom tabs. Tabs are built locally so the
            translations stay co-located with the other screen copy. */}
        <MobileWorkspaceTabBar<MobileHomeTab>
          tabs={workspaceTabSpecs(labels, showTasksTab, showInboxTab)}
          selectedTab={effectiveSelectedTab}
          onTabSelect={(tab) => onTabSelect?.(tab)}
          onNewChat={onNewChat}
          newChatAriaLabel={labels.newChatAriaLabel}
          ariaLabel={labels.chatTab ?? '导航'}
          theme={resolvedTheme}
          scrollContainerRef={listScrollRef}
        />
      </div>
    </div>
  );
}

/* ── Inbox tab ───────────────────────────────────────────────────────── */

function InboxTabView({
  label,
  placeholder,
  loadingLabel,
  dismissAriaLabel,
  emptySearchLabel,
  items,
  loading = false,
  query,
  onSelect,
  onDismiss,
}: {
  label: string;
  placeholder?: string;
  loadingLabel: string;
  dismissAriaLabel: string;
  emptySearchLabel: string;
  items: MobileInboxItem[];
  loading?: boolean;
  query: string;
  onSelect?: (itemId: string) => void;
  onDismiss?: (itemId: string) => void;
}) {
  const visibleItems = useMemo(() => {
    return filterMobileInboxItems(items, query);
  }, [items, query]);

  if (!loading && items.length === 0) {
    return (
      <section aria-label={label} className="flex flex-col">
        <TabEmptyState label={placeholder ?? 'No new notifications'} />
      </section>
    );
  }
  if (!loading && query && visibleItems.length === 0) {
    return (
      <section aria-label={label} className="flex flex-col">
        <TabEmptyState label={emptySearchLabel} />
      </section>
    );
  }
  return (
    <section aria-label={label} className="flex flex-col gap-2 px-4 py-3">
      {loading ? (
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">{loadingLabel}</div>
      ) : null}
      {visibleItems.map((item) => {
        const Icon =
          item.kind === 'sharing_review'
            ? LockKeyhole
            : item.kind === 'permission_requested'
              ? BellRing
              : CircleCheckBig;
        return (
          <article
            key={item.id}
            className="relative flex gap-3 rounded-2xl border border-border/60 bg-background px-3.5 py-3 shadow-xs"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-start gap-3 text-left active:opacity-70"
              onClick={() => onSelect?.(item.id)}
            >
              <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
                {item.unread ? (
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.9rem] font-semibold leading-snug text-foreground">
                  {item.title}
                </span>
                <span className="mt-0.5 block text-[0.78rem] leading-relaxed text-muted-foreground">
                  {item.description}
                </span>
                {item.actionLabel ? (
                  <span className="mt-2 block text-[0.78rem] font-medium text-primary">
                    {item.actionLabel}
                  </span>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-muted"
              onClick={() => onDismiss?.(item.id)}
              aria-label={dismissAriaLabel}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </article>
        );
      })}
    </section>
  );
}

/* ── Projects tab (Local + GitHub merged) ────────────────────────────── */

/* The Projects tab's top-level body. Owns the layout order:
   (1) unified recents strip, (2) sub-tab selector, (3) sub-tab body
   (Local or GitHub). The recents strip is rendered only when there are
   any recents AND the user isn't searching — search should focus the
   user on the filtered full list. */
function ProjectsTabView({
  localProjects,
  githubRepositories,
  recentProjectsMerged,
  selectedSubTab,
  onSubTabSelect,
  machineLookup,
  hasMachines,
  labels,
  query,
  onLocalProjectSelect,
  onGitHubRepositorySelect,
  onPrivateHelp,
  iosTheme,
}: {
  localProjects: MobileHomeLocalProject[];
  githubRepositories: MobileHomeGitHubRepository[];
  recentProjectsMerged: MobileHomeRecentProject[];
  selectedSubTab: MobileProjectsSubTab;
  onSubTabSelect: (sub: MobileProjectsSubTab) => void;
  machineLookup: Map<string, { name: string; isOnline: boolean }>;
  hasMachines: boolean;
  labels: MobileHomeScreenLabels;
  query: string;
  onLocalProjectSelect?: (projectId: string) => void;
  onGitHubRepositorySelect?: (fullName: string) => void;
  onPrivateHelp: () => void;
  iosTheme: boolean;
}) {
  const localLabel = labels.localTab ?? '本地';
  const githubLabel = labels.githubTab ?? 'GitHub';

  /* Unified recents — only rendered when there's anything to show
     AND the user isn't actively searching. Each item's `kind` drives
     the inline render branch (avatar source + caption format). */
  const recentStrip =
    !query && recentProjectsMerged.length > 0 ? (
      <RecentItemsRow
        items={recentProjectsMerged}
        heading={labels.recentProjectsHeading ?? '最近常用'}
        onSelect={(item) => {
          if (item.kind === 'local') onLocalProjectSelect?.(item.id);
          else onGitHubRepositorySelect?.(item.fullName);
        }}
        renderItem={(item) =>
          item.kind === 'local' ? (
            <>
              <MobileInitialLetterAvatar name={item.name} hashSeed={item.id} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.7rem] leading-tight text-muted-foreground">
                  {item.machineName ?? item.path}
                </div>
                <div className="truncate text-[0.85rem] font-semibold leading-tight">
                  {item.name}
                </div>
              </div>
            </>
          ) : (
            <>
              {item.avatarUrl ? (
                <CachedAvatarImg
                  src={item.avatarUrl}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                  loading="lazy"
                />
              ) : (
                <Github className="h-8 w-8 shrink-0" strokeWidth={1.6} aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.7rem] leading-tight text-muted-foreground">
                  {item.ownerHandle}
                </div>
                <div className="truncate text-[0.85rem] font-semibold leading-tight">
                  {item.name}
                </div>
              </div>
            </>
          )
        }
      />
    ) : null;

  return (
    <section aria-label={labels.projectsTab ?? '项目'} className="flex flex-col">
      {recentStrip}
      <ProjectsSubTabSelector
        active={selectedSubTab}
        localLabel={localLabel}
        githubLabel={githubLabel}
        onSelect={onSubTabSelect}
        iosTheme={iosTheme}
      />
      {selectedSubTab === 'local' ? (
        <LocalProjectsList
          projects={localProjects}
          machineLookup={machineLookup}
          hasMachines={hasMachines}
          labels={labels}
          query={query}
          onSelect={onLocalProjectSelect}
          onPrivateHelp={onPrivateHelp}
        />
      ) : (
        <GitHubReposList
          repositories={githubRepositories}
          labels={labels}
          query={query}
          onSelect={onGitHubRepositorySelect}
        />
      )}
    </section>
  );
}

/* ── Local projects (grouped by machine) ─────────────────────────────── */

/* Section heading for a machine group: status dot + machine name in
   normal case (machine names are proper nouns, so unlike `AllItemsHeading`
   it isn't uppercased). */
function MachineGroupHeading({
  machine,
  fallbackName,
  privateLabel,
  privateHelpAriaLabel,
  hasPrivateProject,
  onPrivateHelp,
}: {
  machine: { name: string; isOnline: boolean; isPrivate?: boolean } | null;
  fallbackName: string;
  privateLabel: string;
  privateHelpAriaLabel: string;
  hasPrivateProject: boolean;
  onPrivateHelp: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-5 pb-1 pt-3">
      <MachineStatusDot online={machine?.isOnline ?? false} />
      <span className="min-w-0 truncate text-[0.78rem] font-semibold tracking-tight text-foreground">
        {machine?.name ?? fallbackName}
      </span>
      {machine?.isPrivate || hasPrivateProject ? (
        <button
          type="button"
          onClick={onPrivateHelp}
          aria-label={privateHelpAriaLabel}
          className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full px-1.5 text-[0.68rem] font-medium text-muted-foreground active:bg-muted"
        >
          <LockKeyhole className="h-3 w-3" aria-hidden="true" />
          {machine?.isPrivate ? privateLabel : null}
          <CircleHelp className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function LocalProjectsList({
  projects,
  machineLookup,
  hasMachines,
  labels,
  query,
  onSelect,
  onPrivateHelp,
}: {
  projects: MobileHomeLocalProject[];
  machineLookup: Map<string, { name: string; isOnline: boolean; isPrivate?: boolean }>;
  hasMachines: boolean;
  labels: MobileHomeScreenLabels;
  query: string;
  onSelect?: (projectId: string) => void;
  onPrivateHelp: () => void;
}) {
  const visible = useMemo(() => {
    if (!query) return projects;
    return projects.filter(
      (project) =>
        normalizeForSearch(project.name).includes(query) ||
        normalizeForSearch(project.path).includes(query)
    );
  }, [projects, query]);

  /* Bucket the visible projects by machine. Group order follows the
     caller's already-sorted project list, so cross-machine project
     recency is not lost when section headings are inserted. */
  const groups = useMemo<Array<[string, MobileHomeLocalProject[]]>>(() => {
    const byMachine = new Map<string, MobileHomeLocalProject[]>();
    for (const project of visible) {
      const bucket = byMachine.get(project.machineId);
      if (bucket) bucket.push(project);
      else byMachine.set(project.machineId, [project]);
    }
    return Array.from(byMachine.entries());
  }, [visible]);

  if (projects.length === 0) {
    return (
      <TabEmptyState
        label={
          labels.emptyLocalProjects ??
          (hasMachines ? '当前 workspace 还没有本地项目' : '当前 workspace 没有可用机器')
        }
      />
    );
  }
  if (query && visible.length === 0) {
    return <TabEmptyState label={labels.emptySearch ?? '没有匹配的结果'} />;
  }

  return (
    <>
      {groups.map(([machineId, machineProjects]) => {
        const machine = machineLookup.get(machineId) ?? null;
        return (
          <Fragment key={machineId}>
            <MachineGroupHeading
              machine={machine}
              fallbackName={machineId}
              privateLabel={labels.privateLabel ?? 'Private'}
              privateHelpAriaLabel={labels.privateHelpAriaLabel ?? 'Learn about private resources'}
              hasPrivateProject={machineProjects.some((project) => project.isPrivate)}
              onPrivateHelp={onPrivateHelp}
            />
            <MobileHomeListShell>
              {machineProjects.map((project) => (
                <MobileHomeListRow
                  key={project.id}
                  ariaLabel={project.name}
                  onClick={project.removalState ? undefined : () => onSelect?.(project.id)}
                  disabled={Boolean(project.removalState)}
                  leading={
                    <MobileInitialLetterAvatar
                      name={project.name}
                      hashSeed={project.id}
                      size="lg"
                    />
                  }
                  title={project.name}
                  /* Full project name (wraps instead of truncating). The
                     machine now lives in the group heading, so the row
                     only carries the name + path. */
                  wrapTitle
                  titleSuffix={
                    project.removalState ? (
                      <span className="inline-flex min-w-0 items-center gap-1 text-[0.7rem] font-medium text-muted-foreground">
                        {project.removalState === 'waiting_for_device' ? (
                          <Clock3 className="h-3 w-3 shrink-0" aria-hidden="true" />
                        ) : (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                        )}
                        <span className="truncate">
                          {project.removalState === 'waiting_for_device'
                            ? (labels.projectRemovalWaiting ?? 'Waiting for device…')
                            : (labels.projectRemoving ?? 'Removing…')}
                        </span>
                      </span>
                    ) : project.isPrivate ? (
                      <LockKeyhole
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : undefined
                  }
                  secondaryLine={
                    project.path ? (
                      <span className="mt-0.5 block truncate text-[0.72rem] text-muted-foreground">
                        {project.path}
                      </span>
                    ) : undefined
                  }
                  trailing={
                    project.removalState ? undefined : (
                      <RowTrailingMeta
                        latestMessageAt={project.latestMessageAt}
                        unreadCount={project.unreadCount}
                      />
                    )
                  }
                />
              ))}
            </MobileHomeListShell>
          </Fragment>
        );
      })}
    </>
  );
}

/* ── GitHub repos (flat list, newest first) ──────────────────────────── */

function GitHubReposList({
  repositories,
  labels,
  query,
  onSelect,
}: {
  repositories: MobileHomeGitHubRepository[];
  labels: MobileHomeScreenLabels;
  query: string;
  onSelect?: (repoFullName: string) => void;
}) {
  const visible = useMemo(() => {
    if (!query) return repositories;
    return repositories.filter(
      (repo) =>
        normalizeForSearch(repo.fullName).includes(query) ||
        normalizeForSearch(repo.name).includes(query) ||
        normalizeForSearch(repo.ownerHandle).includes(query) ||
        (repo.description ? normalizeForSearch(repo.description).includes(query) : false)
    );
  }, [repositories, query]);

  if (repositories.length === 0) {
    return (
      <TabEmptyState
        label={labels.emptyGitHubProjects ?? '当前 workspace 没有已授权的 GitHub 仓库'}
      />
    );
  }
  if (query && visible.length === 0) {
    return <TabEmptyState label={labels.emptySearch ?? '没有匹配的结果'} />;
  }

  return (
    <>
      <AllItemsHeading>{labels.allGitHubReposHeading ?? '全部仓库'}</AllItemsHeading>
      <MobileHomeListShell>
        {visible.map((repository) => (
          <MobileHomeListRow
            key={repository.id}
            ariaLabel={repository.fullName}
            onClick={() => onSelect?.(repository.fullName)}
            leading={
              <GhOwnerAvatar url={repository.ownerAvatarUrl} handle={repository.ownerHandle} />
            }
            title={repository.fullName}
            trailing={
              <RowTrailingMeta
                latestMessageAt={repository.latestMessageAt}
                unreadCount={repository.unreadCount}
              />
            }
          />
        ))}
      </MobileHomeListShell>
    </>
  );
}

/* ── Chats (flat list, newest first) ─────────────────────────────────── */

/* The filter pill bar is rendered ABOVE the scroll region by
   `MobileHomeScreen` itself, so this view doesn't carry it anymore
   — keeping the pill bar outside the scroll container is what
   contains the vertical scrollbar to the list area only. */
function ChatsFlatView({
  chats,
  groupBy,
  labels,
  query,
  onSelect,
  onTogglePin,
  onArchive,
  onRestore,
  archived,
  onPermanentDelete,
  hasActiveFilters = false,
  onClearFilters,
  firstGroupTrailing,
  onPrivateHelp,
}: {
  chats: MobileConversationItem[];
  groupBy: MobileChatGroupBy;
  labels: MobileHomeScreenLabels;
  query: string;
  onSelect?: (chatId: string) => void;
  onTogglePin?: (chatId: string, nextPinned: boolean) => void;
  onArchive?: (chatId: string) => void;
  onRestore?: (chatId: string) => void;
  archived?: boolean;
  onPermanentDelete?: (chatIds: string[]) => void | Promise<void>;
  /** True when active filters narrowed the list — switches the empty
     state to the "filters hid everything" copy + Clear filters button. */
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
  /** Filter chip mounted on the first group heading (or a trailing-only
     row when the list is empty / flat with no heading). */
  firstGroupTrailing?: ReactNode;
  onPrivateHelp: () => void;
}) {
  const visible = useMemo(() => {
    if (!query) return chats;
    return chats.filter(
      (chat) =>
        normalizeForSearch(chat.title).includes(query) ||
        normalizeForSearch(chat.branchName).includes(query)
    );
  }, [chats, query]);

  /* Shared "Clear filters" action for the empty states below. Only
     offered when filters are active and a handler is wired. */
  const clearFiltersAction =
    hasActiveFilters && onClearFilters ? (
      <TabEmptyStateButton onClick={onClearFilters}>
        {labels.clearChatFilters ?? '清除所有过滤'}
      </TabEmptyStateButton>
    ) : undefined;

  /* Empty states still need the filter chip so the user can open the
     bar / clear filters without a group heading to host it. */
  const emptyTrailing =
    firstGroupTrailing != null ? (
      <div className="flex w-full items-center justify-end px-4 pb-1.5 pt-2">
        {firstGroupTrailing}
      </div>
    ) : null;

  if (chats.length === 0) {
    /* `chats` is already filtered by the caller, so an empty list with
       active filters means the filters hid everything (vs. a workspace
       with no conversations at all). */
    return (
      <section aria-label={labels.chatTab ?? 'Chat'} className="flex flex-col">
        {emptyTrailing}
        <TabEmptyState
          label={
            hasActiveFilters
              ? (labels.emptyFilteredChats ?? '当前过滤条件下没有对话')
              : (labels.emptyChats ?? '当前 workspace 还没有对话')
          }
          action={clearFiltersAction}
        />
      </section>
    );
  }
  if (query && visible.length === 0) {
    return (
      <section aria-label={labels.chatTab ?? 'Chat'} className="flex flex-col">
        {emptyTrailing}
        <TabEmptyState label={labels.emptySearch ?? '没有匹配的结果'} action={clearFiltersAction} />
      </section>
    );
  }

  return (
    /* The chat tab aggregates EVERY conversation (chat-only,
       local-project, github-repo) into one newest-first list. The
       list body is rendered by `MobileChatList` (shared with the
       in-project detail page) so design tweaks land in one place. */
    <section aria-label={labels.chatTab ?? 'Chat'} className="flex flex-col">
      <MobileChatList
        chats={visible}
        groupBy={groupBy}
        groupLabels={labels.chatGroupLabels}
        /* Home aggregates every project and worktree into one scroll, so each
           bucket previews its latest rows and offers the rest. Without it a
           single busy project owns the screen — the whole reason the cap
           exists. The in-project list deliberately does not pass this. */
        capGroupPreviews
        /* Active list is flat — no "全部对话" section label. Only the
           archived surface keeps a heading so the mode is obvious. */
        flatHeading={archived ? (labels.archivedChatsHeading ?? '归档对话') : undefined}
        firstGroupTrailing={firstGroupTrailing}
        onSelect={onSelect}
        rowActions={{ onTogglePin, onArchive, onRestore }}
        archived={archived}
        onPermanentDelete={onPermanentDelete}
        selectionLabels={labels.archiveSelection}
        privateLabel={labels.privateLabel}
        privateHelpAriaLabel={labels.privateHelpAriaLabel}
        onPrivateHelp={onPrivateHelp}
      />
    </section>
  );
}

/* Minimal first-run hint shown on the Chat tab of an empty workspace (no
   machines + no conversations). The mobile app is a thin client over a
   desktop/CLI host, so a brand-new user just needs a short nudge to go
   install + start the desktop client — one icon, one line, one button.
   Rendered inline (not a blocking modal) so the user can still switch
   workspaces / open settings underneath it. Pure presentational — copy via
   `labels`, action via `onDownloadClient` — so i18n + Storybook live in the
   caller. */
function MobileHomeOnboarding({
  labels,
  onDownloadClient,
}: {
  labels: MobileHomeOnboardingLabels;
  onDownloadClient?: () => void;
}) {
  return (
    <div className="px-5 pt-10">
      {/* Wide enough that the one-line sub-copy doesn't wrap on a phone
         (the title + button are short and stay centered regardless). */}
      <div className="mx-auto flex max-w-xs flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <MonitorSmartphone className="h-6 w-6" strokeWidth={1.6} aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <p className="text-[0.95rem] font-medium text-foreground">
            {labels.title ?? '在电脑上启动 Lody'}
          </p>
          {labels.description ? (
            <p className="text-[0.8rem] leading-relaxed text-muted-foreground">
              {labels.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onDownloadClient?.()}
          className={cn(
            'inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2',
            'text-[0.85rem] font-medium text-primary-foreground',
            'transition-transform active:scale-[0.98]'
          )}
        >
          <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          {labels.downloadButton ?? '下载客户端'}
        </button>
      </div>
    </div>
  );
}

function TabEmptyState({ label, action }: { label: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-3 mt-3 rounded-2xl border border-border/40 bg-card px-4 py-6 text-center text-sm text-muted-foreground">
      <div>{label}</div>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

/* Pill button shown inside an empty state (e.g. "Clear filters"). Quiet
   secondary styling so it reads as a recovery action, not a primary CTA. */
function TabEmptyStateButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background px-3.5 py-1.5',
        'text-[0.8rem] font-medium text-foreground transition-colors',
        'active:bg-muted/60 hover:bg-muted/40'
      )}
    >
      <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      {children}
    </button>
  );
}
