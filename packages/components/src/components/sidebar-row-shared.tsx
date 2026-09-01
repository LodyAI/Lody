import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Check,
  ChevronDown,
  CircleDot,
  CornerLeftUp,
  Github,
  Hand,
  Loader2,
  MoreHorizontal,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { PrStatus, SessionPullRequestCiState } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { ContextMenuItem, ContextMenuSeparator } from '@/ui/context-menu';
import { Skeleton } from '@/ui/skeleton';
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
 * Row anatomy: `[① status/tree affordance | more][② author avatar? + title][③ diff/mergeable?][worktree?][④ PR icon? | archive]`.
 * The author avatar (`SessionRowAuthorAvatar`) only appears in team ("All Tasks") scope on a
 * multi-member workspace; otherwise the title owns the leading edge of slot ②. The leading slot
 * stays reserved even when empty (the ⋯ menu button reveals there on hover). A local worktree
 * session shows a faint worktree glyph (`SessionRowWorktreeIndicator`) inside the metric cluster,
 * between the line diff and the PR icon (taking the PR's right-edge spot when there is no PR);
 * GitHub sessions are always worktrees so they never show it. The full
 * repo / folder / worktree session-type detail still lives in the desktop hover info card
 * (`session-info-hover-card.tsx`). At rest, PR status
 * owns the right edge when present and line diff sits immediately before it. Without
 * PR status, line diff owns the right edge. Archive replaces the trailing content on
 * hover, so the row's rightmost metric never shifts.
 */
export type SidebarRowKind = 'github' | 'local' | 'chat';

type PrCiVerdict = 'success' | 'failure' | 'pending' | 'expected';

/**
 * PR + CI use the original 14px PR / 10px verdict-slot geometry. The circular
 * mask removes the PR stroke beneath the verdict without painting a
 * sidebar-colored backdrop, so the cutout stays transparent on hover and
 * selected-row surfaces. The base keeps its PR-status tone; only the verdict
 * uses the CI-state tone. Running uses a static dot and a tighter cutout.
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

/**
 * ① The 14px status slot at the row's leading edge. Single-slot priority:
 * `waitingPermission > isWorking > hasUnread > empty`. The PR status now lives in
 * the end slot (④), not here, so a resting GitHub row's leading slot is empty
 * unless it is working / unread — but the slot is always reserved so the ⋯ menu
 * button can reveal there on hover without shifting the row.
 */
function SessionRowIndicator({
  isWaitingPermission,
  isWorking,
  hasUnreadMessages,
}: {
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
}) {
  let icon: ReactNode = null;

  if (isWaitingPermission) {
    icon = <Hand className="h-3 w-3 text-status-warning" />;
  } else if (isWorking) {
    icon = (
      <Loader2
        data-session-working-spinner=""
        className="h-3 w-3 shrink-0 animate-spin text-primary will-change-transform"
      />
    );
  } else if (hasUnreadMessages) {
    icon = <span className="h-2 w-2 rounded-full bg-primary" />;
  }

  return (
    <div
      data-session-row-indicator=""
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      {icon}
    </div>
  );
}

/**
 * ③ The PR status icon shown in the final slot (colored, non-interactive —
 * opening the PR is handled by the row context menu + info card). Sized to match
 * the Archive button that replaces it on hover.
 *
 * The mobile conversation row (`mobile/mobile-project-screen.tsx`) renders this
 * same component at the end of its own metric cluster, so PR status tone and the
 * CI verdict badge read identically on both platforms.
 */
export function SessionPrIcon({
  prStatus,
  prCiState,
  className,
}: {
  prStatus: PrStatus;
  prCiState?: SessionPullRequestCiState | null;
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
        className={className}
      />
    );
  }
  return (
    <BaseIcon
      className={cn('h-3.5 w-3.5 shrink-0', meta.iconColorClassName, className)}
      strokeWidth={2.25}
      aria-hidden="true"
    />
  );
}

/**
 * Passive readiness marker for an inactive session row. It intentionally owns
 * the former diff-stat slot: once a PR is ready, the next useful sidebar fact
 * is that it can be merged, not how many lines it changes.
 */
export function SessionMergeablePill() {
  const { t } = useTranslation();
  return (
    <span
      data-session-mergeable-pill=""
      className="inline-flex h-5 shrink-0 items-center rounded-full border border-status-success/45 bg-status-success/[0.06] px-1.5 text-[10px] font-medium leading-none tracking-[0.01em] text-status-success"
    >
      {t('sessions.pr.mergeable', 'Mergeable')}
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
  return (
    <UserAvatar
      user={author}
      className="h-[18px] w-[18px] shrink-0"
      fallbackClassName="text-[9px] font-medium"
    />
  );
}

/**
 * A faint worktree glyph shown inside the end slot's metric cluster, sitting to
 * the LEFT of the PR icon and to the RIGHT of the line diff — so a worktree
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center text-sidebar-foreground-muted/45">
          <WorktreeIcon className="h-3.5 w-3.5" aria-label={label} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Tree state for the shared leading slot. The opener keeps the 14px slot; a
 * child widens it to 26px (12px title indent). Idle children draw ├/└; an
 * active child shows only status at the same 7px node as ⋯. A working opener
 * likewise shows the status spinner instead of its disclosure — loading
 * outranks folding.
 */
export type SessionRowOpenedByTreeSlot =
  | {
      kind: 'opener';
      expanded: boolean;
      label: string;
      onToggle: () => void;
    }
  | {
      kind: 'child';
      isLastChild: boolean;
    };

const TREE_CHILD_SLOT_CLASS = 'w-[26px] justify-start';
const TREE_CONTROL_LEFT_CLASS = 'left-[7px]';
const TREE_LINE_CLASS = 'bg-sidebar-foreground/20';
/** Cover row padding/border from the 14px slot, plus 1px for list `gap-px`. */
const TREE_TRUNK_FROM_PREV_CLASS = '-top-2';
const TREE_TRUNK_INTO_NEXT_CLASS = '-bottom-[9px]';

/**
 * Maps one {@link OpenedBySessionTreeNode} to the leading slot's tree state.
 * Every session list renders the same three cases (opener with a disclosure,
 * nested child with a connector, plain flat row), so the mapping — including
 * the disclosure's i18n label — lives here rather than in each list.
 *
 * `onToggle` absent means the caller cannot fold, so an opener degrades to a
 * plain row rather than showing a dead control.
 */
export function buildSessionRowOpenedByTreeSlot(
  node: { depth: 0 | 1; childCount: number; expanded: boolean; isLastChild: boolean },
  t: TFunction,
  onToggle?: () => void
): SessionRowOpenedByTreeSlot | undefined {
  if (node.childCount > 0 && onToggle) {
    return {
      kind: 'opener',
      expanded: node.expanded,
      label: node.expanded
        ? t('sessions.openedBy.collapse', 'Hide opened sessions')
        : t('sessions.openedBy.expand', 'Show {{count}} opened sessions', {
            count: node.childCount,
          }),
      onToggle,
    };
  }
  return node.depth === 1 ? { kind: 'child', isLastChild: node.isLastChild } : undefined;
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
  separateToggle = true,
}: {
  opener?: Extract<SessionRowOpenedByTreeSlot, { kind: 'opener' }> | null;
  /** Omitted when this row has no opener, or the surface cannot navigate. */
  goToOpener?: () => void;
  goToOpenerLabel: string;
  /** False when nothing follows the toggle in this menu. */
  separateToggle?: boolean;
}) {
  return (
    <>
      {opener ? (
        <>
          <ContextMenuItem onSelect={opener.onToggle}>
            <ChevronDown
              className={cn('transition-transform', opener.expanded ? 'rotate-0' : '-rotate-90')}
            />
            {opener.label}
          </ContextMenuItem>
          {separateToggle ? <ContextMenuSeparator /> : null}
        </>
      ) : null}
      {goToOpener ? (
        <>
          <ContextMenuItem onSelect={goToOpener}>
            <CornerLeftUp />
            {goToOpenerLabel}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
    </>
  );
}

/**
 * ① Status, opened-by tree affordance, and the hover ⋯ button share one spot.
 * ⋯ synthesizes `contextmenu` so there is no second menu. Hover fades the rest
 * state (disclosure, ├/└, or status) without moving the title.
 *
 * A working opener swaps its disclosure for the status spinner — loading
 * outranks folding, so the collapse toggle moves to the row's context menu
 * while the session is active.
 */
export function SessionRowLeadingSlot({
  isWaitingPermission,
  isWorking,
  hasUnreadMessages,
  showMenuButton,
  menuLabel,
  openedByTree,
  /** Fade the status while hovering (e.g. 'group-hover/row:opacity-0' for named groups). */
  fadeClassName = 'group-hover:opacity-0 group-data-[menu-open]:opacity-0',
  /** Disable an opener disclosure while its ⋯ replacement is active. */
  restPointerClassName = 'group-hover:pointer-events-none group-data-[menu-open]:pointer-events-none',
  /** Reveal the ⋯ button while hovering. */
  revealClassName = 'group-hover:opacity-100 group-hover:pointer-events-auto group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto',
}: {
  isWaitingPermission?: boolean;
  isWorking?: boolean;
  hasUnreadMessages?: boolean;
  showMenuButton?: boolean;
  menuLabel: string;
  openedByTree?: SessionRowOpenedByTreeSlot;
  fadeClassName?: string;
  restPointerClassName?: string;
  revealClassName?: string;
}) {
  const childTree = openedByTree?.kind === 'child' ? openedByTree : null;
  const isTreeChild = childTree !== null;
  const hasActivity = Boolean(isWaitingPermission || isWorking || hasUnreadMessages);
  const showChildConnectors = childTree !== null && !hasActivity;
  /* Status outranks the tree on BOTH sides of the relationship: an active
     child drops its ├/└ and an active opener drops its disclosure, because one
     node can only say one thing and "this session needs you" beats "this
     session has children". Folding stays reachable the same way it always is
     on a busy row — hover swaps in ⋯, whose menu carries the same toggle.

     Gated on the whole activity set, not just `isWorking`: the disclosure
     branch REPLACES the indicator, so an unread or waiting-permission opener
     would otherwise render a chevron and silently drop its own status mark. */
  const openerTree = openedByTree?.kind === 'opener' && !hasActivity ? openedByTree : null;
  const restClassName = showMenuButton
    ? cn('transition-opacity duration-100', fadeClassName)
    : undefined;
  const controlLeftClassName = isTreeChild ? TREE_CONTROL_LEFT_CLASS : 'left-1/2';

  return (
    <div
      data-session-row-leading-slot=""
      className={cn(
        'relative flex h-3.5 shrink-0 items-center',
        isTreeChild ? TREE_CHILD_SLOT_CLASS : 'w-3.5 justify-center'
      )}
    >
      {openerTree ? (
        <button
          type="button"
          data-session-opened-by-toggle=""
          aria-label={openerTree.label}
          aria-expanded={openerTree.expanded}
          title={openerTree.label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openerTree.onToggle();
          }}
          className={cn(
            'relative z-20 flex h-3.5 w-3.5 items-center justify-center rounded-sm',
            'text-sidebar-foreground-muted transition-[opacity,color] duration-100',
            'hover:text-sidebar-foreground focus-visible:outline-hidden',
            showMenuButton && cn(restClassName, restPointerClassName)
          )}
        >
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform duration-150 ease-out',
              openerTree.expanded ? 'rotate-0' : '-rotate-90'
            )}
            aria-hidden="true"
          />
        </button>
      ) : showChildConnectors ? (
        <div className={cn('absolute inset-0', restClassName)}>
          <span
            aria-hidden="true"
            data-session-tree-connector="trunk"
            className={cn(
              'absolute w-px',
              TREE_LINE_CLASS,
              TREE_CONTROL_LEFT_CLASS,
              TREE_TRUNK_FROM_PREV_CLASS,
              childTree.isLastChild ? 'bottom-1/2' : TREE_TRUNK_INTO_NEXT_CLASS
            )}
          />
          <span
            aria-hidden="true"
            data-session-tree-connector="elbow"
            className={cn(
              'absolute top-1/2 h-px w-[13px]',
              TREE_LINE_CLASS,
              TREE_CONTROL_LEFT_CLASS
            )}
          />
        </div>
      ) : (
        <div className={restClassName}>
          <SessionRowIndicator
            isWaitingPermission={isWaitingPermission}
            isWorking={isWorking}
            hasUnreadMessages={hasUnreadMessages}
          />
        </div>
      )}
      {showMenuButton ? (
        <button
          type="button"
          aria-label={menuLabel}
          onClick={(event) => {
            // Open the row's existing right-click menu from a left click on ⋯.
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: Math.round(rect.left),
                clientY: Math.round(rect.bottom),
              })
            );
          }}
          className={cn(
            // Overlay a 20px hit target centered on the 14px status slot so the ⋯
            // gets a visible rounded hover chip (it reads as clickable) without
            // the tiny status-slot footprint clipping the background.
            'absolute top-1/2 z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md opacity-0 pointer-events-none',
            controlLeftClassName,
            'text-sidebar-foreground-muted transition-[opacity,color,background-color] duration-100',
            'hover:bg-sidebar-foreground/15 hover:text-sidebar-foreground',
            // The trigger itself stays pressed-looking while its menu is open,
            // not just the row around it.
            'group-data-[menu-open]:bg-sidebar-foreground/15 group-data-[menu-open]:text-sidebar-foreground',
            revealClassName
          )}
        >
          <MoreHorizontal className="relative -top-px h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

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
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <SidebarConfirmArchiveButton
          label={label}
          confirmLabel={confirmLabel}
          className={cn(
            'absolute right-0 top-0 z-20 opacity-0 pointer-events-none',
            revealClassName
          )}
          onConfirm={onConfirm}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * ③ The final slot at the row's right edge. Its resting content can be a compact
 * line diff, time, or an icon. Archive is absolutely overlaid on hover, so a wide
 * diff never causes layout movement. When the rest content is absent but Archive is
 * available, it still reserves the action's 20px hit target.
 */
export function SidebarRowEndSlot({
  restIcon,
  archive,
  /** Fade the rest icon while hovering (match the row's group, e.g. 'group-hover/row:opacity-0'). */
  fadeClassName = 'group-hover:opacity-0',
}: {
  restIcon?: ReactNode;
  archive?: ReactNode;
  fadeClassName?: string;
}) {
  const hasRest = Boolean(restIcon);
  // Reserve the action hit target whenever something can occupy it; otherwise the
  // slot sizes to its resting content (for example, a +/- line diff).
  const reserve = hasRest || Boolean(archive);
  return (
    // pointer-events-none so the resting PR icon area still passes clicks through to
    // the row's navigation; the Archive button re-enables pointer events on hover.
    <div
      className={cn(
        'relative flex h-5 shrink-0 items-center justify-center pointer-events-none',
        reserve ? 'min-w-5' : 'w-0'
      )}
    >
      {hasRest ? (
        <span
          className={cn('flex', archive && cn('transition-opacity duration-100', fadeClassName))}
        >
          {restIcon}
        </span>
      ) : null}
      {archive}
    </div>
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
}: {
  repoFullName: string | null;
  className?: string;
}) {
  const ownerHandle = repoFullName ? (repoFullName.split('/')[0] ?? '').trim() : '';
  const [failed, setFailed] = useState(false);

  if (!ownerHandle || failed) {
    return <Github className={className} aria-hidden="true" />;
  }
  return (
    <CachedAvatarImg
      src={getGitHubOwnerAvatarUrl(ownerHandle)}
      alt=""
      aria-hidden="true"
      className={cn('rounded-sm object-cover', className)}
      onError={() => setFailed(true)}
    />
  );
}

// Shared section-header metrics. Every sidebar organize mode (Workspace local
// project / GitHub Worktrees sections and the flat Updated list) uses these so
// section labels read identically (13px medium, muted — full muted token, not a
// further /55 fade: that made "Pinned"/"Chats" and the filter icon nearly
// illegible on light sidebars).
const SECTION_HEADER_BUTTON_CLASS = cn(
  'relative flex h-7 min-w-0 flex-1 select-none items-center gap-1.5 rounded-md px-2 text-left',
  'border border-transparent bg-transparent',
  'text-[13px] font-medium text-sidebar-foreground-muted transition-colors',
  // The outer row paints the focus ring; suppress the global :focus-visible
  // box-shadow here so the ring wraps the whole row (label + action).
  'focus-visible:shadow-none'
);

const SECTION_HEADER_CHEVRON_CLASS = cn(
  'h-3.5 w-3.5 shrink-0 text-current opacity-0',
  'transition-[opacity,translate,scale] duration-150 ease-out'
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
  onToggleCollapsed?: () => void;
  isMobile?: boolean;
  toggleLabel?: string;
}) {
  const canToggle = typeof onToggleCollapsed === 'function';
  const handleToggle = () => {
    if (canToggle) onToggleCollapsed?.();
  };
  return (
    <div className="group flex h-7 items-center gap-1 rounded-md pr-2 has-[[role=button]:focus-visible]:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.5)]">
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
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
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
            <div
              key={index}
              className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2"
            >
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
