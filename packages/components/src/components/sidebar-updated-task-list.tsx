import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  Archive,
  GitBranch,
  GitPullRequest,
  Link2,
  LockKeyhole,
  Pencil,
  Pin,
  PinOff,
  Users,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';
/** The legacy flat Updated list's own layout and ink. */
const updatedStyles = stylex.create({
  /** A list's own column. */
  listStack: { display: 'flex', flexDirection: 'column' },
  /** The right-aligned row that hosts the list's header action. */
  headerActionRow: {
    display: 'flex',
    height: themeSpace[7],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  /** The empty state's own card. */
  emptyCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: themeSpace[1],
    marginTop: themeSpace[2],
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
  /** The rows under a bucket. */
  rowStack: { display: 'flex', flexDirection: 'column', gap: '1px' },
  /** The row that shows the rest of a bucket. */
  showMoreBox: {
    display: 'flex',
    height: themeSpace[4],
    width: themeSpace[4],
    alignItems: 'center',
    justifyContent: 'center',
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
  /** A row's own body. */
  rowBody: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  /** The pin that marks a pinned row. */
  pin: {
    position: 'relative',
    top: '-1px',
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
    color: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
  },
  glyph16: { width: themeSpace[4], height: themeSpace[4] },
  archiveAction: {
    backgroundColor: themeColors.sidebarHover,
    color: themeColors.sidebarHoverForeground,
  },
  bucket: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 0.5)',
  },
  expandedBucket: {
    marginBottom: {
      default: 'calc(var(--spacing) * 4)',
      ':last-child': 'calc(var(--spacing) * 0)',
    },
  },
  collapsedBucket: {
    marginBottom: {
      default: 'calc(var(--spacing) * 1)',
      ':last-child': 'calc(var(--spacing) * 0)',
    },
  },
  showMore: {
    display: 'flex',
    userSelect: 'none',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    textAlign: 'left',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--tw-leading, var(--text-xs--line-height))',
    color: {
      default: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted) / 1) 80%, transparent)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--sidebar-hover-foreground) / 1)' },
    },
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': 'hsl(var(--sidebar-hover) / 1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  renameInput: {
    minWidth: 0,
    width: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    backgroundColor: 'transparent',
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
    borderWidth: '1px',
    borderStyle: 'var(--tw-border-style)',
    borderColor: 'color-mix(in oklab, hsl(var(--sidebar-ring) / 1) 40%, transparent)',
    borderRadius: 'var(--radius-sm)',
    paddingInline: 'calc(var(--spacing) * 1)',
    marginInline: 'calc(var(--spacing) * -1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--tw-leading, var(--text-sm--line-height))',
    fontWeight: 'var(--font-weight-normal)',
  },
  title: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 'var(--font-weight-normal)',
    color: 'hsl(var(--sidebar-row-foreground) / 1)',
  },
  selectedTitle: { color: 'hsl(var(--sidebar-selection-foreground) / 1)' },
  row: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    textAlign: 'left',
    borderWidth: '1px',
    borderStyle: 'var(--tw-border-style)',
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  rowHover: {
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--sidebar-hover) / 1)' },
    },
    color: {
      default: null,
      '@media (hover: hover)': { ':hover': 'hsl(var(--sidebar-hover-foreground) / 1)' },
    },
  },
  rowSelected: {
    backgroundColor: 'hsl(var(--sidebar-selection) / 1)',
    color: 'hsl(var(--sidebar-selection-foreground) / 1)',
  },
  pointer: { cursor: 'pointer' },
  defaultCursor: { cursor: 'default' },
  titleBox: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--tw-leading, var(--text-sm--line-height))',
  },
  editingAnchorTitle: { position: 'relative', zIndex: 20 },
  restingMetrics: {
    display: 'flex',
    userSelect: 'none',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted) / 1) 80%, transparent)',
  },
  anchorMetrics: { zIndex: 20 },
});
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { Tooltip } from '@lody/ui/tooltip';
import { ContextMenu } from '@lody/ui/context-menu';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import {
  SessionPrIcon,
  SessionMergeablePill,
  SessionRowLeadingSlot,
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SidebarListSkeleton,
  SidebarSectionHeader,
  SidebarSessionTitleText,
  type SidebarRowKind,
} from '@/components/sidebar-row-shared';
import { SessionInfoHoverCard } from '@/components/session-info-hover-card';
import type {
  LocalProjectHistoryProvider,
  PrStatus,
  SessionPullRequestCiState,
  SessionPullRequestReadiness,
} from '@lody/shared';
import type { TaskListPullRequestOpen, TaskListTaskOwner } from '@/components/task-list';
import { SessionSharingIndicator } from '@/components/session-sharing';
import type { SessionSharingState } from '@/lib/session-sharing';

export type SidebarUpdatedItemKind = SidebarRowKind;

export type SidebarUpdatedItem = {
  id: string;
  kind: SidebarUpdatedItemKind;
  title: string;
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
  owner?: TaskListTaskOwner | null;
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

export type SidebarUpdatedTaskListLabels = {
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
  copyUrl: string;
  shareWithTeam: string;
  onlyOwnerCanShare: string;
  registerDeviceToShare: string;
  loadingSharing: string;
  copyBranch: string;
};

/**
 * Standalone right-aligned row hosting {@link SidebarUpdatedTaskListProps.headerAction}
 * when there is no first bucket header to attach it to (loading skeleton / empty
 * state), so the control stays reachable in every list state.
 */
function HeaderActionRow({ action }: { action: ReactNode }) {
  return <div {...stylex.props(updatedStyles.headerActionRow)}>{action}</div>;
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
 * preview pattern in TaskList, but with a higher threshold because Updated
 * mode is a flat firehose rather than a small per-repo group.
 */
export const SHOW_FULL_BUCKET_THRESHOLD = 20;

export function getVisibleUpdatedItems(
  orderedItems: SidebarUpdatedItem[],
  canToggleFullList: boolean,
  showFull: boolean
): SidebarUpdatedItem[] {
  if (!canToggleFullList || showFull || orderedItems.length <= SHOW_FULL_BUCKET_THRESHOLD) {
    return orderedItems;
  }
  return orderedItems.slice(0, SHOW_FULL_BUCKET_THRESHOLD);
}

export type SidebarUpdatedTaskListProps = {
  items: SidebarUpdatedItem[];
  now: Date;
  selectedItemId?: string | null;
  isMobile?: boolean;
  /** Whether pinned rows show a leading pin icon. */
  showPinnedIcon?: boolean;
  /**
   * When true and `items` is empty, render a skeleton rather than the empty
   * state. Workspace mode uses the same approach for `TaskList` so the two
   * organize modes don't disagree about what "loading" looks like.
   */
  isLoading?: boolean;
  className?: string;
  labels?: Partial<SidebarUpdatedTaskListLabels>;
  onSelectItem?: (id: string) => void;
  /**
   * Archive an item. When provided, desktop rows reveal an Archive button on hover
   * (replacing the relative timestamp) with a two-step Archive → Confirm flow, and
   * mobile rows expose the same action via left-swipe + tap-to-confirm.
   */
  onArchiveItem?: (id: string) => void;
  /**
   * Inline-rename an item. When provided, rows expose Rename via the desktop
   * context menu and double-click, matching `TaskList` behavior.
   */
  onRenameItem?: (id: string, nextTitle: string) => void;
  /**
   * Toggle pin. Mirrors `TaskList.onTogglePinTask`: receives the next desired
   * pin state.
   */
  onTogglePinItem?: (id: string, nextPinned: boolean) => void;
  /** Copy a shareable session URL for the item. */
  onCopyItemUrl?: (id: string) => void;
  /** Open the share-with-team confirmation for a private session. */
  onShareItemWithTeam?: (id: string) => void;
  /**
   * Open the GitHub PR for a row. Only invoked for `kind === 'github'` items
   * with a `prUrl`. Mirrors `TaskList.onOpenPullRequest` so both organize
   * modes route PR opens through the same internal navigation path.
   */
  onOpenPullRequest?: (request: TaskListPullRequestOpen) => void;
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

const defaultLabels: SidebarUpdatedTaskListLabels = {
  heading: 'Chats',
  emptyTitle: 'Nothing yet',
  emptyDescription: 'Start a chat or open a worktree to see it here.',
};

export const SidebarUpdatedTaskList = memo(function SidebarUpdatedTaskList({
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
}: SidebarUpdatedTaskListProps) {
  const { t } = useTranslation();
  const merged: SidebarUpdatedTaskListLabels = useMemo(
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

  // Inline rename: scope the editing state at the list level so opening the
  // context menu on row A while row B is editing automatically tears down B's
  // input. (Same pattern as TaskList.)
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const renameFinalizedRef = useRef(false);
  const beginRename = useCallback((id: string, currentTitle: string) => {
    renameFinalizedRef.current = false;
    setEditingItemId(id);
    setDraftTitle(currentTitle);
  }, []);
  const cancelRename = useCallback(() => {
    renameFinalizedRef.current = true;
    setEditingItemId(null);
    setDraftTitle('');
  }, []);
  const commitRename = useCallback(
    (id: string, originalTitle: string) => {
      if (renameFinalizedRef.current) return;
      renameFinalizedRef.current = true;
      const next = draftTitle.replace(/[\r\n]+/g, ' ').trim();
      if (next && next !== originalTitle.trim()) {
        onRenameItem?.(id, next);
      }
      setEditingItemId(null);
      setDraftTitle('');
    },
    [draftTitle, onRenameItem]
  );

  const buckets = useMemo<SidebarUpdatedBucket[]>(() => {
    if (!items.length) return [];
    return [{ key: 'all', label: merged.heading, items: sortUpdatedItems(items) }];
  }, [items, merged.heading]);

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
        <div className={clsx(stylex.props(updatedStyles.emptyCard).className, className)}>
          <div {...stylex.props(updatedStyles.emptyTitle)}>{merged.emptyTitle}</div>
          <div {...stylex.props(updatedStyles.emptyDescription)}>{merged.emptyDescription}</div>
        </div>
      </div>
    );
  }

  const canToggleBucket = typeof onToggleBucket === 'function';
  const canToggleFullBucket = typeof onToggleFullBucket === 'function';

  return (
    <Tooltip.Provider>
      <div className={clsx(stylex.props(updatedStyles.listStack).className, className)}>
        {buckets.map((bucket, bucketIndex) => {
          const bucketHeaderAction = bucketIndex === 0 ? headerAction : null;
          const collapsed = Boolean(collapsedBuckets?.[bucket.key]);
          const handleToggle = () => {
            if (!canToggleBucket) return;
            onToggleBucket?.(bucket.key);
          };
          const showFull = Boolean(showFullBuckets?.[bucket.key]);
          const overflows = bucket.items.length > SHOW_FULL_BUCKET_THRESHOLD;
          const visibleItems = getVisibleUpdatedItems(bucket.items, canToggleFullBucket, showFull);
          const showToggleFullList = canToggleFullBucket && overflows && !collapsed;
          const toggleFullListLabel = showFull
            ? t('sessions.showLess', 'Show less')
            : t('sessions.showAll', 'Show all ({{count}})', { count: bucket.items.length });
          return (
            <div
              key={bucket.key}
              className={cn(
                'group',
                stylex.props(
                  updatedStyles.bucket,
                  collapsed ? updatedStyles.collapsedBucket : updatedStyles.expandedBucket
                ).className
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
                <div {...stylex.props(updatedStyles.rowStack)}>
                  {visibleItems.map((item) => (
                    <UpdatedItemRow
                      key={item.id}
                      item={item}
                      now={now}
                      selected={item.id === selectedItemId}
                      isMobile={isMobile}
                      showPinnedIcon={showPinnedIcon}
                      href={getItemHref?.(item.id)}
                      isEditing={editingItemId === item.id}
                      draftTitle={draftTitle}
                      onSelect={onSelectItem}
                      onArchive={onArchiveItem}
                      onRename={onRenameItem}
                      onTogglePin={onTogglePinItem}
                      onCopyUrl={onCopyItemUrl}
                      onShareWithTeam={onShareItemWithTeam}
                      onOpenPullRequest={onOpenPullRequest}
                      onBeginRename={beginRename}
                      onChangeDraft={setDraftTitle}
                      onCommitRename={commitRename}
                      onCancelRename={cancelRename}
                      contextMenuLabels={contextMenuLabels}
                      archiveTooltipLabel={archiveLabels.tooltip}
                      archiveActionLabel={archiveLabels.action}
                      archiveConfirmLabel={archiveLabels.confirm}
                    />
                  ))}
                  {showToggleFullList ? (
                    <button
                      type="button"
                      data-sidebar-updated-show-more={bucket.key}
                      {...stylex.props(updatedStyles.showMore)}
                      aria-label={toggleFullListLabel}
                      onClick={() => onToggleFullBucket?.(bucket.key)}
                    >
                      <span {...stylex.props(updatedStyles.showMoreBox)} aria-hidden="true" />
                      <span>{toggleFullListLabel}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Tooltip.Provider>
  );
});

SidebarUpdatedTaskList.displayName = 'SidebarUpdatedTaskList';

type UpdatedItemRowProps = {
  item: SidebarUpdatedItem;
  now: Date;
  selected: boolean;
  isMobile: boolean;
  showPinnedIcon: boolean;
  href?: string;
  isEditing: boolean;
  draftTitle: string;
  onSelect?: (id: string) => void;
  onArchive?: (id: string) => void;
  onRename?: (id: string, nextTitle: string) => void;
  onTogglePin?: (id: string, nextPinned: boolean) => void;
  onCopyUrl?: (id: string) => void;
  onShareWithTeam?: (id: string) => void;
  onOpenPullRequest?: (request: TaskListPullRequestOpen) => void;
  onBeginRename: (id: string, currentTitle: string) => void;
  onChangeDraft: (next: string) => void;
  onCommitRename: (id: string, originalTitle: string) => void;
  onCancelRename: () => void;
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
  isEditing,
  draftTitle,
  onSelect,
  onArchive,
  onRename,
  onTogglePin,
  onCopyUrl,
  onShareWithTeam,
  onOpenPullRequest,
  onBeginRename,
  onChangeDraft,
  onCommitRename,
  onCancelRename,
  contextMenuLabels,
  archiveTooltipLabel,
  archiveActionLabel,
  archiveConfirmLabel,
}: UpdatedItemRowProps) {
  const showSelectedState = selected;
  // Editing rows must not turn into anchors: the overlay <a> would intercept
  // clicks on the input. Same trick as TaskList.
  const useAnchor = typeof href === 'string' && href.length > 0 && !isEditing;
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
  // only github rows pass through TaskList's diff path.
  const hasChanges = item.kind === 'github' && (addedLines !== 0 || deletedLines !== 0);
  const isMergeable = showPr && item.prReadiness === 'y';
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
  // Desktop-only context menu mirrors TaskList's: rename / pin / archive /
  // copyUrl / copyBranch. Mobile users reach archive via swipe and lack the
  // other actions in both organize modes — keeping it consistent rather than
  // inventing a new mobile entry point here.
  const hasMenuActions =
    !isMobile &&
    (canRename ||
      canTogglePin ||
      canArchive ||
      canCopyUrl ||
      Boolean(shareMenuState) ||
      Boolean(branchName) ||
      (showPr && Boolean(onOpenPullRequest)));
  const handlePrOpen =
    onOpenPullRequest && prUrl
      ? () =>
          onOpenPullRequest({
            taskId: item.id,
            repoFullName,
            prUrl,
            prNumber,
          })
      : undefined;

  const titleNode = isEditing ? (
    <input
      type="text"
      autoFocus
      value={draftTitle}
      onChange={(e) => onChangeDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommitRename(item.id, item.title);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancelRename();
        }
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => onCommitRename(item.id, item.title)}
      onFocus={(e) => e.currentTarget.select()}
      {...stylex.props(updatedStyles.renameInput)}
    />
  ) : (
    <SidebarSessionTitleText
      sessionId={item.id}
      selected={showSelectedState}
      {...stylex.props(updatedStyles.title, showSelectedState && updatedStyles.selectedTitle)}
    >
      {item.title}
    </SidebarSessionTitleText>
  );

  const [rowMenuOpen, setRowMenuOpen] = useState(false);

  const row = (
    <div
      role={!useAnchor && onSelect ? 'button' : undefined}
      tabIndex={!useAnchor && onSelect ? 0 : undefined}
      aria-current={selected ? 'page' : undefined}
      data-id={`updated:${item.id}`}
      data-scope-item="row"
      data-sidebar-updated-id={item.id}
      data-sidebar-updated-kind={item.kind}
      data-menu-open={rowMenuOpen ? '' : undefined}
      className={cn(
        // Named group ('row') so the archive hover-reveal scopes to the hovered row
        // only. The bucket wrapper above also uses an (unnamed) `group` for its
        // header chevron — without naming, hovering any row would match the bucket's
        // group-hover and reveal every row's archive button at once.
        'group/row',
        stylex.props(
          updatedStyles.row,
          !showSelectedState && onSelect && !isMobile && updatedStyles.rowHover,
          showSelectedState && updatedStyles.rowSelected,
          onSelect ? updatedStyles.pointer : updatedStyles.defaultCursor
        ).className,
        !showSelectedState &&
          onSelect &&
          !isMobile &&
          'data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground',
        // Keyboard-only focus ring — see TaskList: plain :focus-within also
        // matches after mouse clicks via the overlay <a> and left a permanent
        // inset ring on the selected row.
        useAnchor &&
          'has-[a:focus-visible]:outline-hidden has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-sidebar-ring/40'
      )}
      onClick={
        useAnchor
          ? undefined
          : () => {
              if (!onSelect) return;
              if (isEditing) return;
              onSelect(item.id);
            }
      }
      onKeyDown={
        useAnchor
          ? undefined
          : (event) => {
              if (!onSelect) return;
              if (isEditing) return;
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
          {...stylex.props(updatedStyles.anchor)}
          onClick={handleAnchorClick}
        />
      ) : null}

      <div {...stylex.props(updatedStyles.rowBody)}>
        <SessionRowLeadingSlot
          showMenuButton={hasMenuActions}
          menuLabel={contextMenuLabels.moreActions}
          fadeClassName="group-hover/row:opacity-0 group-data-[menu-open]/row:opacity-0"
          revealClassName="group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-data-[menu-open]/row:opacity-100 group-data-[menu-open]/row:pointer-events-auto"
        />
        {showPinnedIcon && item.isPinned ? (
          <Pin aria-hidden="true" {...stylex.props(updatedStyles.pin)} />
        ) : null}
        <div
          {...stylex.props(
            updatedStyles.titleBox,
            useAnchor && isEditing && updatedStyles.editingAnchorTitle
          )}
          // Double-click to rename is scoped to the title only, so double-clicking
          // elsewhere on the row (e.g. the two-step Archive confirm button) cannot
          // accidentally trigger a rename.
          onDoubleClick={(e) => {
            if (!canRename || isEditing) return;
            e.preventDefault();
            e.stopPropagation();
            onBeginRename(item.id, item.title);
          }}
        >
          {titleNode}
        </div>
        {/* Keep PR at the right edge. Line totals stay in the hover card. */}
        <SidebarRowEndSlot
          sessionId={item.id}
          isWaitingPermission={item.isWaitingPermission}
          isWorking={item.isWorking}
          hasUnreadMessages={item.hasUnreadMessages}
          fadeClassName="group-hover/row:opacity-0 group-data-[menu-open]/row:opacity-0"
          restIcon={
            showPr || showMergeablePill || isMobile || item.sharing?.visibility === 'private' ? (
              <span
                {...stylex.props(
                  updatedStyles.restingMetrics,
                  useAnchor && updatedStyles.anchorMetrics
                )}
              >
                {isMobile ? <span>{relativeTime}</span> : null}
                {showMergeablePill ? <SessionMergeablePill /> : null}
                {showPr ? (
                  <SessionPrIcon compact prStatus={prStatus} prCiState={item.prCiState} />
                ) : null}
                {item.sharing ? <SessionSharingIndicator state={item.sharing} /> : null}
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
            icon: <Archive className={stylex.props(updatedStyles.glyph16).className} />,
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
        {handlePrOpen && (canRename || canTogglePin || canArchive || canCopyUrl || branchName) ? (
          <ContextMenu.Separator />
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
        {(canRename || canTogglePin || canArchive) && (canCopyUrl || branchName) ? (
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
