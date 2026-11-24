import { control } from '@lody/ui/tokens/scales.stylex';
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronRight,
  CircleHelp,
  Folder,
  FolderOpen,
  LockKeyhole,
  MessageCircle,
} from 'lucide-react';
import { atom, useAtom, useAtomValue, useSetAtom, type PrimitiveAtom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { useTranslation } from 'react-i18next';
import {
  flattenStatusViewRows,
  formatSnoozeCountdown,
  getServerNow,
  isStatusTierCollapsedByDefault,
  STATUS_VIEW_SETTLED_FOLD_THRESHOLD,
  type PinSection,
  type StatusViewLayout,
  type StatusViewRow,
  type StatusViewTier,
} from '@lody/shared';
import { buildMobileStatusViewLayout } from './mobile-status-view';
import { useMobileStatusList, type MobileStatusCommands } from './use-mobile-status-list';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import {
  buildOpenedBySessionTree,
  countOpenedByTreeRoots,
  pinnedFirstRootRank,
  placeOpenedSessionsWithOpeners,
} from '@/lib/session-opened-by-tree';
import {
  sidebarCollapsedOpenedBySessionsAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
} from '@/atoms/focus-layer';
import { buildSessionRowOpenedByTreeSlot } from '@/components/sidebar-row-shared';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { AlertDialog } from '@/ui/dialog';
import {
  ConversationRow,
  conversationRowHasActivity,
  type MobileConversationItem,
} from './mobile-project-screen';
import { MobileInitialLetterAvatar } from './mobile-initial-letter-avatar';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import {
  MobileStatusSwipeRow,
  MobileSwipeableRow,
  MobileSwipeableRowGroup,
  type MobileStatusSwipeActionId,
} from './mobile-swipeable-row';

/* Exit animation tuned to feel like a row "falling out" of the list
   rather than vanishing: a height-and-opacity collapse paired with
   `layout` on every sibling so they slide up to fill the gap in
   lockstep. Rejected alternatives:
   - Spring on `height`: bouncy on a list-row collapse looks jittery,
     and the bounce ripples through every sibling's layout animation.
   - Slide-left out: that's already what super-swipe does for the row
     content; doing it again on the wrapper would be a double-slide.
   - Pure opacity fade: leaves a phantom gap until React commits the
     new layout — the collapse is what the user actually wants to see.

   Duration tuning (user reported 220ms read as "just disappears"):
   - 0.34s for height + layout — long enough that the eye registers
     the slot shrinking instead of just blinking out.
   - 0.34s for opacity matching the height curve — the previous 0.14s
     fade ended at frame ~140ms, so the row was already invisible by
     the time the slot finished collapsing. Sharing the duration with
     `height` keeps the fade visually tied to the collapse. */
const ROW_EXIT_TRANSITION = {
  /* `easeInOut` instead of the snappier `[0.32, 0.72, 0, 1]` because
     the snappy curve front-loaded ~60% of the motion into the first
     100ms — the user couldn't see the slot shrinking, only the
     "before" and "after". A balanced ease-in-out lets the collapse
     read as a steady motion across the whole duration. */
  layout: { duration: 0.4, ease: 'easeInOut' as const },
  height: { duration: 0.4, ease: 'easeInOut' as const },
  opacity: { duration: 0.4, ease: 'easeInOut' as const },
};

/* Grouping modes for the chat list.
   - `none`: flat list (in-project page; home no longer offers this)
   - `project`: bucket by `projectKey` (+ no-project catch-all)
   - `date`: Today / Yesterday / This Week / This Month / older months
   - `status`: the Status view's Focus / Later / Settled tiers
   Callers supply heading labels via `groupLabels` for i18n. */
export type MobileChatGroupBy = 'none' | 'project' | 'date' | 'status';

/* Bucket id used for chats that have no associated project (kind
   = 'chat'). Exported so callers can map it in `groupLabels`. */
export const NO_PROJECT_BUCKET_ID = '__no-project__';

/* Synthetic top bucket for pinned sessions. Always rendered first
   (when non-empty), ahead of project / date / flat unpinned groups. */
export const PINNED_BUCKET_ID = '__pinned__';

/* Flat unpinned tail when groupBy is `none` and there is a Pinned
   section above — no heading; just the remaining rows. */
const FLAT_UNPINNED_BUCKET_ID = '__flat-unpinned__';
/** Bucket id prefix of a user pin section. */
const PIN_SECTION_BUCKET_PREFIX = `${PINNED_BUCKET_ID}:`;
const isPinnedBucketId = (id: string): boolean =>
  id === PINNED_BUCKET_ID || id.startsWith(PIN_SECTION_BUCKET_PREFIX);

/* Rows a bucket shows before it collapses behind "Show more".
   Same value as the desktop sidebar's `MAX_VISIBLE_SESSIONS`
   (`../session-list.tsx`) — deliberately duplicated rather than imported so
   the mobile bundle does not pull in the desktop session-list module.

   Why 5 and not 3: a phone screen already fits ~8 rows, so 3 turns every
   project into a two-tap read and puts the toggle back in the user's way on
   every bucket. 5 is the point where a project's recent work still reads as a
   list while an idle project costs one line more than its heading — and it
   keeps the two platforms saying the same thing about the same workspace.

   The cap counts TOP-LEVEL rows only (`maxRoots`), so a preview never splits
   an opener from the Sessions it opened. */
export const MOBILE_CHAT_PREVIEW_MAX_ROOTS = 5;

/* Tree accessors shared by the render pass and the overflow count, so the
   "does this bucket overflow" question is answered by the same nesting model
   that decides what renders. */
const CHAT_OPENED_BY_TREE_ACCESSORS = {
  getId: (chat: MobileConversationItem) => chat.id,
  getOpenedBySessionId: (chat: MobileConversationItem) =>
    chat.openedByRowSessionId ?? chat.openedBySessionId,
} as const;

/* Per-bucket preview state. Owned by `MobileChatList` (one flag per bucket id)
   rather than by the shared `sidebarCollapsedOpenedBySessionsAtom`: that atom
   is the opener FOLD state, which the drawer sidebar and this list must agree
   on. How many rows a mobile bucket previews is a property of this surface
   alone and must not leak into the sidebar. */
export type MobileChatPreviewState = {
  /** Extra top-level rows "Show more" has uncovered beyond the preview cap. */
  revealedRows: number;
  onShowMore: () => void;
  onShowLess: () => void;
  /** Top-level rows shown before the toggle; defaults to {@link MOBILE_CHAT_PREVIEW_MAX_ROOTS}. */
  maxRoots?: number;
};

/**
 * A card rendered inside the Status view: which list its rows belong to (drag
 * targeting reads it from `data-status-*`), the swipe and menu actions they
 * offer, and the drop indicator while a drag hovers this list.
 */
export type MobileChatCardStatus = {
  area: 'focus' | 'later' | 'settled' | 'pinned';
  /** Pin section of a Pinned-area card; `null` is the default section. */
  sectionId: string | null;
  /** The slot a drag would land in, when it is in this list: before that row, or the end. */
  dropBeforeId?: string | null | undefined;
  /** Rows the person may Later / Settle / move to Focus. */
  canManage: (chatId: string) => boolean;
  /** Rows the person may pin or unpin. */
  canPrefer: (chatId: string) => boolean;
  onLater: (chatId: string) => void;
  onSettle: (chatId: string) => void;
  /** True while a long press holds a row; swipes stand down. */
  isLocked: () => boolean;
};

/* Group fold + reveal state for one list surface. Held in an atom, not
   component state, because leaving the home screen (e.g. into Settings)
   unmounts the list and would otherwise re-expand every folded group on
   return. In-memory only: it survives navigation, not an app reload. */
type MobileChatBucketUiState = {
  collapsed: ReadonlySet<string>;
  /** Extra top-level rows each bucket has revealed beyond its preview cap. */
  revealed: Readonly<Record<string, number>>;
};
const createBucketUiStateAtom = () =>
  atom<MobileChatBucketUiState>({ collapsed: new Set<string>(), revealed: {} });
const mobileChatBucketUiStateAtomFamily = atomFamily((_stateKey: string) =>
  createBucketUiStateAtom()
);
const toggleInSet = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/* Fixed date-bucket ids (ordered newest → oldest). Month buckets use
   `date:month:YYYY-MM` and sort after these named ones. */
export const DATE_BUCKET_TODAY = 'date:today';
export const DATE_BUCKET_YESTERDAY = 'date:yesterday';
export const DATE_BUCKET_THIS_WEEK = 'date:this-week';
export const DATE_BUCKET_THIS_MONTH = 'date:this-month';
/** Sessions with no usable `latestMessageAt`. Sorts after all months. */
export const DATE_BUCKET_UNKNOWN = 'date:unknown';

const DATE_NAMED_BUCKET_ORDER = [
  DATE_BUCKET_TODAY,
  DATE_BUCKET_YESTERDAY,
  DATE_BUCKET_THIS_WEEK,
  DATE_BUCKET_THIS_MONTH,
] as const;

const DATE_MONTH_PREFIX = 'date:month:';

/* Linear-style section label: quiet muted title case (not all-caps),
   generous top padding so groups breathe. Used for archived mode and
   non-project group buckets. */
/* Group labels sit at 18px (16+2) so their left edge optically lines
   up with the search field — plain `px-4` read ~2px left of the bar. */
const groupHeadingBox = {
  paddingInlineStart: '18px',
  paddingInlineEnd: themeSpace[4],
};

/* Group label type size — slightly under session-row 15px so sections
   stay secondary, but large enough to scan. */
const groupHeadingText = {
  fontSize: '14px',
  fontWeight: themeFontWeight.semibold,
  letterSpacing: '-0.025em',
  color: themeColors.mutedForeground,
};

const styles = stylex.create({
  selectionCheck: { pointerEvents: 'none' },
  sectionHeading: {
    ...groupHeadingBox,
    ...groupHeadingText,
    paddingBottom: themeSpace[1.5],
    paddingTop: themeSpace[5],
  },
  /* Chevron for group collapse state: points right when collapsed,
     rotates 90° to point down when expanded. Same muted color as the
     section label + folder mark so the cluster reads as one unit. */
  chevron: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: '150ms',
    transitionTimingFunction: themeEasing['in-out'],
  },
  chevronExpanded: { transform: 'rotate(90deg)' },
  collapsibleRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingBottom: themeSpace[1.5],
    ...groupHeadingBox,
  },
  collapsibleRowCompact: { paddingTop: themeSpace[2] },
  collapsibleRowTall: { paddingTop: themeSpace[4] },
  collapsibleButton: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    textAlign: 'left',
    opacity: { default: 1, ':active': 0.7 },
    ...groupHeadingText,
  },
  labelCluster: {
    display: 'flex',
    minWidth: 0,
    maxWidth: '100%',
    alignItems: 'center',
    gap: themeSpace[1],
  },
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  bucketLabel: {
    ...groupHeadingText,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  bucketMarkImage: {
    width: themeSpace[5],
    height: themeSpace[5],
    flexShrink: 0,
    borderRadius: 'var(--radius)',
    objectFit: 'cover',
  },
  bucketMarkIcon: {
    width: themeSpace[5],
    height: themeSpace[5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  bucketRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingBottom: themeSpace[1.5],
    ...groupHeadingBox,
  },
  bucketRowCompact: { paddingTop: themeSpace[2] },
  bucketRowTall: { paddingTop: themeSpace[4] },
  bucketButton: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[1.5],
    textAlign: 'left',
    opacity: { default: 1, ':active': 0.7 },
  },
  bucketBody: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  privateBadge: {
    display: 'inline-flex',
    minHeight: themeSpace[7],
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.full,
    paddingInline: themeSpace[1.5],
    fontSize: '0.68rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
    backgroundColor: { default: 'transparent', ':active': themeColors.muted },
  },
  privateBadgeIcon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  badgeGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  helpIcon: { width: themeSpace[3], height: themeSpace[3] },
  rowShell: {
    overflow: 'hidden',
    backgroundColor: themeColors.background,
  },
  previewToggle: {
    display: 'flex',
    minHeight: themeSpace[11],
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2.5],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[2],
    textAlign: 'left',
    fontSize: '13px',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
    backgroundColor: {
      default: themeColors.background,
      ':active': 'hsl(var(--muted) / 0.4)',
    },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: themeEasing['in-out'],
  },
  previewSpacer: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },
  flatHeadingRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingBottom: themeSpace[1.5],
    paddingTop: themeSpace[5],
    ...groupHeadingBox,
  },
  flatHeadingText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    ...groupHeadingText,
  },
  trailing: { flexShrink: 0 },
  flatTailRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: themeSpace[1.5],
    ...groupHeadingBox,
  },
  flatTailRowCompact: { paddingTop: themeSpace[2] },
  flatTailRowTall: { paddingTop: themeSpace[4] },
  selectionToolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[1.5],
    paddingTop: themeSpace[5],
  },
  selectAllButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[2],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  selectionActions: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
  },
  cancelButton: {
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
    backgroundColor: { default: 'transparent', ':active': 'hsl(var(--muted) / 0.6)' },
  },
  deleteButton: {
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.semibold,
    color: themeColors.destructive,
    backgroundColor: { default: 'transparent', ':active': 'hsl(var(--destructive) / 0.1)' },
    opacity: { default: 1, ':disabled': control.disabledOpacity },
  },
});

export function MobileChatSectionHeading({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.sectionHeading)}>{children}</div>;
}

/* Chevron for group collapse state: points right when collapsed,
   rotates 90° to point down when expanded. Same muted color as the
   section label + folder mark so the cluster reads as one unit. */
function GroupChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      className={stylex.props(styles.chevron, expanded && styles.chevronExpanded).className}
      strokeWidth={2.25}
      aria-hidden="true"
    />
  );
}

/* Tappable variant of `MobileChatSectionHeading` for collapsible
   buckets that don't carry a project identity mark. Collapse control
   is a nested button so `trailing` (e.g. the list filter chip) can
   sit at the row's far right without nesting interactive controls. */
function CollapsibleSectionHeading({
  children,
  expanded,
  onToggle,
  compactTop = false,
  trailing,
}: {
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** First section under the filter bar — less top padding so the
      gap between chrome and "Today" / first project doesn't feel empty. */
  compactTop?: boolean;
  /** Optional right-edge control (home/project list filter toggle). */
  trailing?: ReactNode;
}) {
  return (
    <div
      {...stylex.props(
        styles.collapsibleRow,
        compactTop ? styles.collapsibleRowCompact : styles.collapsibleRowTall
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        {...stylex.props(styles.collapsibleButton)}
      >
        {/* Label + chevron as a tight cluster (not row-end). */}
        <span {...stylex.props(styles.labelCluster)}>
          <span {...stylex.props(styles.truncate)}>{children}</span>
          <GroupChevron expanded={expanded} />
        </span>
      </button>
      {trailing ? <div {...stylex.props(styles.trailing)}>{trailing}</div> : null}
    </div>
  );
}

/* Project / repo section heading — Linear quiet section + small
   identity mark. Leading mark rules:
   - explicit `leading` (no-project chat glyph)
   - GitHub with `avatarUrl` → owner image
   - local project → monochrome Folder / FolderOpen by expand state
     (same `text-muted-foreground` as the section label)
   - GitHub without avatar → initial-letter fallback
   When `onToggle` is set the whole row is a button that collapses /
   expands the bucket body below. */
function ProjectBucketHeading({
  label,
  avatarUrl,
  hashSeed,
  isLocal = false,
  leading,
  expanded = true,
  onToggle,
  compactTop = false,
  trailing,
  isPrivate = false,
  privateLabel,
  privateHelpAriaLabel,
  onPrivateHelp,
}: {
  label: string;
  avatarUrl?: string | null;
  hashSeed?: string;
  /** True for local (non-GitHub) project buckets — uses a Folder icon
     instead of the colored initial-letter tile. */
  isLocal?: boolean;
  /** Overrides the default mark. Used by the no-project bucket. */
  leading?: ReactNode;
  /** Whether the bucket body is shown. Drives Folder vs FolderOpen. */
  expanded?: boolean;
  /** Click handler for collapse / expand. When set, the label cluster
     renders as a button; trailing stays a sibling so filter controls
     do not nest inside it. */
  onToggle?: () => void;
  /** First section under the filter bar — less top padding. */
  compactTop?: boolean;
  /** Optional right-edge control (home/project list filter toggle). */
  trailing?: ReactNode;
  /** Effective private state for local project buckets in team workspaces. */
  isPrivate?: boolean;
  privateLabel?: string;
  privateHelpAriaLabel?: string;
  onPrivateHelp?: () => void;
}) {
  let mark: ReactNode = leading;
  if (mark == null) {
    if (avatarUrl) {
      mark = (
        <CachedAvatarImg
          src={avatarUrl}
          alt=""
          loading="lazy"
          className={stylex.props(styles.bucketMarkImage).className}
        />
      );
    } else if (isLocal) {
      /* Closed folder when collapsed, open folder when expanded.
         Match label color so icon + text + chevron are one tone. */
      const FolderIcon = expanded ? FolderOpen : Folder;
      mark = (
        <FolderIcon
          className={stylex.props(styles.bucketMarkIcon).className}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      );
    } else {
      mark = <MobileInitialLetterAvatar name={label} hashSeed={hashSeed ?? label} size="xs" />;
    }
  }
  const labelCluster = (
    <>
      {mark}
      {/* Label + chevron share a tight cluster so the chevron sits
          immediately after the text, not at the row's far right. */}
      <span {...stylex.props(styles.labelCluster)}>
        <span {...stylex.props(styles.bucketLabel)}>{label}</span>
        {onToggle ? <GroupChevron expanded={expanded} /> : null}
      </span>
    </>
  );
  return (
    <div
      {...stylex.props(
        styles.bucketRow,
        compactTop ? styles.bucketRowCompact : styles.bucketRowTall
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          {...stylex.props(styles.bucketButton)}
        >
          {labelCluster}
        </button>
      ) : (
        <div {...stylex.props(styles.bucketBody)}>{labelCluster}</div>
      )}
      {isPrivate ? (
        onPrivateHelp ? (
          <button
            type="button"
            onClick={onPrivateHelp}
            aria-label={privateHelpAriaLabel ?? privateLabel}
            {...stylex.props(styles.privateBadge)}
          >
            <LockKeyhole className={stylex.props(styles.badgeGlyph).className} aria-hidden="true" />
            {privateLabel ? <span>{privateLabel}</span> : null}
            <CircleHelp className={stylex.props(styles.helpIcon).className} aria-hidden="true" />
          </button>
        ) : (
          <LockKeyhole
            className={stylex.props(styles.privateBadgeIcon).className}
            aria-hidden="true"
          />
        )
      ) : null}
      {trailing ? <div {...stylex.props(styles.trailing)}>{trailing}</div> : null}
    </div>
  );
}

/* Quiet chat glyph for the no-project bucket — same outer size as the
   project mark so the section rhythm stays aligned. */
function NoProjectBucketLeading() {
  return (
    <MessageCircle
      className={stylex.props(styles.bucketMarkIcon).className}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}

/* Shared selection-state shape that `MobileChatList` builds once at
   the top and forwards down through `MobileChatListCard` to each
   `ConversationRow`. Lifting the state up here means "select all"
   covers every row across grouped sections in one go, and the
   toolbar's count stays in sync with the rows below it. */
type ChatSelectionState = {
  active: boolean;
  isSelected: (chatId: string) => boolean;
  onToggleSelect: (chatId: string) => void;
  onLongPress: (chatId: string) => void;
};

/* Flat stack of `ConversationRow`s (no card chrome / dividers). Both
   the home Chat tab and the in-project page render rows through this —
   keeps the row chrome + grouping in one place so design tweaks land
   everywhere. */
export type MobileChatListRowActions = {
  /** Toggle pin / unpin for the given chat. Receives the chat id +
     the NEXT pinned state (so the handler doesn't have to look the
     current state up). Omit to hide the pin chip from the
     swipe-to-reveal drawer. Active (non-archived) list only. */
  onTogglePin?: (chatId: string, nextPinned: boolean) => void;
  /** Archive the chat. Omit to hide the archive chip from the
     drawer (and disable the super-swipe behavior). Active list only. */
  onArchive?: (chatId: string) => void;
  /** Restore (un-archive) the chat. Wires the restore chip in the
     swipe drawer of the *archived* list. Omit to hide it. */
  onRestore?: (chatId: string) => void;
};

export function MobileChatListCard({
  chats,
  selectedConversationId,
  onSelect,
  rowActions,
  archived = false,
  onRequestDelete,
  selection,
  preview,
  preserveOrder = false,
  status,
  shownIds,
}: {
  chats: MobileConversationItem[];
  /**
   * Ids every card of the surrounding list renders now. A row that leaves this
   * card for another one (a drop into another section, a tier change) is
   * removed at once instead of collapsing, so it is never shown twice.
   */
  shownIds?: ReadonlySet<string>;
  /** Status view rows: drag targeting, status swipes and the drop indicator. */
  status?: MobileChatCardStatus;
  /** A pin section: keep the given manual order instead of ranking by activity. */
  preserveOrder?: boolean;
  selectedConversationId?: string | null;
  onSelect?: (chatId: string) => void;
  rowActions?: MobileChatListRowActions;
  /** Archived list only: a row's delete chip calls this with its id so
     the owning `MobileChatList` can run the shared confirm-then-delete
     flow. Omit to hide the delete chip. */
  onRequestDelete?: (chatId: string) => void;
  /** When true, the AnimatePresence `key`-rotates so toggling between
     active and archived lists doesn't run the per-row exit animation
     on every row at once (laggy on lists with > a few entries), and
     each row's title renders dimmed to read as "this row is in the
     archive". The dimmed title is the visual cue in both modes. */
  archived?: boolean;
  /** When provided, the rows render in multi-select mode (or with
     long-press wired to enter it). Owned by `MobileChatList` so the
     toolbar's "select all" + count stay in sync across grouped
     sections. */
  selection?: ChatSelectionState;
  /** Caps the bucket at {@link MOBILE_CHAT_PREVIEW_MAX_ROOTS} top-level rows
     and appends a "Show more" stepper. Omit to render every row (what a
     standalone card without a `MobileChatList` around it does). */
  preview?: MobileChatPreviewState;
}) {
  /* The archived list swaps the pin/archive chips for restore/delete;
     each list mode only honours its own callbacks so a stray handler
     can't surface the wrong action in the wrong surface. */
  const { t } = useTranslation();
  const hasActions = archived
    ? Boolean(rowActions?.onRestore || onRequestDelete)
    : Boolean(rowActions?.onTogglePin || rowActions?.onArchive);
  /* Swipe-to-reveal and selection-mode tap should not coexist on the
     same row: the swipe captures pointer events that the selection
     tap also wants to claim. Drop the swipe wrapper once selection
     mode is *active* (long-press still works while inactive). */
  const wrapSwipe = hasActions && !(selection?.active ?? false);
  /* Sessions created by another Session (the `lody_session_create` MCP tool)
     render indented under their opener — same model as the desktop sidebar
     (`lib/session-opened-by-tree.ts`), resolved INSIDE this one bucket so a
     Pinned / date / project section boundary is never crossed. An opener that
     is missing from this bucket leaves its Session as an ordinary top-level
     row; the tree never hides anything.

     Collapse state is the SAME atom the sidebar lists use, so folding an
     opener in the drawer and in the mobile list can never disagree. */
  const collapsedOpeners = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const toggleCollapsedOpener = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);
  /* A capped bucket renders at most `MOBILE_CHAT_PREVIEW_MAX_ROOTS` top-level
     rows. `maxRoots` is applied AFTER `rootRank`, so the preview keeps the
     pinned-first / latest-activity order the bucket already promises — it
     truncates that order rather than reshuffling it. */
  const revealedRows = preview?.revealedRows ?? 0;
  const previewEnabled = preview != null;
  const capped = previewEnabled;
  const maxRoots = preview?.maxRoots ?? MOBILE_CHAT_PREVIEW_MAX_ROOTS;
  const treeNodes = useMemo(
    () =>
      buildOpenedBySessionTree(chats, {
        ...CHAT_OPENED_BY_TREE_ACCESSORS,
        isCollapsed: (openerId) => collapsedOpeners[openerId] === true,
        /* Bucket order is pinned-first then latest activity; rank an opener by
           its freshest opened Session so nesting cannot bury a just-updated
           row under a stale opener. */
        ...(preserveOrder
          ? {}
          : {
              rootRank: (chat: MobileConversationItem) =>
                pinnedFirstRootRank(chat.latestMessageAt ?? 0, chat.isPinned),
            }),
        ...(capped ? { maxRoots: maxRoots + revealedRows } : {}),
      }),
    [capped, chats, collapsedOpeners, maxRoots, preserveOrder, revealedRows]
  );
  /* Gate the toggle on TOP-LEVEL rows, matching what the cap actually limits:
     five openers plus the Sessions they opened is not an overflowing bucket,
     so it must not sprout a "Show more" the tap would not change.

     Deliberately NOT wrapped in `useMemo`. `MobileChatList` calls `groupChats`
     in its render body, so every bucket receives a freshly built `chats` array
     on every render — measured: a state-only re-render (tapping one bucket's
     toggle) hands all buckets a new array. A memo keyed on `chats` therefore
     cannot ever hit, and one that looks like a cache while caching nothing is
     worse than the O(rows) scan it fails to avoid. `previewEnabled` exists for
     the same reason: `preview` is a new object literal each render, so only the
     one bit of it that matters may be read. */
  const rootCount = previewEnabled
    ? countOpenedByTreeRoots(chats, CHAT_OPENED_BY_TREE_ACCESSORS)
    : 0;
  const overflowsPreview = rootCount > maxRoots;
  const hasMoreRows = rootCount > maxRoots + revealedRows;
  return (
    /* Flat list — no rounded card shell or inter-row dividers. Rows
       sit directly on the page canvas; `ConversationRow` supplies its
       own horizontal padding and selected/active backgrounds. */
    <>
      {/* AnimatePresence runs the exit transition on a row whose key
         leaves the children set (i.e. the parent removed it from the
         chats array after archive). `initial={false}` skips the
         appear animation on first mount — we don't want every row to
         do a height-grow when the list first renders or when the user
         flips a filter pill.

         Keying on the archived flag forces a full unmount + remount of
         AnimatePresence and its children when the toggle flips, so the
         per-row exit animations don't fire for every row at once
         (which felt like a freeze on lists with > 5–10 rows). The
         intentional single-row archive case still works because that
         path only removes one item from the same key bucket.

         "Show less" is the same shape of bulk removal. Measured with the key
         carrying only `archived`: collapsing a 14-row bucket leaves all 14 rows
         in the DOM a frame later, animating out together for 400ms. Adding the
         preview state to the key makes that transition a remount instead — the
         same frame reports the 5 rows that remain — and `initial={false}` means
         expanding adds its rows with no enter animation either. */}
      <AnimatePresence
        initial={false}
        custom={shownIds}
        key={`${archived ? 'archived' : 'active'}:${capped ? `preview:${revealedRows}` : 'full'}`}
      >
        {treeNodes.map((node, nodeIndex) => {
          const conversation = node.item;
          let rootId = conversation.id;
          if (node.depth > 0) {
            for (let i = nodeIndex - 1; i >= 0; i -= 1) {
              if (treeNodes[i]!.depth === 0) {
                rootId = treeNodes[i]!.id;
                break;
              }
            }
          }
          const showDropBefore =
            status?.dropBeforeId !== undefined &&
            node.depth === 0 &&
            status.dropBeforeId === conversation.id;
          /* Same builder the sidebar rows use, so the disclosure's aria-label
             and its "Show N opened sessions" count stay identical across
             platforms and only need translating once. */
          const treeSlot = buildSessionRowOpenedByTreeSlot(node, t, () =>
            toggleCollapsedOpener(node.id)
          );
          /* The chevron only renders while the leading node is free, so only
             then does the row put a tap target in the back-swipe strip. */
          const showsTreeToggle =
            treeSlot?.kind === 'opener' && !conversationRowHasActivity(conversation);
          const row = (
            <ConversationRow
              conversation={conversation}
              selected={selectedConversationId === conversation.id}
              onClick={() => onSelect?.(conversation.id)}
              archived={archived}
              treeSlot={treeSlot}
              selectionMode={!conversation.readOnly && (selection?.active ?? false)}
              isSelected={selection?.isSelected(conversation.id) ?? false}
              onToggleSelect={
                selection && !conversation.readOnly
                  ? () => selection.onToggleSelect(conversation.id)
                  : undefined
              }
              onLongPress={
                selection && !conversation.readOnly
                  ? () => selection.onLongPress(conversation.id)
                  : undefined
              }
            />
          );
          return (
            <motion.div
              key={conversation.id}
              layout
              /* Pin layout-tracking to the row count. Without this,
                 framer-motion re-measures via `getBoundingClientRect()`
                 on EVERY render — including when an ancestor transforms
                 (e.g. pull-to-refresh translates the whole list region).
                 The viewport position then "changes", and framer spring-
                 animates each row back to where it thinks it should be,
                 producing the visible lag where the rows trail behind
                 the heading + pills during a pull. Gating on the row
                 count limits the layout pass to actual archive /
                 filter-set transitions, which is the only time we
                 actually want the slide-up animation. */
              layoutDependency={chats.length}
              initial={false}
              variants={rowExitVariants(conversation.id)}
              exit="exit"
              transition={ROW_EXIT_TRANSITION}
              /* `overflow-hidden` lets `height: 0` actually clip the
                 row content while it collapses. Canvas bg matches the
                 page so exit-collapse never flashes a seam. */
              {...stylex.props(styles.rowShell)}
              {...(status
                ? {
                    'data-status-row-id': conversation.id,
                    'data-status-root-id': rootId,
                    'data-status-area': status.area,
                    'data-status-section': status.sectionId ?? '',
                    style: STATUS_ROW_TOUCH_STYLE,
                  }
                : {})}
            >
              {showDropBefore ? <MobileStatusDropIndicator /> : null}
              {wrapSwipe && status ? (
                <MobileStatusSwipeRow
                  liftAboveEdgeSwipeZone={showsTreeToggle}
                  isLocked={status.isLocked}
                  isPinned={conversation.isPinned ?? false}
                  onTogglePin={
                    rowActions?.onTogglePin && status.canPrefer(conversation.id)
                      ? () => rowActions.onTogglePin!(conversation.id, !conversation.isPinned)
                      : undefined
                  }
                  trailing={statusSwipeActions(status, conversation, rowActions)}
                >
                  {row}
                </MobileStatusSwipeRow>
              ) : wrapSwipe ? (
                archived ? (
                  <MobileSwipeableRow
                    variant="archived"
                    liftAboveEdgeSwipeZone={showsTreeToggle}
                    onRestore={
                      !conversation.readOnly && rowActions?.onRestore
                        ? () => rowActions.onRestore!(conversation.id)
                        : undefined
                    }
                    onDelete={
                      !conversation.readOnly && onRequestDelete
                        ? () => onRequestDelete(conversation.id)
                        : undefined
                    }
                  >
                    {row}
                  </MobileSwipeableRow>
                ) : (
                  <MobileSwipeableRow
                    /* Only a rendered chevron puts a control in the leading
                       48px, so only then does the row need to clear the
                       back-swipe strip. */
                    liftAboveEdgeSwipeZone={showsTreeToggle}
                    isPinned={conversation.isPinned ?? false}
                    onTogglePin={
                      rowActions?.onTogglePin
                        ? () => rowActions.onTogglePin!(conversation.id, !conversation.isPinned)
                        : undefined
                    }
                    onArchive={
                      !conversation.readOnly && rowActions?.onArchive
                        ? () => rowActions.onArchive!(conversation.id)
                        : undefined
                    }
                  >
                    {row}
                  </MobileSwipeableRow>
                )
              ) : (
                row
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
      {status?.dropBeforeId === null ? <MobileStatusDropIndicator /> : null}
      {overflowsPreview && preview ? (
        <MobileChatPreviewToggle
          revealedRows={revealedRows}
          hasMoreRows={hasMoreRows}
          onShowMore={preview.onShowMore}
          onShowLess={preview.onShowLess}
        />
      ) : null}
    </>
  );
}

const rowExitVariants = (id: string) => ({
  exit: (shown: ReadonlySet<string> | undefined) =>
    shown?.has(id)
      ? { height: 0, opacity: 0, transition: { duration: 0 } }
      : { height: 0, opacity: 0 },
});

/** A lifted row must not start the WebView's text selection or callout. */
const STATUS_ROW_TOUCH_STYLE = {
  WebkitUserSelect: 'none',
  userSelect: 'none',
  WebkitTouchCallout: 'none',
} as const;

/** Trailing swipe per tier (note's phone table): Settle + Later, or Archive. */
function statusSwipeActions(
  status: MobileChatCardStatus,
  conversation: MobileConversationItem,
  rowActions: MobileChatListRowActions | undefined
): Array<{ id: MobileStatusSwipeActionId; onSelect: () => void }> {
  const archive =
    !conversation.readOnly && rowActions?.onArchive
      ? [{ id: 'archive' as const, onSelect: () => rowActions.onArchive!(conversation.id) }]
      : [];
  if (status.area === 'settled' || status.area === 'pinned') return archive;
  if (!status.canManage(conversation.id)) return archive;
  return [
    { id: 'settle', onSelect: () => status.onSettle(conversation.id) },
    { id: 'later', onSelect: () => status.onLater(conversation.id) },
  ];
}

/** Where a dragged row would land. */
function MobileStatusDropIndicator() {
  return (
    <div
      aria-hidden="true"
      data-status-drop-indicator=""
      {...stylex.props(statusStyles.dropIndicator)}
    />
  );
}

/* Tail affordance of a capped bucket. Sits inside the bucket body, directly
   under the last row and above the next group heading, so it reads as the end
   of THIS list rather than as chrome between sections.

   Geometry: the label starts on the row-title x (px-4 + the 16px leading slot
   + gap-2.5 = 42px) via an empty spacer, exactly as the desktop sidebar's
   "Show more" does. The slot stays EMPTY on purpose — it is the column that
   carries a row's status indicator and an opener's fold chevron, so a chevron
   here would read as one of those. The label alone says which way it goes.

   The type is quieter than a session title (15px medium foreground) and than a
   group heading (14px semibold muted), which is the hierarchy: rows, then
   sections, then this. Full-width `min-h-11` keeps a thumb target the size of
   a row. */
function MobileChatPreviewToggle({
  revealedRows,
  hasMoreRows,
  onShowMore,
  onShowLess,
}: {
  revealedRows: number;
  hasMoreRows: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const wasRevealed = useRef(revealedRows > 0);
  /* Collapsing removes rows ABOVE this button, so on a long bucket the tap
     target — and everything the user was reading — jumps off the top of the
     viewport. Pull it back into view minimally (`nearest` is a no-op when it
     is already visible). A layout effect runs after the rows are removed and
     before paint, so the correction never renders as a visible scroll jump.
     Chrome's native scroll anchoring would cover this on its own; WebKit has
     never shipped `overflow-anchor`, and iOS is the surface this list is for. */
  useLayoutEffect(() => {
    const revealed = revealedRows > 0;
    if (wasRevealed.current && !revealed) {
      buttonRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
    wasRevealed.current = revealed;
  }, [revealedRows]);
  return (
    <div ref={buttonRef}>
      {hasMoreRows ? (
        <button
          type="button"
          data-chat-list-preview-toggle=""
          aria-expanded={revealedRows > 0}
          onClick={onShowMore}
          {...stylex.props(styles.previewToggle)}
        >
          <span {...stylex.props(styles.previewSpacer)} aria-hidden="true" />
          <span {...stylex.props(styles.truncate)}>{t('sessions.showMore', 'Show more')}</span>
        </button>
      ) : null}
      {revealedRows > 0 ? (
        <button
          type="button"
          data-chat-list-preview-collapse=""
          aria-expanded="true"
          onClick={onShowLess}
          {...stylex.props(styles.previewToggle)}
        >
          <span {...stylex.props(styles.previewSpacer)} aria-hidden="true" />
          <span {...stylex.props(styles.truncate)}>{t('sessions.showLess', 'Show less')}</span>
        </button>
      ) : null}
    </div>

  );
}

/** Status tier bucket ids (`specs/sidebar-status-view.md`). */
export const STATUS_BUCKET_FOCUS = 'status:focus';
export const STATUS_BUCKET_LATER = 'status:later';
export const STATUS_BUCKET_SETTLED = 'status:settled';

export type MobileChatBucket = {
  id: string;
  items: MobileConversationItem[];
  label?: string;
  /** Pinned-area bucket: its pin section (`null` = default). */
  pinSectionId?: string | null;
  /** Status grouping: the tier this bucket shows. */
  tier?: StatusViewTier;
  /** Pinned-area bucket: pinned rows the list's scope hid. */
  hiddenCount?: number;
};

const bucketIdOfSection = (sectionId: string | null) =>
  sectionId === null ? PINNED_BUCKET_ID : `${PIN_SECTION_BUCKET_PREFIX}${sectionId}`;

/**
 * Build ordered list sections from the shared Status view layout. The Pinned
 * area comes from the layout in every grouping: pinned rows and the visible
 * rows they opened, split into pin sections in their manual order. Named
 * sections stay listed while empty so they remain a drop target and their
 * header menu stays reachable. The remaining rows then follow:
 * - `status`: Focus, Later and Settled in the layout's order (Focus always,
 *   so a Later or Settled row can be dropped into it)
 * - `none`: one unlabeled flat tail
 * - `project` / `date`: normal buckets. An opened Session joins the bucket
 *   of its topmost unpinned ancestor, so the tree there indents it, matching
 *   the desktop Workspace groups. In `date` mode that bucket is the tree's
 *   freshest update, the same time that ranks the opener.
 *
 * Item order inside project / date buckets matches the input order.
 * `nowMs` is injectable for tests.
 */
export function groupChats(
  chats: MobileConversationItem[],
  groupBy: MobileChatGroupBy,
  nowMs: number = getServerNow(),
  pinSections: readonly PinSection[] = [],
  sectionsLoaded = true,
  layout: StatusViewLayout = buildMobileStatusViewLayout(chats, {
    sections: pinSections,
    sectionsLoaded,
    writable: true,
    nowMs,
  })
): MobileChatBucket[] {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const itemsOf = (rows: readonly StatusViewRow[]) =>
    flattenStatusViewRows(rows).flatMap((row) => {
      const item = byId.get(row.id);
      if (!item) return [];
      return [row.unread && !item.hasUnreadMessages ? { ...item, hasUnreadMessages: true } : item];
    });

  const ordered: MobileChatBucket[] = [];
  const pinnedIds = new Set<string>();
  for (const section of layout.pinned) {
    const items = itemsOf(section.rows);
    for (const item of items) pinnedIds.add(item.id);
    if (items.length === 0 && section.sectionId === null && section.hiddenCount === 0) continue;
    ordered.push({
      id: bucketIdOfSection(section.sectionId),
      items,
      ...(section.name != null ? { label: section.name } : {}),
      pinSectionId: section.sectionId,
      ...(section.hiddenCount > 0 ? { hiddenCount: section.hiddenCount } : {}),
    });
  }

  if (groupBy === 'status') {
    const later = itemsOf(layout.later).map((item) => {
      const countdown =
        typeof item.snoozedUntil === 'number'
          ? formatSnoozeCountdown(item.snoozedUntil, nowMs)
          : null;
      return countdown ? { ...item, snoozeCountdown: countdown } : item;
    });
    ordered.push({ id: STATUS_BUCKET_FOCUS, items: itemsOf(layout.focus), tier: 'focus' });
    if (later.length > 0) ordered.push({ id: STATUS_BUCKET_LATER, items: later, tier: 'later' });
    const settled = itemsOf(layout.settled);
    if (settled.length > 0)
      ordered.push({ id: STATUS_BUCKET_SETTLED, items: settled, tier: 'settled' });
    return ordered;
  }

  const unpinned = chats.filter((chat) => !pinnedIds.has(chat.id) && !chat.isPinned);

  if (groupBy === 'none') {
    if (unpinned.length > 0) {
      ordered.push({ id: FLAT_UNPINNED_BUCKET_ID, items: unpinned });
    }
    return ordered;
  }

  const naturalBucketById = new Map(
    unpinned.map((chat) => [chat.id, bucketIdFor(chat, groupBy, nowMs)])
  );
  const openerById = new Map(
    unpinned.map((chat) => [chat.id, CHAT_OPENED_BY_TREE_ACCESSORS.getOpenedBySessionId(chat)])
  );
  const moved =
    groupBy === 'project'
      ? placeOpenedSessionsWithOpeners(naturalBucketById, (id) => openerById.get(id))
      : placeTreesByFreshestUpdate(unpinned, openerById, nowMs);
  const buckets = new Map<string, MobileConversationItem[]>();
  for (const chat of unpinned) {
    const id = moved.get(chat.id) ?? naturalBucketById.get(chat.id) ?? NO_PROJECT_BUCKET_ID;
    const list = buckets.get(id) ?? [];
    list.push(chat);
    buckets.set(id, list);
  }

  if (groupBy === 'date') {
    const ids = [...buckets.keys()].sort(compareDateBucketIds);
    for (const id of ids) {
      const items = buckets.get(id);
      if (items && items.length > 0) ordered.push({ id, items });
    }
    return ordered;
  }

  /* Project mode: sort by freshest item in each bucket. Input is
     already recency-sorted within the unpinned slice, so the FIRST
     item in each bucket is its freshest. */
  const bucketRecency = new Map<string, number>();
  for (const [id, items] of buckets) {
    const head = items[0];
    const ts = typeof head?.latestMessageAt === 'number' ? head.latestMessageAt : 0;
    bucketRecency.set(id, ts);
  }
  const ids = [...buckets.keys()].sort((a, b) => {
    /* No-project bucket sinks to the end regardless of recency. */
    if (a === NO_PROJECT_BUCKET_ID && b !== NO_PROJECT_BUCKET_ID) return 1;
    if (b === NO_PROJECT_BUCKET_ID && a !== NO_PROJECT_BUCKET_ID) return -1;
    return (bucketRecency.get(b) ?? 0) - (bucketRecency.get(a) ?? 0);
  });
  for (const id of ids) {
    const items = buckets.get(id);
    if (items && items.length > 0) ordered.push({ id, items });
  }
  return ordered;
}

/** Date bucket of every row in an opened-by tree: the day of its freshest member. */
function placeTreesByFreshestUpdate(
  chats: MobileConversationItem[],
  openerById: ReadonlyMap<string, string | null | undefined>,
  nowMs: number
): Map<string, string> {
  // Each row is its own group, so every nested row "moves" to its tree root.
  const rootById = placeOpenedSessionsWithOpeners(
    new Map(chats.map((chat) => [chat.id, chat.id])),
    (id) => openerById.get(id)
  );
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const latestOf = (id: string) => {
    const latest = chatById.get(id)?.latestMessageAt;
    return typeof latest === 'number' ? latest : 0;
  };
  const treeLatest = new Map<string, number>();
  for (const [id, root] of rootById) {
    treeLatest.set(root, Math.max(treeLatest.get(root) ?? latestOf(root), latestOf(id)));
  }
  const bucketById = new Map<string, string>();
  for (const chat of chats) {
    const latest = treeLatest.get(rootById.get(chat.id) ?? chat.id);
    if (latest !== undefined) bucketById.set(chat.id, dateBucketIdFor(latest, nowMs));
  }
  return bucketById;
}

function bucketIdFor(
  chat: MobileConversationItem,
  groupBy: 'project' | 'date',
  nowMs: number
): string {
  if (groupBy === 'project') {
    return chat.projectKey ?? NO_PROJECT_BUCKET_ID;
  }
  if (groupBy === 'date') {
    return dateBucketIdFor(chat.latestMessageAt, nowMs);
  }
  return NO_PROJECT_BUCKET_ID;
}

/** Map a message timestamp onto a date-bucket id. Exported for tests. */
export function dateBucketIdFor(
  latestMessageAt: number | null | undefined,
  nowMs: number = getServerNow()
): string {
  const t =
    typeof latestMessageAt === 'number' && Number.isFinite(latestMessageAt) ? latestMessageAt : 0;
  if (t <= 0) return DATE_BUCKET_UNKNOWN;

  const startToday = startOfLocalDayMs(nowMs);
  const startYesterday = startToday - 24 * 60 * 60 * 1000;
  const startThisWeek = startOfWeekMondayMs(startToday);
  const startThisMonth = startOfMonthMs(nowMs);

  if (t >= startToday) return DATE_BUCKET_TODAY;
  if (t >= startYesterday) return DATE_BUCKET_YESTERDAY;
  /* "This Week" = earlier in the current week, after today/yesterday
     have already claimed those days. */
  if (t >= startThisWeek) return DATE_BUCKET_THIS_WEEK;
  /* "This Month" = earlier in the current calendar month, after
     this-week has claimed the week slice. */
  if (t >= startThisMonth) return DATE_BUCKET_THIS_MONTH;

  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${DATE_MONTH_PREFIX}${y}-${m}`;
}

function startOfLocalDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 local of the week that contains `dayStartMs`
    (itself a local-midnight timestamp). */
function startOfWeekMondayMs(dayStartMs: number): number {
  const d = new Date(dayStartMs);
  const day = d.getDay(); /* 0 = Sun … 6 = Sat */
  const daysFromMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - daysFromMonday);
  return d.getTime();
}

function startOfMonthMs(ms: number): number {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Named date buckets first (Today → This Month), then month keys
    newest-first, then unknown last. */
function compareDateBucketIds(a: string, b: string): number {
  const ai = (DATE_NAMED_BUCKET_ORDER as readonly string[]).indexOf(a);
  const bi = (DATE_NAMED_BUCKET_ORDER as readonly string[]).indexOf(b);
  const aNamed = ai >= 0;
  const bNamed = bi >= 0;
  if (aNamed && bNamed) return ai - bi;
  if (aNamed) return -1;
  if (bNamed) return 1;
  if (a === DATE_BUCKET_UNKNOWN && b !== DATE_BUCKET_UNKNOWN) return 1;
  if (b === DATE_BUCKET_UNKNOWN && a !== DATE_BUCKET_UNKNOWN) return -1;
  /* `date:month:YYYY-MM` — lexicographic reverse = newest first. */
  if (a.startsWith(DATE_MONTH_PREFIX) && b.startsWith(DATE_MONTH_PREFIX)) {
    return b.localeCompare(a);
  }
  return a.localeCompare(b);
}

/** Resolve a date-bucket id to a display label. `groupLabels` overrides
    named buckets; month keys format via `Intl` when not overridden. */
export function resolveDateBucketLabel(
  bucketId: string,
  groupLabels: Partial<Record<string, string>> = {}
): string {
  const override = groupLabels[bucketId];
  if (override) return override;
  switch (bucketId) {
    case PINNED_BUCKET_ID:
      return 'Pinned';
    case DATE_BUCKET_TODAY:
      return 'Today';
    case DATE_BUCKET_YESTERDAY:
      return 'Yesterday';
    case DATE_BUCKET_THIS_WEEK:
      return 'This Week';
    case DATE_BUCKET_THIS_MONTH:
      return 'This Month';
    case DATE_BUCKET_UNKNOWN:
      return 'Older';
    default:
      break;
  }
  if (bucketId.startsWith(DATE_MONTH_PREFIX)) {
    const raw = bucketId.slice(DATE_MONTH_PREFIX.length);
    const [yStr, mStr] = raw.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          month: 'long',
          year: 'numeric',
        }).format(new Date(y, m - 1, 1));
      } catch {
        return `${y}-${mStr}`;
      }
    }
  }
  return bucketId;
}

export type MobileChatListSelectionLabels = {
  /** Plural "{count} 已选" — pass a formatter so the caller can do its
     own i18n. */
  selectedCount?: (count: number) => string;
  cancel?: string;
  deleteAction?: string;
  /** Confirmation alert-dialog copy. */
  confirmTitle?: string;
  /** `{count}` placeholder is substituted with the selected count. */
  confirmDescription?: string;
  confirmDelete?: string;
};

/**
 * Top-level chat list renderer. Combines `MobileChatListCard` with the
 * grouping mode + section headings. Used by the home Chat tab and the
 * in-project conversation list — both wrap it with their own header
 * (full-screen heading on home, per-project header on the detail
 * page) and filter pills, but the list body itself is identical.
 *
 * When `archived` is true AND `onPermanentDelete` is wired, the list
 * also exposes a long-press multi-select flow:
 * - Long-press any row → enters selection mode + selects that row.
 * - The flat-heading slot is replaced by a toolbar with a select-all
 *   checkbox + count on the left, Cancel + Delete on the right.
 * - Delete opens a confirmation alert-dialog; confirm calls
 *   `onPermanentDelete` with the selected ids.
 * The toolbar lives at the position the heading occupied so the
 * user's mental model of "where the page-level controls live" stays
 * intact; the rest of the list scrolls under it normally.
 */
export function MobileChatList({
  chats,
  groupBy = 'none',
  groupLabels = {},
  flatHeading,
  firstGroupTrailing,
  selectedConversationId,
  onSelect,
  rowActions,
  archived = false,
  onPermanentDelete,
  selectionLabels,
  capGroupPreviews = false,
  privateLabel,
  privateHelpAriaLabel,
  onPrivateHelp,
  bucketStateKey,
  splitTargets,
  pinSections: pinSectionsOverride,
  statusCommands,
  statusWritable = true,
  statusPreferable = true,
  scopeHiddenCounts,
}: {
  chats: MobileConversationItem[];
  /** Status view writes (drag, row menu, section header menu). Omit for a read-only list. */
  statusCommands?: MobileStatusCommands;
  /**
   * Whether this member may write Status view state at all (Later, Settle, Focus
   * order, pin sections); read-only members only pin (`useStatusViewWritable`).
   */
  statusWritable?: boolean;
  /** False when not even a pin can be written (an encrypted workspace's read role). */
  statusPreferable?: boolean;
  /** Pinned rows the list's scope hid, by pin section id (`""` = default). */
  scopeHiddenCounts?: Record<string, number>;
  /** Pin sections to split pinned rows by; defaults to the workspace catalog's. */
  pinSections?: readonly PinSection[];
  groupBy?: MobileChatGroupBy;
  /** Per-bucket headings keyed by bucket id: `NO_PROJECT_BUCKET_ID` and project
     keys in project mode, the `DATE_BUCKET_*` ids in date mode, and
     `PINNED_BUCKET_ID`. Missing entries fall back to a built-in label or the id. */
  groupLabels?: Partial<Record<string, string>>;
  /** Heading rendered ABOVE the list when groupBy is 'none'. Omit to
     render a flat list with no heading. Replaced by the multi-select
     toolbar when selection mode is active. */
  flatHeading?: ReactNode;
  /** Right-edge control on the first group heading (home/project filter
     chip). When the first section is an unlabeled flat tail, a trailing-
     only row is rendered so the control still has a home. Hidden while
     multi-select is active (selection toolbar owns that slot). */
  firstGroupTrailing?: ReactNode;
  selectedConversationId?: string | null;
  onSelect?: (chatId: string) => void;
  /** Per-row swipe-action callbacks. Forward whatever the caller
     has wired (pin, archive, both, or neither). */
  rowActions?: MobileChatListRowActions;
  /** Renders the list against the archived surface (dimmed titles +
     suppresses the per-row exit animation on toggle). See
     `MobileChatListCard` for the rationale. */
  archived?: boolean;
  /** Hands a batch of ids to the caller for permanent deletion. Only
     consulted when `archived` is true — wires up the long-press
     multi-select flow. The promise lets the list wait before
     clearing its selection state. */
  onPermanentDelete?: (chatIds: string[]) => void | Promise<void>;
  /** Caps every bucket at {@link MOBILE_CHAT_PREVIEW_MAX_ROOTS} top-level rows
     behind a "Show more" stepper. On for the workspace home list, where
     buckets compete for the screen and one busy project would otherwise push
     every other project and worktree below the fold. Off inside a single
     project's page: the user drilled in to read exactly that list, and there
     is nothing else there for a cap to make room for.

     This stays an explicit flag rather than being derived from
     `groupBy !== 'none'`, which is equivalent TODAY and shorter. The project
     page is `none` only because `chat-landing.tsx` pins it there so a
     single-bucket list does not render a redundant heading — a presentation
     decision that has nothing to do with capping. Deriving from it would couple
     the two through a shared variable and fail silently in both directions: give
     the project page a date mode and the cap switches on and starts hiding
     worktree rows, which is the opposite of what it is for; give home a flat
     mode and the cap disappears. `groupBy` also defaults to `none`, so a new
     caller would silently opt out. */
  capGroupPreviews?: boolean;
  /** Keeps group fold / reveal state across unmounts (navigating to
     Settings and back). Surfaces sharing a key share that state; omit it to
     scope the state to this mount. */
  bucketStateKey?: string;
  /** Home-owned scroll regions for the first and remaining whole buckets. */
  splitTargets?: { upper: HTMLElement; lower: HTMLElement };
  /** Copy for the multi-select toolbar + confirmation alert-dialog.
     All keys are optional with reasonable Chinese defaults; callers
     can override to localize. */
  selectionLabels?: MobileChatListSelectionLabels;
  privateLabel?: string;
  privateHelpAriaLabel?: string;
  onPrivateHelp?: () => void;
}) {
  const workspaceCatalog = useWorkspaceCatalog();
  const pinSections = pinSectionsOverride ?? workspaceCatalog.pinSections;
  // Until the section rows are read, sectioned pins wait instead of flashing as unsectioned.
  const pinSectionsLoaded =
    pinSectionsOverride !== undefined || workspaceCatalog.loaded || workspaceCatalog.failed;
  const { t } = useTranslation();
  const statusMode = groupBy === 'status' && !archived;
  const statusList = useMobileStatusList({
    chats,
    sections: pinSections,
    sectionsLoaded: pinSectionsLoaded,
    writable: statusWritable,
    preferable: statusPreferable,
    scopeHiddenCounts,
    statusMode,
    commands: archived ? undefined : statusCommands,
    rowActions,
    touchSurfaces: splitTargets ? [splitTargets.upper, splitTargets.lower] : undefined,
  });
  /* Multi-select state is owned here so a Select-All hits every row,
     including rows that live in separate group cards when
     `groupBy !== 'none'`. */
  const selectionEnabled = archived && Boolean(onPermanentDelete);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  /* Project-group collapse (ids in `collapsed` hide their body; default
     empty → every bucket starts expanded) and buckets the user expanded past
     the preview cap (`expanded`). Every bucket starts capped at
     `MOBILE_CHAT_PREVIEW_MAX_ROOTS`, which is the whole point: without it a
     project with forty Sessions pushes every other project and worktree off
     the screen. The preview flag is deliberately NOT the shared opener-fold
     atom — see `MobileChatPreviewState`. With `bucketStateKey` the state
     outlives this component; without it, it lives and dies with the mount. */
  const [localBucketUiStateAtom] =
    useState<PrimitiveAtom<MobileChatBucketUiState>>(createBucketUiStateAtom);
  const [bucketUiState, setBucketUiState] = useAtom(
    bucketStateKey ? mobileChatBucketUiStateAtomFamily(bucketStateKey) : localBucketUiStateAtom
  );
  const collapsedBucketIds = bucketUiState.collapsed;
  const revealedRowsByBucket = bucketUiState.revealed;
  const toggleBucket = (bucketId: string) => {
    setBucketUiState((prev) => ({ ...prev, collapsed: toggleInSet(prev.collapsed, bucketId) }));
  };
  const showMoreBucketRows = (bucketId: string, step: number) => {
    setBucketUiState((prev) => ({
      ...prev,
      revealed: { ...prev.revealed, [bucketId]: (prev.revealed[bucketId] ?? 0) + step },
    }));
  };
  const showLessBucketRows = (bucketId: string) => {
    setBucketUiState((prev) => ({ ...prev, revealed: { ...prev.revealed, [bucketId]: 0 } }));
  };
  /* Pending permanent-delete confirmation. Drives one shared
     alert-dialog for two entry points: the multi-select toolbar
     (`fromSelection: true`, so confirming also exits selection mode)
     and a single row's swipe delete chip (`fromSelection: false`).
     `null` = dialog closed. */
  const [pendingDelete, setPendingDelete] = useState<{
    ids: string[];
    fromSelection: boolean;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  /* The full id set for "select-all" computations. Memoized so the
     toolbar can read it cheaply on every render. */
  const allIds = useMemo(() => chats.filter((c) => !c.readOnly).map((c) => c.id), [chats]);

  /* When the underlying chat set changes (e.g. user flips the archive
     toggle off, or a delete completes), drop any ids that are no
     longer present so the toolbar's count stays accurate. We don't
     unconditionally clear because the user may still be selecting
     mid-mutation. */
  const validSelectedIds = useMemo(() => {
    if (selectedIds.size === 0) return selectedIds;
    const idSet = new Set(allIds);
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (idSet.has(id)) next.add(id);
    }
    if (next.size === selectedIds.size) return selectedIds;
    return next;
  }, [allIds, selectedIds]);

  const selectedCount = validSelectedIds.size;
  const allSelected = selectedCount > 0 && selectedCount === allIds.length;

  /* Selection-mode handlers. `enterMode` is fired by a row long-press
     and selects that row in the same tick so the user sees their
     gesture take effect immediately (rather than a two-step "mode
     on, now tap to actually select"). */
  const enterModeWithSelection = (chatId: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([chatId]));
  };
  const toggleOne = (chatId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedIds((prev) => {
      if (prev.size === allIds.length && allIds.length > 0) return new Set();
      return new Set(allIds);
    });
  };
  const exitMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };
  const handleDelete = async () => {
    if (!onPermanentDelete || !pendingDelete || pendingDelete.ids.length === 0) return;
    const { ids, fromSelection } = pendingDelete;
    setIsDeleting(true);
    try {
      await onPermanentDelete(ids);
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
      /* Only the multi-select entry point owns selection state; a swipe
         delete never entered selection mode, so leave it untouched. */
      if (fromSelection) exitMode();
    }
  };
  /* Swipe delete on a single archived row → same confirm-then-delete
     flow as the toolbar, scoped to that one id. Guard on
     `onPermanentDelete` so a row can't open a dialog that has nothing
     to call on confirm. */
  const requestSwipeDelete = (chatId: string) => {
    if (!onPermanentDelete) return;
    setPendingDelete({ ids: [chatId], fromSelection: false });
  };

  const pendingDeleteCount = pendingDelete?.ids.length ?? 0;

  const selectionState: ChatSelectionState | undefined = selectionEnabled
    ? {
        active: selectionMode,
        isSelected: (chatId) => validSelectedIds.has(chatId),
        onToggleSelect: toggleOne,
        onLongPress: enterModeWithSelection,
      }
    : undefined;

  /* The heading slot we render at the top of the list:
     - selection-mode ON → multi-select toolbar
     - selection-mode OFF, flatHeading present → the original heading
     - neither → nothing
     Grouped lists (groupBy !== 'none') don't carry a flat heading so
     the toolbar lives ABOVE the first group's bucket label, which is
     fine — the bucket labels still appear between groups. */
  const selectionToolbarActive = selectionEnabled && selectionMode;
  const headingNode = selectionToolbarActive ? (
    <SelectionToolbar
      selectedCount={selectedCount}
      allSelected={allSelected}
      anySelected={selectedCount > 0}
      labels={selectionLabels}
      onToggleAll={toggleAll}
      onCancel={exitMode}
      onDeleteClick={() =>
        setPendingDelete({ ids: Array.from(validSelectedIds), fromSelection: true })
      }
    />
  ) : flatHeading != null && groupBy === 'none' ? (
    <div {...stylex.props(styles.flatHeadingRow)}>
      <div {...stylex.props(styles.flatHeadingText)}>{flatHeading}</div>
      {firstGroupTrailing ? (
        <div {...stylex.props(styles.trailing)}>{firstGroupTrailing}</div>
      ) : null}
    </div>
  ) : null;

  /* `firstGroupTrailing` only mounts on the first *visible* group
     heading while multi-select is off — selection toolbar already owns
     that vertical band. */
  const showFirstGroupTrailing = Boolean(firstGroupTrailing) && !selectionToolbarActive;
  /* When groupBy is none and flatHeading is set, the trailing already
     lives on that heading above the cards — don't also pin it to the
     first Pinned / flat bucket. */
  const trailingConsumedByFlatHeading =
    flatHeading != null && groupBy === 'none' && !selectionToolbarActive;

  /* Always go through `groupChats` so pinned rows lift into a top
     "Pinned" section in every mode (project / date / flat). */
  const groups = groupChats(
    chats,
    groupBy,
    undefined,
    pinSections,
    pinSectionsLoaded,
    statusList.layout
  );
  const isBucketExpanded = (id: string, tier: StatusViewTier | undefined) =>
    collapsedBucketIds.has(id) === (tier ? isStatusTierCollapsedByDefault(tier) : false);
  const shownIds = new Set(
    groups.flatMap((group) =>
      isBucketExpanded(group.id, group.tier) ? group.items.map((item) => item.id) : []
    )
  );
  const cards = groups.map(({ id, items, label, tier, pinSectionId, hiddenCount }, index) => {
    const expanded = isBucketExpanded(id, tier);
    const isPinnedBucket = pinSectionId !== undefined;
    const dropTarget = statusList.dropTarget;
    const cardStatus: MobileChatCardStatus | undefined =
      statusMode && statusCommands && (tier || isPinnedBucket)
        ? {
            area: tier ?? 'pinned',
            sectionId: pinSectionId ?? null,
            dropBeforeId:
              dropTarget &&
              ((dropTarget.to.area === 'focus' && tier === 'focus') ||
                (dropTarget.to.area === 'pinned' &&
                  isPinnedBucket &&
                  dropTarget.to.sectionId === pinSectionId))
                ? dropTarget.beforeId
                : undefined,
            canManage: statusList.canManage,
            canPrefer: statusList.canPrefer,
            onLater: statusList.openLater,
            onSettle: statusCommands.settle,
            isLocked: statusList.drag.isLifted,
          }
        : undefined;
    const dropHeaderAttrs =
      cardStatus && (tier === 'focus' || isPinnedBucket)
        ? {
            'data-status-drop-header': '',
            'data-status-area': cardStatus.area,
            'data-status-section': pinSectionId ?? '',
          }
        : undefined;
    const sectionMenu = isPinnedBucket ? statusList.sectionHeaderMenu(pinSectionId ?? null) : null;
    const onToggle = () => toggleBucket(id);
    const compactTop = index === 0;
    /* Multi-select drives a permanent delete, and "select all" operates on
           every id in the list. Capping the rows while it is active would let
           the user confirm a delete of Sessions the surface never showed them,
           so selection mode renders the buckets in full. */
    const bucketPreview: MobileChatPreviewState | undefined =
      !capGroupPreviews ||
      selectionToolbarActive ||
      (groupBy === 'status' && id !== STATUS_BUCKET_SETTLED)
        ? undefined
        : {
            revealedRows: revealedRowsByBucket[id] ?? 0,
            onShowMore: () =>
              showMoreBucketRows(
                id,
                id === STATUS_BUCKET_SETTLED
                  ? STATUS_VIEW_SETTLED_FOLD_THRESHOLD
                  : MOBILE_CHAT_PREVIEW_MAX_ROOTS
              ),
            onShowLess: () => showLessBucketRows(id),
            ...(id === STATUS_BUCKET_SETTLED
              ? { maxRoots: STATUS_VIEW_SETTLED_FOLD_THRESHOLD }
              : {}),
          };
    const filterTrailing =
      showFirstGroupTrailing && !trailingConsumedByFlatHeading && index === 0
        ? firstGroupTrailing
        : undefined;
    const trailing =
      sectionMenu && filterTrailing ? (
        <span {...stylex.props(statusStyles.trailingCluster)}>
          {sectionMenu}
          {filterTrailing}
        </span>
      ) : (
        (sectionMenu ?? filterTrailing)
      );

    /* Flat unpinned tail under a Pinned section (groupBy none):
           no heading — just the remaining rows. When nothing is
           pinned, this is the only section and still has no heading
           — mount a trailing-only row so the filter chip still has a
           home. */
    if (id === FLAT_UNPINNED_BUCKET_ID) {
      return (
        <Fragment key={id}>
          {trailing ? (
            <div
              {...stylex.props(
                styles.flatTailRow,
                compactTop ? styles.flatTailRowCompact : styles.flatTailRowTall
              )}
            >
              {trailing}
            </div>
          ) : null}
          <MobileChatListCard
            chats={items}
            selectedConversationId={selectedConversationId}
            onSelect={onSelect}
            rowActions={rowActions}
            archived={archived}
            onRequestDelete={selectionEnabled ? requestSwipeDelete : undefined}
            selection={selectionState}
            preview={bucketPreview}
            shownIds={shownIds}
          />
        </Fragment>
      );
    }

    /* Pinned + date buckets: quiet collapsible text label.
           Project buckets: identity mark (folder / avatar / chat). */
    const labeledItem =
      groupBy === 'project' && !isPinnedBucketId(id)
        ? // A row nested here under its opener describes another project.
          items.find((it) => it.projectKey === id && it.projectLabel != null)
        : undefined;
    const projectLabel = labeledItem?.projectLabel ?? null;
    const heading = label
      ? label
      : tier
        ? t(
            `sidebar.status.${tier}`,
            tier === 'focus' ? 'Focus' : tier === 'later' ? 'Later' : 'Settled'
          )
        : id === PINNED_BUCKET_ID || groupBy === 'date'
          ? resolveDateBucketLabel(id, groupLabels)
          : (projectLabel ?? groupLabels[id] ?? id);

    const isLocalBucket =
      labeledItem != null &&
      (labeledItem.kind === 'local' ||
        (labeledItem.kind !== 'github' && !labeledItem.projectAvatarUrl));

    const tierHeading =
      tier === 'later' || tier === 'settled' ? (
        <>
          {heading}
          <span {...stylex.props(statusStyles.count)}>{items.length}</span>
          {!expanded && items.some((item) => item.hasUnreadMessages) ? (
            <span
              role="img"
              aria-label={t('sessions.unreadMessages', 'Unread messages')}
              {...stylex.props(statusStyles.unreadDot)}
            />
          ) : null}
        </>
      ) : (
        heading
      );
    let groupedHeadingNode: ReactNode;
    if (isPinnedBucketId(id) || tier || groupBy === 'date' || groupBy === 'none') {
      groupedHeadingNode = (
        <CollapsibleSectionHeading
          expanded={expanded}
          onToggle={onToggle}
          compactTop={compactTop}
          trailing={trailing}
        >
          {tierHeading}
        </CollapsibleSectionHeading>
      );
    } else if (id === NO_PROJECT_BUCKET_ID) {
      groupedHeadingNode = (
        <ProjectBucketHeading
          label={heading}
          leading={<NoProjectBucketLeading />}
          expanded={expanded}
          onToggle={onToggle}
          compactTop={compactTop}
          trailing={trailing}
        />
      );
    } else if (labeledItem) {
      groupedHeadingNode = (
        <ProjectBucketHeading
          label={heading}
          avatarUrl={labeledItem.projectAvatarUrl}
          hashSeed={labeledItem.projectKey ?? id}
          isLocal={isLocalBucket}
          expanded={expanded}
          onToggle={onToggle}
          compactTop={compactTop}
          trailing={trailing}
          isPrivate={labeledItem.isPrivateProject}
          privateLabel={privateLabel}
          privateHelpAriaLabel={privateHelpAriaLabel}
          onPrivateHelp={onPrivateHelp}
        />
      );
    } else {
      groupedHeadingNode = (
        <CollapsibleSectionHeading
          expanded={expanded}
          onToggle={onToggle}
          compactTop={compactTop}
          trailing={trailing}
        >
          {heading}
        </CollapsibleSectionHeading>
      );
    }

    return (
      <Fragment key={id}>
        {dropHeaderAttrs ? (
          <div
            {...dropHeaderAttrs}
            {...stylex.props(
              !expanded && cardStatus?.dropBeforeId !== undefined && statusStyles.dropHeader
            )}
          >
            {groupedHeadingNode}
          </div>
        ) : (
          groupedHeadingNode
        )}
        {hiddenCount ? (
          <div {...stylex.props(statusStyles.hiddenCount)}>
            {t('sidebar.pinSections.hiddenByScope', '{{count}} sessions hidden', {
              count: hiddenCount,
            })}
          </div>
        ) : null}
        {expanded ? (
          <MobileChatListCard
            chats={items}
            selectedConversationId={selectedConversationId}
            onSelect={onSelect}
            rowActions={rowActions}
            archived={archived}
            onRequestDelete={selectionEnabled ? requestSwipeDelete : undefined}
            selection={selectionState}
            preview={bucketPreview}
            preserveOrder={isPinnedBucketId(id) || tier !== undefined}
            shownIds={shownIds}
            status={cardStatus}
          />
        ) : null}
      </Fragment>
    );
  });

  return (
    /* All cards rendered under a single `MobileSwipeableRowGroup` so the
       "only one row open at a time" rule covers every row in the list,
       across section headings — matches iOS Mail / Messages where a tap
       or swipe on any other row closes the previously-open one. */
    <MobileSwipeableRowGroup>
      <div ref={statusList.drag.touchSurfaceRef} {...statusList.drag.handlers}>
        {splitTargets ? (
          <>
            {createPortal(
              <>
                {headingNode}
                {cards[0]}
              </>,
              splitTargets.upper
            )}
            {createPortal(cards.slice(1), splitTargets.lower)}
          </>
        ) : (
          <>
            {headingNode}
            {cards}
          </>
        )}
      </div>
      {statusList.overlays}
      <AlertDialog.Root
        open={pendingDelete != null}
        onOpenChange={(open) => !isDeleting && !open && setPendingDelete(null)}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {selectionLabels?.confirmTitle ?? '彻底删除归档对话'}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {(
                selectionLabels?.confirmDescription ??
                '将永久删除选中的 {count} 个对话，此操作不可恢复。'
              ).replace('{count}', String(pendingDeleteCount))}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={isDeleting}>
              {selectionLabels?.cancel ?? '取消'}
            </AlertDialog.Cancel>
            <Button
              onClick={() => {
                /* Don't auto-close — `handleDelete` does it after the
                   delete promise resolves. Without this, Radix closes
                   synchronously and the user sees the destructive
                   action complete with no feedback that anything is
                   happening on slow networks. */
                void handleDelete();
              }}
              disabled={isDeleting}
              variant="destructive"
            >
              {selectionLabels?.confirmDelete ?? '删除'}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </MobileSwipeableRowGroup>
  );
}

/* Toolbar that replaces the section heading while multi-select is
   active. Left side hosts the select-all checkbox + count (so the
   user can see what they're operating on without scrolling), right
   side hosts Cancel + Delete with the destructive action tinted. */
function SelectionToolbar({
  selectedCount,
  allSelected,
  anySelected,
  labels,
  onToggleAll,
  onCancel,
  onDeleteClick,
}: {
  selectedCount: number;
  allSelected: boolean;
  anySelected: boolean;
  labels?: MobileChatListSelectionLabels;
  onToggleAll: () => void;
  onCancel: () => void;
  onDeleteClick: () => void;
}) {
  const countLabel = labels?.selectedCount
    ? labels.selectedCount(selectedCount)
    : `已选 ${selectedCount}`;
  return (
    /* `px-4` matches each `ConversationRow`; `gap-2.5` mirrors the row
       leading status → title gap so the checkbox lines up with the
       status column. */
    <div {...stylex.props(styles.selectionToolbar)}>
      <button type="button" onClick={onToggleAll} {...stylex.props(styles.selectAllButton)}>
        <Checkbox checked={allSelected} tabIndex={-1} xstyle={styles.selectionCheck} />
        <span>{countLabel}</span>
      </button>
      <div {...stylex.props(styles.selectionActions)}>
        <button type="button" onClick={onCancel} {...stylex.props(styles.cancelButton)}>
          {labels?.cancel ?? '取消'}
        </button>
        <button
          type="button"
          onClick={onDeleteClick}
          disabled={!anySelected}
          {...stylex.props(styles.deleteButton)}
        >
          {labels?.deleteAction ?? '删除'}
        </button>
      </div>
    </div>
  );
}

const statusStyles = stylex.create({
  count: {
    marginInlineStart: space[1.5],
    fontWeight: 400,
    fontVariantNumeric: 'tabular-nums',
  },
  unreadDot: {
    display: 'inline-block',
    width: 6,
    height: 6,
    marginInlineStart: space[1.5],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    verticalAlign: 'middle',
  },
  dropHeader: {
    backgroundColor: colors.selectedFill,
    borderRadius: radius.medium,
  },
  hiddenCount: {
    paddingInline: space[4],
    paddingBottom: space[2],
    fontSize: 13,
    color: colors.secondaryLabel,
  },
  trailingCluster: { display: 'flex', alignItems: 'center', gap: space[1] },
  dropIndicator: {
    height: 2,
    marginInline: space[4],
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
});
