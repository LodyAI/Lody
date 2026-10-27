import { isElectronRenderer } from '@/lib/electron';
import { openSessionOnModifiedClick } from '@/lib/desktop-window';
import { SessionWindowMenuItem } from './session-window-menu-item';
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
  Folders,
  Folder,
  GitBranch,
  GitPullRequest,
  Link2,
  LockKeyhole,
  Mail,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Users,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';
import { SIDEBAR_ROW_LINE_CLASS, sidebarSurface } from './sidebar-surface';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { Tooltip } from '@lody/ui/tooltip';
import { ContextMenu } from '@lody/ui/context-menu';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import {
  GitHubOwnerIcon,
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
  summarizeSidebarGroupActivity,
  withSessionSendStates,
  SidebarSessionTitleText,
  SessionRowOpenedByMenuItems,
  buildSessionRowOpenedByTreeSlot,
  SidebarBranchSegment,
  type SidebarRowKind,
  type SessionRowOpenedByTreeSlot,
  SIDEBAR_ROW_LIST_CLASS,
  SIDEBAR_ROW_TEXT_CLASS,
  SIDEBAR_CAPTION_TEXT_CLASS,
} from '@/components/sidebar-row-shared';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
import { sidebarShowBranchNamesAtom } from '@/atoms/sidebar-state';
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
  SessionHistoryBackendKind,
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
  historyBackend?: SessionHistoryBackendKind;
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
  /**
   * Set for a Project group conversation: `subtitle` is the group's name and
   * the project line shows the group mark instead of a folder.
   */
  projectGroup?: boolean;
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
  return <div {...stylex.props(updatedStyles.headerAction)}>{action}</div>;
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
 * Project line in Updated mode. Local rows use the folder name (`subtitle`);
 * GitHub rows use the repo full name; chat rows fall back to the section label
 * ("Chats") so a mixed list still says where the row lives.
 */
export function resolveUpdatedItemProjectLabel(item: SidebarUpdatedItem): string | null {
  const subtitle = item.subtitle?.trim();
  if (subtitle) return subtitle;
  const section = item.sectionLabel.trim();
  return section || null;
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
  /**
   * Updated organize mode mixes sessions from every project into one recency
   * list, so top-level rows show a second line: folder / GitHub owner mark +
   * project name. Nested opened Sessions skip it — they already sit under a
   * parent that carries the project. Workspace-mode Pinned omits this because
   * those rows still live next to their project groups.
   */
  showProjectContext?: boolean;
  /**
   * When true, rows that carry a branch show it after the project segment on
   * the same second line. Read from the shared
   * `sidebarShowBranchNamesAtom`; the Workspace rows use the same preference
   * for their branch/time line.
   */
  showBranchContext?: boolean;
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
  showProjectContext = false,
}: SidebarUpdatedSessionListProps) {
  const { t } = useTranslation();
  const showBranchContext = useAtomValue(sidebarShowBranchNamesAtom);
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

  const sendStates = useAtomValue(sessionSendStatesAtom);
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
            // A folded bucket still says whether anything inside needs the user.
            collapsedActivity: summarizeSidebarGroupActivity(
              withSessionSendStates(bucket.items, (item) => item.id, sendStates)
            ),
          };
        }
        return {
          collapsedActivity: null,
          overflows: updatedBucketOverflowsPreview(bucket.items),
          nodes: getVisibleUpdatedItemTree(
            bucket.items,
            canToggleFullBucket,
            Boolean(showFullBuckets?.[bucket.key]),
            collapsedOpenedBySessionIds
          ),
        };
      }),
    [
      buckets,
      canToggleFullBucket,
      collapsedBuckets,
      collapsedOpenedBySessionIds,
      sendStates,
      showFullBuckets,
    ]
  );

  if (isLoading && items.length === 0) {
    return (
      <div {...stylex.props(updatedStyles.listStack)}>
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
      <div {...stylex.props(updatedStyles.listStack)}>
        {headerAction ? <HeaderActionRow action={headerAction} /> : null}
        <div className={cn(stylex.props(updatedStyles.emptyCard).className, className)}>
          <div {...stylex.props(updatedStyles.emptyTitle)}>{merged.emptyTitle}</div>
          <div {...stylex.props(updatedStyles.emptyDescription)}>{merged.emptyDescription}</div>
        </div>
      </div>
    );
  }

  return (
    <Tooltip.Provider>
      <div className={cn(stylex.props(updatedStyles.listStack).className, className)}>
        {buckets.map((bucket, bucketIndex) => {
          const bucketHeaderAction = bucketIndex === 0 ? headerAction : null;
          const collapsed = Boolean(collapsedBuckets?.[bucket.key]);
          const handleToggle = () => {
            if (!canToggleBucket) return;
            onToggleBucket?.(bucket.key);
          };
          const showFull = Boolean(showFullBuckets?.[bucket.key]);
          const {
            overflows,
            nodes: visibleNodes,
            collapsedActivity,
          } = bucketTrees[bucketIndex] ?? {
            overflows: false,
            nodes: EMPTY_TREE_NODES,
            collapsedActivity: null,
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
                'group',
                stylex.props(updatedStyles.bucket, collapsed && updatedStyles.collapsedBucket)
                  .className
              )}
            >
              {/* Same shared section header as Workspace mode, so section labels
                  read identically (13px medium) across organize modes. */}
              <SidebarSectionHeader
                label={bucket.label}
                collapsed={collapsed}
                activity={collapsedActivity}
                action={bucketHeaderAction}
                isMobile={isMobile}
                toggleLabel={toggleBucketLabel}
                onToggleCollapsed={canToggleBucket ? handleToggle : undefined}
              />
              {!collapsed ? (
                <div className={SIDEBAR_ROW_LIST_CLASS}>
                  {visibleNodes.map((node, nodeIndex) => {
                    const openedByTree = buildSessionRowOpenedByTreeSlot(node, t, () =>
                      handleToggleOpenedBySessions(node.item.id)
                    );
                    const prevNode = visibleNodes[nodeIndex - 1];
                    const treeSlot: SessionRowOpenedByTreeSlot | undefined =
                      openedByTree?.kind === 'child' && (showProjectContext || showBranchContext)
                        ? {
                            ...openedByTree,
                            isFirstChild: prevNode?.depth === 0,
                            tallOpener: true,
                          }
                        : openedByTree;
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
                          showProjectContext={showProjectContext}
                          showBranchContext={showBranchContext}
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
                          openedByTree={treeSlot}
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
                      {...stylex.props(updatedStyles.showMore)}
                      aria-label={toggleFullListLabel}
                      onClick={() => onToggleFullBucket?.(bucket.key)}
                    >
                      <span {...stylex.props(updatedStyles.showMoreIcon)} aria-hidden="true" />
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
    </Tooltip.Provider>
  );
});

SidebarUpdatedSessionList.displayName = 'SidebarUpdatedSessionList';

function UpdatedGitHubOwnerMark({ repoFullName }: { repoFullName: string | null }) {
  return <GitHubOwnerIcon repoFullName={repoFullName} {...stylex.props(updatedStyles.ownerIcon)} />;
}

function UpdatedItemProjectLine({ item }: { item: SidebarUpdatedItem }) {
  const label = resolveUpdatedItemProjectLabel(item);
  if (!label) return null;
  const repoFullName = item.repoFullName ?? (item.kind === 'github' ? label : null);
  const isGithub = item.kind === 'github';
  const mark = item.projectGroup ? (
    <Folders
      {...stylex.props(updatedStyles.projectGroupGlyph)}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  ) : isGithub ? (
    <UpdatedGitHubOwnerMark repoFullName={repoFullName} />
  ) : item.kind === 'local' ? (
    <Folder {...stylex.props(updatedStyles.glyph12)} strokeWidth={1.75} aria-hidden="true" />
  ) : (
    <MessageCircle {...stylex.props(updatedStyles.glyph12)} strokeWidth={1.75} aria-hidden="true" />
  );
  return (
    <div
      data-sidebar-updated-project={item.kind}
      className={cn(
        stylex.props(updatedStyles.projectLine, sidebarSurface.meta).className,
        SIDEBAR_CAPTION_TEXT_CLASS
      )}
    >
      <span
        className={cn(
          stylex.props(
            updatedStyles.projectMark,
            isGithub ? updatedStyles.githubMark : updatedStyles.smallMark
          ).className
        )}
      >
        {mark}
      </span>
      <span {...stylex.props(updatedStyles.projectLabel)}>{label}</span>
    </div>
  );
}

type UpdatedItemRowProps = {
  item: SidebarUpdatedItem;
  now: Date;
  selected: boolean;
  isMobile: boolean;
  showPinnedIcon: boolean;
  showProjectContext?: boolean;
  showBranchContext?: boolean;
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
  showProjectContext = false,
  showBranchContext = false,
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
        if (openSessionOnModifiedClick(event, item.id)) return;
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

  const isNestedChild = openedByTree?.kind === 'child';
  const showProjectLine = showProjectContext && !isNestedChild;
  // The branch rides on the same second line as the project segment; nested
  // children skip it like the project context does.
  const showBranchLine = showBranchContext && Boolean(branchName) && !isNestedChild;
  const showMetaLine = showProjectLine || showBranchLine;
  const projectLabel = showProjectLine ? resolveUpdatedItemProjectLabel(item) : null;
  const titleNode = (
    <SidebarSessionTitleText
      sessionId={item.id}
      selected={showSelectedState}
      className={
        stylex.props(sidebarSurface.title, showSelectedState && sidebarSurface.titleSelected)
          .className
      }
    >
      {item.title}
    </SidebarSessionTitleText>
  );
  const rowAriaLabel = projectLabel ? `${item.title}, ${projectLabel}` : item.title;

  const [rowMenuOpen, setRowMenuOpen] = useState(false);

  const row = (
    <div
      role={!useAnchor && onSelect ? 'button' : undefined}
      tabIndex={!useAnchor && onSelect ? 0 : undefined}
      aria-label={!useAnchor && onSelect ? rowAriaLabel : undefined}
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
        'group/row',
        // Hover marks the row with its fill only; the title keeps its color.
        // Unselected titles sit below the reading column's brightness.
        stylex.props(
          stylex.defaultMarker(),
          updatedStyles.row,
          onSelect ? updatedStyles.clickable : updatedStyles.staticRow,
          sidebarSurface.row,
          showMetaLine ? sidebarSurface.tall : sidebarSurface.snug,
          showSelectedState
            ? sidebarSurface.selected
            : onSelect && !isMobile && sidebarSurface.hover,
          !showSelectedState && onSelect && !isMobile && rowMenuOpen && updatedStyles.rowMenuOpen
        ).className,
        // Keyboard-only focus ring — see SessionList: plain :focus-within also
        // matches after mouse clicks via the overlay <a> and left a permanent
        // inset ring on the selected row.
        useAnchor &&
          'has-[a:focus-visible]:outline-hidden has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-sidebar-ring/40'
      )}
      onClick={
        useAnchor
          ? undefined
          : (event) => {
              if (!onSelect) return;
              if (openSessionOnModifiedClick(event, item.id)) return;
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
          aria-label={rowAriaLabel}
          {...stylex.props(updatedStyles.anchor)}
          // The overlay anchor covers the row, so it is what a drag starts on;
          // left draggable it would drag its link instead.
          draggable={false}
          onClick={handleAnchorClick}
        />
      ) : null}

      <div
        className={cn(
          stylex.props(updatedStyles.rowBody, isMobile && updatedStyles.mobileRowBody).className,
          SIDEBAR_ROW_TEXT_CLASS
        )}
      >
        <div className={cn(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}>
          <SessionRowLeadingSlot
            showMenuButton={hasMenuActions}
            menuLabel={contextMenuLabels.moreActions}
            openedByTree={openedByTree}
            fadeClassName={stylex.props(updatedStyles.rowFade).className}
            restPointerClassName={stylex.props(updatedStyles.rowRestPointer).className}
            revealClassName={stylex.props(updatedStyles.rowReveal).className}
          />
        </div>
        {item.owner ? (
          <span
            className={cn(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}
          >
            <SessionRowAuthorAvatar author={item.owner} />
          </span>
        ) : null}
        {showPinnedIcon && item.isPinned ? (
          <span
            className={cn(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}
          >
            <Pin aria-hidden="true" {...stylex.props(updatedStyles.pin)} />
          </span>
        ) : null}
        <div
          className={
            stylex.props(updatedStyles.titleColumn, showMetaLine && updatedStyles.titleWithMeta)
              .className
          }
        >
          <div
            className={cn(
              stylex.props(updatedStyles.titleLine).className,
              SIDEBAR_ROW_LINE_CLASS,
              SIDEBAR_ROW_TEXT_CLASS
            )}
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
          {showMetaLine ? (
            <div data-sidebar-session-meta="" {...stylex.props(updatedStyles.metaLine)}>
              {showProjectLine ? <UpdatedItemProjectLine item={item} /> : null}
              {showBranchLine ? <SidebarBranchSegment branchName={branchName} /> : null}
            </div>
          ) : null}
        </div>
        {/* Keep PR at the right edge. Line totals stay in the hover card. */}
        <div className={cn(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}>
          <SidebarRowEndSlot
            sessionId={item.id}
            isWaitingPermission={item.isWaitingPermission}
            isWorking={item.isWorking}
            hasUnreadMessages={item.hasUnreadMessages}
            fadeClassName={stylex.props(updatedStyles.rowFade).className}
            restIcon={
              showPr ||
              showMergeablePill ||
              isMobile ||
              (item.kind === 'local' && item.isWorktree) ? (
                <span
                  className={cn(
                    stylex.props(
                      updatedStyles.restMetrics,
                      sidebarSurface.faint,
                      useAnchor && updatedStyles.anchoredMetrics
                    ).className,
                    SIDEBAR_CAPTION_TEXT_CLASS
                  )}
                >
                  {isMobile ? <span>{relativeTime}</span> : null}
                  {showMergeablePill ? <SessionMergeablePill /> : null}
                  <SessionRowWorktreeIndicator
                    isWorktree={item.kind === 'local' && item.isWorktree}
                  />
                  {showPr ? (
                    <SessionPrIcon compact prStatus={prStatus} prCiState={item.prCiState} />
                  ) : null}
                </span>
              ) : undefined
            }
            archive={
              showInlineArchive ? (
                <SidebarRowArchiveButton
                  label={archiveTooltipLabel}
                  confirmLabel={archiveConfirmLabel}
                  onConfirm={() => onArchive?.(item.id)}
                  revealClassName={stylex.props(updatedStyles.rowReveal).className}
                />
              ) : undefined
            }
          />
        </div>
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
            icon: <Archive {...stylex.props(updatedStyles.glyph16)} />,
            hideLabel: item.kind === 'chat',
            className: stylex.props(updatedStyles.archiveAction).className,
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
    <ContextMenu.Root onOpenChange={setRowMenuOpen}>
      <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      <ContextMenu.Content className="min-w-[180px]">
        <SessionRowOpenedByMenuItems
          opener={openedByOpener}
          goToOpenerLabel={contextMenuLabels.goToOpenerSession}
        />
        {canTogglePin ? (
          <ContextMenu.Item
            icon={item.isPinned ? PinOff : Pin}
            onClick={() => {
              onTogglePin?.(item.id, !item.isPinned);
            }}
          >
            {item.isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
          </ContextMenu.Item>
        ) : null}
        {canMarkUnread ? (
          <ContextMenu.Item
            icon={Mail}
            onClick={() => {
              onMarkUnread?.(item.id);
            }}
          >
            {contextMenuLabels.markUnread}
          </ContextMenu.Item>
        ) : null}
        {canRename ? (
          <ContextMenu.Item
            icon={Pencil}
            onClick={() => {
              onBeginRename(item.id, item.title);
            }}
          >
            {contextMenuLabels.rename}
          </ContextMenu.Item>
        ) : null}
        {(openedByOpener || canTogglePin || canMarkUnread || canRename) &&
        (canCopyUrl || branchName || shareMenuState) ? (
          <ContextMenu.Separator />
        ) : null}
        {canCopyUrl ? (
          <ContextMenu.Item
            icon={Link2}
            onClick={() => {
              onCopyUrl?.(item.id);
            }}
          >
            {contextMenuLabels.copyUrl}
          </ContextMenu.Item>
        ) : null}
        {branchName ? (
          <ContextMenu.Item
            icon={GitBranch}
            onClick={() => {
              void navigator.clipboard.writeText(branchName).catch(() => {});
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
              onShareWithTeam?.(item.id);
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
          canTogglePin ||
          canMarkUnread ||
          canRename ||
          canCopyUrl ||
          branchName ||
          shareMenuState) &&
        (handlePrOpen || (canGoToOpener && openerSessionId) || isElectronRenderer()) ? (
          <ContextMenu.Separator />
        ) : null}
        {handlePrOpen ? (
          <ContextMenu.Item
            icon={GitPullRequest}
            onClick={() => {
              handlePrOpen();
            }}
          >
            {contextMenuLabels.openPr}
          </ContextMenu.Item>
        ) : null}
        <SessionRowOpenedByMenuItems
          goToOpener={
            canGoToOpener && openerSessionId
              ? () => onSelect?.(openerRootSessionId ?? openerSessionId, openerSessionId)
              : undefined
          }
          goToOpenerLabel={contextMenuLabels.goToOpenerSession}
        />
        <SessionWindowMenuItem sessionId={item.id} />
        {(openedByOpener ||
          canTogglePin ||
          canMarkUnread ||
          canRename ||
          canCopyUrl ||
          branchName ||
          shareMenuState ||
          handlePrOpen ||
          (canGoToOpener && openerSessionId) ||
          isElectronRenderer()) &&
        canArchive ? (
          <ContextMenu.Separator />
        ) : null}
        {canArchive ? (
          <ContextMenu.Item
            icon={Archive}
            onClick={() => {
              onArchive?.(item.id);
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
      historyBackend={item.historyBackend}
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

const updatedStyles = stylex.create({
  listStack: { display: 'flex', flexDirection: 'column' },
  headerAction: {
    display: 'flex',
    height: themeSpace[7],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: themeSpace[2],
  },
  emptyCard: {
    marginTop: themeSpace[2],
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: 'hsl(var(--sidebar-border) / 0.7)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[4],
  },
  emptyTitle: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.sidebarForeground,
  },
  emptyDescription: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.sidebarForegroundMuted,
  },
  bucket: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[0.5],
    marginBottom: { default: themeSpace[4], ':last-child': 0 },
  },
  collapsedBucket: { marginBottom: { default: themeSpace[1], ':last-child': 0 } },
  showMore: {
    display: 'flex',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    padding: themeSpace[2],
    textAlign: 'left',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: {
      default: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
      '@media (hover: hover)': { ':hover': themeColors.sidebarHoverForeground },
    },
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': themeColors.sidebarHover },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  showMoreIcon: {
    display: 'flex',
    width: themeSpace[4],
    height: themeSpace[4],
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownerIcon: { width: themeSpace[4], height: themeSpace[4], opacity: 0.6 },
  glyph12: { width: themeSpace[3], height: themeSpace[3] },
  projectGroupGlyph: {
    width: 'calc(var(--spacing) * 3)',
    height: 'calc(var(--spacing) * 3)',
  },
  glyph16: { width: themeSpace[4], height: themeSpace[4] },
  projectLine: { display: 'flex', minWidth: 0, alignItems: 'center', gap: themeSpace[1] },
  projectMark: { display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  githubMark: {
    width: themeSpace[4],
    height: themeSpace[4],
    overflow: 'hidden',
    borderRadius: '3px',
  },
  smallMark: { width: themeSpace[3], height: themeSpace[3], opacity: 0.8 },
  projectLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  row: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    alignItems: 'flex-start',
    textAlign: 'left',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
  },
  clickable: { cursor: 'pointer' },
  staticRow: { cursor: 'default' },
  rowMenuOpen: { backgroundColor: 'hsl(var(--sidebar-hover) / 1)' },
  rowFade: {
    opacity: {
      default: null,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-sidebar-updated-id]):hover')]: 0,
      },
      [stylex.when.ancestor(':is([data-sidebar-updated-id][data-menu-open])')]: 0,
    },
  },
  rowRestPointer: {
    pointerEvents: {
      default: null,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-sidebar-updated-id]):hover')]: 'none',
      },
      [stylex.when.ancestor(':is([data-sidebar-updated-id][data-menu-open])')]: 'none',
    },
  },
  rowReveal: {
    opacity: {
      default: null,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-sidebar-updated-id]):hover')]: 1,
      },
      [stylex.when.ancestor(':is([data-sidebar-updated-id][data-menu-open])')]: 1,
    },
    pointerEvents: {
      default: null,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-sidebar-updated-id]):hover')]: 'auto',
      },
      [stylex.when.ancestor(':is([data-sidebar-updated-id][data-menu-open])')]: 'auto',
    },
  },
  anchor: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    borderRadius: themeRadius.md,
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  rowBody: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'flex-start',
    gap: themeSpace[2],
  },
  mobileRowBody: { gap: themeSpace[1.5] },
  lineSlot: { display: 'flex', flexShrink: 0, alignItems: 'center' },
  pin: {
    position: 'relative',
    top: '-1px',
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
    color: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
  },
  titleColumn: { minWidth: 0, flex: '1 1 0%' },
  titleWithMeta: { display: 'flex', flexDirection: 'column', gap: themeSpace[1] },
  titleLine: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  metaLine: { display: 'flex', minWidth: 0, alignItems: 'center', gap: themeSpace[1.5] },
  restMetrics: {
    display: 'flex',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontVariantNumeric: 'tabular-nums',
  },
  anchoredMetrics: { zIndex: 20 },
  archiveAction: {
    backgroundColor: themeColors.sidebarHover,
    color: themeColors.sidebarHoverForeground,
  },
});
