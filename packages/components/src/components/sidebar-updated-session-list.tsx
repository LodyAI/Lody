import {
  memo,
  useCallback,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { startSessionMentionDrag } from '@/lib/session-mention-drag';
import {
  Archive,
  GitBranch,
  GitPullRequest,
  Link2,
  Loader2,
  LockKeyhole,
  Mail,
  Pencil,
  Pin,
  PinOff,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { TooltipProvider } from '@/ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/ui/context-menu';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import {
  SessionOpenedByTreeRow,
  SessionPrIcon,
  SessionMergeablePill,
  SessionRowAuthorAvatar,
  SessionRowLeadingSlot,
  SessionRowWorktreeIndicator,
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SidebarListSkeleton,
  SidebarSectionHeader,
  SessionRowOpenedByMenuItems,
  buildSessionRowOpenedByTreeSlot,
  type SidebarRowKind,
  type SessionRowOpenedByTreeSlot,
} from '@/components/sidebar-row-shared';
import {
  sidebarCollapsedOpenedBySessionsAtom,
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
import { SessionInfoHoverCard } from '@/components/session-info-hover-card';
import type {
  LocalProjectHistoryProvider,
  PrStatus,
  SessionId,
  SessionPullRequestCiState,
  SessionPullRequestReadiness,
} from '@lody/shared';
import type { SessionListPullRequestOpen, SessionListRowOwner } from '@/components/session-list';
import type { SessionSharingState } from '@/lib/session-sharing';
import {
  RenameSessionDialogView,
  type RenameSessionDialogTarget,
} from '@/components/sessions/rename-session-dialog';

export type SidebarUpdatedItemKind = SidebarRowKind;

export type SidebarUpdatedItem = {
  id: string;
  kind: SidebarUpdatedItemKind;
  title: string;
  /**
   * PRECISE opener: the Session that created/opened this one
   * (`SessionMeta.openedBySessionId`). Presentation-only provenance; see
   * `@/lib/session-opened-by-tree`. Drives "Go to Opener Session", so it keeps
   * pointing at the exact opener even when that opener is a child Tab.
   * Navigation combines it with `openedByRowSessionId`.
   */
  openedBySessionId?: string | null;
  /**
   * Sidebar row this one nests under — the opener's ROOT Session when the opener
   * is a child Tab, otherwise the opener itself. It is also the root route for
   * precise child-Tab navigation; it never replaces `openedBySessionId`.
   * Nesting is still resolved WITHIN one rendered section, so a pinned opener
   * and an unpinned opened Session (different sections) both stay top-level.
   */
  openedByRowSessionId?: string | null;
  /**
   * Section the item lives in under the Workspace organize mode.
   * Surfaces in the row's hover tooltip (desktop only).
   */
  sectionLabel: string;
  /**
   * Optional second-line label. Free-form per kind:
   *   - github: repo full name (e.g. "loro-dev/loro")
   *   - local:  project name
   *   - chat:   nothing (falls back to sectionLabel)
   */
  subtitle?: string | null;
  /** Repo full name; set for `kind === 'github'`, and for `kind === 'local'`
   * rows whose project is linked to a GitHub repo. */
  repoFullName?: string | null;
  /**
   * Branch name surfaced via the row's context menu (Copy Current Branch).
   * Only populated for `kind === 'github'` rows; absent otherwise.
   */
  branchName?: string | null;
  /** Name of the machine the session runs on, shown in the hover info card. */
  machineName?: string | null;
  latestMessageAt: Date | number | string;
  isPinned?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  isOffline?: boolean;
  isWaitingPermission?: boolean;
  prStatus?: PrStatus | null;
  prCiState?: SessionPullRequestCiState | null;
  prReadiness?: SessionPullRequestReadiness | null;
  prNumber?: number | null;
  prUrl?: string | null;
  owner?: SessionListRowOwner | null;
  addedLines?: number;
  deletedLines?: number;
  isWorktree?: boolean;
  externalHistoryProvider?: LocalProjectHistoryProvider | null;
  sharing?: SessionSharingState;
};

/**
 * The Updated organize mode renders ONE section ("Chats") — a flat
 * recency-sorted list. The bucket plumbing (collapse / show-all state maps,
 * toggle callbacks) survives from the earlier today/week/older design, now
 * keyed by the single 'all' bucket.
 */
export type SidebarUpdatedBucketKey = 'all';

export type SidebarUpdatedSessionListLabels = {
  /** Header of the single flat list section. */
  heading: string;
  emptyTitle: string;
  emptyDescription: string;
};

export type SidebarUpdatedContextMenuLabels = {
  moreActions: string;
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

/**
 * Standalone right-aligned row hosting {@link SidebarUpdatedSessionListProps.headerAction}
 * when there is no first bucket header to attach it to (loading skeleton / empty
 * state), so the control stays reachable in every list state.
 */
function HeaderActionRow({ action }: { action: ReactNode }) {
  return <div className="flex h-7 shrink-0 items-center justify-end">{action}</div>;
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

function toDate(value: SidebarUpdatedItem['latestMessageAt']): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getSortKey(item: SidebarUpdatedItem): number {
  const date = toDate(item.latestMessageAt);
  return date ? date.getTime() : 0;
}

type SidebarUpdatedBucket = {
  key: SidebarUpdatedBucketKey;
  label: string;
  items: SidebarUpdatedItem[];
};

export function sortUpdatedItems(items: SidebarUpdatedItem[]): SidebarUpdatedItem[] {
  return [...items].sort((a, b) => {
    const aPinned = a.isPinned ? 1 : 0;
    const bPinned = b.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const byTime = getSortKey(b) - getSortKey(a);
    if (byTime !== 0) return byTime;
    const byTitle = a.title.localeCompare(b.title);
    if (byTitle !== 0) return byTitle;
    return a.id.localeCompare(b.id);
  });
}

/**
 * When a bucket has more than this many rows, the row list collapses to the
 * latest N and reveals a "Show all (count)" toggle. Mirrors the per-group
 * preview pattern in SessionList, but with a higher threshold because Updated
 * mode is a flat firehose rather than a small per-repo group.
 */
export const SHOW_FULL_BUCKET_THRESHOLD = 20;

/** Group ranking key: pinned first, then latest activity. */
function updatedItemRootRank(item: SidebarUpdatedItem): number {
  return pinnedFirstRootRank(getSortKey(item), item.isPinned);
}

/** Stable identity for a collapsed bucket's (absent) rows. */
const EMPTY_TREE_NODES: OpenedBySessionTreeNode<SidebarUpdatedItem>[] = [];

/** Tree accessors shared by the renderer and the keyboard navigation model. */
export const SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS = {
  getId: (item: SidebarUpdatedItem) => item.id,
  getOpenedBySessionId: (item: SidebarUpdatedItem) =>
    item.openedByRowSessionId ?? item.openedBySessionId ?? null,
} as const;

/** TOP-LEVEL row count — what the "Show all" threshold is measured against. */
export function countUpdatedItemRoots(orderedItems: SidebarUpdatedItem[]): number {
  return countOpenedByTreeRoots(orderedItems, SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS);
}

export function updatedBucketOverflowsPreview(orderedItems: SidebarUpdatedItem[]): boolean {
  return countUpdatedItemRoots(orderedItems) > SHOW_FULL_BUCKET_THRESHOLD;
}

/**
 * Rows this bucket renders, in render order, with their "opened by" geometry.
 * The preview cap counts top-level rows, so it never splits an opener from the
 * Sessions it opened.
 */
export function getVisibleUpdatedItemTree(
  orderedItems: SidebarUpdatedItem[],
  canToggleFullList: boolean,
  showFull: boolean,
  collapsedOpenedBySessionIds?: Record<string, boolean>
): OpenedBySessionTreeNode<SidebarUpdatedItem>[] {
  const capped = canToggleFullList && !showFull && updatedBucketOverflowsPreview(orderedItems);
  return buildOpenedBySessionTree(orderedItems, {
    ...SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
    isCollapsed: (openerId) => collapsedOpenedBySessionIds?.[openerId] === true,
    // Updated mode IS the recency list: rank each opener by its freshest opened
    // Session so nesting can never bury a just-updated row under a stale opener.
    rootRank: updatedItemRootRank,
    ...(capped ? { maxRoots: SHOW_FULL_BUCKET_THRESHOLD } : {}),
  });
}

export function getVisibleUpdatedItems(
  orderedItems: SidebarUpdatedItem[],
  canToggleFullList: boolean,
  showFull: boolean,
  collapsedOpenedBySessionIds?: Record<string, boolean>
): SidebarUpdatedItem[] {
  return getVisibleUpdatedItemTree(
    orderedItems,
    canToggleFullList,
    showFull,
    collapsedOpenedBySessionIds
  ).map((node) => node.item);
}

export type SidebarUpdatedSessionListProps = {
  items: SidebarUpdatedItem[];
  now: Date;
  selectedItemId?: string | null;
  isMobile?: boolean;
  /** Whether pinned rows show a leading pin icon. */
  showPinnedIcon?: boolean;
  /**
   * When true and `items` is empty, render a skeleton rather than the empty
   * state. Workspace mode uses the same approach for `SessionList` so the two
   * organize modes don't disagree about what "loading" looks like.
   */
  isLoading?: boolean;
  className?: string;
  labels?: Partial<SidebarUpdatedSessionListLabels>;
  onSelectItem?: (id: string, tabSessionId?: string) => void;
  /**
   * Archive an item. When provided, desktop rows reveal an Archive button on hover
   * (replacing the relative timestamp) with a two-step Archive → Confirm flow, and
   * mobile rows expose the same action via left-swipe + tap-to-confirm.
   */
  onArchiveItem?: (id: string) => void;
  /** Mark a read desktop item unread. */
  onMarkItemUnread?: (id: string) => void;
  /** Rename an item through the shared Rename Chat dialog. */
  onRenameItem?: (id: string, nextTitle: string) => void | Promise<void>;
  /**
   * Toggle pin. Mirrors `SessionList.onTogglePinSession`: receives the next desired
   * pin state.
   */
  onTogglePinItem?: (id: string, nextPinned: boolean) => void;
  /** Copy a shareable session URL for the item. */
  onCopyItemUrl?: (id: string) => void;
  /** Open the share-with-team confirmation for a private session. */
  onShareItemWithTeam?: (id: string) => void;
  /**
   * Open the GitHub PR for a row. Only invoked for `kind === 'github'` items
   * with a `prUrl`. Mirrors `SessionList.onOpenPullRequest` so both organize
   * modes route PR opens through the same internal navigation path.
   */
  onOpenPullRequest?: (request: SessionListPullRequestOpen) => void;
  /**
   * When provided, rows render as anchors so middle/Cmd-click open in a new tab.
   * Returning undefined for an id keeps that row as a plain button.
   */
  getItemHref?: (id: string) => string | undefined;
  /** Per-bucket collapse state. Missing keys default to false (expanded). */
  collapsedBuckets?: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  /** Toggle a bucket's collapse state. Omit to make buckets non-toggleable. */
  onToggleBucket?: (key: SidebarUpdatedBucketKey) => void;
  toggleBucketLabel?: string;
  /**
   * Per-bucket "show all" state. When false (default) and the bucket exceeds
   * {@link SHOW_FULL_BUCKET_THRESHOLD} items, only the latest N render and a
   * "Show all" button appears.
   */
  showFullBuckets?: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  onToggleFullBucket?: (key: SidebarUpdatedBucketKey) => void;
  /**
   * Always-visible action rendered at the right end of the FIRST bucket's
   * header row (desktop sidebar filter trigger). While loading or empty the
   * list has no bucket headers, so the action renders in a standalone row
   * instead — it must stay reachable in every state.
   */
  headerAction?: ReactNode;
};

const defaultLabels: SidebarUpdatedSessionListLabels = {
  heading: 'Chats',
  emptyTitle: 'Nothing yet',
  emptyDescription: 'Start a chat or open a worktree to see it here.',
};

export const SidebarUpdatedSessionList = memo(function SidebarUpdatedSessionList({
  items,
  now,
  selectedItemId,
  isMobile = false,
  showPinnedIcon = true,
  isLoading = false,
  className,
  labels,
  onSelectItem,
  onArchiveItem,
  onMarkItemUnread,
  onRenameItem,
  onTogglePinItem,
  onCopyItemUrl,
  onShareItemWithTeam,
  onOpenPullRequest,
  getItemHref,
  collapsedBuckets,
  onToggleBucket,
  toggleBucketLabel,
  showFullBuckets,
  onToggleFullBucket,
  headerAction,
}: SidebarUpdatedSessionListProps) {
  const { t } = useTranslation();
  const merged: SidebarUpdatedSessionListLabels = useMemo(
    () => ({
      heading: labels?.heading ?? t('sidebar.updated.heading', defaultLabels.heading),
      emptyTitle: labels?.emptyTitle ?? t('sidebar.updated.empty.title', defaultLabels.emptyTitle),
      emptyDescription:
        labels?.emptyDescription ??
        t('sidebar.updated.empty.description', defaultLabels.emptyDescription),
    }),
    [labels, t]
  );

  const archiveLabels = useMemo(
    () => ({
      tooltip: t('sessions.archive', 'Archive session'),
      action: t('archive.title', 'Archive'),
      confirm: t('common.confirm', 'Confirm'),
    }),
    [t]
  );

  const contextMenuLabels: SidebarUpdatedContextMenuLabels = useMemo(
    () => ({
      moreActions: t('sessions.moreActions', 'More actions'),
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

  const [renameTarget, setRenameTarget] = useState<RenameSessionDialogTarget | null>(null);
  const beginRename = useCallback((id: string, currentTitle: string) => {
    setRenameTarget({ sessionId: id as SessionId, initialTitle: currentTitle });
  }, []);
  // Same atom SessionList uses, so an opener folded in one organize mode stays
  // folded in the other. This component renders BOTH the Updated bucket and the
  // Pinned section; each instance resolves nesting inside its OWN `items`, which
  // is what keeps the two sections from reaching across each other.
  const collapsedOpenedBySessionIds = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const handleToggleOpenedBySessions = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);

  const canToggleBucket = typeof onToggleBucket === 'function';
  const canToggleFullBucket = typeof onToggleFullBucket === 'function';

  const buckets = useMemo<SidebarUpdatedBucket[]>(() => {
    if (!items.length) return [];
    return [{ key: 'all', label: merged.heading, items: sortUpdatedItems(items) }];
  }, [items, merged.heading]);

  // Updated mode is a flat firehose, so a bucket can hold the whole workspace
  // while showing 20 rows. Resolving the tree per render would re-scan all of
  // it on every message/status tick; a collapsed bucket renders no rows at all.
  const bucketTrees = useMemo(
    () =>
      buckets.map((bucket) => {
        if (collapsedBuckets?.[bucket.key]) {
          return {
            overflows: updatedBucketOverflowsPreview(bucket.items),
            nodes: EMPTY_TREE_NODES,
          };
        }
        return {
          overflows: updatedBucketOverflowsPreview(bucket.items),
          nodes: getVisibleUpdatedItemTree(
            bucket.items,
            canToggleFullBucket,
            Boolean(showFullBuckets?.[bucket.key]),
            collapsedOpenedBySessionIds
          ),
        };
      }),
    [buckets, canToggleFullBucket, collapsedBuckets, collapsedOpenedBySessionIds, showFullBuckets]
  );

  if (isLoading && items.length === 0) {
    return (
      <div className="flex flex-col">
        {headerAction ? <HeaderActionRow action={headerAction} /> : null}
        <SidebarListSkeleton
          className={className}
          showHeaderIcon={false}
          sectionClassName="mb-4 last:mb-0"
        />
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="flex flex-col">
        {headerAction ? <HeaderActionRow action={headerAction} /> : null}
        <div
          className={cn(
            'mt-2 flex flex-col items-start gap-1 rounded-md border border-dashed border-sidebar-border/70 px-3 py-4',
            className
          )}
        >
          <div className="text-sm font-medium text-sidebar-foreground">{merged.emptyTitle}</div>
          <div className="text-xs text-sidebar-foreground-muted">{merged.emptyDescription}</div>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className={cn('flex flex-col', className)}>
        {buckets.map((bucket, bucketIndex) => {
          const bucketHeaderAction = bucketIndex === 0 ? headerAction : null;
          const collapsed = Boolean(collapsedBuckets?.[bucket.key]);
          const handleToggle = () => {
            if (!canToggleBucket) return;
            onToggleBucket?.(bucket.key);
          };
          const showFull = Boolean(showFullBuckets?.[bucket.key]);
          const { overflows, nodes: visibleNodes } = bucketTrees[bucketIndex] ?? {
            overflows: false,
            nodes: EMPTY_TREE_NODES,
          };
          // Only a bucket that actually contains an opened Session enables the
          // tree wrapper. Unrelated top-level rows keep their flat geometry.
          const showTreeGutter = hasOpenedByTreeNesting(visibleNodes);
          const showToggleFullList = canToggleFullBucket && overflows && !collapsed;
          const toggleFullListLabel = showFull
            ? t('sessions.showLess', 'Show less')
            : t('sessions.showAll', 'Show all ({{count}})', { count: bucket.items.length });
          return (
            <div
              key={bucket.key}
              className={cn(
                'group flex flex-col gap-0.5',
                collapsed ? 'mb-1 last:mb-0' : 'mb-4 last:mb-0'
              )}
            >
              {/* Same shared section header as Workspace mode, so section labels
                  read identically (13px medium) across organize modes. */}
              <SidebarSectionHeader
                label={bucket.label}
                collapsed={collapsed}
                action={bucketHeaderAction}
                isMobile={isMobile}
                toggleLabel={toggleBucketLabel}
                onToggleCollapsed={canToggleBucket ? handleToggle : undefined}
              />
              {!collapsed ? (
                <div className="flex flex-col gap-px">
                  {visibleNodes.map((node) => {
                    const openedByTree = buildSessionRowOpenedByTreeSlot(node, t, () =>
                      handleToggleOpenedBySessions(node.item.id)
                    );
                    return (
                      <SessionOpenedByTreeRow
                        key={node.item.id}
                        depth={node.depth}
                        gutter={showTreeGutter}
                      >
                        <UpdatedItemRow
                          item={node.item}
                          now={now}
                          selected={node.item.id === selectedItemId}
                          isMobile={isMobile}
                          showPinnedIcon={showPinnedIcon}
                          href={getItemHref?.(node.item.id)}
                          onSelect={onSelectItem}
                          onArchive={onArchiveItem}
                          onMarkUnread={onMarkItemUnread}
                          onRename={onRenameItem}
                          onTogglePin={onTogglePinItem}
                          onCopyUrl={onCopyItemUrl}
                          onShareWithTeam={onShareItemWithTeam}
                          onOpenPullRequest={onOpenPullRequest}
                          onBeginRename={beginRename}
                          openedByTree={openedByTree}
                          contextMenuLabels={contextMenuLabels}
                          archiveTooltipLabel={archiveLabels.tooltip}
                          archiveActionLabel={archiveLabels.action}
                          archiveConfirmLabel={archiveLabels.confirm}
                        />
                      </SessionOpenedByTreeRow>
                    );
                  })}
                  {showToggleFullList ? (
                    <button
                      type="button"
                      data-sidebar-updated-show-more={bucket.key}
                      className={cn(
                        'flex select-none items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-sidebar-foreground-muted/80',
                        'transition-colors',
                        'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
                        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40'
                      )}
                      aria-label={toggleFullListLabel}
                      onClick={() => onToggleFullBucket?.(bucket.key)}
                    >
                      <span
                        className="flex h-4 w-4 items-center justify-center"
                        aria-hidden="true"
                      />
                      <span>{toggleFullListLabel}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        <RenameSessionDialogView
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRename={(sessionId, nextTitle) => onRenameItem?.(sessionId, nextTitle)}
        />
      </div>
    </TooltipProvider>
  );
});

SidebarUpdatedSessionList.displayName = 'SidebarUpdatedSessionList';

type UpdatedItemRowProps = {
  item: SidebarUpdatedItem;
  now: Date;
  selected: boolean;
  isMobile: boolean;
  showPinnedIcon: boolean;
  href?: string;
  onSelect?: (id: string, tabSessionId?: string) => void;
  onArchive?: (id: string) => void;
  onMarkUnread?: (id: string) => void;
  onRename?: (id: string, nextTitle: string) => void | Promise<void>;
  onTogglePin?: (id: string, nextPinned: boolean) => void;
  onCopyUrl?: (id: string) => void;
  onShareWithTeam?: (id: string) => void;
  onOpenPullRequest?: (request: SessionListPullRequestOpen) => void;
  onBeginRename: (id: string, currentTitle: string) => void;
  openedByTree?: SessionRowOpenedByTreeSlot;
  contextMenuLabels: SidebarUpdatedContextMenuLabels;
  archiveTooltipLabel: string;
  archiveActionLabel: string;
  archiveConfirmLabel: string;
};

const UpdatedItemRow = memo(function UpdatedItemRow({
  item,
  now,
  selected,
  isMobile,
  showPinnedIcon,
  href,
  onSelect,
  onArchive,
  onMarkUnread,
  onRename,
  onTogglePin,
  onCopyUrl,
  onShareWithTeam,
  onOpenPullRequest,
  onBeginRename,
  openedByTree,
  contextMenuLabels,
  archiveTooltipLabel,
  archiveActionLabel,
  archiveConfirmLabel,
}: UpdatedItemRowProps) {
  const showSelectedState = selected;
  const useAnchor = typeof href === 'string' && href.length > 0;
  // Mobile keeps a right-edge relative time (no hover info card on touch).
  const relativeTime = formatCompactRelativeTime(item.latestMessageAt, now);
  const prUrl = typeof item.prUrl === 'string' && item.prUrl.trim() ? item.prUrl.trim() : null;
  const prNumber =
    typeof item.prNumber === 'number' && Number.isFinite(item.prNumber)
      ? item.prNumber
      : prUrl
        ? parseGitHubPrNumber(prUrl)
        : null;
  const prStatus: PrStatus = item.prStatus ?? 'open';
  // Any row carrying a PR shows its status at rest and in the hover info card.
  // Local-project sessions can carry one too: their repo identity lives on
  // `session.project`, not the legacy `repoFullName` field that `kind` derives from.
  const showPr = Boolean(prUrl);
  const addedLines = typeof item.addedLines === 'number' ? item.addedLines : 0;
  const deletedLines = typeof item.deletedLines === 'number' ? item.deletedLines : 0;
  // +/- diff stats only exist for repo (worktree) sessions. Local-project and
  // chat rows never have a meaningful change count; rendering 0/0 there would
  // be noise. Workspace mode reaches the same conclusion structurally because
  // only github rows pass through SessionList's diff path.
  const hasChanges = item.kind === 'github' && (addedLines !== 0 || deletedLines !== 0);
  // A merged/closed PR can leave a stale "clean/mergeable" record in
  // `pullRequestState` (the webhook fan-out sets status='merged' but can't
  // clear that field, and the poller stops observing terminal PRs). Gate the
  // pill on the PR still being live so it doesn't linger next to a merged PR.
  const isMergeable =
    showPr && item.prReadiness === 'y' && prStatus !== 'merged' && prStatus !== 'closed';
  const showMergeablePill = isMergeable && !selected;
  const branchName =
    typeof item.branchName === 'string' && item.branchName.trim() ? item.branchName.trim() : null;
  const repoFullName =
    typeof item.repoFullName === 'string' && item.repoFullName.trim()
      ? item.repoFullName.trim()
      : null;
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
        onSelect?.(item.id);
      }
    : undefined;

  const canArchive = typeof onArchive === 'function';
  const canMarkUnread = typeof onMarkUnread === 'function' && !item.hasUnreadMessages;
  const showInlineArchive = canArchive && !isMobile;
  const canRename = typeof onRename === 'function';
  const canTogglePin = typeof onTogglePin === 'function';
  const canCopyUrl = typeof onCopyUrl === 'function';
  // Copy URL stays available for private sessions (the link still works for
  // the owner); sharing is a separate menu item shown only while the
  // conversation isn't team-visible.
  const shareMenuState = !item.sharing
    ? null
    : item.sharing.visibility === 'unknown'
      ? 'loading'
      : item.sharing.visibility === 'team'
        ? null
        : item.sharing.privateReason === 'machine-not-registered'
          ? 'unregistered'
          : item.sharing.canManage
            ? 'share'
            : 'owner-only';
  // Desktop-only context menu mirrors SessionList's: rename / pin / archive /
  // copyUrl / copyBranch. Mobile users reach archive via swipe and lack the
  // other actions in both organize modes — keeping it consistent rather than
  // inventing a new mobile entry point here.
  // Reverse leg of the opened-by relationship. Available even when the row is
  // NOT nested (opener pinned into the other section, archived, or filtered
  // out), which is exactly when the tree cannot show the link.
  const openerSessionId = normalizeSessionRowId(item.openedBySessionId);
  const openerRootSessionId = normalizeSessionRowId(item.openedByRowSessionId) ?? openerSessionId;
  const canGoToOpener = Boolean(openerSessionId && typeof onSelect === 'function');
  const openedByOpener = openedByTree?.kind === 'opener' ? openedByTree : null;
  const hasMenuActions =
    !isMobile &&
    (canRename ||
      canTogglePin ||
      canArchive ||
      canMarkUnread ||
      canCopyUrl ||
      Boolean(shareMenuState) ||
      Boolean(branchName) ||
      canGoToOpener ||
      (showPr && Boolean(onOpenPullRequest)) ||
      Boolean(openedByOpener));
  const titleFontClassName = item.isPinned ? 'font-normal' : 'font-medium';

  const handlePrOpen =
    onOpenPullRequest && prUrl
      ? () =>
          onOpenPullRequest({
            sessionId: item.id,
            repoFullName,
            prUrl,
            prNumber,
          })
      : undefined;

  const titleNode = (
    <span
      className={cn(
        'min-w-0 flex-1 truncate',
        titleFontClassName,
        showSelectedState
          ? 'text-sidebar-selection-foreground'
          : 'text-sidebar-foreground dark:text-sidebar-foreground/75 group-hover/row:text-sidebar-hover-foreground'
      )}
    >
      {item.title}
    </span>
  );

  const [rowMenuOpen, setRowMenuOpen] = useState(false);

  const row = (
    <div
      role={!useAnchor && onSelect ? 'button' : undefined}
      tabIndex={!useAnchor && onSelect ? 0 : undefined}
      aria-current={selected ? 'page' : undefined}
      data-id={`updated:${item.id}`}
      data-scope-item="row"
      data-sidebar-session-id={item.id}
      data-sidebar-updated-id={item.id}
      data-sidebar-updated-kind={item.kind}
      data-menu-open={rowMenuOpen ? '' : undefined}
      // Drag a conversation onto a chat surface to mention it there.
      draggable
      onDragStart={(event) =>
        startSessionMentionDrag(event, { sessionId: item.id, title: item.title })
      }
      className={cn(
        // Named group ('row') so the archive hover-reveal scopes to the hovered row
        // only. The bucket wrapper above also uses an (unnamed) `group` for its
        // header chevron — without naming, hovering any row would match the bucket's
        // group-hover and reveal every row's archive button at once.
        'group/row relative flex w-full items-center rounded-md px-2 py-1 text-left',
        'border border-transparent bg-transparent',
        !showSelectedState &&
          onSelect &&
          !isMobile &&
          'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground',
        showSelectedState &&
          'border-sidebar-foreground/10 bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/10',
        // Keyboard-only focus ring — see SessionList: plain :focus-within also
        // matches after mouse clicks via the overlay <a> and left a permanent
        // inset ring on the selected row.
        useAnchor &&
          'has-[a:focus-visible]:outline-hidden has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-sidebar-ring/40',
        onSelect ? 'cursor-pointer' : 'cursor-default'
      )}
      onClick={
        useAnchor
          ? undefined
          : () => {
              if (!onSelect) return;
              onSelect(item.id);
            }
      }
      onKeyDown={
        useAnchor
          ? undefined
          : (event) => {
              if (!onSelect) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelect(item.id);
            }
      }
    >
      {useAnchor && href ? (
        <a
          href={href}
          aria-label={item.title}
          className="absolute inset-0 z-10 rounded-md focus:outline-hidden focus-visible:shadow-none"
          // The overlay anchor covers the row, so it is what a drag starts on;
          // left draggable it would drag its link instead.
          draggable={false}
          onClick={handleAnchorClick}
        />
      ) : null}

      <div className="flex w-full min-w-0 items-center gap-1.5 text-sm">
        <SessionRowLeadingSlot
          isWaitingPermission={item.isWaitingPermission}
          isWorking={item.isWorking}
          hasUnreadMessages={item.hasUnreadMessages}
          showMenuButton={hasMenuActions}
          menuLabel={contextMenuLabels.moreActions}
          openedByTree={openedByTree}
          fadeClassName="group-hover/row:opacity-0"
          restPointerClassName="group-hover/row:pointer-events-none"
          revealClassName="group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-data-[menu-open]/row:opacity-100 group-data-[menu-open]/row:pointer-events-auto"
        />
        <SessionRowAuthorAvatar author={item.owner} />
        {showPinnedIcon && item.isPinned ? (
          <Pin
            aria-hidden="true"
            className="relative -top-px h-3 w-3 shrink-0 text-sidebar-foreground-muted/80"
          />
        ) : null}
        <div
          className={cn('min-w-0 flex-1 flex items-center truncate text-sm')}
          // Double-click to rename is scoped to the title only, so double-clicking
          // elsewhere on the row (e.g. the two-step Archive confirm button) cannot
          // accidentally trigger a rename.
          onDoubleClick={(e) => {
            if (!canRename) return;
            e.preventDefault();
            e.stopPropagation();
            onBeginRename(item.id, item.title);
          }}
        >
          {titleNode}
        </div>
        {/* Keep PR at the right edge, with All Changes totals immediately before it. */}
        <SidebarRowEndSlot
          fadeClassName="group-hover/row:opacity-0"
          restIcon={
            showPr ||
            hasChanges ||
            showMergeablePill ||
            isMobile ||
            (item.kind === 'local' && item.isWorktree) ? (
              <span
                className={cn(
                  'flex select-none items-center gap-1.5 text-[11px] tabular-nums text-sidebar-foreground-muted/80',
                  useAnchor && 'z-20'
                )}
              >
                {isMobile ? <span>{relativeTime}</span> : null}
                {showMergeablePill ? (
                  <SessionMergeablePill />
                ) : hasChanges && !isMergeable ? (
                  <span className="flex items-center gap-1">
                    <span className="text-code-added">+{addedLines}</span>
                    <span className="text-code-removed">-{deletedLines}</span>
                  </span>
                ) : null}
                <SessionRowWorktreeIndicator
                  isWorktree={item.kind === 'local' && item.isWorktree}
                />
                {showPr ? <SessionPrIcon prStatus={prStatus} prCiState={item.prCiState} /> : null}
              </span>
            ) : undefined
          }
          archive={
            showInlineArchive ? (
              <SidebarRowArchiveButton
                label={archiveTooltipLabel}
                confirmLabel={archiveConfirmLabel}
                onConfirm={() => onArchive?.(item.id)}
                revealClassName="group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-data-[menu-open]/row:opacity-100 group-data-[menu-open]/row:pointer-events-auto"
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );

  // Tooltip anchored to the row reveals the section the item belongs to (desktop only).
  // Skipping it on mobile keeps long-press behavior available for native gestures.
  // Mobile additionally wraps the row in SwipeActionRow when archive is wired so a
  // left-swipe reveals the Archive action with tap-to-confirm.
  if (isMobile) {
    if (!canArchive) return row;
    return (
      <SwipeActionRow
        enabled={isMobile}
        className="rounded-md"
        contentClassName="bg-sidebar"
        actions={[
          {
            key: 'archive',
            label: archiveActionLabel,
            ariaLabel: archiveTooltipLabel,
            icon: <Archive className="h-4 w-4" />,
            hideLabel: item.kind === 'chat',
            className: 'bg-sidebar-hover text-sidebar-hover-foreground',
            onClick: () => onArchive?.(item.id),
          },
        ]}
        onCommit={() => onArchive?.(item.id)}
      >
        {row}
      </SwipeActionRow>
    );
  }

  const menuRow = hasMenuActions ? (
    <ContextMenu onOpenChange={setRowMenuOpen}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        <SessionRowOpenedByMenuItems
          opener={openedByOpener}
          goToOpener={
            canGoToOpener && openerSessionId
              ? () => onSelect?.(openerRootSessionId ?? openerSessionId, openerSessionId)
              : undefined
          }
          goToOpenerLabel={contextMenuLabels.goToOpenerSession}
        />
        {handlePrOpen ? (
          <ContextMenuItem
            onSelect={() => {
              handlePrOpen();
            }}
          >
            <GitPullRequest />
            {contextMenuLabels.openPr}
          </ContextMenuItem>
        ) : null}
        {handlePrOpen &&
        (canRename || canTogglePin || canArchive || canMarkUnread || canCopyUrl || branchName) ? (
          <ContextMenuSeparator />
        ) : null}
        {canRename ? (
          <ContextMenuItem
            onSelect={() => {
              onBeginRename(item.id, item.title);
            }}
          >
            <Pencil />
            {contextMenuLabels.rename}
          </ContextMenuItem>
        ) : null}
        {canTogglePin ? (
          <ContextMenuItem
            onSelect={() => {
              onTogglePin?.(item.id, !item.isPinned);
            }}
          >
            {item.isPinned ? <PinOff /> : <Pin />}
            {item.isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
          </ContextMenuItem>
        ) : null}
        {canMarkUnread ? (
          <ContextMenuItem
            onSelect={() => {
              onMarkUnread?.(item.id);
            }}
          >
            <Mail />
            {contextMenuLabels.markUnread}
          </ContextMenuItem>
        ) : null}
        {canArchive ? (
          <ContextMenuItem
            onSelect={() => {
              onArchive?.(item.id);
            }}
          >
            <Archive />
            {contextMenuLabels.archive}
          </ContextMenuItem>
        ) : null}
        {(canRename || canTogglePin || canArchive || canMarkUnread) &&
        (canCopyUrl || branchName) ? (
          <ContextMenuSeparator />
        ) : null}
        {canCopyUrl ? (
          <ContextMenuItem
            onSelect={() => {
              onCopyUrl?.(item.id);
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
              onShareWithTeam?.(item.id);
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
        {branchName ? (
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(branchName).catch(() => {});
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

  return (
    <SessionInfoHoverCard
      kind={item.kind}
      author={item.owner ?? undefined}
      title={item.title}
      isWorktree={item.isWorktree}
      latestMessageAt={item.latestMessageAt}
      now={now}
      repoFullName={repoFullName}
      // Local items carry the folder name as their subtitle; surface it in the card
      // so a local session in the Updated list isn't left with only title + time.
      folderName={item.kind === 'local' ? (item.subtitle ?? undefined) : undefined}
      machineName={item.machineName}
      branchName={branchName}
      prStatus={showPr ? prStatus : undefined}
      prCiState={item.prCiState}
      prNumber={prNumber}
      prUrl={prUrl}
      onOpenPullRequest={handlePrOpen}
      addedLines={hasChanges ? addedLines : undefined}
      deletedLines={hasChanges ? deletedLines : undefined}
      sharing={item.sharing}
    >
      {menuRow}
    </SessionInfoHoverCard>
  );
});

UpdatedItemRow.displayName = 'UpdatedItemRow';
