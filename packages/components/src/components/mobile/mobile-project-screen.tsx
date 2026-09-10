import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  File as FileIcon,
  Github,
  Hand,
  Loader2,
  MessageCircle,
  Pin,
  Search,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { MdChat, MdSettings } from 'react-icons/md';
import { FaRegFileCode } from 'react-icons/fa';
import type { IconType } from 'react-icons';
import type { SessionPullRequestCiState, SessionPullRequestReadiness } from '@lody/shared';
import { isNativeAppShell } from '@/lib/native-platform';
import { consumeMobileBackNavigation } from '@/lib/mobile-back-navigation';
import { cn } from '@/lib/utils';
import { useLongPress } from '@/hooks/use-long-press';
import { Checkbox } from '@lody/ui/checkbox';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import {
  SessionMergeablePill,
  SessionPrIcon,
  SessionRowAuthorAvatar,
  type SessionRowOpenedByTreeSlot,
} from '@/components/sidebar-row-shared';
import { CarbonSettingsAdjust } from '@/components/icons/carbon-settings-adjust';
import { MobileEdgeBackSwipeZone } from './mobile-edge-back-swipe';
import { MobileFilterPillBar, type FilterPill } from './mobile-filter-pill-bar';
import {
  MobileChatList,
  type MobileChatGroupBy,
  type MobileChatListSelectionLabels,
} from './mobile-chat-list';
import { MobileInitialLetterAvatar } from './mobile-initial-letter-avatar';
import {
  MobileWorkspaceTabBar,
  type MobileBottomTabBarTabSpec,
  type MobileWorkspaceTabBarScrollSignal,
} from './mobile-workspace-tabbar';

function MobileReactIcon({ icon: Icon, className }: { icon: IconType; className?: string }) {
  /* Fill the sized wrapper — not size="1em" (inherits the tab label's 0.72rem). */
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center [&_svg]:h-full [&_svg]:w-full', className)}
      aria-hidden="true"
    >
      <Icon />
    </span>
  );
}

/* --------------------------------------------------------------------------
 * Data types — kept aligned with desktop SessionList's SessionListRow where they
 * overlap so chat-landing can feed the same metas in. The mobile row is a
 * cut-down view, not a re-skin, so it owns its own type rather than
 * importing SessionListRow wholesale.
 * ----------------------------------------------------------------------- */

export type MobileProjectKind = 'local' | 'github';

export type MobileProjectContext =
  | {
      kind: 'local';
      machineId: string;
      projectId: string;
      /** Display name (e.g. "lody"). */
      name: string;
      /** Optional path shown alongside the project name. */
      path?: string;
    }
  | {
      kind: 'github';
      /** "owner/repo" (used as the row key + URL slug). */
      fullName: string;
      /** GitHub-side display name (typically the repo name without owner). */
      name: string;
      /** GitHub org / user the repo belongs to. */
      ownerHandle: string;
      /** Optional avatar (org / user). Falls back to the GitHub octocat. */
      avatarUrl?: string | null;
    };

export type MobilePrStatus = 'open' | 'merged' | 'closed' | 'draft';

export type MobileConversationKind = 'chat' | 'local' | 'github';

export type MobileConversationItem = {
  id: string;
  title: string;
  /** Which "container" the conversation belongs to — drives the home
     Chat tab's by-type grouping and the conversation-type filter pill.
     Optional for back-compat with callers that don't need it. */
  kind?: MobileConversationKind | null;
  branchName?: string | null;
  prNumber?: number | null;
  prStatus?: MobilePrStatus | null;
  /** Associated PR url. Presence is what decides the row's PR icon (a PR can
     sync before its status does), mirroring the desktop sidebar's `showPr`. */
  prUrl?: string | null;
  /** Rollup CI verdict of the PR head commit, synced by the CLI PR poller.
     Rendered as the badge cut into the PR glyph (see `SessionPrIcon`). */
  prCiState?: SessionPullRequestCiState | null;
  /** Merge readiness derived from the poller's CI + merge-state codes. `y`
     swaps the row's line diff for the `Mergeable` pill (see `SessionMergeablePill`). */
  prReadiness?: SessionPullRequestReadiness | null;
  addedLines?: number;
  deletedLines?: number;
  /** Numeric timestamp used for sorting; the caller MAY pre-format `ageLabel`. */
  latestMessageAt?: number | null;
  ageLabel?: string;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  isOffline?: boolean;
  hasUnreadMessages?: boolean;
  isPinned?: boolean;
  /** Machine id the conversation lives on. Powers the machine filter. */
  machineId?: string | null;
  /** PRECISE Session that created this one — `lody session create` with a
     session in scope, which is how the `lody_session_create` MCP tool spawns
     independent work. Presentation-only provenance; deliberately NOT
     `parentSessionId`. See `lib/session-opened-by-tree.ts`. */
  openedBySessionId?: string | null;
  /** The list ROW to nest under. Differs from `openedBySessionId` when the
     opener is a child Tab, which has no row of its own — the caller walks
     `parentSessionId` up to the root via `buildSidebarOpenerRowResolver`. */
  openedByRowSessionId?: string | null;
  /** Stable id for the project the conversation belongs to:
     `machineId:localProjectId` for local sessions, `owner/repo` for
     GitHub sessions. `null` for chat-only sessions with no project.
     Powers the project filter pill AND the "Group: Project" bucket
     mode — same field for both so the filter selection and the
     bucket key never drift apart. */
  projectKey?: string | null;
  /** Human-readable label for the project bucket (e.g. project name
     or `owner/repo`). Only set when `projectKey` is also set;
     consumed by the chat list's group heading. */
  projectLabel?: string | null;
  /** Effective privacy of a local project bucket in a team workspace. */
  isPrivateProject?: boolean;
  /** Owner avatar URL for GitHub-bound sessions (see
     `getGitHubOwnerAvatarUrl`). Used as the row's leading identity
     icon and by project-bucket headings in "Group: Project". Local
     sessions leave this undefined. */
  projectAvatarUrl?: string | null;
  /** True when the session runs in an isolated git worktree. Drives the
     leading Worktree leaf icon for local sessions (GitHub rows keep the
     owner avatar instead — they are effectively always worktrees). */
  isWorktree?: boolean;
  /** Creator of the conversation. Populated only when the caller is
     showing team-scope sessions; in `my` scope the row hides the
     avatar slot entirely. Shape matches `<UserAvatar>`'s user prop
     so the row can pass it through directly. */
  owner?: {
    id?: string | null;
    name?: string | null;
    image?: string | null;
  } | null;
};

export type MobileProjectMachine = {
  id: string;
  name: string;
  isOnline: boolean;
};

export type MobileProjectTab = 'chat' | 'files' | 'settings';

export type MobileProjectScreenLabels = {
  backAriaLabel?: string;
  /** Aria for the always-visible search field at the top of the header. */
  searchAriaLabel?: string;
  /** Aria + tooltip for the archive-toggle chip in the header. */
  archiveToggleLabel?: string;
  /** Aria for the filter chip on the first group heading. */
  filterBarToggleLabel?: string;
  /** Copy for the multi-select toolbar + delete confirmation shown
     when the user long-presses a row in the archive view. */
  archiveSelection?: MobileChatListSelectionLabels;
  /** Placeholder shown inside the header search input. */
  searchPlaceholder?: string;
  /** Aria label for the X chip that clears the search query. */
  clearSearchAriaLabel?: string;
  /** @deprecated Chat list no longer shows a section heading in the
     active (non-archived) mode. Kept for call-site compatibility. */
  allConversationsHeading?: string;
  /** Heading rendered above the project list when the archive toggle
     is on. Falls back to "归档对话" when omitted. */
  archivedConversationsHeading?: string;
  /** Empty-state copy when nothing matches the active filters. */
  emptyConversations?: string;
  /** Bottom-tabbar tab labels. */
  chatTab?: string;
  filesTab?: string;
  settingsTab?: string;
  newChatAriaLabel?: string;
  /** Copy for the Settings tab placeholder empty state. */
  settingsTabPlaceholderTitle?: string;
  settingsTabPlaceholderBody?: string;
};

export type MobileProjectFilesTabContentProps = {
  readonly onScrollActivity: (scrollTop: number) => void;
  readonly bottomTabBarVisible: boolean;
};

export type MobileProjectScreenProps = {
  project: MobileProjectContext;
  /** Already filtered + sorted by the caller (newest first), in the
     same shape the home Chat tab uses. */
  conversations: MobileConversationItem[];
  /** Optional pill bar rendered above the list. Each consumer
     (local-project vs github-repo) trims this to the filters that
     make sense for the surface. */
  filterPills?: ReadonlyArray<FilterPill>;
  /** View grouping. Defaults to `none` (flat list); other values
     bucket the same items into named sections. Headings come from
     `labels.chatGroupLabels` via `MobileChatList`. */
  chatGroupBy?: MobileChatGroupBy;
  /** Per-bucket headings keyed by `MobileChatList`'s bucket ids. */
  chatGroupLabels?: Partial<Record<string, string>>;
  selectedConversationId?: string | null;
  labels?: MobileProjectScreenLabels;
  /** Optional content rendered inside the project's Settings tab. When
     omitted, the tab shows the existing "coming soon" placeholder.
     Production caller (chat-landing) passes
     `<MobileLocalProjectSettings ... />` for local projects so the
     per-project share + history-import controls live alongside the
     conversation list, not in a separate workspace-wide
     `/settings/projects` page. */
  settingsTabContent?: ReactNode;
  /** Content rendered inside the project's Files tab. */
  filesTabContent: ReactNode | ((props: MobileProjectFilesTabContentProps) => ReactNode);
  onBack: () => void;
  onConversationSelect?: (conversationId: string) => void;
  /** Pin / archive callbacks for the swipe-to-reveal drawer on each
     conversation row (active list). */
  onConversationTogglePin?: (conversationId: string, nextPinned: boolean) => void;
  onConversationArchive?: (conversationId: string) => void;
  /** Restore (un-archive) callback for the swipe drawer shown on each
     row of the *archived* list. */
  onConversationRestore?: (conversationId: string) => void;
  /** Hands a batch of conversation ids to the parent for *permanent*
     deletion. Only invoked from the multi-select toolbar shown in the
     archive view's selection mode. */
  onConversationPermanentDelete?: (chatIds: string[]) => void | Promise<void>;
  /** When provided, the bottom tabbar's new-chat chip is rendered;
     tap fires this callback (typically opens the new-chat sheet in
     the same project context). Omit to hide the chip. */
  onNewChat?: () => void;
  /** When true, the chat list renders the *archived* conversations and
     the shell tints to `bg-muted` so the whole surface reads as "you
     are looking at archived items". The caller still owns the data —
     it hands over the archived list via `conversations` when this is
     true and the active list when it's false. */
  showArchived?: boolean;
  /** Fires when the user taps the archive chip in the header. Renders
     the chip when both this and `onConversationSelect` are wired. */
  onShowArchivedToggle?: () => void;
  /** File-browser breadcrumb segments (relative to the project root) for
     the Files tab's shared header. Empty at the root. */
  fileNavSegments?: string[];
  /** Pop one file-browser level. Wired to the shared header's back chip
     when the Files tab is drilled into a folder/file. */
  onFileNavBack?: () => void;
};

/* --------------------------------------------------------------------------
 * Status indicator — priority matches desktop `TaskIndicator`:
 *
 *   waiting-permission  →  <Hand>  text-status-warning
 *   working             →  <Loader2 animate-spin>  text-primary
 *   unread              →  small primary dot (not a large filled disc)
 *   idle                →  null (slot stays reserved for title alignment)
 * ----------------------------------------------------------------------- */
function StatusIndicator({
  isWorking,
  isWaitingPermission,
  hasUnreadMessages,
}: {
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  hasUnreadMessages?: boolean;
}): ReactNode {
  if (isWaitingPermission) {
    return (
      <Hand className="h-4 w-4 shrink-0 text-status-warning" aria-label="waiting permission" />
    );
  }
  if (isWorking) {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-label="running" />;
  }
  if (hasUnreadMessages) {
    return (
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />
    );
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Opened-by tree (`lib/session-opened-by-tree.ts`) — mobile geometry.
 *
 * The leading slot owns ONE node, exactly like the desktop sidebar row: it
 * shows the fold chevron on an opener, ├/└ on an opened Session, or the status
 * indicator — never two of them. Status wins, on both sides of the
 * relationship: "this session needs you" beats "this session has children".
 *
 * That single node is why a top-level row keeps its exact flat geometry — the
 * slot is the same 16px status slot it always was. Only an opened Session
 * widens it (16px → 32px, left-aligned so the node stays at the same x),
 * producing a 16px content indent without moving the node or the background.
 * ----------------------------------------------------------------------- */
/** Widened leading slot for an opened Session: the indent, and nothing else. */
const TREE_CHILD_SLOT_CLASS = 'w-8 justify-start';
/** Node centre — `ps-4` + half of the 16px slot. Shared by chevron/lines/status. */
const TREE_NODE_START_CLASS = 'start-[23px]';
/** 23px node → 44px, i.e. 4px shy of the child's 48px content start. */
const TREE_ELBOW_WIDTH_CLASS = 'w-[21px]';
const TREE_LINE_CLASS = 'bg-muted-foreground/30';

function ConversationRowTreeConnector({ isLastChild }: { isLastChild: boolean }) {
  return (
    /* Anchored to the ROW, not the slot, so the trunk can run the row's full
       height and meet its neighbours with no seam. */
    <span
      aria-hidden="true"
      data-conversation-tree-connector=""
      className="pointer-events-none absolute inset-0"
    >
      <span
        className={cn(
          'absolute top-0 w-px',
          TREE_NODE_START_CLASS,
          TREE_LINE_CLASS,
          /* Last child stops at the elbow so the trunk does not dangle past
             the group; every other child carries it into the next row. */
          isLastChild ? 'h-1/2' : 'bottom-0'
        )}
      />
      <span
        className={cn(
          'absolute top-1/2 h-px',
          TREE_NODE_START_CLASS,
          TREE_ELBOW_WIDTH_CLASS,
          TREE_LINE_CLASS
        )}
      />
    </span>
  );
}

/**
 * The opener's fold control. A SIBLING of the row button, never a child of it —
 * a phone row is one big `<button>`, and nesting an interactive control inside
 * a button is invalid and unreachable to assistive tech.
 *
 * It sits ON the leading node, so it renders only while that node is free
 * (see `conversationRowHasActivity`). `z-30` clears the project screen's
 * `EDGE_ZONE_PX` back-swipe strip at `zIndex={20}`, which would otherwise
 * swallow every tap in the leading 48px — the same reason the composer carries
 * `protectFromEdgeBackZone`.
 */
function ConversationRowTreeToggle({
  expanded,
  label,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-conversation-tree-toggle=""
      aria-label={label}
      aria-expanded={expanded}
      onClick={(event) => {
        /* The row button is a sibling, so this never bubbles into it — but the
           swipe wrapper listens on an ancestor, and a drag that began here
           should not also read as a tap on the row. */
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        /* 28x36 hit box centred on the node — comfortably past the 24px
           minimum, and it only overlaps the row's own padding + status slot. */
        'absolute top-1/2 z-30 flex h-9 w-7 -translate-y-1/2 items-center justify-center',
        'start-[9px] rounded-md text-muted-foreground active:bg-muted/60'
      )}
    >
      <ChevronDown
        className={cn(
          'h-4 w-4 transition-transform duration-150 ease-out',
          expanded ? 'rotate-0' : '-rotate-90'
        )}
        aria-hidden="true"
      />
    </button>
  );
}

/**
 * Whether the row's leading node is already claimed by a status mark. Exported
 * because the list needs the same answer to decide whether the row carries a
 * tap target in the back-swipe strip (`liftAboveEdgeSwipeZone`), and the two
 * must not drift apart.
 */
export function conversationRowHasActivity(conversation: MobileConversationItem): boolean {
  return Boolean(
    conversation.isWaitingPermission || conversation.isWorking || conversation.hasUnreadMessages
  );
}

/* --------------------------------------------------------------------------
 * Conversation row — Linear-inspired single line:
 *   [status circle] [team owner?] [pin?] title .............. [+/-] [worktree] [PR]
 * Always-on leading status, comfortable row height, medium title weight.
 * Age / branch / project meta omitted. `secondaryField` kept for callers.
 *
 * The trailing metric cluster keeps the desktop sidebar's order and glyphs
 * (`sidebar-row-shared.tsx`): line diff, then the worktree marker, then the PR
 * status icon owning the right edge. It is the same `SessionPrIcon` component,
 * so PR status tone + the CI verdict badge cut into it stay identical across
 * platforms. A ready PR replaces the diff numbers with `SessionMergeablePill`
 * in that same slot, on the same gates the sidebar uses.
 * ----------------------------------------------------------------------- */
export function ConversationRow({
  conversation,
  selected,
  onClick,
  archived = false,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
  onLongPress,
  treeSlot,
  secondaryField: _secondaryField = 'branch',
}: {
  conversation: MobileConversationItem;
  selected: boolean;
  onClick?: () => void;
  /** When true, the row is being rendered inside the archive view —
     the title text dims to `text-muted-foreground` so the list as a
     whole reads as "you're looking at archived items". Status
     indicators and change counts stay at full opacity. */
  archived?: boolean;
  /** When true, the parent list is in multi-select mode: the row
     renders a leading checkbox, tap toggles `isSelected` instead of
     firing `onClick`, and long-press is a no-op (we're already in
     the mode it would have entered). */
  selectionMode?: boolean;
  /** Drawn state of the leading checkbox while in selection mode. */
  isSelected?: boolean;
  /** Tap handler while in selection mode — caller flips this row's
     entry in the selected-ids set. */
  onToggleSelect?: () => void;
  /** Press-and-hold handler — enters multi-select mode and selects
     this row. Caller is expected to start the mode + pre-select this
     id in one go (matches iOS Mail edit-mode entry). */
  onLongPress?: () => void;
  /** This row's place in the opened-by tree (`lib/session-opened-by-tree.ts`):
     an opener with a fold control, an opened Session with a ├/└ connector, or
     undefined for a plain top-level row. Built by the caller with the shared
     `buildSessionRowOpenedByTreeSlot` so the labels match the desktop sidebar. */
  treeSlot?: SessionRowOpenedByTreeSlot;
  /** @deprecated Second-line branch/project meta is no longer shown.
     Kept so existing callers (home Chat tab, project page, list
     grouping) do not need a simultaneous API change. */
  secondaryField?: 'branch' | 'project';
}) {
  void _secondaryField;
  const treeChild = treeSlot?.kind === 'child' ? treeSlot : null;
  /* One node, one meaning. An active row shows its status and drops both the
     fold chevron and the ├/└ — same rule the desktop sidebar row applies. */
  const hasActivity = conversationRowHasActivity(conversation);
  const treeOpener = treeSlot?.kind === 'opener' && !hasActivity ? treeSlot : null;
  const showChildConnectors = treeChild !== null && !hasActivity;
  const hasChanges =
    typeof conversation.addedLines === 'number' &&
    typeof conversation.deletedLines === 'number' &&
    (conversation.addedLines > 0 || conversation.deletedLines > 0);
  /* Same gate as the desktop sidebar row: a row carrying a PR shows its
     status. `prUrl` is the primary signal (status can still be syncing);
     a bare number covers callers that only carry the compact fields. */
  const showPr =
    Boolean(conversation.prUrl?.trim()) ||
    (typeof conversation.prNumber === 'number' && conversation.prNumber > 0);
  const prStatus = conversation.prStatus ?? 'open';
  /* Readiness can linger on a terminal PR (the webhook fan-out flips status to
     merged but cannot clear the poller's record), so gate the pill on the PR
     still being live — same reasoning as the desktop sidebar row. */
  const isMergeable =
    showPr && conversation.prReadiness === 'y' && prStatus !== 'merged' && prStatus !== 'closed';
  /* The pill takes the line diff's slot: once a PR is ready, "it can merge" is
     the more useful fact than how many lines changed. Hidden on the open
     conversation, whose own info bar owns the merge control. */
  const showMergeablePill = isMergeable && !selected;

  /* Long-press only arms outside selection mode — once we're in it,
     a press should toggle the row's checkbox, not re-enter the mode.
     The hook is a no-op when `enabled` is false so the row stays a
     plain button. */
  const { handlers: longPressHandlers, shouldSwallowClick } = useLongPress({
    onLongPress,
    enabled: Boolean(onLongPress) && !selectionMode,
  });

  const rowButton = (
    <button
      type="button"
      onClick={(event) => {
        if (shouldSwallowClick()) {
          /* Long-press already fired during this gesture — the
             implicit tap that follows pointer-up would otherwise
             trigger the regular click handler. */
          event.preventDefault();
          return;
        }
        if (selectionMode) {
          onToggleSelect?.();
          return;
        }
        onClick?.();
      }}
      aria-pressed={selectionMode ? isSelected : selected}
      {...longPressHandlers}
      className={cn(
        /* Linear issue-row cadence: ~44px min height, full-bleed press
           wash, fixed leading status so every title shares one x. */
        'mobile-project-conversation-row relative flex min-h-11 w-full items-center gap-2.5 border-0 px-4 py-2.5 text-left shadow-none outline-none transition-colors',
        /* Solid canvas (not transparent) so nothing under the row can
           read as a divider hairline between list items. */
        selected && !selectionMode
          ? 'bg-muted/50'
          : 'bg-background active:bg-muted/40',
        selectionMode && isSelected && 'bg-primary/10'
      )}
    >
      {showChildConnectors ? (
        <ConversationRowTreeConnector isLastChild={treeChild.isLastChild} />
      ) : null}
      {/* The one leading node. An opened Session widens it (left-aligned, so
          the node itself does not move) to indent everything after it. */}
      <div
        data-conversation-row-leading-slot=""
        className={cn(
          'flex h-4 shrink-0 items-center',
          treeChild ? TREE_CHILD_SLOT_CLASS : 'w-4 justify-center'
        )}
      >
        {selectionMode ? (
          <Checkbox
            checked={isSelected}
            tabIndex={-1}
            className="pointer-events-none"
            aria-hidden="true"
          />
        ) : (
          <StatusIndicator
            isWorking={conversation.isWorking}
            isWaitingPermission={conversation.isWaitingPermission}
            hasUnreadMessages={conversation.hasUnreadMessages}
          />
        )}
      </div>
      <SessionRowAuthorAvatar author={conversation.owner} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {conversation.isPinned ? (
          /* h-4 matches ~15px title optically (glyph fills less than
             the box, so h-3 read as much smaller than the type). */
          <Pin aria-label="pinned" className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        ) : null}
        <span
          className={cn(
            /* Linear titles: ~15px medium, comfortable line-height. */
            'min-w-0 flex-1 truncate text-[15px] font-medium leading-snug tracking-[-0.01em] text-foreground',
            archived && 'text-muted-foreground'
          )}
        >
          {conversation.title}
        </span>
      </div>
      {showMergeablePill ? (
        <SessionMergeablePill />
      ) : hasChanges && !isMergeable ? (
        <span className="shrink-0 text-[11px] tabular-nums leading-none tracking-tight">
          <span className="text-github-addition">+{conversation.addedLines}</span>
          <span className="ms-1 text-github-deletion">-{conversation.deletedLines}</span>
        </span>
      ) : null}
      {conversation.isWorktree ? (
        <WorktreeIcon
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55"
          aria-label="Worktree"
        />
      ) : null}
      {showPr ? <SessionPrIcon prStatus={prStatus} prCiState={conversation.prCiState} /> : null}
    </button>
  );

  /* Only a visible chevron needs the positioning wrapper that lets it sit
     BESIDE the row button instead of inside it. Every other row — including an
     active opener, whose node is showing status — returns the bare button, so
     the flat DOM is unchanged for them. */
  if (!treeOpener) return rowButton;
  return (
    <div className="relative">
      {rowButton}
      <ConversationRowTreeToggle
        expanded={treeOpener.expanded}
        label={treeOpener.label}
        onToggle={treeOpener.onToggle}
      />
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Project / repo detail screen — a focused single-purpose surface:
 *
 *   [back chevron]   [avatar] owner/repo or projectName
 *   [filter pills, scrolled-horizontal, drop the irrelevant ones]
 *   [grouped or flat conversation list, identical chrome to the home Chat tab]
 *
 * Everything else that used to live here (filter popover, scope popover,
 * three-tab dock with placeholder tabs) is gone — the home
 * Chat tab's filter pills + view-mode pill cover that ground, and the
 * placeholder tabs were not implemented. Edge-swipe-back is preserved.
 * ----------------------------------------------------------------------- */

const PROJECT_TRANSITION = { duration: 0.28, ease: [0.32, 0.72, 0, 1] as const };

export function MobileProjectScreen({
  project,
  conversations,
  filterPills,
  chatGroupBy = 'none',
  chatGroupLabels,
  selectedConversationId = null,
  labels = {},
  onBack,
  onConversationSelect,
  onConversationTogglePin,
  onConversationArchive,
  onConversationRestore,
  onConversationPermanentDelete,
  onNewChat,
  showArchived = false,
  onShowArchivedToggle,
  fileNavSegments,
  onFileNavBack,
  filesTabContent,
  settingsTabContent,
}: MobileProjectScreenProps) {
  /* Tab state is screen-local: switching tabs is purely a view
     concern (no URL change, no chat-landing state mutation). */
  const [selectedProjectTab, setSelectedProjectTab] = useState<MobileProjectTab>('chat');
  /* Scroll container handed to `MobileWorkspaceTabBar` so the dock
     collapses while the user scrolls. */
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [filesScrollSignal, setFilesScrollSignal] =
    useState<MobileWorkspaceTabBarScrollSignal | null>(null);
  const handleFilesScrollActivity = useCallback((scrollTop: number) => {
    setFilesScrollSignal((previous) => ({
      scrollTop,
      seq: (previous?.seq ?? 0) + 1,
    }));
  }, []);
  useEffect(() => {
    if (selectedProjectTab !== 'files') {
      setFilesScrollSignal(null);
    }
  }, [selectedProjectTab]);
  /* `owner/repo` for github reads more anchored than just the repo
     short name (matches the home GitHub-tab row title). For local we
     use the project's display name as-is. */
  const displayName = project.kind === 'github' ? project.fullName : project.name;
  const filesTabAtRoot = (fileNavSegments?.length ?? 0) === 0;
  const filesTabNested = selectedProjectTab === 'files' && !filesTabAtRoot;
  const showProjectTabBar = selectedProjectTab !== 'files' || filesTabAtRoot;
  const renderedFilesTabContent =
    typeof filesTabContent === 'function'
      ? filesTabContent({
          onScrollActivity: handleFilesScrollActivity,
          bottomTabBarVisible: showProjectTabBar,
        })
      : filesTabContent;

  /* In-page search — always-visible pill at the top of the chat header.
     Local-only state: search is purely a view concern for this screen. */
  const [searchQuery, setSearchQuery] = useState('');
  /* Filter pill bar starts collapsed; the chip on the first group
     heading toggles it open (mirrors home Chat tab). */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const visibleConversations = useMemo(() => {
    if (!trimmedQuery) return conversations;
    return conversations.filter((conversation) =>
      conversation.title.toLowerCase().includes(trimmedQuery)
    );
  }, [conversations, trimmedQuery]);
  const hasFilterPills = Boolean(filterPills && filterPills.length > 0);
  /* Best-effort "filters applied" signal: any multi-select pill whose
     selection differs from its default, or any non-first single-select
     option. Enough for the trailing chip's active dot. */
  const hasActiveProjectFilters = useMemo(() => {
    if (!filterPills) return false;
    for (const pill of filterPills) {
      if (pill.kind === 'multi') {
        if (pill.selectedIds.size !== pill.defaultIds.size) return true;
        for (const id of pill.selectedIds) {
          if (!pill.defaultIds.has(id)) return true;
        }
      } else if (pill.kind === 'single') {
        const defaultId = pill.options[0]?.id;
        if (defaultId != null && pill.selectedId !== defaultId) return true;
      } else if (pill.kind === 'aggregate') {
        for (const dim of pill.pills) {
          if (dim.selectedIds.size !== dim.defaultIds.size) return true;
          for (const id of dim.selectedIds) {
            if (!dim.defaultIds.has(id)) return true;
          }
        }
      }
    }
    return false;
  }, [filterPills]);

  /* If we're being mounted because the user just *backed out of* a
     session-detail page, the chat already played its slide-off to the
     right — replaying our forward push-enter on top of that would look
     like an iOS push on a pop. `useState` initializer + flag consume
     keeps the value stable across re-renders and self-clears so a real
     forward navigation to this page still gets its enter slide. */
  const [skipEnterAnimation] = useState(() => consumeMobileBackNavigation());

  return (
    <div className="mobile-home-app safe-areas relative h-full min-h-0 w-full overflow-hidden text-foreground">
      {/* iOS-style push enter: slide in from the right on mount, unless
         we're a back-navigation destination (see `skipEnterAnimation`
         above). The back navigation has no exit animation — see
         `mobile-settings-layout.tsx` for the rationale (the brief
         frame between exit-animation end and route unmount flashes the
         html bg). */}
      <motion.div
        initial={skipEnterAnimation ? false : { x: '100%' }}
        animate={{ x: 0 }}
        transition={PROJECT_TRANSITION}
        /* Column flex: header + (search) + (pills) all sit ABOVE the
           scroll container. Only the inner list region scrolls — so
           the vertical scrollbar appears to the right of the
           conversation list, not running through the header + pills.
           See the user-reported bug "scrollbar should be above the
           pills". */
        className="mobile-home-shell relative flex h-full w-full flex-col bg-background"
      >
        {filesTabNested ? null : (
          <MobileEdgeBackSwipeZone isNativeApp={isNativeAppShell()} onBack={onBack} zIndex={20} />
        )}
        {selectedProjectTab === 'chat' ? (
          <ProjectChatTopBar
            project={project}
            displayName={displayName}
            labels={labels}
            onBack={onBack}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            showArchived={showArchived}
            onShowArchivedToggle={onShowArchivedToggle}
          />
        ) : (
          <ProjectPlainTopBar
            project={project}
            displayName={displayName}
            labels={labels}
            /* At the file root the back chip exits the project (same as
               Settings); once drilled into a folder/file it pops one
               file-browser level instead. */
            onBack={
              selectedProjectTab === 'files' && (fileNavSegments?.length ?? 0) > 0 && onFileNavBack
                ? onFileNavBack
                : onBack
            }
          />
        )}

        {/* Filter pill bar — toggled from the first group heading's
           trailing chip (mirrors home Chat). Unmounted on Files /
           Settings so those tabs stay free of conversation chrome. */}
        <AnimatePresence initial={false}>
          {selectedProjectTab === 'chat' && filtersOpen && hasFilterPills && filterPills ? (
            <motion.div
              key="project-filter-pills"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <MobileFilterPillBar pills={filterPills} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div
          ref={listScrollRef}
          className={cn(
            'scrollbar-pro relative min-h-0 flex-1 overflow-y-auto pt-1 [scrollbar-gutter:auto]',
            /* The bottom tabbar floats fixed at the viewport bottom,
               so the scrollable content needs padding to clear it
               (height + safe-area). Same trick the home screen uses. */
            'pb-[calc(var(--mobile-tabbar-height)+var(--k-safe-area-bottom,0px)+1rem)]'
          )}
        >
          {selectedProjectTab === 'chat' ? (
            visibleConversations.length === 0 ? (
              <>
                {hasFilterPills ? (
                  <div className="flex w-full items-center justify-end px-4 pb-1.5 pt-2">
                    <ProjectListFilterToggle
                      open={filtersOpen}
                      hasActiveFilters={hasActiveProjectFilters}
                      ariaLabel={labels.filterBarToggleLabel ?? '过滤器'}
                      onToggle={() => setFiltersOpen((open) => !open)}
                    />
                  </div>
                ) : null}
                <ProjectEmptyState label={labels.emptyConversations ?? '没有匹配的对话'} />
              </>
            ) : (
              <MobileChatList
                chats={visibleConversations}
                groupBy={chatGroupBy}
                groupLabels={chatGroupLabels}
                /* Project sub-page always shows the branch name in the
                   row's meta line. We're already inside a single
                   project's surface, so the project label would be
                   redundant chrome — branch is the disambiguating piece
                   of info between rows. */
                rowSecondaryField="branch"
                /* Active list is flat — no "全部对话" section label. Only
                   the archived surface keeps a heading so the mode is
                   obvious. */
                flatHeading={
                  showArchived
                    ? (labels.archivedConversationsHeading ?? '归档对话')
                    : undefined
                }
                firstGroupTrailing={
                  hasFilterPills ? (
                    <ProjectListFilterToggle
                      open={filtersOpen}
                      hasActiveFilters={hasActiveProjectFilters}
                      ariaLabel={labels.filterBarToggleLabel ?? '过滤器'}
                      onToggle={() => setFiltersOpen((open) => !open)}
                    />
                  ) : undefined
                }
                selectedConversationId={selectedConversationId}
                onSelect={onConversationSelect}
                rowActions={{
                  onTogglePin: onConversationTogglePin,
                  onArchive: onConversationArchive,
                  onRestore: onConversationRestore,
                }}
                archived={showArchived}
                onPermanentDelete={showArchived ? onConversationPermanentDelete : undefined}
                selectionLabels={labels.archiveSelection}
              />
            )
          ) : null}
          {selectedProjectTab === 'files' ? renderedFilesTabContent : null}
          {selectedProjectTab === 'settings'
            ? (settingsTabContent ?? (
                <ProjectTabPlaceholder
                  icon={
                    <SettingsIcon
                      className="h-8 w-8 text-muted-foreground/70"
                      strokeWidth={1.6}
                      aria-hidden="true"
                    />
                  }
                  title={labels.settingsTabPlaceholderTitle ?? labels.settingsTab ?? '设置'}
                  body={labels.settingsTabPlaceholderBody ?? '即将上线'}
                />
              ))
            : null}
        </div>

        {showProjectTabBar ? (
          /* Bottom dock — same component the home page uses, with
             project-specific tabs (Chat / Files / Settings) and a
             project-context new-chat chip. The chip is hidden when
             `onNewChat` isn't wired. */
          <MobileWorkspaceTabBar<MobileProjectTab>
            tabs={projectTabSpecs(labels)}
            selectedTab={selectedProjectTab}
            onTabSelect={setSelectedProjectTab}
            onNewChat={onNewChat}
            newChatAriaLabel={labels.newChatAriaLabel}
            ariaLabel={labels.chatTab ?? '导航'}
            /* Distinct layoutId so the highlight FLIP animation doesn't
               share state with the home page's tabbar. */
            layoutId="mobile-project-tabbar"
            scrollContainerRef={listScrollRef}
            scrollSignal={selectedProjectTab === 'files' ? filesScrollSignal : null}
          />
        ) : null}
      </motion.div>
    </div>
  );
}

/* Tab specs for the project bottom tabbar — mirrors `workspaceTabSpecs`
   in mobile-home-screen.tsx but for the project context. Both local and
   GitHub projects get a Settings tab: local exposes team-share + ACP
   history sync + worktree scripts, GitHub exposes the repo-level worktree
   setup + cleanup scripts. The tab's content is supplied by chat-landing
   via `settingsTabContent` per project kind. */
function projectTabSpecs(
  labels: MobileProjectScreenLabels
): ReadonlyArray<MobileBottomTabBarTabSpec<MobileProjectTab>> {
  return [
    {
      key: 'chat',
      ios: <MessageCircle className="h-6 w-6" strokeWidth={1.75} />,
      material: <MobileReactIcon icon={MdChat} className="h-6 w-6" />,
      label: labels.chatTab ?? '对话',
    },
    {
      key: 'files',
      ios: <FileIcon className="h-6 w-6" strokeWidth={1.75} />,
      material: <MobileReactIcon icon={FaRegFileCode} className="h-6 w-6" />,
      label: labels.filesTab ?? '文件',
    },
    {
      key: 'settings',
      ios: <SettingsIcon className="h-6 w-6" strokeWidth={1.75} />,
      material: <MobileReactIcon icon={MdSettings} className="h-6 w-6" />,
      label: labels.settingsTab ?? '设置',
    },
  ];
}

/* Empty-state shell rendered on the Files / Settings tabs until the
   real surfaces are designed. Centered glyph + heading + body, same
   neutral card shell the conversation empty state uses so the page
   doesn't look mid-load. */
function ProjectTabPlaceholder({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="mx-3 mt-3 flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/40 bg-card px-4 py-12 text-center">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

/* Chat-tab project header — one chrome row matching home:
   back | compact project mark | search (fills the blank) | archive.
   The full display name is no longer a centered title; the mark +
   search placeholder keep context. Filter lives on the first group
   heading (not here). */
function ProjectChatTopBar({
  project,
  displayName,
  labels,
  onBack,
  searchQuery,
  onSearchChange,
  showArchived,
  onShowArchivedToggle,
}: {
  project: MobileProjectContext;
  displayName: string;
  labels: MobileProjectScreenLabels;
  onBack: () => void;
  searchQuery: string;
  onSearchChange: (next: string) => void;
  showArchived: boolean;
  onShowArchivedToggle?: () => void;
}) {
  return (
    <header
      className={cn(
        'mobile-home-glass sticky top-0 z-30 flex items-center gap-2',
        'pt-safe-2 pb-2 ps-safe-3 pe-safe-3'
      )}
    >
      <HeaderChip onClick={onBack} ariaLabel={labels.backAriaLabel ?? 'Back'}>
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </HeaderChip>
      <span className="sr-only">{displayName}</span>
      <ProjectAvatar project={project} />
      <div className="min-w-0 flex-1">
        <ProjectSearchInput value={searchQuery} onChange={onSearchChange} labels={labels} />
      </div>
      {onShowArchivedToggle ? (
        <HeaderChip
          onClick={onShowArchivedToggle}
          ariaLabel={labels.archiveToggleLabel ?? '归档'}
          ariaPressed={showArchived}
          active={showArchived}
        >
          <Archive className="h-4 w-4" aria-hidden="true" strokeWidth={2} />
        </HeaderChip>
      ) : null}
    </header>
  );
}

/* Plain project header for Files and Settings. The right spacer keeps the
   project identity centered while omitting chat-only actions. */
function ProjectPlainTopBar({
  project,
  displayName,
  labels,
  onBack,
}: {
  project: MobileProjectContext;
  displayName: string;
  labels: MobileProjectScreenLabels;
  onBack: () => void;
}) {
  return (
    <header
      className={cn(
        'mobile-home-glass sticky top-0 z-30',
        /* `2.25rem` back chip + flexible centered identity + a matching
           `2.25rem` spacer so the identity stays optically centered now
           that the right-hand chips are gone. */
        'grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2',
        'pt-safe-2 pb-2 ps-safe-3 pe-safe-3'
      )}
    >
      <HeaderChip onClick={onBack} ariaLabel={labels.backAriaLabel ?? 'Back'}>
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </HeaderChip>
      <ProjectHeaderIdentity project={project} displayName={displayName} />
      <span aria-hidden />
    </header>
  );
}

function ProjectHeaderIdentity({
  project,
  displayName,
}: {
  project: MobileProjectContext;
  displayName: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-2">
      <ProjectAvatar project={project} />
      <h1 className="truncate text-[0.98rem] font-semibold tracking-tight">{displayName}</h1>
    </div>
  );
}

/* Floating-pill side chip used by the project header's back + archive
   buttons. Matches home `FloatingPill`: recessed muted fill (no
   card-on-white soft shadow — muddy in light theme). `active` uses a
   primary tint so archive-on reads as engaged. */
function HeaderChip({
  children,
  onClick,
  ariaLabel,
  ariaPressed,
  active = false,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaLabel: string;
  ariaPressed?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border',
        'transition-colors active:scale-[0.97]',
        active
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border/50 bg-muted text-foreground active:bg-muted/80 dark:border-white/12 dark:bg-white/10 dark:active:bg-white/14'
      )}
    >
      {children}
    </button>
  );
}

/* Filter chip on the first group heading — same look as the home Chat
   list filter toggle. */
function ProjectListFilterToggle({
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

/* Leading avatar for the project header:
   - github: owner image when present, github glyph fallback;
   - local:  initial-letter tile (same component the home rows use,
             at the smaller `sm` size). Seeded on the unique project
             id so two projects named "lody" on different machines
             get distinct hues. */
function ProjectAvatar({ project }: { project: MobileProjectContext }) {
  if (project.kind === 'github') {
    if (project.avatarUrl) {
      return (
        <CachedAvatarImg
          src={project.avatarUrl}
          alt=""
          loading="lazy"
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      );
    }
    return <Github className="h-6 w-6 shrink-0" strokeWidth={1.6} aria-hidden="true" />;
  }
  return (
    <MobileInitialLetterAvatar
      name={project.name}
      hashSeed={`${project.machineId}:${project.projectId}`}
      size="sm"
    />
  );
}

/* Always-visible search pill at the top of the chat header. Filters
   conversations by title — keep the predicate inside the screen
   since search is purely a view concern (no need to persist it or
   round-trip through chat-landing). */
function ProjectSearchInput({
  value,
  onChange,
  labels,
}: {
  value: string;
  onChange: (next: string) => void;
  labels: MobileProjectScreenLabels;
}) {
  return (
    <label
      className={cn(
        'flex h-9 w-full min-w-0 items-center gap-1.5 rounded-full border border-border/50 bg-muted px-3 text-foreground',
        'dark:border-white/12 dark:bg-white/10',
        'transition-colors focus-within:bg-muted/80 dark:focus-within:bg-white/14'
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
        placeholder={labels.searchPlaceholder ?? '搜索对话'}
        aria-label={labels.searchAriaLabel ?? '搜索'}
        enterKeyHint="search"
        className="min-w-0 flex-1 border-none bg-transparent text-[0.82rem] outline-none focus:outline-none focus:ring-0 placeholder:text-muted-foreground"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={labels.clearSearchAriaLabel ?? 'Clear search'}
          className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}

function ProjectEmptyState({ label }: { label: string }) {
  return (
    <div className="mx-3 mt-3 rounded-2xl border border-border/40 bg-card px-4 py-6 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
