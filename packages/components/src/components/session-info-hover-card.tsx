import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  Check,
  Copy,
  ExternalLink,
  FileDiff,
  Folder,
  GitBranch,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Monitor,
  CircleCheck,
  CircleDot,
  CircleX,
  User,
  Users,
} from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { Badge } from '@lody/ui/badge';
import { useTranslation } from 'react-i18next';
import type { PrStatus, SessionPullRequestCiState } from '@lody/shared';
import { cn } from '@/lib/utils';
import { writeTextToClipboard } from '@/lib/clipboard';
import { CachedAvatarImg } from '@/components/cached-avatar-img';

import { PR_STATUS_META } from '@/components/sessions/pull-request-badge';
import {
  PR_CI_RUN_ICON,
  usePrCiPresentation,
  type PrCiRun,
} from '@/components/sessions/session-info-chips';
import { GitHubOwnerIcon, type SidebarRowKind } from '@/components/sidebar-row-shared';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import { useStableNow } from '@/hooks/use-stable-now';
import { formatCompactRelativeTime, type RelativeTimeValue } from '@/lib/format-relative-time';
import type { SessionSharingState } from '@/lib/session-sharing';
import { getSessionSharingDescription, getSessionSharingLabel } from '@/components/session-sharing';

/**
 * A richer replacement for the old Tooltip-based session info card. This is a
 * hover card, not a tooltip: it stays open when the cursor moves from the row
 * INTO the card (open/close grace timers), so its contents can be interactive —
 * the branch is copyable and the PR opens on click.
 *
 * `SessionInfoCard` is the standalone presentational surface (rendered directly
 * in `SessionInfoCard.stories.tsx`); `SessionInfoHoverCard` wraps a trigger with
 * the hover-open behavior and positions the card next to it.
 */

const CLOSE_DELAY_MS = 180;
/**
 * The first hover — or the first after the pointer has been idle for
 * {@link WARM_WINDOW_MS} — waits this long before the card appears, so brushing
 * past a row doesn't flash a card. Once "warm", subsequent hovers open instantly.
 */
const WARMUP_DELAY_MS = 650;
/**
 * As long as cards keep opening/closing within this window, opens stay instant.
 * After this much idle time the next hover has to warm up again.
 */
const WARM_WINDOW_MS = 3_000;

// Sidebar-tinted surface with a 0.5px edge and a light composer-style drop.
// The shared menu hairline is derived from --background and would wash out on
// this warmer fill, so the edge is mixed from --sidebar-background instead.
// Dark uses a quieter 10% foreground step so it does not read as a bright ring.
const cardEdgeColor =
  'color-mix(in oklab, hsl(var(--sidebar-background)) 76%, hsl(var(--foreground)) 24%)';
const cardDarkEdgeColor =
  'color-mix(in oklab, hsl(var(--sidebar-background)) 90%, hsl(var(--foreground)) 10%)';
const cardSeparatorColor =
  'color-mix(in oklab, hsl(var(--sidebar-background)) 86%, hsl(var(--foreground)) 14%)';

const cardSurfaceStyle: CSSProperties = {
  backgroundColor: 'hsl(var(--sidebar-background))',
  boxShadow: '0px 3px 6px -2px lch(0% 0 0 / 0.02), 0px 1px 1px lch(0% 0 0 / 0.04)',
  '--session-info-card-edge': cardEdgeColor,
  '--session-info-card-dark-edge': cardDarkEdgeColor,
} as CSSProperties;

function CopyableValue({
  text,
  mono,
  copyLabel,
  copiedLabel,
}: {
  text: string;
  mono?: boolean;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = useCallback(() => {
    void writeTextToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? copiedLabel : copyLabel}
      aria-label={`${copyLabel}: ${text}`}
      className={cn(
        'group/copy -mx-1 inline-flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-left',
        'text-foreground transition-colors hover:bg-muted-foreground/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
    >
      <span className={cn('truncate', mono && 'font-mono')}>{text}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-status-success" aria-hidden="true" />
      ) : (
        <Copy
          className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function InfoCardCi({ runs }: { runs: readonly PrCiRun[] }) {
  const { overallLabel, toneClassName, settled } = usePrCiPresentation(runs);
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted-foreground/[0.06] p-1.5">
      <div className="flex items-center gap-1.5">
        <span className={toneClassName}>{overallLabel}</span>
        <span className="text-muted-foreground">
          · {settled}/{runs.length}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {runs.map((run) => {
          const { Icon, className } = PR_CI_RUN_ICON[run.status];
          return (
            <li key={run.name} className="flex items-center gap-1.5">
              <Icon className={cn('h-3 w-3 shrink-0', className)} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-foreground/90">{run.name}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function InfoCardCiRollup({ state }: { state: SessionPullRequestCiState }) {
  const { t } = useTranslation();
  const isPassing = state === 's';
  const isFailing = state === 'f' || state === 'e';
  const Icon = isPassing ? CircleCheck : isFailing ? CircleX : CircleDot;
  const label = isPassing
    ? t('sessions.prCi.passing', 'CI passed')
    : isFailing
      ? t('sessions.prCi.failing', 'CI failed')
      : state === 'x'
        ? t('sessions.prCi.expected', 'CI expected')
        : t('sessions.prCi.running', 'CI running');
  const toneClassName = isPassing
    ? 'text-status-success'
    : isFailing
      ? 'text-destructive'
      : 'text-status-warning';

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md bg-muted-foreground/[0.06] p-1.5',
        toneClassName
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export type SessionInfoCardProps = {
  /** Row kind — a `chat` with no repo/folder shows just a "Chat" indicator. */
  kind?: SidebarRowKind;
  /**
   * Conversation creator, shown as the first "Author" row. Pass it only when it
   * should surface (e.g. team workspaces); omit for solo workspaces where the
   * author is always the current user.
   */
  author?: { name?: string | null; image?: string | null } | null;
  /** Optional session title shown as the card header. */
  title?: string;
  isWorktree?: boolean;
  latestMessageAt: RelativeTimeValue;
  now: Date;
  repoFullName?: string | null;
  /** Local project folder name (shown as "Folder" for local-project sessions). */
  folderName?: string | null;
  /** Name of the machine the session runs on. */
  machineName?: string | null;
  branchName?: string | null;
  prStatus?: PrStatus | null;
  /** Compact CI rollup written by the CLI poller for the selected PR. */
  prCiState?: SessionPullRequestCiState | null;
  prNumber?: number | null;
  prUrl?: string | null;
  /** CI check runs for the PR. Undefined until a real CI feed exists (see info-bar). */
  prCiRuns?: readonly PrCiRun[];
  addedLines?: number;
  deletedLines?: number;
  /** Effective conversation visibility inherited from its machine/project access. */
  sharing?: SessionSharingState;
  /** Open the PR inside the app (right-panel PR tab). Falls back to `prUrl` in a new tab. */
  onOpenPullRequest?: () => void;
  className?: string;
};

/**
 * The presentational hover-card surface. Only renders the fields it has, so a
 * chat row shows just the elapsed time. Time is always relative ("elapsed"),
 * never a raw timestamp.
 */
export function SessionInfoCard({
  kind,
  author,
  title,
  isWorktree,
  latestMessageAt,
  now,
  repoFullName,
  folderName,
  machineName,
  branchName,
  prStatus,
  prCiState,
  prNumber,
  prUrl,
  prCiRuns,
  addedLines,
  deletedLines,
  sharing,
  onOpenPullRequest,
  className,
}: SessionInfoCardProps) {
  const { t } = useTranslation();
  const relative = formatCompactRelativeTime(latestMessageAt, now);
  const copyLabel = t('sessions.infoCard.copy', 'Copy');
  const copiedLabel = t('sessions.copied', 'Copied');
  const hasChanges =
    typeof addedLines === 'number' &&
    typeof deletedLines === 'number' &&
    (addedLines !== 0 || deletedLines !== 0);
  const showPr = Boolean(prStatus);

  // Each metadata row leads with an ICON instead of a text label (GitHub owner
  // avatar / folder / branch / diff), so the card reads at a glance. `label` still
  // feeds the icon's tooltip + aria for accessibility.
  const rows: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    value: ReactNode;
    /** Pin the icon to the first line instead of centering it against a multi-line value. */
    iconAlignTop?: boolean;
  }> = [];

  if (author?.name) {
    rows.push({
      key: 'author',
      icon: author.image ? (
        <CachedAvatarImg
          src={author.image}
          alt=""
          aria-hidden="true"
          className="h-3.5 w-3.5 rounded-full object-cover"
        />
      ) : (
        <User className="h-3.5 w-3.5" aria-hidden="true" />
      ),
      label: t('sessions.infoCard.author', 'Author'),
      value: <span className="min-w-0 truncate text-foreground">{author.name}</span>,
    });
  }

  if (repoFullName) {
    rows.push({
      key: 'repository',
      icon: <GitHubOwnerIcon repoFullName={repoFullName} className="h-3.5 w-3.5" />,
      label: t('sessions.infoCard.repository', 'Repository'),
      value: <CopyableValue text={repoFullName} copyLabel={copyLabel} copiedLabel={copiedLabel} />,
    });
  }

  if (folderName) {
    rows.push({
      key: 'folder',
      icon: <Folder className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sessions.infoCard.folder', 'Folder'),
      value: <CopyableValue text={folderName} copyLabel={copyLabel} copiedLabel={copiedLabel} />,
    });
  }

  if (machineName) {
    rows.push({
      key: 'machine',
      icon: <Monitor className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sessions.machineLabel', 'Machine'),
      value: <span className="min-w-0 truncate text-foreground">{machineName}</span>,
    });
  }

  if (branchName) {
    rows.push({
      key: 'branch',
      // A worktree session leads with the worktree glyph (same as its row mode
      // icon) AND labels the row "Worktree" so the isolated checkout is explicit;
      // a plain branch leads with GitBranch and reads "Branch".
      icon: isWorktree ? (
        <WorktreeIcon className="h-3.5 w-3.5" />
      ) : (
        <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
      ),
      label: isWorktree
        ? t('sessions.infoCard.worktree', 'Worktree')
        : t('sessions.infoCard.branch', 'Branch'),
      value: (
        <span className="flex min-w-0 items-center gap-1.5">
          <CopyableValue text={branchName} mono copyLabel={copyLabel} copiedLabel={copiedLabel} />
          {isWorktree ? (
            // The icon glyph alone is easy to miss; a small pill makes the
            // isolated-worktree mode unmistakable in the details surface.
            <Badge>{t('sessions.infoCard.worktree', 'Worktree')}</Badge>
          ) : null}
        </span>
      ),
    });
  }

  if (hasChanges) {
    rows.push({
      key: 'changes',
      icon: <FileDiff className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sessions.infoCard.changes', 'Changes'),
      value: (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span className="text-code-added">+{addedLines}</span>
          <span className="text-code-removed">-{deletedLines}</span>
        </span>
      ),
    });
  }

  // A chat has no repo / folder / branch, so it just says it's a chat.
  if (kind === 'chat' && rows.length === 0) {
    rows.push({
      key: 'chat',
      icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sessions.infoCard.chat', 'Chat'),
      value: <span className="text-muted-foreground">{t('sessions.infoCard.chat', 'Chat')}</span>,
    });
  }

  if (sharing) {
    const sharingLabel = getSessionSharingLabel(t, sharing);
    const SharingIcon =
      sharing.visibility === 'team'
        ? Users
        : sharing.visibility === 'private'
          ? LockKeyhole
          : Loader2;
    rows.push({
      key: 'sharing',
      icon: (
        <Spinner
          icon={SharingIcon}
          spinning={sharing.visibility === 'unknown'}
          className="h-3.5 w-3.5"
          aria-hidden="true"
        />
      ),
      label: t('sessions.sharing.visibility', 'Visibility'),
      iconAlignTop: true,
      value: (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium text-foreground">{sharingLabel}</span>
          <span className="text-[11px] leading-4 text-muted-foreground">
            {getSessionSharingDescription(t, sharing)}
          </span>
        </span>
      ),
    });
  }

  const prMeta = showPr ? (PR_STATUS_META[prStatus!] ?? PR_STATUS_META.open) : null;
  const PrIcon = prMeta?.icon;
  const canOpenPr = Boolean(onOpenPullRequest || prUrl);
  const openPr = useCallback(() => {
    if (onOpenPullRequest) {
      onOpenPullRequest();
      return;
    }
    if (prUrl) window.open(prUrl, '_blank', 'noopener,noreferrer');
  }, [onOpenPullRequest, prUrl]);

  const hasMeta = rows.length > 0;
  const hasBody = hasMeta || (showPr && prMeta && PrIcon);

  return (
    <div
      style={cardSurfaceStyle}
      className={cn(
        'flex w-[16.5rem] flex-col rounded-lg border-[0.5px] border-[var(--session-info-card-edge)] p-2.5 text-xs text-foreground dark:border-[var(--session-info-card-dark-edge)]',
        className
      )}
    >
      {/* Header: title on the left, elapsed time on the right. */}
      <div className={cn('flex items-baseline gap-2', hasBody && 'mb-2')}>
        {title ? (
          <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={title}>
            {title}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground">{relative}</span>
      </div>

      {hasMeta ? (
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground',
                  row.iconAlignTop && 'mt-px self-start'
                )}
                title={row.label}
                aria-label={row.label}
              >
                {row.icon}
              </span>
              <div className="flex min-w-0 flex-1">{row.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {showPr && prMeta && PrIcon ? (
        <>
          {hasMeta ? (
            <div
              className="my-2 h-px"
              style={{ backgroundColor: cardSeparatorColor }}
              aria-hidden="true"
            />
          ) : null}
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={canOpenPr ? openPr : undefined}
              disabled={!canOpenPr}
              aria-label={t('sessions.pr.openTab', 'Open pull request')}
              className={cn(
                '-mx-1 inline-flex w-fit items-center gap-1.5 rounded px-1 py-0.5 transition-colors',
                prMeta.iconColorClassName,
                canOpenPr
                  ? 'hover:bg-muted-foreground/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50'
                  : 'cursor-default'
              )}
            >
              <PrIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
              <span>
                {t(prMeta.labelKey, prMeta.labelFallback)}
                {typeof prNumber === 'number' ? ` #${prNumber}` : ''}
              </span>
              {canOpenPr ? (
                <ExternalLink className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              ) : null}
            </button>
            {prCiRuns && prCiRuns.length > 0 ? (
              <InfoCardCi runs={prCiRuns} />
            ) : prCiState ? (
              <InfoCardCiRollup state={prCiState} />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export type SessionInfoHoverCardProps = Omit<SessionInfoCardProps, 'now'> & {
  /** The trigger (a sidebar row). Hovering it opens the card. */
  children: ReactNode;
  /** Skip the hover card entirely (e.g. on touch devices with no hover). */
  disabled?: boolean;
  /**
   * Optional fixed "now" for the card's relative times. When omitted the card
   * ticks itself via `useStableNow()` — and only while open (the popover
   * content stays unmounted when closed), so resting rows pay nothing.
   */
  now?: Date;
};

/**
 * At most one info card is open across the whole app. When a card opens it closes
 * the previously-open one INSTANTLY (bypassing the close grace), so sweeping the
 * cursor across rows never shows two cards at once.
 */
let activeClose: (() => void) | null = null;

/**
 * `performance.now()` of the last time any card actually opened or closed. Drives
 * the warm/instant window: while cards keep coming within {@link WARM_WINDOW_MS},
 * opens are instant; after a longer idle gap the next hover warms up again. A
 * hover that's aborted before its card shows does NOT update this, so brushing
 * past rows never "warms" the window.
 */
let lastCardInteractionAt = Number.NEGATIVE_INFINITY;

/**
 * Wraps a trigger with hover-to-open behavior and renders {@link SessionInfoCard}
 * beside it. The first hover warms up (~650ms) before opening; while the pointer
 * keeps hitting cards, later opens are instant. A short close grace lets the
 * cursor travel from the row into the card without it closing.
 */
export function SessionInfoHoverCard({
  children,
  disabled,
  now,
  ...cardProps
}: SessionInfoHoverCardProps) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const openTimer = useRef<number | null>(null);

  const clearClose = useCallback(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const clearOpen = useCallback(() => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const closeSelf = useCallback(() => {
    clearClose();
    clearOpen();
    // Only a card that was actually shown counts as an interaction (keeps the warm
    // window alive); an aborted warmup must not.
    if (openRef.current) lastCardInteractionAt = performance.now();
    openRef.current = false;
    setOpen(false);
  }, [clearClose, clearOpen]);

  // Open now, closing whatever else is open first so only one card ever shows at a
  // time (the outgoing card disappears instantly, no grace).
  const openNow = useCallback(() => {
    clearClose();
    clearOpen();
    if (activeClose && activeClose !== closeSelf) activeClose();
    activeClose = closeSelf;
    lastCardInteractionAt = performance.now();
    openRef.current = true;
    setOpen(true);
  }, [clearClose, clearOpen, closeSelf]);

  // Hover intent: instant while warm, otherwise wait out the warmup delay.
  const requestOpen = useCallback(() => {
    clearClose();
    if (openRef.current) return;
    const warm = performance.now() - lastCardInteractionAt < WARM_WINDOW_MS;
    if (warm) {
      openNow();
      return;
    }
    clearOpen();
    openTimer.current = window.setTimeout(openNow, WARMUP_DELAY_MS);
  }, [clearClose, clearOpen, openNow]);

  // Leaving cancels a pending warmup (so the card never appears after the cursor
  // is gone) and schedules the close grace for an already-open card.
  const scheduleClose = useCallback(() => {
    clearOpen();
    clearClose();
    closeTimer.current = window.setTimeout(closeSelf, CLOSE_DELAY_MS);
  }, [clearOpen, clearClose, closeSelf]);

  // Release the shared slot whenever this card is closed (incl. Escape / outside).
  useEffect(() => {
    if (!open && activeClose === closeSelf) activeClose = null;
  }, [open, closeSelf]);

  useEffect(
    () => () => {
      clearClose();
      clearOpen();
      if (activeClose === closeSelf) activeClose = null;
    },
    [clearClose, clearOpen, closeSelf]
  );

  if (disabled) return <>{children}</>;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSelf();
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <div onPointerEnter={requestOpen} onPointerLeave={scheduleClose}>
          {children}
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={clearClose}
          onPointerLeave={scheduleClose}
          className="z-[var(--z-popover)] outline-hidden"
        >
          <SessionInfoCardWithNow {...cardProps} now={now} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * Renders the card with a `now`. When the caller didn't pin one, the card ticks
 * itself — and because the popover content unmounts while closed, that
 * subscription only exists while the card is actually open.
 */
function SessionInfoCardWithNow(props: Omit<SessionInfoCardProps, 'now'> & { now?: Date }) {
  const { now: pinnedNow, ...cardProps } = props;
  const tickingNow = useStableNow();
  return <SessionInfoCard {...cardProps} now={pinnedNow ?? tickingNow} />;
}
