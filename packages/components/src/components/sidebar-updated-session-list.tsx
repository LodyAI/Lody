import { colors as uiColors, shadow as uiShadow } from '@lody/ui/tokens/colors.stylex';
import { corner as uiCorner, radius as uiRadius, text as uiText } from '@lody/ui/tokens/scales.stylex';
import { clsx } from 'clsx';
import { cn } from '@/lib/utils';
import { isElectronRenderer } from '@/lib/electron';
import { openSessionOnModifiedClick } from '@/lib/desktop-window';
import { SessionWindowMenuItem } from './session-window-menu-item';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  clearSessionMentionDrag,
  getInFlightSessionMentionDragId,
  startSessionMentionDrag,
  subscribeSessionMentionDrag,
} from '@/lib/session-mention-drag';
import { useDraggable } from '@dnd-kit/core';
import { DEFAULT_PIN_SECTION_KEY, FOCUS_SECTION_DND_KEY, pinnedRowDndId } from './pinned-rows-dnd';
import {
  beginPinnedDropSettle,
  flyPinnedDropSettle,
  getPinnedDropSettle,
  getPinnedPointerTarget,
  subscribePinnedPointerTarget,
  recordPinnedDragOrigin,
  subscribePinnedDropSettle,
  takePinnedDragOrigin,
} from '@/lib/pinned-drop-settle';
import {
  AlarmClock,
  Archive,
  ArrowUpCircle,
  CheckCircle2,
  Folders,
  Folder,
  FolderInput,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Link2,
  LockKeyhole,
  MailOpen,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Timer,
  Users,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';

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
  SessionRowMenuButton,
  SessionRowWorktreeIndicator,
  SidebarRowActionButton,
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
import { isSidebarBucketCollapsed } from '@/lib/sidebar-status-group';
import {
  buildSnoozePresets,
  buildStatusViewTiers,
  flattenStatusViewRows,
  formatSnoozeCountdown,
  STATUS_VIEW_TIERS,
  statusViewTier,
  type StatusViewSession,
  type StatusViewTier,
} from '@lody/shared';
import { CustomSnoozeDialog, type CustomSnoozeDialogTarget } from './sidebar-status-snooze-dialog';
import { SidebarFocusDndContainer } from './sidebar-status-focus-dnd';
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
import { copyTextToClipboard } from '@/lib/clipboard';

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
   * Nesting is resolved within one rendered section; desktop section placement
   * keeps pinned openers together with their visible opened Sessions.
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
  /** Fractional index for manual ordering in Pinned and Status Focus. */
  orderKey?: string | null;
  /** Epoch ms until which the session is snoozed in Status Later. */
  snoozedUntil?: number | null;
  /** Epoch ms when the session was explicitly settled in Status Settled. */
  settledAt?: number | null;
  /** Epoch ms when the user explicitly restored an inactive session to Focus. */
  focusRestoredAt?: number | null;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  isOffline?: boolean;
  isWaitingPermission?: boolean;
  /** The latest turn ended in failure; the Status view files the row under Needs you. */
  hasFailedTurn?: boolean;
  /** Auto delivery stopped for this conversation's PR and needs the person. */
  deliveryStalled?: boolean;
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
 * recency-sorted list keyed 'all'. The Status organize mode renders one
 * section per {@link StatusViewTier}, keyed by the group, skipping empty
 * groups. Both share the collapse / reveal state maps.
 */
export type SidebarUpdatedBucketKey = 'all' | StatusViewTier;

/** How the list splits its rows: one recency list, or the status groups. */
/** `manual` keeps the caller's order (pinned sections); the others sort by activity. */
export type SidebarUpdatedGrouping = 'recency' | 'status' | 'manual';

/** Row menu entries for moving a pinned conversation between pin sections. */
export type SidebarPinSectionMenu = {
  /** Sections in display order; `null` is the default section. */
  sections: readonly { id: string | null; name: string }[];
  currentSectionId: string | null;
  onMove: (itemId: string, sectionId: string | null) => void;
  onCreate: (itemId: string) => void;
  labels: { moveToSection: string; newSection: string };
};

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
  snooze: string;
  snoozeOneHour: string;
  snoozeLaterToday: string;
  snoozeTomorrowMorning: string;
  snoozeNextWeek: string;
  snoozeCustom: string;
  settle: string;
  moveToFocus: string;
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
  items: SidebarUpdatedItem[];
};

/**
 * The list's sections in render order, each sorted pinned-first then by latest
 * activity. Shared by the renderer and the keyboard navigation model so both
 * walk the same rows.
 */
export function buildSidebarUpdatedBuckets(
  items: SidebarUpdatedItem[],
  grouping: SidebarUpdatedGrouping,
  nowMs: number = Date.now()
): SidebarUpdatedBucket[] {
  // A pin section keeps its header while empty: it is still a drop target.
  if (grouping === 'manual') return [{ key: 'all', items: [...items] }];
  if (!items.length) return [];
  if (grouping === 'recency') return [{ key: 'all', items: sortUpdatedItems(items) }];
  const byId = new Map(items.map((item) => [item.id, item]));
  const tiers = buildStatusViewTiers(items.map(toStatusViewSession), nowMs);
  return STATUS_VIEW_TIERS.flatMap<SidebarUpdatedBucket>((key) => {
    const rows = tiers[key];
    // Keep Focus mounted even when empty so Later/Settled rows can be dragged back into it.
    if (!rows.length) return key === 'focus' ? [{ key, items: [] }] : [];
    return [{ key, items: flattenStatusViewRows(rows).map((row) => byId.get(row.id)!) }];
  });
}

/**
 * One sidebar row as the shared Status view reads it. Pinned rows never reach
 * the Status tiers, so pin fields are left out.
 */
export function toStatusViewSession(item: SidebarUpdatedItem): StatusViewSession {
  return {
    id: item.id,
    title: item.title,
    lastMessageAt: getSortKey(item),
    activityAt: getSortKey(item),
    lastReadAt: null,
    isPinned: false,
    pinSectionId: null,
    orderKey: item.orderKey ?? null,
    snoozedUntil: item.snoozedUntil ?? null,
    settledAt: item.settledAt ?? null,
    focusRestoredAt: item.focusRestoredAt ?? null,
    openedById: SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS.getOpenedBySessionId(item),
    isWorking: Boolean(item.isWorking),
    isWaitingPermission: Boolean(item.isWaitingPermission),
    canManage: true,
    canPrefer: true,
  };
}

/**
 * Whether a section folds past {@link UPDATED_BUCKET_PREVIEW_MAX} rows behind
 * "Show more". Focus and Later list in full when expanded; Settled and Updated
 * recency lists fold past the preview cap.
 */
export function updatedBucketCanFold(key: SidebarUpdatedBucketKey): boolean {
  return key === 'all' || key === 'settled';
}

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
 * latest N and reveals a "Show more" stepper. Mirrors the per-group preview
 * pattern in SessionList, but with a higher threshold because Updated mode is
 * a flat firehose rather than a small per-repo group.
 */
export const UPDATED_BUCKET_PREVIEW_MAX = 20;

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

/** TOP-LEVEL row count — what the preview threshold is measured against. */
export function countUpdatedItemRoots(orderedItems: SidebarUpdatedItem[]): number {
  return countOpenedByTreeRoots(orderedItems, SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS);
}

export function updatedBucketOverflowsPreview(orderedItems: SidebarUpdatedItem[]): boolean {
  return countUpdatedItemRoots(orderedItems) > UPDATED_BUCKET_PREVIEW_MAX;
}

/**
 * Rows this bucket renders, in render order, with their "opened by" geometry.
 * The preview cap counts top-level rows, so it never splits an opener from the
 * Sessions it opened.
 */
export function getVisibleUpdatedItemTree(
  orderedItems: SidebarUpdatedItem[],
  canRevealRows: boolean,
  revealedRows: number,
  collapsedOpenedBySessionIds?: Record<string, boolean>,
  preserveOrder = false
): OpenedBySessionTreeNode<SidebarUpdatedItem>[] {
  const capped = canRevealRows && updatedBucketOverflowsPreview(orderedItems);
  return buildOpenedBySessionTree(orderedItems, {
    ...SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
    isCollapsed: (openerId) => collapsedOpenedBySessionIds?.[openerId] === true,
    // Updated mode IS the recency list: rank each opener by its freshest opened
    // Session so nesting can never bury a just-updated row under a stale opener.
    // A manually ordered pin section keeps its roots where the user put them.
    ...(preserveOrder ? {} : { rootRank: updatedItemRootRank }),
    ...(capped ? { maxRoots: UPDATED_BUCKET_PREVIEW_MAX + revealedRows } : {}),
  });
}

export function getVisibleUpdatedItems(
  orderedItems: SidebarUpdatedItem[],
  canRevealRows: boolean,
  revealedRows: number,
  collapsedOpenedBySessionIds?: Record<string, boolean>,
  preserveOrder = false
): SidebarUpdatedItem[] {
  return getVisibleUpdatedItemTree(
    orderedItems,
    canRevealRows,
    revealedRows,
    collapsedOpenedBySessionIds,
    preserveOrder
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
  /** Toggle pin. Mirrors `SessionList.onTogglePinSession`: receives the next desired pin state. */
  onTogglePinItem?: (id: string, nextPinned: boolean) => void;
  /** Snooze a session until `snoozedUntil` (epoch ms) into Status Later. */
  onSnoozeItem?: (id: string, snoozedUntil: number) => void;
  /** Mark a session settled into Status Settled. */
  onSettleItem?: (id: string) => void;
  /** Restore a snoozed or settled session back to Status Focus. */
  onMoveItemToFocus?: (id: string) => void;
  /** Reorder (or restore via drag) a session to `toIndex` inside Status Focus. */
  onDropFocusSession?: (id: string, toIndex: number) => void;
  /** Pin a Focus session when dragged and dropped onto a Pinned section. */
  onDropFocusIntoPinSection?: (
    sessionId: string,
    pinSectionId: string | null,
    toIndex: number
  ) => void;
  /** Whether Status-specific menu entries and countdown pills are shown. Defaults to `grouping === 'status'`. */
  showStatusActions?: boolean;
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
   * Per-bucket incremental reveal. When a bucket exceeds
   * {@link UPDATED_BUCKET_PREVIEW_MAX} top-level rows, only the latest N
   * render and a "Show more" button uncovers one more page per click; "Show
   * less" returns to the preview.
   */
  revealedRowsByBucket?: Partial<Record<SidebarUpdatedBucketKey, number>>;
  onShowMore?: (key: SidebarUpdatedBucketKey) => void;
  onShowLess?: (key: SidebarUpdatedBucketKey) => void;
  /**
   * Always-visible action rendered at the right end of the FIRST bucket's
   * header row (desktop sidebar filter trigger). While loading or empty the
   * list has no bucket headers, so the action renders in a standalone row
   * instead — it must stay reachable in every state.
   */
  headerAction?: ReactNode;
  headerMenu?: ReactNode;
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
  /**
   * 'recency' (default) renders one "Chats" section; 'status' renders the
   * status groups, each with its own header.
   */
  grouping?: SidebarUpdatedGrouping;
  /** Pinned sections only: "Move to section" entries in each row's context menu. */
  pinSectionMenu?: SidebarPinSectionMenu;
  /** Pinned sections only: identifies this list's section for drag and tests. */
  pinSectionId?: string | null;
  /**
   * Pinned sections only: accept a dragged conversation. `toIndex` counts this
   * section's pinned rows without the dragged one.
   */
  onDropPinnedSession?: (sessionId: string, toIndex: number) => void;
  /** Pinned sections only: wraps the section header (the section drag handle). */
  renderHeader?: (header: ReactElement) => ReactNode;
  /**
   * Pinned sections only: a quiet line under the section's rows, rendered
   * only while the section is expanded (e.g. "2 hidden in this view").
   */
  footer?: ReactNode;
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
  onSnoozeItem,
  onSettleItem,
  onMoveItemToFocus,
  onDropFocusSession,
  onDropFocusIntoPinSection,
  showStatusActions,
  onCopyItemUrl,
  onShareItemWithTeam,
  onOpenPullRequest,
  getItemHref,
  collapsedBuckets,
  onToggleBucket,
  toggleBucketLabel,
  revealedRowsByBucket,
  onShowMore,
  onShowLess,
  headerAction,
  headerMenu,
  showProjectContext = false,
  grouping = 'recency',
  pinSectionMenu,
  pinSectionId,
  onDropPinnedSession,
  renderHeader,
  footer,
}: SidebarUpdatedSessionListProps) {
  const preserveOrder = grouping === 'manual';
  const effectiveShowStatusActions = showStatusActions ?? grouping === 'status';
  const pinDrag = usePinnedDropGap(items, onDropPinnedSession, pinSectionId ?? null);
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
  const bucketLabels = useMemo<Record<SidebarUpdatedBucketKey, string>>(
    () => ({
      all: merged.heading,
      focus: t('sidebar.status.focus', 'Focus'),
      later: t('sidebar.status.later', 'Later'),
      settled: t('sidebar.status.settled', 'Settled'),
    }),
    [merged.heading, t]
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
      snooze: t('sessions.contextMenu.snooze', 'Later'),
      snoozeOneHour: t('sessions.contextMenu.snoozeOneHour', 'In 1 hour'),
      snoozeLaterToday: t('sessions.contextMenu.snoozeLaterToday', 'In 3 hours'),
      snoozeTomorrowMorning: t('sessions.contextMenu.snoozeTomorrowMorning', 'Tomorrow morning'),
      snoozeNextWeek: t('sessions.contextMenu.snoozeNextWeek', 'Next week'),
      snoozeCustom: t('sessions.contextMenu.snoozeCustom', 'Custom time…'),
      settle: t('sessions.contextMenu.settle', 'Settle'),
      moveToFocus: t('sessions.contextMenu.moveToFocus', 'Move to Focus'),
    }),
    [t]
  );

  const [renameTarget, setRenameTarget] = useState<RenameSessionDialogTarget | null>(null);
  const [customSnoozeTarget, setCustomSnoozeTarget] = useState<CustomSnoozeDialogTarget | null>(
    null
  );
  const beginRename = useCallback((id: string, currentTitle: string) => {
    setRenameTarget({ sessionId: id as SessionId, initialTitle: currentTitle });
  }, []);
  const beginCustomSnooze = useCallback((id: string, title: string) => {
    setCustomSnoozeTarget({ sessionId: id, title });
  }, []);
  // Same atom SessionList uses, so an opener folded in one organize mode stays
  // folded in the other. This component renders BOTH the Updated bucket and the
  // Pinned section; each instance resolves nesting inside its OWN `items`, which
  // is what keeps the two sections from reaching across each other.
  const collapsedOpenedBySessionIds = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const handleToggleOpenedBySessions = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);

  const canToggleBucket = typeof onToggleBucket === 'function';
  const canToggleFullBucket = typeof onShowMore === 'function';

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const buckets = useMemo(
    () => buildSidebarUpdatedBuckets(items, grouping, nowMs),
    [items, grouping, nowMs]
  );

  const sendStates = useAtomValue(sessionSendStatesAtom);
  // Updated mode is a flat firehose, so a bucket can hold the whole workspace
  // while showing 20 rows. Resolving the tree per render would re-scan all of
  // it on every message/status tick; a collapsed bucket renders no rows at all.
  const bucketTrees = useMemo(
    () =>
      buckets.map((bucket) => {
        if (isSidebarBucketCollapsed(bucket.key, collapsedBuckets)) {
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
            canToggleFullBucket && updatedBucketCanFold(bucket.key),
            revealedRowsByBucket?.[bucket.key] ?? 0,
            collapsedOpenedBySessionIds,
            preserveOrder || bucket.key === 'focus' || bucket.key === 'later'
          ),
        };
      }),
    [
      buckets,
      canToggleFullBucket,
      collapsedBuckets,
      collapsedOpenedBySessionIds,
      preserveOrder,
      sendStates,
      revealedRowsByBucket,
    ]
  );

  if (isLoading && items.length === 0) {
    return (
      <div {...stylex.props(updatedStyles.listStack)}>
        {headerAction ? <HeaderActionRow action={headerAction} /> : null}
        <SidebarListSkeleton
          className={className}
          showHeaderIcon={false}
          sectionClassName={stylex.props(updatedStyles.skeletonSpacing).className}
        />
      </div>
    );
  }

  if (!items.length && !preserveOrder) {
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

  return (
    <Tooltip.Provider>
      <div
        className={clsx(stylex.props(updatedStyles.listStack).className, className)}
        data-pin-section={
          pinSectionId === undefined ? undefined : (pinSectionId ?? DEFAULT_PIN_SECTION_KEY)
        }
        onDragOver={pinDrag?.onDragOver}
        onDragLeave={pinDrag?.onDragLeave}
        onDrop={pinDrag?.onDrop}
      >
        {buckets.map((bucket, bucketIndex) => {
          const bucketHeaderAction = bucketIndex === 0 ? headerAction : null;
          const bucketHeaderMenu = bucketIndex === 0 ? headerMenu : null;
          const collapsed = isSidebarBucketCollapsed(bucket.key, collapsedBuckets);
          const handleToggle = () => {
            if (!canToggleBucket) return;
            onToggleBucket?.(bucket.key);
          };
          if (grouping === 'status' && bucket.key === 'focus' && onDropFocusSession && !isMobile) {
            return (
              <div
                key={bucket.key}
                className={cn('group', stylex.props(bucketStyles.group, collapsed && bucketStyles.folded).className)}
              >
                <SidebarFocusDndContainer
                  items={bucket.items}
                  enabled={!collapsed}
                  onDropFocusSession={onDropFocusSession}
                  onDropIntoPinSection={onDropFocusIntoPinSection}
                >
                  {(orderedFocusItems) => (
                    <SidebarUpdatedSessionList
                      // The space down to the next bucket's label is padding of the
                      // drop section, not a margin outside it: a release just below
                      // the last row still lands at the end of Focus.
                      className={
                        stylex.props(!collapsed && bucketIndex < buckets.length - 1 && bucketStyles.sectionGap).className
                      }
                      items={orderedFocusItems}
                      now={now}
                      selectedItemId={selectedItemId}
                      isMobile={isMobile}
                      showPinnedIcon={showPinnedIcon}
                      showProjectContext={showProjectContext}
                      grouping="manual"
                      showStatusActions
                      pinSectionId={FOCUS_SECTION_DND_KEY}
                      onDropPinnedSession={onDropFocusSession}
                      labels={{
                        heading: bucketLabels.focus,
                        emptyTitle: merged.emptyTitle,
                        emptyDescription: merged.emptyDescription,
                      }}
                      collapsedBuckets={collapsed ? { all: true } : undefined}
                      onToggleBucket={canToggleBucket ? handleToggle : undefined}
                      toggleBucketLabel={toggleBucketLabel}
                      headerAction={bucketHeaderAction}
                      onSelectItem={onSelectItem}
                      onArchiveItem={onArchiveItem}
                      onMarkItemUnread={onMarkItemUnread}
                      onRenameItem={onRenameItem}
                      onTogglePinItem={onTogglePinItem}
                      onSnoozeItem={onSnoozeItem}
                      onSettleItem={onSettleItem}
                      onMoveItemToFocus={onMoveItemToFocus}
                      onCopyItemUrl={onCopyItemUrl}
                      onShareItemWithTeam={onShareItemWithTeam}
                      onOpenPullRequest={onOpenPullRequest}
                      getItemHref={getItemHref}
                    />
                  )}
                </SidebarFocusDndContainer>
              </div>
            );
          }
          const revealedRows = revealedRowsByBucket?.[bucket.key] ?? 0;
          const {
            overflows,
            nodes: visibleNodes,
            collapsedActivity,
          } = bucketTrees[bucketIndex] ?? {
            overflows: false,
            nodes: EMPTY_TREE_NODES,
            collapsedActivity: null,
          };
          const showBucketCount =
            (bucket.key === 'later' || bucket.key === 'settled') && bucket.items.length > 0;
          const headerLabel = showBucketCount ? (
            <span {...stylex.props(themeStyles.row)}>
              <span>{bucketLabels[bucket.key]}</span>
              <span {...stylex.props(themeStyles.hint)}>
                {bucket.items.length}
              </span>
            </span>
          ) : (
            bucketLabels[bucket.key]
          );
          // Only a bucket that actually contains an opened Session enables the
          // tree wrapper. Unrelated top-level rows keep their flat geometry.
          const showTreeGutter = hasOpenedByTreeNesting(visibleNodes);
          const bucketCanFold = canToggleFullBucket && updatedBucketCanFold(bucket.key);
          const hasMoreRows =
            bucketCanFold &&
            countUpdatedItemRoots(bucket.items) > UPDATED_BUCKET_PREVIEW_MAX + revealedRows;
          const showMoreRow = bucketCanFold && overflows && hasMoreRows && !collapsed;
          const showLessRow = bucketCanFold && overflows && revealedRows > 0 && !collapsed;
          const showMoreLabel = t('sessions.showMore', 'Show more');
          const showLessLabel = t('sessions.showLess', 'Show less');
          return (
            <div
              key={bucket.key}
              className={clsx(
                'group',
                stylex.props(updatedStyles.bucket, collapsed && updatedStyles.collapsedBucket)
                  .className
              )}
            >
              {/* Same shared section header as Workspace mode, so section labels
                  read identically (13px medium) across organize modes. */}
              {(renderHeader ?? identityHeader)(
                <SidebarSectionHeader
                  label={headerLabel}
                  collapsed={collapsed}
                  activity={collapsedActivity}
                  menu={bucketHeaderMenu}
                  action={bucketHeaderAction}
                  isMobile={isMobile}
                  toggleLabel={toggleBucketLabel}
                  onToggleCollapsed={canToggleBucket ? handleToggle : undefined}
                />
              )}
              {!collapsed ? (
                <div
                  ref={pinDrag?.rowsRef}
                  data-pin-rows={pinDrag ? '' : undefined}
                  className={cn(SIDEBAR_ROW_LIST_CLASS, stylex.props(pinDrag && bucketStyles.positioned).className)}
                  style={pinDrag?.rowsStyle}
                >
                  {(() => {
                    const renderNode = (
                      node: OpenedBySessionTreeNode<SidebarUpdatedItem>,
                      nodeIndex: number
                    ) => {
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
                            onSnooze={effectiveShowStatusActions ? onSnoozeItem : undefined}
                            onSettle={effectiveShowStatusActions ? onSettleItem : undefined}
                            onMoveToFocus={
                              effectiveShowStatusActions ? onMoveItemToFocus : undefined
                            }
                            onBeginCustomSnooze={
                              effectiveShowStatusActions ? beginCustomSnooze : undefined
                            }
                            showSnoozeCountdown={effectiveShowStatusActions}
                            showStatusActions={effectiveShowStatusActions}
                            onCopyUrl={onCopyItemUrl}
                            onShareWithTeam={onShareItemWithTeam}
                            onOpenPullRequest={onOpenPullRequest}
                            onBeginRename={beginRename}
                            pinSectionMenu={node.item.isPinned ? pinSectionMenu : undefined}
                            nativeDrag={!pinDrag}
                            openedByTree={treeSlot}
                            contextMenuLabels={contextMenuLabels}
                            archiveTooltipLabel={archiveLabels.tooltip}
                            archiveActionLabel={archiveLabels.action}
                            archiveConfirmLabel={archiveLabels.confirm}
                          />
                        </SessionOpenedByTreeRow>
                      );
                    };
                    if (!pinDrag) return visibleNodes.map(renderNode);
                    if (pinSectionId === FOCUS_SECTION_DND_KEY && visibleNodes.length === 0) {
                      return (
                        <div
                          data-status-focus-empty=""
                          {...stylex.props(themeStyles.row2)}
                        >
                          {t('sidebar.status.focusEmptyDrop', 'Drag a conversation here to focus')}
                        </div>
                      );
                    }
                    // A pin section moves an opener together with the Sessions it
                    // opened: each top-level row and its children are one slot.
                    const groups: {
                      rootId: string;
                      nodes: [number, (typeof visibleNodes)[number]][];
                    }[] = [];
                    visibleNodes.forEach((node, nodeIndex) => {
                      const last = groups[groups.length - 1];
                      if (node.depth === 0 || !last) {
                        groups.push({ rootId: node.item.id, nodes: [[nodeIndex, node]] });
                      } else {
                        last.nodes.push([nodeIndex, node]);
                      }
                    });
                    return groups.map((group) => {
                      return (
                        <DraggablePinnedRowSlot
                          key={group.rootId}
                          id={group.rootId}
                          drag={pinDrag}
                          gutter={showTreeGutter}
                        >
                          {group.nodes.map(([nodeIndex, node]) => renderNode(node, nodeIndex))}
                        </DraggablePinnedRowSlot>
                      );
                    });
                  })()}
                  {showMoreRow ? (
                    <button
                      type="button"
                      data-sidebar-updated-show-more={bucket.key}
                      {...stylex.props(updatedStyles.showMore)}
                      aria-label={showMoreLabel}
                      onClick={() => onShowMore?.(bucket.key)}
                    >
                      <span
                        {...stylex.props(updatedStyles.showMoreIcon)}
                        aria-hidden="true"
                      />
                      <span>{showMoreLabel}</span>
                    </button>
                  ) : null}
                  {showLessRow ? (
                    <button
                      type="button"
                      data-sidebar-updated-show-less={bucket.key}
                      {...stylex.props(updatedStyles.showMore)}
                      aria-label={showLessLabel}
                      onClick={() => onShowLess?.(bucket.key)}
                    >
                      <span
                        {...stylex.props(updatedStyles.showMoreIcon)}
                        aria-hidden="true"
                      />
                      <span>{showLessLabel}</span>

                    </button>
                  ) : null}
                </div>
              ) : null}
              {!collapsed ? footer : null}
            </div>
          );
        })}
        <RenameSessionDialogView
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRename={(sessionId, nextTitle) => onRenameItem?.(sessionId, nextTitle)}
        />
        <CustomSnoozeDialog
          target={customSnoozeTarget}
          now={now}
          onClose={() => setCustomSnoozeTarget(null)}
          onConfirm={(sessionId, snoozedUntil) => onSnoozeItem?.(sessionId, snoozedUntil)}
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
      className={clsx(
        stylex.props(updatedStyles.projectLine, sidebarSurface.meta).className,
        SIDEBAR_CAPTION_TEXT_CLASS
      )}
    >
      <span
        className={clsx(
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
  onSnooze?: (id: string, snoozedUntil: number) => void;
  onSettle?: (id: string) => void;
  onMoveToFocus?: (id: string) => void;
  onBeginCustomSnooze?: (id: string, title: string) => void;
  showSnoozeCountdown?: boolean;
  /**
   * Status view: Focus and Later rows replace the hover Archive button with a
   * one-click Settle ("mark as completed") action; Settled rows keep Archive.
   */
  showStatusActions?: boolean;
  onCopyUrl?: (id: string) => void;
  onShareWithTeam?: (id: string) => void;
  onOpenPullRequest?: (request: SessionListPullRequestOpen) => void;
  onBeginRename: (id: string, currentTitle: string) => void;
  openedByTree?: SessionRowOpenedByTreeSlot;
  contextMenuLabels: SidebarUpdatedContextMenuLabels;
  pinSectionMenu?: SidebarPinSectionMenu;
  /** False in pin sections, whose rows are dragged by dnd-kit instead. */
  nativeDrag?: boolean;
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
  onSnooze,
  onSettle,
  onMoveToFocus,
  onBeginCustomSnooze,
  showSnoozeCountdown = false,
  showStatusActions = false,
  onCopyUrl,
  onShareWithTeam,
  onOpenPullRequest,
  onBeginRename,
  pinSectionMenu,
  nativeDrag = true,
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

  const readOnly = item.sharing?.access === 'read';
  const canArchive = !readOnly && typeof onArchive === 'function';
  const canMarkUnread = typeof onMarkUnread === 'function' && !item.hasUnreadMessages;
  const canRename = !readOnly && typeof onRename === 'function';
  const canTogglePin = typeof onTogglePin === 'function';
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const statusGroup = statusViewTier({ ...item, activityAt: getSortKey(item) }, nowMs);
  const snoozeCountdown =
    showSnoozeCountdown && typeof item.snoozedUntil === 'number'
      ? formatSnoozeCountdown(item.snoozedUntil, nowMs)
      : null;
  const canSnooze = !readOnly && typeof onSnooze === 'function';
  const canSettle = !readOnly && typeof onSettle === 'function' && statusGroup !== 'settled';
  // The Status view trades Archive's two-step destructive action for a
  // one-click Settle on rows that are still open; only a Settled row keeps
  // Archive in the hover slot. Other organize modes always show Archive.
  const showInlineSettle = canSettle && !isMobile && showStatusActions;
  const showInlineArchive = canArchive && !isMobile && !showInlineSettle;
  const canMoveToFocus =
    !readOnly && typeof onMoveToFocus === 'function' && statusGroup !== 'focus';
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
  // NOT nested (opener archived or filtered
  // out), which is exactly when the tree cannot show the link.
  const openerSessionId = normalizeSessionRowId(item.openedBySessionId);
  const openerRootSessionId = normalizeSessionRowId(item.openedByRowSessionId) ?? openerSessionId;
  const canGoToOpener = Boolean(openerSessionId && typeof onSelect === 'function');
  const openedByOpener = openedByTree?.kind === 'opener' ? openedByTree : null;
  const hasMenuActions =
    !isMobile &&
    (canRename ||
      canTogglePin ||
      canSnooze ||
      canSettle ||
      canMoveToFocus ||
      canArchive ||
      canMarkUnread ||
      canCopyUrl ||
      Boolean(shareMenuState) ||
      Boolean(branchName) ||
      canGoToOpener ||
      (showPr && Boolean(onOpenPullRequest)) ||
      Boolean(openedByOpener) ||
      Boolean(pinSectionMenu));
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
  const showBranchLine =
    showBranchContext &&
    (item.kind === 'github' || item.isWorktree === true) &&
    Boolean(branchName) &&
    !isNestedChild;
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
      // Drag a conversation onto a chat surface to mention it there. Pin
      // sections drag with dnd-kit and mention through the pointer-drop bridge.
      draggable={nativeDrag}
      onDragStart={
        nativeDrag
          ? (event) => {
              startSessionMentionDrag(event, { sessionId: item.id, title: item.title });
              // A drop into a pin section lands from where this row was released.
              recordPinnedDragOrigin(item.id, event.currentTarget, event);
            }
          : undefined
      }
      className={clsx(
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
        useAnchor && stylex.props(updatedStyles.anchorFocus).className
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
        className={clsx(
          stylex.props(updatedStyles.rowBody, isMobile && updatedStyles.mobileRowBody).className,
          SIDEBAR_ROW_TEXT_CLASS
        )}
      >
        <div
          className={clsx(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}
        >
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
            className={clsx(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}
          >
            <SessionRowAuthorAvatar author={item.owner} />
          </span>
        ) : null}
        {showPinnedIcon && item.isPinned ? (
          <span
            className={clsx(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}
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
            className={clsx(
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
            <div
              data-sidebar-session-meta=""
              className={clsx(
                stylex.props(updatedStyles.metaLine, sidebarSurface.meta).className,
                SIDEBAR_CAPTION_TEXT_CLASS
              )}
            >
              {showProjectLine ? <UpdatedItemProjectLine item={item} /> : null}
              {showBranchLine ? <SidebarBranchSegment branchName={branchName} /> : null}
            </div>
          ) : null}
        </div>
        {/* Keep PR at the right edge. Line totals stay in the hover card. */}
        <div
          className={clsx(stylex.props(updatedStyles.lineSlot).className, SIDEBAR_ROW_LINE_CLASS)}
        >
          <SidebarRowEndSlot
            sessionId={item.id}
            selected={showSelectedState}
            isWaitingPermission={item.isWaitingPermission}
            needsAttention={item.deliveryStalled}
            isWorking={item.isWorking}
            hasUnreadMessages={item.hasUnreadMessages}
            fadeClassName="group-hover/row:opacity-0 group-data-[menu-open]/row:opacity-0"
            restIcon={
              snoozeCountdown ||
              showPr ||
              showMergeablePill ||
              isMobile ||
              (item.kind === 'local' && item.isWorktree) ? (
                <span
                  className={clsx(
                    stylex.props(
                      updatedStyles.restMetrics,
                      sidebarSurface.faint,
                      useAnchor && updatedStyles.anchoredMetrics
                    ).className,
                    SIDEBAR_CAPTION_TEXT_CLASS
                  )}
                >
                  {isMobile && !snoozeCountdown ? <span>{relativeTime}</span> : null}
                  {showMergeablePill ? <SessionMergeablePill /> : null}
                  <SessionRowWorktreeIndicator
                    isWorktree={item.kind === 'local' && item.isWorktree}
                  />
                  {showPr ? (
                    <SessionPrIcon compact prStatus={prStatus} prCiState={item.prCiState} />
                  ) : null}
                  {/* The wake-up countdown sits at the far right in a neutral
                      chip: it is recurring meta, not an alert, so it keeps the
                      row's own ink instead of a status colour. */}
                  {snoozeCountdown ? (
                    <span
                      data-snooze-countdown=""
                      title={
                        typeof item.snoozedUntil === 'number'
                          ? new Date(item.snoozedUntil).toLocaleString()
                          : undefined
                      }
                      {...stylex.props(previewStyles.row)}
                    >
                      <Timer {...stylex.props(themeStyles.glyph)} aria-hidden="true" />
                      <span>{snoozeCountdown}</span>
                    </span>
                  ) : null}
                </span>
              ) : undefined
            }
            menu={
              hasMenuActions ? (
                <SessionRowMenuButton
                  label={contextMenuLabels.moreActions}
                  revealClassName="group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-data-[menu-open]/row:opacity-100 group-data-[menu-open]/row:pointer-events-auto"
                />
              ) : undefined
            }
            archive={
              showInlineSettle ? (
                <SidebarRowActionButton
                  label={contextMenuLabels.settle}
                  icon={<CheckCircle2 {...stylex.props(themeStyles.glyph2)} aria-hidden="true" />}
                  onConfirm={() => onSettle?.(item.id)}
                  revealClassName="group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-data-[menu-open]/row:opacity-100 group-data-[menu-open]/row:pointer-events-auto"
                />
              ) : showInlineArchive ? (
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
        rootXstyle={updatedStyles.swipeRoot}
        contentXstyle={updatedStyles.swipeContent}
        actions={[
          {
            key: 'archive',
            label: archiveActionLabel,
            ariaLabel: archiveTooltipLabel,
            icon: <Archive {...stylex.props(updatedStyles.glyph16)} />,
            hideLabel: item.kind === 'chat',
            xstyle: updatedStyles.archiveAction,
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
      <ContextMenu.Content minWidth={180}>
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
        {pinSectionMenu ? (
          <ContextMenu.Submenu>
            <ContextMenu.SubmenuTrigger icon={FolderInput}>
              {pinSectionMenu.labels.moveToSection}
            </ContextMenu.SubmenuTrigger>
            <ContextMenu.SubmenuContent xstyle={themeStyles.glyph3}>
              {pinSectionMenu.sections.map((section) => (
                <ContextMenu.Item
                  key={section.id ?? DEFAULT_PIN_SECTION_KEY}
                  disabled={section.id === pinSectionMenu.currentSectionId}
                  onClick={() => pinSectionMenu.onMove(item.id, section.id)}
                >
                  {section.name}
                </ContextMenu.Item>
              ))}
              <ContextMenu.Separator />
              <ContextMenu.Item icon={FolderPlus} onClick={() => pinSectionMenu.onCreate(item.id)}>
                {pinSectionMenu.labels.newSection}
              </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
          </ContextMenu.Submenu>
        ) : null}
        {canSnooze ? (
          <ContextMenu.Submenu>
            <ContextMenu.SubmenuTrigger icon={AlarmClock}>
              {contextMenuLabels.snooze}
            </ContextMenu.SubmenuTrigger>
            <ContextMenu.SubmenuContent xstyle={themeStyles.glyph4}>
              {buildSnoozePresets(now).map((preset) => {
                const label =
                  preset.id === 'oneHour'
                    ? contextMenuLabels.snoozeOneHour
                    : preset.id === 'laterToday'
                      ? contextMenuLabels.snoozeLaterToday
                      : preset.id === 'tomorrowMorning'
                        ? contextMenuLabels.snoozeTomorrowMorning
                        : contextMenuLabels.snoozeNextWeek;
                return (
                  <ContextMenu.Item
                    key={preset.id}
                    onClick={() => onSnooze?.(item.id, preset.timestamp)}
                  >
                    <span {...stylex.props(themeStyles.row3)}>
                      <span>{label}</span>
                      <span {...stylex.props(themeStyles.hint2)}>
                        {preset.countdown}
                      </span>
                    </span>
                  </ContextMenu.Item>
                );
              })}
              <ContextMenu.Separator />
              <ContextMenu.Item
                icon={Timer}
                onClick={() => onBeginCustomSnooze?.(item.id, item.title)}
              >
                {contextMenuLabels.snoozeCustom}
              </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
          </ContextMenu.Submenu>
        ) : null}
        {canSettle ? (
          <ContextMenu.Item icon={CheckCircle2} onClick={() => onSettle?.(item.id)}>
            {contextMenuLabels.settle}
          </ContextMenu.Item>
        ) : null}
        {canMoveToFocus ? (
          <ContextMenu.Item icon={ArrowUpCircle} onClick={() => onMoveToFocus?.(item.id)}>
            {contextMenuLabels.moveToFocus}
          </ContextMenu.Item>
        ) : null}
        {canMarkUnread ? (
          <ContextMenu.Item
            icon={MailOpen}
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
              void copyTextToClipboard(branchName).catch(() => {});
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
      menuOpen={rowMenuOpen}
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
  swipeRoot: { borderRadius: 'var(--radius-md)' },
  swipeContent: { backgroundColor: 'hsl(var(--sidebar) / 1)' },
  skeletonSpacing: { marginBottom: { default: themeSpace[4], ':last-child': 0 } },
  anchorFocus: {
    boxShadow: {
      default: null,
      ':has(a:focus-visible)':
        'inset 0 0 0 1px color-mix(in oklab, hsl(var(--sidebar-ring) / 1) 40%, transparent)',
    },
  },
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
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
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

const identityHeader = (header: ReactElement): ReactNode => header;

/**
 * Drop index for a pointer at `clientY` over a pin section's rows element:
 * how many of its other rows rest above the pointer. Resting layout
 * (`offsetTop`, which the gap's transforms do not move), so the gap cannot
 * chase the pointer. Above the rows (the header) is the top; below, the end.
 */
export function pinnedDropIndexAt(
  rows: HTMLElement | null,
  clientY: number,
  draggedId: string
): number {
  if (!rows) return 0;
  const y = clientY - rows.getBoundingClientRect().top;
  let index = 0;
  for (const node of Array.from(rows.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const id = node.getAttribute('data-pin-node');
    if (!id || id === draggedId) continue;
    if (node.offsetTop + node.offsetHeight / 2 < y) index += 1;
  }
  return index;
}

const escapeAttributeValue = (value: string) =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');

const PINNED_DROP_DEFAULT_GAP_PX = 29;
const PINNED_DROP_TRANSITION = 'transform 160ms ease, opacity 120ms ease';
const PINNED_DROP_ROWS_TRANSITION = 'padding-bottom 160ms ease, margin-bottom 160ms ease';

type PinnedDropGap = {
  rowsRef: RefObject<HTMLDivElement | null>;
  rowsStyle: CSSProperties | undefined;
  nodeStyle: (id: string) => CSSProperties | undefined;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
};

const noopSubscribe = () => () => {};
const readNoDrag = () => null;

/**
 * Pin-section drop target. While a conversation is dragged, the dragged row's
 * slot closes and the rows at the drop position slide down to open a gap of
 * its height. The drop index is read against the rows' resting layout
 * (`offsetTop`, which transforms do not move), so the gap cannot chase the pointer.
 * `null` for lists that accept no drop.
 */
function usePinnedDropGap(
  items: readonly SidebarUpdatedItem[],
  onDropPinnedSession: ((sessionId: string, toIndex: number) => void) | undefined,
  sectionId: string | null
): PinnedDropGap | null {
  const enabled = typeof onDropPinnedSession === 'function';
  const inFlight = useSyncExternalStore(
    enabled ? subscribeSessionMentionDrag : noopSubscribe,
    enabled ? getInFlightSessionMentionDragId : readNoDrag,
    readNoDrag
  );
  const settle = useSyncExternalStore(
    enabled ? subscribePinnedDropSettle : noopSubscribe,
    enabled ? getPinnedDropSettle : readNoDrag,
    readNoDrag
  );
  // Only this section's index: moving the pointer elsewhere re-renders nothing here.
  const readPointerIndex = useCallback(() => {
    const target = getPinnedPointerTarget();
    return target && target.sectionId === sectionId ? target.index : null;
  }, [sectionId]);
  const pointerIndex = useSyncExternalStore(
    enabled ? subscribePinnedPointerTarget : noopSubscribe,
    enabled ? readPointerIndex : readNoDrag,
    readNoDrag
  );
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const [nativeDropIndex, setDropIndex] = useState<number | null>(null);
  // A pointer (dnd-kit) drag of a pinned row aims here, or a native drag does.
  const dropIndex = nativeDropIndex ?? pointerIndex;
  const [gap, setGap] = useState(PINNED_DROP_DEFAULT_GAP_PX);
  // A released row still owns the layout until it lands in its slot.
  const dragged = enabled
    ? (inFlight ?? (settle?.phase === 'waiting' ? settle.sessionId : null))
    : null;
  const flyingId = enabled && settle?.phase === 'flying' ? settle.sessionId : null;
  // Only a live drag animates. After the release, the rows' new layout equals
  // what is already on screen, so it must snap: the landing has one motion.
  const animate = Boolean(enabled && inFlight);

  useEffect(() => {
    if (!dragged) {
      setDropIndex(null);
      return;
    }
    const row = document.querySelector<HTMLElement>(
      `[data-sidebar-updated-id="${escapeAttributeValue(dragged)}"]`
    );
    // The list's 1px row gap travels with the slot.
    if (row && row.offsetHeight > 0) setGap(row.offsetHeight + 1);
  }, [dragged]);

  const layout = useMemo(() => {
    const rootOf = new Map<string, string>();
    const rootIds: string[] = [];
    if (sectionId === FOCUS_SECTION_DND_KEY) {
      const nodes = buildOpenedBySessionTree(items, SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS);
      let currentRootId: string | null = null;
      for (const node of nodes) {
        if (node.depth === 0 || !currentRootId) {
          currentRootId = node.item.id;
          rootIds.push(currentRootId);
        }
        rootOf.set(node.item.id, currentRootId);
      }
    } else {
      for (const item of items) {
        rootOf.set(item.id, item.isPinned ? item.id : (item.openedByRowSessionId ?? item.id));
        if (item.isPinned) rootIds.push(item.id);
      }
    }
    const rowIndex = new Map(items.map((item, index) => [item.id, index]));
    return { rootOf, rootIds, rowIndex };
  }, [items, sectionId]);
  // Each root's position among the section's rows other than the dragged one.
  const otherIndex = useMemo(
    () =>
      new Map(
        layout.rootIds.filter((id) => id !== dragged).map((id, index) => [id, index] as const)
      ),
    [dragged, layout.rootIds]
  );
  // Events read the live drag: the first dragover can arrive before a re-render.
  const liveDragged = useCallback(
    () => (enabled ? getInFlightSessionMentionDragId() : null),
    [enabled]
  );
  const sourceHere = Boolean(dragged && layout.rootOf.has(dragged));

  // The write landed: the row now renders in this section at the dropped index.
  // Measure its slot before paint and hand the landing to the flight.
  useLayoutEffect(() => {
    if (!enabled || settle?.phase !== 'waiting' || settle.toSectionId !== sectionId) return;
    if (layout.rootIds.indexOf(settle.sessionId) !== settle.toIndex) return;
    const node = Array.from(rowsRef.current?.children ?? []).find(
      (child) => child.getAttribute('data-pin-node') === settle.sessionId
    );
    const row = node?.querySelector<HTMLElement>('[data-sidebar-updated-id]');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    flyPinnedDropSettle(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      getComputedStyle(row).backgroundColor,
      row.cloneNode(true) as HTMLElement,
      getComputedStyle(row).borderRadius
    );
  }, [enabled, layout.rootIds, sectionId, settle]);

  const resolveIndex = useCallback(
    (event: DragEvent<HTMLDivElement>): number | null => {
      const current = liveDragged();
      if (!current) return null;
      return pinnedDropIndexAt(rowsRef.current, event.clientY, current);
    },
    [liveDragged]
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const index = resolveIndex(event);
      if (index === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      setDropIndex(index);
    },
    [resolveIndex]
  );
  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    // Chrome often reports no relatedTarget when the pointer moves onto a child,
    // so only a pointer outside the section's box closes the gap.
    const box = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX < box.right &&
      event.clientY >= box.top &&
      event.clientY < box.bottom;
    if (inside) return;
    setDropIndex(null);
  }, []);
  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const index = resolveIndex(event);
      const current = liveDragged();
      if (index === null || !current) {
        setDropIndex(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDropIndex(index);
      const origin = takePinnedDragOrigin(current);
      beginPinnedDropSettle({
        sessionId: current,
        toSectionId: sectionId,
        toIndex: index,
        from: origin
          ? {
              left: event.clientX - origin.offsetX,
              top: event.clientY - origin.offsetY,
              width: origin.width,
              height: origin.height,
            }
          : { left: event.clientX - 24, top: event.clientY - gap / 2, width: 0, height: gap },
        ghost: origin?.ghost ?? null,
        fromBackground: origin?.background ?? null,
      });
      // The drag ends here: when the move unmounts the source row, no dragend
      // will arrive. The settle keeps the layout until the row lands.
      clearSessionMentionDrag();
      onDropPinnedSession?.(current, index);
    },
    [gap, liveDragged, onDropPinnedSession, resolveIndex, sectionId]
  );

  const nodeStyle = useCallback(
    (id: string): CSSProperties | undefined => {
      // Under its flying copy, the landed row waits invisible, without a fade.
      if (flyingId && (layout.rootOf.get(id) ?? id) === flyingId) return { opacity: 0 };
      if (!dragged) return undefined;
      const root = layout.rootOf.get(id) ?? id;
      if (root === dragged) {
        return { opacity: 0, transition: animate ? PINNED_DROP_TRANSITION : undefined };
      }
      let shift = 0;
      // Rows below the dragged one close its slot.
      if (sourceHere && (layout.rowIndex.get(id) ?? 0) > (layout.rowIndex.get(dragged) ?? 0)) {
        shift -= gap;
      }
      // Rows at and after the drop position open the gap.
      const position = otherIndex.get(root) ?? -1;
      if (dropIndex !== null && position >= dropIndex) shift += gap;
      return {
        transform: shift ? `translateY(${shift}px)` : undefined,
        transition: animate ? PINNED_DROP_TRANSITION : undefined,
      };
    },
    [animate, dragged, dropIndex, flyingId, gap, layout, otherIndex, sourceHere]
  );

  if (!enabled) return null;
  return {
    rowsRef,
    // A gap opened in another section needs room below its last row, and the
    // section the row left gives its slot back, so the sidebar keeps its height.
    rowsStyle: !dragged
      ? undefined
      : {
          transition: animate ? PINNED_DROP_ROWS_TRANSITION : undefined,
          ...(dropIndex !== null && !sourceHere ? { paddingBottom: gap } : {}),
          ...(dropIndex === null && sourceHere ? { marginBottom: -gap } : {}),
        },
    nodeStyle,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}

type PinnedRowSlotProps = {
  id: string;
  drag: PinnedDropGap;
  gutter: boolean;
  children: ReactNode;
};

const slotClassName = (gutter: boolean) =>
  // A nested trunk draws into the list's 1px gap; the slot keeps that pixel
  // inside its own (paint-contained) box, as `SessionOpenedByTreeRow` does.
  stylex.props(bucketStyles.slot, gutter && bucketStyles.gutter).className;

/**
 * One row slot of a pin section (a top-level row and the Sessions it opened).
 * dnd-kit picks it up (pin rows carry no native drag), and it carries the gap
 * layout shared by pointer drags and native drops from other lists.
 */
function DraggablePinnedRowSlot({ id, drag, gutter, children }: PinnedRowSlotProps) {
  const { setNodeRef, listeners } = useDraggable({ id: pinnedRowDndId(id) });
  return (
    <div
      ref={setNodeRef}
      data-pin-node={id}
      data-pin-sortable=""
      className={slotClassName(gutter)}
      style={drag.nodeStyle(id)}
      {...listeners}
    >
      {children}
    </div>
  );
}

const themeStyles = stylex.create({
  row: { display: 'inline-flex', alignItems: 'center', gap: themeSpace[1.5] },
  hint: { fontSize: uiText.captionSize, lineHeight: uiText.captionLeading, fontWeight: 400, fontVariantNumeric: 'tabular-nums', color: uiColors.secondaryLabel },
  row2: { display: 'flex', minHeight: themeSpace[10], alignItems: 'center', justifyContent: 'center', borderRadius: uiRadius.small, cornerShape: uiCorner.shape, boxShadow: uiShadow.card, backgroundColor: uiColors.elevatedBackground, paddingInline: themeSpace[3], paddingBlock: themeSpace[2], fontSize: uiText.footnoteSize, lineHeight: uiText.footnoteLeading, color: uiColors.secondaryLabel },
  glyph: { height: themeSpace[3], width: themeSpace[3], flexShrink: 0 },
  glyph2: { height: themeSpace[3.5], width: themeSpace[3.5] },
  glyph3: { minWidth: '180px' },
  glyph4: { minWidth: '200px' },
  row3: { display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: themeSpace[4] },
  hint2: { fontSize: uiText.captionSize, lineHeight: uiText.captionLeading, fontVariantNumeric: 'tabular-nums', color: uiColors.secondaryLabel },
});

const bucketStyles = stylex.create({
 sectionGap: { paddingBottom: themeSpace[4] },
  group: { display: 'flex', flexDirection: 'column', gap: themeSpace[0.5] },
  folded: { marginBottom: { default: themeSpace[1], ':last-child': 0 } },
  positioned: { position: 'relative' },
  slot: { display: 'flex', minWidth: 0, flexDirection: 'column', gap: '1px' },
  gutter: { position: 'relative', paddingBottom: '1px', marginBottom: '-1px' },
});

const previewStyles = stylex.create({
  row: { display: 'inline-flex', alignItems: 'center', gap: themeSpace[1], borderRadius: uiRadius.full, cornerShape: uiCorner.round, backgroundColor: uiColors.secondaryBackground, paddingInline: themeSpace[1.5], paddingBlock: themeSpace[0.5], fontSize: uiText.captionSize, lineHeight: 1, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: uiColors.secondaryLabel },
});
