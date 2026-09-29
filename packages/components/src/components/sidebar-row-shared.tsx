import {
  useId,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactEventHandler,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionRowOpenedByTreeSlot } from './session-row-leading-slot';
export {
  SessionRowLeadingSlot,
  buildSessionRowOpenedByTreeSlot,
  type SessionRowOpenedByTreeSlot,
} from './session-row-leading-slot';
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleDot,
  CornerLeftUp,
  Github,
  Hand,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useWorkingHandOver, WorkingStatusMark } from '@/ui/working-status-mark';
import {
  sessionSendStatusAtomFamily,
  sessionUnsentNewConversationAtomFamily,
} from '@/atoms/session-send-status';
import type { SessionSendState } from '@/lib/session-send-status';
import { formatFileSize } from '@/lib/session-file-presentation';
import type { PrStatus, SessionPullRequestCiState } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Tooltip } from '@lody/ui/tooltip';
import * as stylex from '@stylexjs/stylex';
import { Badge } from '@lody/ui/badge';
import { mergeableBadgeTheme } from './sidebar-mergeable-badge.stylex';
import { ContextMenu } from '@lody/ui/context-menu';
import { Skeleton } from '@lody/ui/skeleton';
import { PR_STATUS_META } from '@/components/sessions/pull-request-badge';
import { SidebarConfirmArchiveButton } from '@/components/sidebar-confirm-archive-button';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { UserAvatar } from '@/components/user-avatar';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import { getGitHubOwnerAvatarUrl } from '@/lib/github-avatar';

/**
 * Shared building blocks for the single-line sidebar session rows. All three
 * surfaces (Workspace grouping in `task-list.tsx` / `loro-app-sidebar.tsx` and the
 * flat Updated list in `sidebar-updated-task-list.tsx`) render the same anatomy,
 * so the pieces live here once instead of being copied three times.
 *
 * Row anatomy: `[① tree affordance | more][② author avatar? + title][③ status | mergeable? + worktree? + PR icon? | archive]`.
 * The author avatar (`SessionRowAuthorAvatar`) only appears in team ("All Tasks") scope on a
 * multi-member workspace; otherwise the title owns the leading edge of slot ②. The leading slot
 * stays reserved even when empty (the ⋯ menu button reveals there on hover). A local worktree
 * session shows a faint worktree glyph (`SessionRowWorktreeIndicator`) inside the metric cluster,
 * immediately before the PR icon (taking the PR's right-edge spot when there is no PR);
 * GitHub sessions are always worktrees so they never show it. The full
 * repo / folder / worktree session-type detail still lives in the desktop hover info card
 * (`session-info-hover-card.tsx`).
 *
 * The END slot (③) is the row's single status channel: working / waiting / unread
 * REPLACES the whole resting metric cluster there, so an active row reads
 * `[title][status]` and nothing else competes with it. Only a resting row shows
 * metrics, where PR status owns the right edge when present. Line totals stay
 * off the row (hover card only). Archive replaces the trailing content on hover, so the
 * row's rightmost mark never shifts. The leading slot (①) is therefore free to
 * ALWAYS draw the opened-by tree: a running or unread child keeps its ├/└ and an
 * active opener keeps its disclosure.
 */
export type SidebarRowKind = 'github' | 'local' | 'chat';

type PrCiVerdict = 'success' | 'failure' | 'pending' | 'expected';

/**
 * PR + CI use the original 14px PR / 10px verdict-slot geometry. The circular
 * mask removes the PR stroke beneath the verdict without painting a
 * sidebar-colored backdrop. The info bar ContextChip uses this same
 * `SessionPrIcon`. Running uses a static dot and a tighter cutout.
 */
function MaskedPrCiIcon({
  BaseIcon,
  VerdictIcon,
  baseToneClassName,
  verdict,
  className,
}: {
  BaseIcon: LucideIcon;
  VerdictIcon: LucideIcon | null;
  baseToneClassName: string;
  verdict: PrCiVerdict;
  className?: string;
}) {
  const maskId = `pr-ci-${verdict}-${useId().replaceAll(':', '')}`;
  const isRunning = verdict === 'pending';
  const verdictToneClassName =
    verdict === 'success'
      ? 'text-status-success'
      : verdict === 'failure'
        ? 'text-destructive'
        : 'text-status-warning';

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('h-4 w-4 shrink-0', className)}
      data-pr-ci-verdict={verdict}
      aria-hidden="true"
    >
      <mask
        id={maskId}
        x="0"
        y="0"
        width="16"
        height="16"
        maskUnits="userSpaceOnUse"
        maskContentUnits="userSpaceOnUse"
      >
        <rect width="16" height="16" fill="white" />
        <circle cx="12" cy="12" r={isRunning ? 3.75 : 5} fill="black" />
      </mask>

      <g mask={`url(#${maskId})`}>
        <BaseIcon width={14} height={14} strokeWidth={2.25} className={baseToneClassName} />
      </g>
      <g transform="translate(7 7)" data-pr-ci-verdict-slot="">
        {isRunning ? (
          <circle cx="5" cy="5" r="2.5" fill="currentColor" className={verdictToneClassName} />
        ) : VerdictIcon ? (
          <VerdictIcon width={10} height={10} strokeWidth={3} className={verdictToneClassName} />
        ) : null}
      </g>
    </svg>
  );
}

const SEND_RING_RADIUS = 4.25;
const SEND_RING_CIRCUMFERENCE = 2 * Math.PI * SEND_RING_RADIUS;
const SEND_RING_SHIMMER_LENGTH = 5;

/**
 * A local message still uploading: a thin ring that fills with the bytes sent,
 * with a faint highlight sweeping along the filled arc so a ring waiting on the
 * next progress report never reads as a frozen spinner. Without a measurable
 * size the same ring turns with a quarter arc. The turn rides an HTML wrapper,
 * like `@lody/ui`'s Spinner: a rotating svg does not composite at DPR≠1.
 */
export function SessionSendProgressRing({ progress }: { progress?: number }) {
  const known = typeof progress === 'number';
  const filled = known ? Math.min(100, Math.max(4, progress)) : 25;
  const maskId = `session-send-ring-${useId().replace(/:/g, '')}`;
  const arc = {
    cx: '6',
    cy: '6',
    r: SEND_RING_RADIUS,
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeDasharray: SEND_RING_CIRCUMFERENCE,
    strokeDashoffset: SEND_RING_CIRCUMFERENCE * (1 - filled / 100),
    transform: 'rotate(-90 6 6)',
  };
  return (
    <span
      className={cn(
        'flex h-3 w-3 text-primary',
        !known && 'animate-spin [animation-duration:1.2s] motion-reduce:animate-none'
      )}
      data-session-send-ring={known ? 'determinate' : 'indeterminate'}
    >
      <svg viewBox="0 0 12 12" className="h-full w-full" fill="none" aria-hidden="true">
        <circle
          cx="6"
          cy="6"
          r={SEND_RING_RADIUS}
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={1.5}
        />
        <circle
          {...arc}
          stroke="currentColor"
          className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
        {known ? (
          <>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="12" height="12">
              <circle {...arc} stroke="white" />
            </mask>
            <circle
              cx="6"
              cy="6"
              r={SEND_RING_RADIUS}
              stroke="white"
              strokeOpacity={0.65}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={`${SEND_RING_SHIMMER_LENGTH} ${SEND_RING_CIRCUMFERENCE}`}
              transform="rotate(-90 6 6)"
              mask={`url(#${maskId})`}
              className="motion-reduce:hidden"
              data-session-send-shimmer=""
            >
              <animate
                attributeName="stroke-dashoffset"
                from={SEND_RING_SHIMMER_LENGTH}
                to={-SEND_RING_CIRCUMFERENCE}
                dur="1.8s"
                repeatCount="indefinite"
              />
            </circle>
          </>
        ) : null}
      </svg>
    </span>
  );
}

/**
 * ③ The 14px status mark, rendered at the row's TRAILING edge inside
 * {@link SidebarRowEndSlot}. Single-mark priority:
 * `sendFailed > waitingPermission > isWorking > sending > hasUnread`. A failed
 * local send outranks everything because nothing else will retry it; an upload
 * in progress yields to the agent's own activity. Returns `null` when the
 * session is idle and read, which is what lets the end slot fall back to its
 * resting metric cluster (diff / worktree / PR) — a row shows one or the other,
 * never both.
 *
 * It lives at the end rather than at the leading edge so the opened-by tree can
 * own the leading slot unconditionally: before this, an active child had to drop
 * its ├/└ connectors and the nesting silently disappeared exactly on the rows a
 * user watches most.
 */
export function SessionRowStatusIndicator({
  isWaitingPermission,
  isWorking,
  hasUnreadMessages,
  sendState,
  sendProgress,
  sendLabel,
}: {
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  /** Renderer-local state of this session's held (in-memory) sends. */
  sendState?: SessionSendState | null;
  /** 0–100; omitted when the upload has no measurable size. */
  sendProgress?: number;
  /** Spoken name of the send mark ("Sending · 12.4 MB / 38.0 MB"). */
  sendLabel?: string;
}) {
  let icon: ReactNode = null;
  let label: string | undefined;

  if (sendState === 'failed') {
    icon = <CircleAlert className="h-3 w-3 text-destructive" strokeWidth={2.25} />;
    label = sendLabel;
  } else if (isWaitingPermission === true) {
    icon = <Hand className="h-3 w-3 text-status-warning" />;
  } else if (isWorking !== true && sendState === 'sending') {
    icon = <SessionSendProgressRing progress={sendProgress} />;
    label = sendLabel;
  } else if (isWorking === true || hasUnreadMessages === true) {
    // Working grid, the working → unread "done" transition, and the unread dot
    // are one component so it stays mounted across that change and can see it.
    icon = (
      <WorkingStatusMark
        working={isWorking === true}
        unread={hasUnreadMessages === true}
        className="text-primary"
      />
    );
  }

  if (!icon) return null;

  return (
    <div
      data-session-row-indicator=""
      data-session-send-state={sendState ?? undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      {icon}
    </div>
  );
}

/** True when {@link SessionRowStatusIndicator} would draw a mark for this row. */
function hasSessionRowStatus({
  isWaitingPermission,
  isWorking,
  hasUnreadMessages,
  sendState,
}: SessionRowStatusFlags): boolean {
  return Boolean(isWaitingPermission || isWorking || hasUnreadMessages || sendState);
}

/**
 * The spoken name of a row's send mark. Sizes are shown only while bytes are
 * measurable; a text-only message is simply "Sending".
 */
function useSessionSendLabel(
  status: { state: SessionSendState; sentBytes: number; totalBytes: number } | null
) {
  const { t } = useTranslation();
  if (!status) return undefined;
  if (status.state === 'failed') return t('sessions.sendStatus.failed');
  if (status.totalBytes <= 0) return t('sessions.sendStatus.sendingWithoutSize');
  return t('sessions.sendStatus.sending', {
    sent: formatFileSize(status.sentBytes),
    total: formatFileSize(status.totalBytes),
  });
}

/**
 * True while a new conversation's first message is not in history yet. The row
 * title reads muted until then; the conversation exists only on this device.
 */
export function useSessionUnsentNewConversation(sessionId: string | undefined): boolean {
  return useAtomValue(sessionUnsentNewConversationAtomFamily(sessionId ?? ''));
}

/** Title colour for a row whose conversation has not been sent yet. */
export const SIDEBAR_UNSENT_TITLE_CLASS = 'text-sidebar-foreground-muted';

/** A row title span that mutes itself while its conversation is unsent. */
export function SidebarSessionTitleText({
  sessionId,
  selected,
  className,
  children,
}: {
  sessionId: string;
  selected: boolean;
  className?: string;
  children: ReactNode;
}) {
  const isUnsent = useSessionUnsentNewConversation(sessionId);
  return (
    <span className={cn(className, isUnsent && !selected && SIDEBAR_UNSENT_TITLE_CLASS)}>
      {children}
    </span>
  );
}

/**
 * ③ The PR status icon shown in the final slot (colored, non-interactive —
 * opening the PR is handled by the row context menu + info card). Sidebar rows
 * pass `compact` so the mark stays below the title's weight; the info bar and
 * mobile row keep the full 14px size.
 *
 * The mobile conversation row (`mobile/mobile-project-screen.tsx`) renders this
 * same component at the end of its own metric cluster, so PR status tone and the
 * CI verdict badge read identically on both platforms.
 */
/** A filter, not opacity: the mark keeps its full lightness, only its hue is muted. */
const SIDEBAR_PR_ICON_COMPACT_CLASS = 'saturate-[0.55]';

export function SessionPrIcon({
  prStatus,
  prCiState,
  compact = false,
  className,
}: {
  prStatus: PrStatus;
  prCiState?: SessionPullRequestCiState | null;
  /**
   * Sidebar rows: a 12px mark (14px with a CI verdict) at reduced saturation, so
   * the GitHub status hues stay readable without outshining the titles.
   */
  compact?: boolean;
  className?: string;
}) {
  const meta = PR_STATUS_META[prStatus] ?? PR_STATUS_META.open;
  const BaseIcon = meta.icon;
  const verdict: PrCiVerdict | null =
    prCiState === 's'
      ? 'success'
      : prCiState === 'f' || prCiState === 'e'
        ? 'failure'
        : prCiState === 'p'
          ? 'pending'
          : prCiState === 'x'
            ? 'expected'
            : null;
  const VerdictIcon =
    verdict === 'success'
      ? Check
      : verdict === 'failure'
        ? X
        : verdict === 'expected'
          ? CircleDot
          : null;

  if (verdict && (VerdictIcon || verdict === 'pending')) {
    return (
      <MaskedPrCiIcon
        BaseIcon={BaseIcon}
        VerdictIcon={VerdictIcon}
        baseToneClassName={meta.iconColorClassName}
        verdict={verdict}
        className={cn(
          compact && SIDEBAR_PR_ICON_COMPACT_CLASS,
          compact && 'h-3.5 w-3.5',
          prStatus === 'merged' && 'translate-x-px',
          className
        )}
      />
    );
  }
  return (
    <BaseIcon
      className={cn(
        compact ? ['h-3 w-3', SIDEBAR_PR_ICON_COMPACT_CLASS] : 'h-3.5 w-3.5',
        'shrink-0',
        meta.iconColorClassName,
        className
      )}
      strokeWidth={2.25}
      aria-hidden="true"
    />
  );
}

const styles = stylex.create({
  contents: { display: 'contents' },
});

/**
 * Passive readiness marker for an inactive session row. It intentionally owns
 * the former diff-stat slot: once a PR is ready, the next useful sidebar fact
 * is that it can be merged, not how many lines it changes. It is the one
 * status in the row meant to be noticed: a success Badge whose word is the
 * success colour itself (`sidebar-mergeable-badge.stylex.ts`), while the PR
 * icons beside it stay desaturated.
 */
export function SessionMergeablePill() {
  const { t } = useTranslation();
  return (
    // The theme sits on a layout-less wrapper: a Badge reads its tokens from
    // whatever holds it.
    <span {...stylex.props(styles.contents, mergeableBadgeTheme)}>
      <Badge tone="success" data-session-mergeable-pill="">
        {t('sessions.pr.mergeable', 'Mergeable')}
      </Badge>
    </span>
  );
}

/**
 * ② The session author's avatar, shown at the leading edge of the title so a
 * teammate's tasks are identifiable at a glance. It only renders when the caller
 * resolves an `author` — which the sidebar does exclusively in team ("All Tasks")
 * scope on a multi-member workspace — so a solo / My-Tasks view stays avatar-free
 * and the title keeps its normal leading position.
 */
export function SessionRowAuthorAvatar({
  author,
}: {
  author?: { name?: string | null; image?: string | null } | null;
}) {
  if (!author) return null;
  return <UserAvatar user={author} size="small" className="shrink-0" />;
}

/**
 * A faint worktree glyph shown inside the end slot's metric cluster, sitting to
 * the LEFT of the PR icon — so a worktree
 * session with a PR reads `[diff][worktree][PR]`, and one without a PR keeps the
 * glyph at the right edge where the PR icon would otherwise be. It marks a
 * session running in an isolated git worktree, reusing the same glyph the
 * desktop hover info card leads its branch row with (`session-info-hover-card.tsx`).
 * It is deliberately faint (well below the diff/PR weight) so it stays a quiet
 * ambient marker rather than a status.
 *
 * Only LOCAL-project rows pass a truthy `isWorktree`: GitHub-backed sessions are
 * effectively always worktrees, so the glyph carries no information there and would
 * just be noise — the GitHub row surface (`task-list.tsx`) never renders it, and the
 * mixed Updated list gates it on the local row kind. Renders nothing otherwise.
 */
export function SessionRowWorktreeIndicator({ isWorktree }: { isWorktree?: boolean }) {
  const { t } = useTranslation();
  if (!isWorktree) return null;
  const label = t('sessions.infoCard.worktree', 'Worktree');
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span className="inline-flex shrink-0 items-center text-sidebar-foreground-muted/45">
            <WorktreeIcon className="h-3 w-3" aria-label={label} />
          </span>
        }
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/**
 * The two opened-by entries every sidebar row's context menu carries, in order:
 * the opener's expand/collapse (same toggle the leading-slot disclosure uses,
 * so the two can never disagree) and the reverse "Go to Opener Session" leg.
 *
 * The reverse leg is deliberately NOT gated on the row being nested: an opener
 * that is archived, in another group, or filtered out leaves the row un-nested,
 * which is exactly when the tree cannot show the link.
 */
export function SessionRowOpenedByMenuItems({
  opener,
  goToOpener,
  goToOpenerLabel,
}: {
  opener?: Extract<SessionRowOpenedByTreeSlot, { kind: 'opener' }> | null;
  /** Omitted when this row has no opener, or the surface cannot navigate. */
  goToOpener?: () => void;
  goToOpenerLabel: string;
}) {
  return (
    <>
      {goToOpener ? (
        <ContextMenu.Item icon={<CornerLeftUp />} onClick={goToOpener}>
          {goToOpenerLabel}
        </ContextMenu.Item>
      ) : null}
      {opener ? (
        <ContextMenu.Item
          icon={
            <ChevronDown
              className={cn('transition-transform', opener.expanded ? 'rotate-0' : '-rotate-90')}
            />
          }
          onClick={opener.onToggle}
        >
          {opener.label}
        </ContextMenu.Item>
      ) : null}
    </>
  );
}

/**
 * The container of a sidebar session-row list. A workspace sidebar can mount
 * hundreds of rows (244 in one "Chats" group, 94% of the page's DOM) while a
 * dozen are visible. `content-visibility: auto` lets the browser skip style,
 * layout and paint for rows scrolled out of the sidebar: a full-app restyle
 * measured 25ms before and 8.6ms after. Rows must keep drawing inside their own
 * box (focus rings are `ring-inset`), because the property also applies paint
 * containment. The rule lives in `tailwind/index.css` (`sidebar-row-list`).
 */
export const SIDEBAR_ROW_LIST_CLASS = 'flex flex-col gap-px sidebar-row-list';

/**
 * Marks one flat-list row with opened-by tree depth. `gutter={false}` leaves
 * a list with no nesting untouched. Connectors live in the leading slot.
 */
export function SessionOpenedByTreeRow({
  depth,
  gutter,
  children,
}: {
  depth: 0 | 1;
  /** False when the list has no nesting at all: renders children untouched. */
  gutter: boolean;
  children: ReactNode;
}) {
  if (!gutter) return <>{children}</>;
  return (
    <div
      className="relative min-w-0"
      data-session-tree-depth={depth}
      data-session-tree-indent={depth === 1 ? 'child' : undefined}
    >
      {children}
    </div>
  );
}

/**
 * ③ The hover-revealed archive action. Absolutely pinned to the RIGHT edge of its
 * (relative) trailing container so it always lands in the same fixed spot,
 * replacing whatever sits there at rest (the diff / time, which fades out on
 * hover). The button is absolute so its two-step "Confirm" expansion overlays
 * leftward without shifting the row. Place it inside a `relative` trailing box
 * whose resting content fades via `group-hover:opacity-0`.
 */
export function SidebarRowArchiveButton({
  label,
  confirmLabel,
  onConfirm,
  /** Which group's hover reveals the button — e.g. 'group-hover/row:...' for named groups. */
  revealClassName = 'group-hover:opacity-100 group-hover:pointer-events-auto group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto',
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  revealClassName?: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={500}
        render={
          <SidebarConfirmArchiveButton
            label={label}
            confirmLabel={confirmLabel}
            className={cn(
              'absolute right-0 top-0 z-20 opacity-0 pointer-events-none',
              revealClassName
            )}
            onConfirm={onConfirm}
          />
        }
      />
      <Tooltip.Content side="top">{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/**
 * ③ The final slot at the row's right edge, and the row's ONE status channel.
 *
 * A working / waiting / unread session shows only its status mark here: the
 * resting content (`Mergeable`, worktree glyph, PR icon, time) is
 * dropped for as long as the status lasts. That is deliberate — the status is the
 * fact the user is watching, the metrics are still one hover away in the desktop
 * info card, and collapsing them keeps the right edge to a single 14px mark
 * instead of a cluster that competes with it and eats the title.
 *
 * Archive is absolutely overlaid on hover, so a wide rest cluster never causes
 * layout movement. When the rest content is absent but Archive is available, it still
 * reserves the action's 20px hit target.
 */
export function SidebarRowEndSlot({
  sessionId,
  isWaitingPermission,
  isWorking,
  hasUnreadMessages,
  restIcon,
  archive,
  /** Fade the rest icon while hovering (match the row's group, e.g. 'group-hover/row:opacity-0'). */
  fadeClassName = 'group-hover:opacity-0 group-data-[menu-open]:opacity-0',
}: {
  /**
   * Reads this session's local send status here, in the leaf, so upload
   * progress re-renders only the slot and never the memoized row around it.
   */
  sessionId?: string;
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  restIcon?: ReactNode;
  archive?: ReactNode;
  fadeClassName?: string;
}) {
  // The end slot outlives the status mark, so the hand-over hold lives here.
  const drawWorking = useWorkingHandOver(isWorking === true, hasUnreadMessages === true);
  const sendStatus = useAtomValue(sessionSendStatusAtomFamily(sessionId ?? ''));
  const sendLabel = useSessionSendLabel(sendStatus);
  const restContent = hasSessionRowStatus({
    isWaitingPermission,
    isWorking: drawWorking,
    hasUnreadMessages,
    sendState: sendStatus?.state,
  }) ? (
    <SessionRowStatusIndicator
      isWaitingPermission={isWaitingPermission}
      isWorking={drawWorking}
      hasUnreadMessages={hasUnreadMessages}
      sendState={sendStatus?.state}
      sendProgress={sendStatus && sendStatus.totalBytes > 0 ? sendStatus.progress : undefined}
      sendLabel={sendLabel}
    />
  ) : (
    restIcon
  );
  const hasRest = Boolean(restContent);
  // Reserve the action hit target whenever something can occupy it; otherwise the
  // slot sizes to its resting content (for example, a PR icon).
  const reserve = hasRest || Boolean(archive);
  return (
    // pointer-events-none so the resting PR icon area still passes clicks through to
    // the row's navigation; the Archive button re-enables pointer events on hover.
    <div
      data-session-row-end-slot=""
      className={cn(
        'relative flex h-5 shrink-0 items-center justify-center pointer-events-none',
        reserve ? 'min-w-5' : 'w-0'
      )}
    >
      {hasRest ? (
        <span
          className={cn('flex', archive && cn('transition-opacity duration-100', fadeClassName))}
        >
          {restContent}
        </span>
      ) : null}
      {archive}
    </div>
  );
}

type SessionRowStatusFlags = {
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  sendState?: SessionSendState | null;
};

/**
 * What a folded group hides, counted by the mark each hidden row would draw:
 * a row counts once, under its own priority
 * (`failed > waiting > working > sending > unread`), so the numbers add up to
 * the rows that are asking for attention.
 */
export type SidebarGroupActivity = {
  failed: number;
  waiting: number;
  working: number;
  sending: number;
  unread: number;
};

export const EMPTY_SIDEBAR_GROUP_ACTIVITY: SidebarGroupActivity = Object.freeze({
  failed: 0,
  waiting: 0,
  working: 0,
  sending: 0,
  unread: 0,
});

/**
 * Joins each row with the local send state of its session. Group summaries take
 * the progress-free `sessionSendStatesAtom` map, so a layout-level group
 * re-renders on send start, failure and completion, never on upload progress.
 */
export function withSessionSendStates<Row extends SessionRowStatusFlags>(
  rows: Iterable<Row>,
  getSessionId: (row: Row) => string,
  sendStates: Readonly<Record<string, SessionSendState>>
): Row[] {
  const joined: Row[] = [];
  for (const row of rows) {
    const sendState = sendStates[getSessionId(row)];
    joined.push(sendState ? { ...row, sendState } : row);
  }
  return joined;
}

export function summarizeSidebarGroupActivity(
  rows: Iterable<SessionRowStatusFlags>
): SidebarGroupActivity {
  let failed = 0;
  let waiting = 0;
  let working = 0;
  let sending = 0;
  let unread = 0;
  for (const row of rows) {
    if (row.sendState === 'failed') failed += 1;
    else if (row.isWaitingPermission) waiting += 1;
    else if (row.isWorking) working += 1;
    else if (row.sendState === 'sending') sending += 1;
    else if (row.hasUnreadMessages) unread += 1;
  }
  if (!failed && !waiting && !working && !sending && !unread) return EMPTY_SIDEBAR_GROUP_ACTIVITY;
  return { failed, waiting, working, sending, unread };
}

export function hasSidebarGroupActivity(activity: SidebarGroupActivity | null | undefined) {
  return Boolean(
    activity &&
    (activity.failed || activity.waiting || activity.working || activity.sending || activity.unread)
  );
}

/** "1 not sent · 1 waiting for approval · 2 working · 1 sending · 3 unread", omitting zeros. */
export function useSidebarGroupActivityDescription(
  activity: SidebarGroupActivity | null | undefined
): string | null {
  const { t } = useTranslation();
  if (!activity || !hasSidebarGroupActivity(activity)) return null;
  const parts: string[] = [];
  if (activity.failed) {
    parts.push(t('sidebar.groupActivity.failed', { count: activity.failed }));
  }
  if (activity.waiting) {
    parts.push(
      t('sidebar.groupActivity.waiting', '{{count}} waiting for approval', {
        count: activity.waiting,
      })
    );
  }
  if (activity.working) {
    parts.push(
      t('sidebar.groupActivity.working', '{{count}} working', { count: activity.working })
    );
  }
  if (activity.sending) {
    parts.push(t('sidebar.groupActivity.sending', { count: activity.sending }));
  }
  if (activity.unread) {
    parts.push(t('sidebar.groupActivity.unread', '{{count}} unread', { count: activity.unread }));
  }
  return parts.join(' · ');
}

/**
 * The status a FOLDED group (project, repo, machine, section) draws for the
 * Sessions it hides: the one 14px mark a row would draw, in the same trailing
 * column as the rows, chosen by the rows' own priority. Folding therefore never
 * hides that something is waiting on the user, running, or finished unread —
 * and an expanded group draws nothing, because its rows already say it.
 *
 * One mark, never a count or a stack: the glance answers "does anything in
 * here need me?", the hover (`description`) answers "how much?", and expanding
 * answers "which?". The mark stays mounted across status changes and runs the
 * same working → unread hand-over as a row, so the group plays the done
 * transition when its last running Session finishes.
 *
 * Pass `describe={false}` when the header already owns a hover surface (the
 * project path tooltip, the machine card) and put the description there: two
 * hover surfaces on one header open together.
 */
export function SidebarGroupActivityMark({
  activity,
  describe = true,
}: {
  activity: SidebarGroupActivity | null | undefined;
  describe?: boolean;
}) {
  const description = useSidebarGroupActivityDescription(activity);
  const isWaitingPermission = (activity?.waiting ?? 0) > 0;
  const hasUnreadMessages = (activity?.unread ?? 0) > 0;
  const drawWorking = useWorkingHandOver((activity?.working ?? 0) > 0, hasUnreadMessages);
  const sendState: SessionSendState | null = activity?.failed
    ? 'failed'
    : activity?.sending
      ? 'sending'
      : null;
  const hasStatus = hasSessionRowStatus({
    isWaitingPermission,
    isWorking: drawWorking,
    hasUnreadMessages,
    sendState,
  });
  // Keep the slot mounted while empty so the hand-over state survives.
  const mark = (
    <span
      data-sidebar-group-activity=""
      role={hasStatus && description ? 'img' : undefined}
      aria-label={hasStatus && description ? description : undefined}
      className={cn(
        'relative flex h-5 shrink-0 items-center justify-center',
        hasStatus ? 'w-5' : 'w-0'
      )}
    >
      {hasStatus ? (
        <SessionRowStatusIndicator
          isWaitingPermission={isWaitingPermission}
          isWorking={drawWorking}
          hasUnreadMessages={hasUnreadMessages}
          sendState={sendState}
        />
      ) : null}
    </span>
  );
  if (!describe || !hasStatus || !description) return mark;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={300} render={mark} />
      <Tooltip.Content side="right">{description}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/**
 * A GitHub owner (user/org) avatar resolved from just `owner/repo`: the owner's
 * avatar, falling back to the GitHub glyph while it loads, when the handle can't be
 * resolved, or on load error. Shared by the repo group header (`task-list.tsx`) and
 * the session info card. The caller's className threads into BOTH the glyph and the
 * `<img>`, so it can carry size + the header's hover-fade / absolute positioning.
 */
export function GitHubOwnerIcon({
  repoFullName,
  className,
  style,
  crossOrigin,
  onImageLoad,
}: {
  repoFullName: string | null;
  className?: string;
  style?: CSSProperties;
  crossOrigin?: 'anonymous' | 'use-credentials' | '';
  onImageLoad?: ReactEventHandler<HTMLImageElement>;
}) {
  const ownerHandle = repoFullName ? (repoFullName.split('/')[0] ?? '').trim() : '';
  const [failed, setFailed] = useState(false);

  if (!ownerHandle || failed) {
    return <Github className={className} style={style} aria-hidden="true" />;
  }
  return (
    <CachedAvatarImg
      src={getGitHubOwnerAvatarUrl(ownerHandle)}
      alt=""
      aria-hidden="true"
      className={cn('rounded-sm object-cover', className)}
      style={style}
      crossOrigin={crossOrigin}
      onLoad={onImageLoad}
      onError={() => setFailed(true)}
    />
  );
}

// Shared section-header metrics. Every sidebar organize mode (Workspace local
// project / GitHub Worktrees sections and the flat Updated list) uses these so
// section labels read identically (0.9em medium, in the sidebar row color — not
// brighter than the session titles under them, and not a further /55 fade: that
// made "Pinned"/"Chats" and the filter icon nearly illegible on light sidebars).
/**
 * Top-level group label (a machine, GitHub Worktrees, Chats). Projects and
 * repos sit flush below it, so the header is told apart by type alone: about
 * 11.5px bold, faint, a 26px row with no hover fill, above 14px regular rows
 * with a hover fill. Every group label uses exactly this class — one size
 * (from the interface font size, not the parent's `em`), one color — so the
 * groups read as one consistent layer.
 */
export const SIDEBAR_GROUP_LABEL_COLOR_CLASS = 'text-sidebar-foreground-muted/70';
export const SIDEBAR_GROUP_LABEL_CLASS = cn(
  'text-[length:calc(var(--ui-font-size,14px)*0.82)] font-bold tracking-[0.01em]',
  SIDEBAR_GROUP_LABEL_COLOR_CLASS
);

const SECTION_HEADER_BUTTON_CLASS = cn(
  'relative flex h-[26px] min-w-0 flex-1 select-none items-center gap-1.5 rounded-md px-2 text-left',
  'border border-transparent bg-transparent',
  SIDEBAR_GROUP_LABEL_CLASS,
  'transition-colors',
  // The outer row paints the focus ring; suppress the global :focus-visible
  // box-shadow here so the ring wraps the whole row (label + action).
  'focus-visible:shadow-none'
);

const SECTION_HEADER_CHEVRON_CLASS = cn(
  'h-3.5 w-3.5 shrink-0 text-current opacity-0',
  'transition-[opacity,translate,scale,rotate] duration-150 ease-out'
);

/**
 * The ONE section header shared by every sidebar organize mode, so section labels
 * stay visually consistent across Workspace and Updated modes. An optional leading
 * `icon` is a real flex child (vertically centered by the row), NOT nested inside
 * the truncating label span — that keeps an icon+label header (e.g. a machine name
 * with a Monitor glyph) aligned with a plain-text one.
 */
export function SidebarSectionHeader({
  icon,
  label,
  collapsed,
  action,
  activity,
  describeActivity = true,
  wrapToggle,
  onToggleCollapsed,
  isMobile,
  toggleLabel,
}: {
  icon?: ReactNode;
  label: ReactNode;
  collapsed?: boolean;
  /** @deprecated The collapsed count badge has been removed; this prop is ignored. */
  count?: number;
  action?: ReactNode;
  /**
   * Status of the Sessions this section hides. Drawn only while collapsed, as
   * {@link SidebarGroupActivityMark}; an expanded section's rows speak for it.
   */
  activity?: SidebarGroupActivity | null;
  /** False when a wrapper already owns the header's hover surface (machine card). */
  describeActivity?: boolean;
  /**
   * Wraps the label/toggle only, never `action`: a hover card over the whole row
   * would open on the action buttons and cover the menus they open.
   */
  wrapToggle?: (toggle: ReactElement) => ReactNode;
  onToggleCollapsed?: () => void;
  isMobile?: boolean;
  toggleLabel?: string;
}) {
  const canToggle = typeof onToggleCollapsed === 'function';
  const handleToggle = () => {
    if (canToggle) onToggleCollapsed?.();
  };
  const toggle = (
    <div
      role={canToggle ? 'button' : undefined}
      tabIndex={canToggle ? 0 : -1}
      aria-expanded={canToggle ? !collapsed : undefined}
      aria-label={canToggle ? toggleLabel : undefined}
      onClick={canToggle ? handleToggle : undefined}
      onKeyDown={
        canToggle
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              handleToggle();
            }
          : undefined
      }
      className={cn(
        SECTION_HEADER_BUTTON_CLASS,
        canToggle
          ? cn('cursor-pointer', !isMobile && 'hover:text-sidebar-foreground')
          : 'cursor-default'
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {canToggle ? (
        <ChevronDown
          className={cn(
            SECTION_HEADER_CHEVRON_CLASS,
            // This shared header is reserved for top-level sections (Chats,
            // machine names, GitHub Worktrees), whose folded affordance stays visible.
            collapsed || isMobile ? 'opacity-100' : 'group-hover:opacity-100',
            // Collapsed points right (the platform-wide convention).
            collapsed ? '-rotate-90' : 'rotate-0'
          )}
          aria-hidden="true"
        />
      ) : null}
      <span className="flex-1" aria-hidden="true" />
      {collapsed && activity ? (
        <SidebarGroupActivityMark activity={activity} describe={describeActivity} />
      ) : null}
    </div>
  );
  return (
    <div className="group flex h-[26px] items-center gap-1 rounded-md has-[[role=button]:focus-visible]:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.5)]">
      {wrapToggle ? wrapToggle(toggle) : toggle}
      {action ? <div className="mr-2 shrink-0">{action}</div> : null}
    </div>
  );
}

const SIDEBAR_SKELETON_ROW_WIDTHS = [
  'w-[68%]',
  'w-[56%]',
  'w-[74%]',
  'w-[62%]',
  'w-[70%]',
] as const;

/**
 * Loading state for the sidebar lists. Keep this anatomy in sync with the
 * real section header and single-line rows: the skeleton is intentionally not
 * a card, because the loaded rows are flat and use the section's own spacing.
 */
export function SidebarListSkeleton({
  className,
  showHeaderIcon = true,
  sectionClassName = 'mb-2.5 last:mb-0',
}: {
  className?: string;
  showHeaderIcon?: boolean;
  sectionClassName?: string;
}) {
  return (
    <div className={cn('flex flex-col', className)} data-sidebar-loading-skeleton="">
      <div className={cn('flex flex-col gap-0.5', sectionClassName)}>
        <div className="group flex h-7 items-center">
          <div className="relative flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-2">
            {showHeaderIcon ? (
              <span className="flex h-5 w-5 shrink-0 items-center">
                <Skeleton className="h-3.5 w-3.5 rounded-sm" />
              </span>
            ) : null}
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <div className="flex flex-col gap-px">
          {SIDEBAR_SKELETON_ROW_WIDTHS.map((width, index) => (
            <div key={index} className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
              <Skeleton className={cn('h-3 min-w-0', width)} />
              <Skeleton className="ml-auto h-3 w-8 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
