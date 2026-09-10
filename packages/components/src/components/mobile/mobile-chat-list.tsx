import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronRight,
  CircleHelp,
  Folder,
  FolderOpen,
  LockKeyhole,
  MessageCircle,
} from 'lucide-react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { getServerNow } from '@lody/shared';
import {
  buildOpenedBySessionTree,
  countOpenedByTreeRoots,
  pinnedFirstRootRank,
} from '@/lib/session-opened-by-tree';
import {
  sidebarCollapsedOpenedBySessionsAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
} from '@/atoms/focus-layer';
import { buildSessionRowOpenedByTreeSlot } from '@/components/sidebar-row-shared';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import {
  ConversationRow,
  conversationRowHasActivity,
  type MobileConversationItem,
} from './mobile-project-screen';
import { MobileInitialLetterAvatar } from './mobile-initial-letter-avatar';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { MobileSwipeableRow, MobileSwipeableRowGroup } from './mobile-swipeable-row';

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
   Callers supply heading labels via `groupLabels` for i18n. */
export type MobileChatGroupBy = 'none' | 'project' | 'date';

/* Bucket id used for chats that have no associated project (kind
   = 'chat'). Exported so callers can map it in `groupLabels`. */
export const NO_PROJECT_BUCKET_ID = '__no-project__';

/* Synthetic top bucket for pinned sessions. Always rendered first
   (when non-empty), ahead of project / date / flat unpinned groups. */
export const PINNED_BUCKET_ID = '__pinned__';

/* Flat unpinned tail when groupBy is `none` and there is a Pinned
   section above — no heading; just the remaining rows. */
const FLAT_UNPINNED_BUCKET_ID = '__flat-unpinned__';

/* Rows a bucket shows before it collapses behind "Show all (N)".
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
  /** True once the user expanded this bucket past the preview cap. */
  showAll: boolean;
  onToggle: () => void;
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
const GROUP_HEADING_X = 'ps-[18px] pe-4';

/* Group label type size — slightly under session-row 15px so sections
   stay secondary, but large enough to scan. */
const GROUP_HEADING_TEXT =
  'text-[14px] font-semibold tracking-tight text-muted-foreground';

export function MobileChatSectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className={cn(GROUP_HEADING_X, 'pb-1.5 pt-5', GROUP_HEADING_TEXT)}>
      {children}
    </div>
  );
}

/* Chevron for group collapse state: points right when collapsed,
   rotates 90° to point down when expanded. Same muted color as the
   section label + folder mark so the cluster reads as one unit. */
function GroupChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
        expanded && 'rotate-90'
      )}
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
      className={cn(
        'flex w-full items-center gap-2 pb-1.5',
        GROUP_HEADING_X,
        compactTop ? 'pt-2' : 'pt-4'
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'flex min-w-0 flex-1 items-center text-left active:opacity-70',
          GROUP_HEADING_TEXT
        )}
      >
        {/* Label + chevron as a tight cluster (not row-end). */}
        <span className="flex min-w-0 max-w-full items-center gap-1">
          <span className="min-w-0 truncate">{children}</span>
          <GroupChevron expanded={expanded} />
        </span>
      </button>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
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
          className="h-5 w-5 shrink-0 rounded object-cover"
        />
      );
    } else if (isLocal) {
      /* Closed folder when collapsed, open folder when expanded.
         Match label color so icon + text + chevron are one tone. */
      const FolderIcon = expanded ? FolderOpen : Folder;
      mark = (
        <FolderIcon
          className="h-5 w-5 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      );
    } else {
      mark = (
        <MobileInitialLetterAvatar
          name={label}
          hashSeed={hashSeed ?? label}
          size="sm"
          /* Match 20px folder/avatar mark; `sm` defaults to 24px. */
          className="h-5 w-5 rounded text-[0.68rem]"
        />
      );
    }
  }
  const rowClassName = cn(
    'flex w-full items-center gap-2 pb-1.5',
    GROUP_HEADING_X,
    compactTop ? 'pt-2' : 'pt-4'
  );
  const labelCluster = (
    <>
      {mark}
      {/* Label + chevron share a tight cluster so the chevron sits
          immediately after the text, not at the row's far right. */}
      <span className="flex min-w-0 max-w-full items-center gap-1">
        <span className={cn('min-w-0 truncate', GROUP_HEADING_TEXT)}>{label}</span>
        {onToggle ? <GroupChevron expanded={expanded} /> : null}
      </span>
    </>
  );
  return (
    <div className={rowClassName}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left active:opacity-70"
        >
          {labelCluster}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{labelCluster}</div>
      )}
      {isPrivate ? (
        onPrivateHelp ? (
          <button
            type="button"
            onClick={onPrivateHelp}
            aria-label={privateHelpAriaLabel ?? privateLabel}
            className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full px-1.5 text-[0.68rem] font-medium text-muted-foreground active:bg-muted"
          >
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
            {privateLabel ? <span>{privateLabel}</span> : null}
            <CircleHelp className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : (
          <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )
      ) : null}
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

/* Quiet chat glyph for the no-project bucket — same outer size as the
   project mark so the section rhythm stays aligned. */
function NoProjectBucketLeading() {
  return (
    <MessageCircle
      className="h-5 w-5 shrink-0 text-muted-foreground"
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
  secondaryField = 'branch',
}: {
  chats: MobileConversationItem[];
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
     and appends a "Show all (N)" toggle. Omit to render every row (what a
     standalone card without a `MobileChatList` around it does). */
  preview?: MobileChatPreviewState;
  /** @deprecated Conversation rows are single-line; branch/project meta
     is no longer shown. Kept for call-site compatibility. */
  secondaryField?: 'branch' | 'project';
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
  const showAll = preview?.showAll ?? false;
  const previewEnabled = preview != null;
  const capped = previewEnabled && !showAll;
  const treeNodes = useMemo(
    () =>
      buildOpenedBySessionTree(chats, {
        ...CHAT_OPENED_BY_TREE_ACCESSORS,
        isCollapsed: (openerId) => collapsedOpeners[openerId] === true,
        /* Bucket order is pinned-first then latest activity; rank an opener by
           its freshest opened Session so nesting cannot bury a just-updated
           row under a stale opener. */
        rootRank: (chat) => pinnedFirstRootRank(chat.latestMessageAt ?? 0, chat.isPinned),
        ...(capped ? { maxRoots: MOBILE_CHAT_PREVIEW_MAX_ROOTS } : {}),
      }),
    [capped, chats, collapsedOpeners]
  );
  /* Gate the toggle on TOP-LEVEL rows, matching what the cap actually limits:
     five openers plus the Sessions they opened is not an overflowing bucket,
     so it must not sprout a "Show all" the tap would not change.

     Deliberately NOT wrapped in `useMemo`. `MobileChatList` calls `groupChats`
     in its render body, so every bucket receives a freshly built `chats` array
     on every render — measured: a state-only re-render (tapping one bucket's
     toggle) hands all buckets a new array. A memo keyed on `chats` therefore
     cannot ever hit, and one that looks like a cache while caching nothing is
     worse than the O(rows) scan it fails to avoid. `previewEnabled` exists for
     the same reason: `preview` is a new object literal each render, so only the
     one bit of it that matters may be read. */
  const overflowsPreview =
    previewEnabled &&
    countOpenedByTreeRoots(chats, CHAT_OPENED_BY_TREE_ACCESSORS) >
      MOBILE_CHAT_PREVIEW_MAX_ROOTS;
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
        key={`${archived ? 'archived' : 'active'}:${capped ? 'preview' : 'full'}`}
      >
        {treeNodes.map((node) => {
          const conversation = node.item;
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
              selectionMode={selection?.active ?? false}
              isSelected={selection?.isSelected(conversation.id) ?? false}
              onToggleSelect={
                selection ? () => selection.onToggleSelect(conversation.id) : undefined
              }
              onLongPress={
                selection ? () => selection.onLongPress(conversation.id) : undefined
              }
              secondaryField={secondaryField}
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
              exit={{ height: 0, opacity: 0 }}
              transition={ROW_EXIT_TRANSITION}
              /* `overflow-hidden` lets `height: 0` actually clip the
                 row content while it collapses. Canvas bg matches the
                 page so exit-collapse never flashes a seam. */
              className="overflow-hidden bg-background"
            >
              {wrapSwipe ? (
                archived ? (
                  <MobileSwipeableRow
                    variant="archived"
                    liftAboveEdgeSwipeZone={showsTreeToggle}
                    onRestore={
                      rowActions?.onRestore
                        ? () => rowActions.onRestore!(conversation.id)
                        : undefined
                    }
                    onDelete={
                      onRequestDelete
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
                        ? () =>
                            rowActions.onTogglePin!(conversation.id, !conversation.isPinned)
                        : undefined
                    }
                    onArchive={
                      rowActions?.onArchive
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
      {overflowsPreview && preview ? (
        <MobileChatPreviewToggle
          showAll={showAll}
          totalCount={chats.length}
          onToggle={preview.onToggle}
        />
      ) : null}
    </>
  );
}

/* Tail affordance of a capped bucket. Sits inside the bucket body, directly
   under the last row and above the next group heading, so it reads as the end
   of THIS list rather than as chrome between sections.

   Geometry: the label starts on the row-title x (px-4 + the 16px leading slot
   + gap-2.5 = 42px) via an empty spacer, exactly as the desktop sidebar's
   "Show all" does. The slot stays EMPTY on purpose — it is the column that
   carries a row's status indicator and an opener's fold chevron, so a chevron
   here would read as one of those. The label alone says which way it goes.

   The type is quieter than a session title (15px medium foreground) and than a
   group heading (14px semibold muted), which is the hierarchy: rows, then
   sections, then this. Full-width `min-h-11` keeps a thumb target the size of
   a row. */
function MobileChatPreviewToggle({
  showAll,
  totalCount,
  onToggle,
}: {
  showAll: boolean;
  totalCount: number;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasShowingAll = useRef(showAll);
  /* Collapsing removes rows ABOVE this button, so on a long bucket the tap
     target — and everything the user was reading — jumps off the top of the
     viewport. Pull it back into view minimally (`nearest` is a no-op when it
     is already visible). A layout effect runs after the rows are removed and
     before paint, so the correction never renders as a visible scroll jump.
     Chrome's native scroll anchoring would cover this on its own; WebKit has
     never shipped `overflow-anchor`, and iOS is the surface this list is for. */
  useLayoutEffect(() => {
    if (wasShowingAll.current && !showAll) {
      buttonRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
    wasShowingAll.current = showAll;
  }, [showAll]);
  const label = showAll
    ? t('sessions.showLess', 'Show less')
    : t('sessions.showAll', 'Show all ({{count}})', { count: totalCount });
  return (
    <button
      ref={buttonRef}
      type="button"
      data-chat-list-preview-toggle=""
      aria-expanded={showAll}
      onClick={onToggle}
      className="flex min-h-11 w-full items-center gap-2.5 bg-background px-4 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors active:bg-muted/40"
    >
      <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * Build ordered list sections. Pinned sessions always form their own
 * top group (when any exist), regardless of `groupBy`. Unpinned rows
 * then follow:
 * - `none`: one unlabeled flat tail
 * - `project` / `date`: normal buckets
 *
 * Item order inside each bucket matches the input order.
 * `nowMs` is injectable for tests.
 */
export function groupChats(
  chats: MobileConversationItem[],
  groupBy: MobileChatGroupBy,
  nowMs: number = getServerNow()
): Array<{ id: string; items: MobileConversationItem[] }> {
  const pinned: MobileConversationItem[] = [];
  const unpinned: MobileConversationItem[] = [];
  for (const chat of chats) {
    if (chat.isPinned) pinned.push(chat);
    else unpinned.push(chat);
  }

  const ordered: Array<{ id: string; items: MobileConversationItem[] }> = [];
  if (pinned.length > 0) {
    ordered.push({ id: PINNED_BUCKET_ID, items: pinned });
  }

  if (groupBy === 'none') {
    if (unpinned.length > 0) {
      ordered.push({ id: FLAT_UNPINNED_BUCKET_ID, items: unpinned });
    }
    return ordered;
  }

  const buckets = new Map<string, MobileConversationItem[]>();
  for (const chat of unpinned) {
    const id = bucketIdFor(chat, groupBy, nowMs);
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

function bucketIdFor(
  chat: MobileConversationItem,
  groupBy: Exclude<MobileChatGroupBy, 'none'>,
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
    typeof latestMessageAt === 'number' && Number.isFinite(latestMessageAt)
      ? latestMessageAt
      : 0;
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
  rowSecondaryField,
  capGroupPreviews = false,
  privateLabel,
  privateHelpAriaLabel,
  onPrivateHelp,
}: {
  chats: MobileConversationItem[];
  groupBy?: MobileChatGroupBy;
  /** Per-bucket headings keyed by the ids that `bucketIdFor` emits
     ('chat' / 'local' / 'github' / 'open' / 'merged' / 'closed' /
     'no-pr' / 'working' / 'waiting' / 'idle' / 'offline'). Missing
     entries fall back to the id itself. */
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
     behind a "Show all (N)" toggle. On for the workspace home list, where
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
  /** Copy for the multi-select toolbar + confirmation alert-dialog.
     All keys are optional with reasonable Chinese defaults; callers
     can override to localize. */
  selectionLabels?: MobileChatListSelectionLabels;
  privateLabel?: string;
  privateHelpAriaLabel?: string;
  onPrivateHelp?: () => void;
  /** @deprecated Conversation rows are single-line; branch/project meta
     is no longer shown. Kept for call-site compatibility. */
  rowSecondaryField?: 'branch' | 'project';
}) {
  /* Multi-select state is owned here so a Select-All hits every row,
     including rows that live in separate group cards when
     `groupBy !== 'none'`. */
  const selectionEnabled = archived && Boolean(onPermanentDelete);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  /* Project-group collapse: ids in the set are collapsed (body hidden).
     Default empty → every bucket starts expanded. */
  const [collapsedBucketIds, setCollapsedBucketIds] = useState<Set<string>>(
    () => new Set()
  );
  const toggleBucket = (bucketId: string) => {
    setCollapsedBucketIds((prev) => {
      const next = new Set(prev);
      if (next.has(bucketId)) next.delete(bucketId);
      else next.add(bucketId);
      return next;
    });
  };
  /* Buckets the user expanded past the preview cap. Every bucket starts capped
     at `MOBILE_CHAT_PREVIEW_MAX_ROOTS`, which is the whole point: without it a
     project with forty Sessions pushes every other project and worktree off
     the screen. This is deliberately NOT the shared opener-fold atom — see
     `MobileChatPreviewState`. */
  const [expandedBucketIds, setExpandedBucketIds] = useState<Set<string>>(
    () => new Set()
  );
  const toggleBucketPreview = (bucketId: string) => {
    setExpandedBucketIds((prev) => {
      const next = new Set(prev);
      if (next.has(bucketId)) next.delete(bucketId);
      else next.add(bucketId);
      return next;
    });
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
  const allIds = useMemo(() => chats.map((c) => c.id), [chats]);

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
    <div
      className={cn(
        'flex w-full items-center gap-2 pb-1.5 pt-5',
        GROUP_HEADING_X
      )}
    >
      <div className={cn('min-w-0 flex-1', GROUP_HEADING_TEXT)}>{flatHeading}</div>
      {firstGroupTrailing ? <div className="shrink-0">{firstGroupTrailing}</div> : null}
    </div>
  ) : null;

  /* Default secondary-text source: flat list → project label so users
     can tell rows apart across projects; grouped list → branch name
     (the bucket heading already carries the project identity). Caller
     can override via `rowSecondaryField` — project sub-pages do that
     to keep their original branch-name look regardless of groupBy. */
  const resolvedSecondaryField: 'branch' | 'project' =
    rowSecondaryField ?? (groupBy === 'none' ? 'project' : 'branch');

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
  const cards = (
    <>
      {groupChats(chats, groupBy).map(({ id, items }, index) => {
        const expanded = !collapsedBucketIds.has(id);
        const onToggle = () => toggleBucket(id);
        const compactTop = index === 0;
        /* Multi-select drives a permanent delete, and "select all" operates on
           every id in the list. Capping the rows while it is active would let
           the user confirm a delete of Sessions the surface never showed them,
           so selection mode renders the buckets in full. */
        const bucketPreview: MobileChatPreviewState | undefined =
          !capGroupPreviews || selectionToolbarActive
            ? undefined
            : {
                showAll: expandedBucketIds.has(id),
                onToggle: () => toggleBucketPreview(id),
              };
        const trailing =
          showFirstGroupTrailing && !trailingConsumedByFlatHeading && index === 0
            ? firstGroupTrailing
            : undefined;

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
                  className={cn(
                    'flex w-full items-center justify-end pb-1.5',
                    GROUP_HEADING_X,
                    compactTop ? 'pt-2' : 'pt-4'
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
                secondaryField={resolvedSecondaryField}
              />
            </Fragment>
          );
        }

        /* Pinned + date buckets: quiet collapsible text label.
           Project buckets: identity mark (folder / avatar / chat). */
        const labeledItem =
          groupBy === 'project' && id !== PINNED_BUCKET_ID
            ? items.find((it) => it.projectLabel != null)
            : undefined;
        const projectLabel = labeledItem?.projectLabel ?? null;
        const heading =
          id === PINNED_BUCKET_ID || groupBy === 'date'
            ? resolveDateBucketLabel(id, groupLabels)
            : (projectLabel ?? groupLabels[id] ?? id);

        const isLocalBucket =
          labeledItem != null &&
          (labeledItem.kind === 'local' ||
            (labeledItem.kind !== 'github' && !labeledItem.projectAvatarUrl));

        let groupedHeadingNode: ReactNode;
        if (id === PINNED_BUCKET_ID || groupBy === 'date' || groupBy === 'none') {
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
            {groupedHeadingNode}
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
                secondaryField={resolvedSecondaryField}
              />
            ) : null}
          </Fragment>
        );
      })}
    </>
  );

  return (
    /* All cards rendered under a single `MobileSwipeableRowGroup` so the
       "only one row open at a time" rule covers every row in the list,
       across section headings — matches iOS Mail / Messages where a tap
       or swipe on any other row closes the previously-open one. */
    <MobileSwipeableRowGroup>
      {headingNode}
      {cards}
      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !isDeleting && !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectionLabels?.confirmTitle ?? '彻底删除归档对话'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(selectionLabels?.confirmDescription ?? '将永久删除选中的 {count} 个对话，此操作不可恢复。').replace(
                '{count}',
                String(pendingDeleteCount)
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {selectionLabels?.cancel ?? '取消'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                /* Don't auto-close — `handleDelete` does it after the
                   delete promise resolves. Without this, Radix closes
                   synchronously and the user sees the destructive
                   action complete with no feedback that anything is
                   happening on slow networks. */
                event.preventDefault();
                void handleDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {selectionLabels?.confirmDelete ?? '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <div className="flex items-center justify-between gap-2 px-4 pb-1.5 pt-5">
      <button
        type="button"
        onClick={onToggleAll}
        className="inline-flex items-center gap-2 text-sm font-medium text-foreground"
      >
        <Checkbox checked={allSelected} tabIndex={-1} className="pointer-events-none h-4 w-4" />
        <span>{countLabel}</span>
      </button>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-sm font-medium text-foreground active:bg-muted/60"
        >
          {labels?.cancel ?? '取消'}
        </button>
        <button
          type="button"
          onClick={onDeleteClick}
          disabled={!anySelected}
          className="rounded-md px-2 py-1 text-sm font-semibold text-destructive active:bg-destructive/10 disabled:opacity-40"
        >
          {labels?.deleteAction ?? '删除'}
        </button>
      </div>
    </div>
  );
}
