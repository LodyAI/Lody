import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  Folder,
  GitBranch,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Monitor,
  User,
  Users,
} from 'lucide-react';
import { PreviewCard } from '@lody/ui/preview-card';
import { Separator } from '@lody/ui/separator';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, focus, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import type { PrStatus, SessionPullRequestCiState } from '@lody/shared';
import { writeTextToClipboard } from '@/lib/clipboard';
import { CachedAvatarImg } from '@/components/cached-avatar-img';

import { PR_STATUS_META } from '@/components/sessions/pull-request-badge';
import { summarizePrCiRuns, type PrCiRun } from '@/components/sessions/session-info-chips';
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
 * the hover-open behavior and positions the card next to it on `@lody/ui`'s
 * `PreviewCard`, the popover's floating rung.
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

/** The popup row highlight: the floating rung mixed 6% toward the ink. */
const HIGHLIGHT = `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 6%)`;

const styles = stylex.create({
  /**
   * One width for every card: sized to its content, the right edge hugged the
   * longest row and the status line's diff ran into the CI verdict.
   */
  size: { boxSizing: 'border-box', width: '18rem' },
  card: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  /** Standalone (story) rendering: the same floating rung, drawn in place. */
  standalone: {
    padding: space[3],
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.popover,
    color: colors.label,
  },
  header: { display: 'flex', alignItems: 'baseline', gap: space[3], minWidth: 0 },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
    color: colors.label,
  },
  time: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
    color: colors.tertiaryLabel,
  },
  /**
   * The facts, one kind per row, each behind a 14px mark in one column so a
   * glance finds a kind by its mark and the values start on one edge.
   */
  facts: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    fontSize: text.footnoteSize,
    // 1.5: at the footnote's own 16px, Han text closes up line to line.
    lineHeight: '18px',
    color: colors.label,
  },
  mark: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '14px',
    height: '14px',
    color: colors.tertiaryLabel,
  },
  glyph: { display: 'block', flexShrink: 0, width: '14px', height: '14px' },
  avatar: {
    display: 'block',
    flexShrink: 0,
    width: '14px',
    height: '14px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    objectFit: 'cover',
  },
  /** The machine after its author: the same row, its own small mark. */
  machine: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    marginInlineStart: space[3],
    color: colors.secondaryLabel,
  },
  inlineGlyph: {
    display: 'block',
    flexShrink: 0,
    width: '12px',
    height: '12px',
    color: colors.tertiaryLabel,
  },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  dot: { flexShrink: 0 },
  fixed: { flexShrink: 0 },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  /** The pull request and what it changes: one line under the separator. */
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  prGlyph: { display: 'block', flexShrink: 0, width: '14px', height: '14px' },
  prNumber: { color: colors.label, fontVariantNumeric: 'tabular-nums' },
  ci: { display: 'inline-flex', alignItems: 'center', gap: space[1], minWidth: 0 },
  ciGlyph: { display: 'block', flexShrink: 0, width: '12px', height: '12px' },
  diff: {
    display: 'inline-flex',
    gap: space[1.5],
    flexShrink: 0,
    marginInlineStart: 'auto',
    paddingInlineStart: space[3],
    fontVariantNumeric: 'tabular-nums',
  },
  diffAlone: { marginInlineStart: 0, paddingInlineStart: 0 },
  added: { color: 'hsl(var(--github-addition))' },
  removed: { color: 'hsl(var(--github-deletion))' },
  /**
   * A value that does something when pressed (copy, open): the text itself,
   * given the popup row's highlight on hover so it reads as pressable without a
   * frame. Its hint glyph shows through `--hint-opacity` because StyleX has no
   * descendant selector.
   */
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    marginInline: `calc(-1 * ${space[1]})`,
    paddingInline: space[1],
    paddingBlock: 0,
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': HIGHLIGHT },
    color: 'inherit',
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
    '--hint-opacity': { default: '0', ':hover': '1', ':focus-visible': '1' },
  },
  branch: { color: colors.label },
  actionStatic: { cursor: 'default', backgroundColor: 'transparent' },
  hint: {
    display: 'block',
    flexShrink: 0,
    width: '12px',
    height: '12px',
    color: colors.tertiaryLabel,
    opacity: 'var(--hint-opacity, 0)',
  },
  copied: { opacity: 1, color: colors.success },
  success: { color: colors.success },
  failure: { color: colors.destructive },
  pending: { color: colors.warning },
  prOpen: { color: 'hsl(var(--github-open))' },
  prMerged: { color: 'hsl(var(--github-merged))' },
  prClosed: { color: 'hsl(var(--github-closed))' },
  prDraft: { color: 'hsl(var(--github-draft))' },
});

const PR_TONE: Record<PrStatus, stylex.StyleXStyles> = {
  open: styles.prOpen,
  merged: styles.prMerged,
  closed: styles.prClosed,
  draft: styles.prDraft,
};

function CopyableBranch({
  text: value,
  copyLabel,
  copiedLabel,
}: {
  text: string;
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
    void writeTextToClipboard(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [value]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? copiedLabel : copyLabel}
      aria-label={`${copyLabel}: ${value}`}
      {...stylex.props(styles.action, styles.branch)}
    >
      <span {...stylex.props(styles.truncate, styles.mono)}>{value}</span>
      {copied ? (
        <Check {...stylex.props(styles.hint, styles.copied)} aria-hidden="true" />
      ) : (
        <Copy {...stylex.props(styles.hint)} aria-hidden="true" />
      )}
    </button>
  );
}

type CiVerdict = 'passing' | 'failing' | 'pending' | 'expected';

function ciVerdictLabel(t: ReturnType<typeof useTranslation>['t'], verdict: CiVerdict) {
  if (verdict === 'passing') return t('sessions.prCi.passing', 'CI passed');
  if (verdict === 'failing') return t('sessions.prCi.failing', 'CI failed');
  if (verdict === 'expected') return t('sessions.prCi.expected', 'CI expected');
  return t('sessions.prCi.running', 'CI running');
}

/**
 * CI as one verdict beside the PR: its mark in the verdict's tone, its words in
 * the line's grey. The jobs belong to the PR tab; while they run, the settled
 * count replaces the words (the amber mark already says "running"), so the
 * line fits beside the PR and the diff in every language.
 */
function InfoCardCi({
  runs,
  state,
}: {
  runs?: readonly PrCiRun[];
  state?: SessionPullRequestCiState | null;
}) {
  const { t } = useTranslation();
  const hasRuns = Boolean(runs && runs.length > 0);
  let verdict: CiVerdict;
  if (hasRuns) {
    const overall = summarizePrCiRuns(runs!);
    verdict = overall === 'passing' ? 'passing' : overall === 'failing' ? 'failing' : 'pending';
  } else if (state === 's') verdict = 'passing';
  else if (state === 'f' || state === 'e') verdict = 'failing';
  else if (state === 'x') verdict = 'expected';
  else verdict = 'pending';

  const Icon = verdict === 'passing' ? CircleCheck : verdict === 'failing' ? CircleX : CircleDot;
  const tone =
    verdict === 'passing'
      ? styles.success
      : verdict === 'failing'
        ? styles.failure
        : styles.pending;
  const settled = hasRuns
    ? runs!.filter((run) => run.status !== 'running' && run.status !== 'queued').length
    : 0;

  return (
    <span {...stylex.props(styles.ci)}>
      <Icon {...stylex.props(styles.ciGlyph, tone)} aria-hidden="true" />
      <span {...stylex.props(styles.truncate)}>
        {hasRuns && verdict === 'pending'
          ? `CI ${settled}/${runs!.length}`
          : ciVerdictLabel(t, verdict)}
      </span>
    </span>
  );
}

export type SessionInfoCardProps = {
  /** Row kind — a `chat` with nothing else known says it is a chat. */
  kind?: SidebarRowKind;
  /**
   * Conversation creator, sharing a row with its machine. Pass it only when it should
   * surface (e.g. team workspaces); omit for solo workspaces where the author
   * is always the current user.
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
  /**
   * Layout only (the standalone story places it). When set, the card draws its
   * own floating rung, since no `PreviewCard` is around it.
   */
  standalone?: boolean;
  className?: string;
};

/**
 * The presentational hover-card surface. Only renders the fields it has, so a
 * chat shows just its title and elapsed time. Time is always relative
 * ("elapsed"), never a raw timestamp.
 *
 * One kind of fact per row, each behind a 14px mark in one column: where the
 * work lives (the owner's avatar or a folder), the branch (its glyph says
 * worktree or plain branch), whose it is and on which machine, who may open
 * it. Under the one separator, the pull request, its CI verdict and the diff
 * share a status line; CI jobs belong to the PR tab.
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
  standalone,
  className,
}: SessionInfoCardProps) {
  const { t } = useTranslation();
  const relative = formatCompactRelativeTime(latestMessageAt, now);
  const hasChanges =
    typeof addedLines === 'number' &&
    typeof deletedLines === 'number' &&
    (addedLines !== 0 || deletedLines !== 0);

  const prMeta = prStatus ? (PR_STATUS_META[prStatus] ?? PR_STATUS_META.open) : null;
  const PrIcon = prMeta?.icon;
  const canOpenPr = Boolean(onOpenPullRequest || prUrl);
  const openPr = useCallback(() => {
    if (onOpenPullRequest) {
      onOpenPullRequest();
      return;
    }
    if (prUrl) window.open(prUrl, '_blank', 'noopener,noreferrer');
  }, [onOpenPullRequest, prUrl]);

  const branchKind = isWorktree
    ? t('sessions.infoCard.worktree', 'Worktree')
    : t('sessions.infoCard.branch', 'Branch');
  const BranchIcon = isWorktree ? WorktreeIcon : GitBranch;
  const glyph = stylex.props(styles.glyph);

  // Where the work lives, then on which branch, then whose it is and on which
  // machine, then who may open it.
  const rows: { key: string; mark: ReactNode; label: string; value: ReactNode }[] = [];
  if (repoFullName || folderName) {
    rows.push({
      key: 'place',
      mark: repoFullName ? (
        <GitHubOwnerIcon
          repoFullName={repoFullName}
          className={stylex.props(styles.avatar).className}
        />
      ) : (
        <Folder {...glyph} aria-hidden="true" />
      ),
      label: repoFullName
        ? t('sessions.infoCard.repository', 'Repository')
        : t('sessions.infoCard.folder', 'Folder'),
      value: <span {...stylex.props(styles.truncate)}>{repoFullName ?? folderName}</span>,
    });
  }
  if (branchName) {
    rows.push({
      key: 'branch',
      mark: <BranchIcon {...glyph} aria-hidden="true" />,
      label: branchKind,
      value: (
        <CopyableBranch
          text={branchName}
          copyLabel={t('sessions.infoCard.copy', 'Copy')}
          copiedLabel={t('sessions.copied', 'Copied')}
        />
      ),
    });
  }
  const machineLabel = t('sessions.machineLabel', 'Machine');
  if (author?.name) {
    rows.push({
      key: 'author',
      mark: author.image ? (
        <CachedAvatarImg
          src={author.image}
          alt=""
          aria-hidden="true"
          {...stylex.props(styles.avatar)}
        />
      ) : (
        <User {...glyph} aria-hidden="true" />
      ),
      label: t('sessions.infoCard.author', 'Author'),
      value: (
        <>
          <span {...stylex.props(styles.truncate)}>{author.name}</span>
          {machineName ? (
            <span {...stylex.props(styles.machine)} title={machineLabel}>
              <Monitor {...stylex.props(styles.inlineGlyph)} aria-hidden="true" />
              <span {...stylex.props(styles.truncate)}>{machineName}</span>
            </span>
          ) : null}
        </>
      ),
    });
  } else if (machineName) {
    rows.push({
      key: 'machine',
      mark: <Monitor {...glyph} aria-hidden="true" />,
      label: machineLabel,
      value: <span {...stylex.props(styles.truncate)}>{machineName}</span>,
    });
  }
  if (sharing) {
    const SharingIcon =
      sharing.visibility === 'team'
        ? Users
        : sharing.visibility === 'private'
          ? LockKeyhole
          : Loader2;
    rows.push({
      key: 'sharing',
      mark: <SharingIcon {...glyph} aria-hidden="true" />,
      label: t('sessions.sharing.visibility', 'Visibility'),
      value: (
        <span {...stylex.props(styles.truncate)} title={getSessionSharingDescription(t, sharing)}>
          {getSessionSharingLabel(t, sharing)}
        </span>
      ),
    });
  }
  // A chat has no place or branch; when nothing else is known it says what it is.
  if (kind === 'chat' && rows.length === 0) {
    const chatLabel = t('sessions.infoCard.chat', 'Chat');
    rows.push({
      key: 'chat',
      mark: <MessageSquare {...glyph} aria-hidden="true" />,
      label: chatLabel,
      value: <span>{chatLabel}</span>,
    });
  }

  const showPr = Boolean(prMeta && PrIcon);
  const hasCi = Boolean((prCiRuns && prCiRuns.length > 0) || prCiState);
  const showStatus = showPr || hasChanges;
  // The diff closes the status line at its far end; alone, it starts it.
  const diff = hasChanges ? (
    <span
      {...stylex.props(styles.diff, !showPr && styles.diffAlone)}
      title={t('sessions.infoCard.changes', 'Changes')}
    >
      <span {...stylex.props(styles.added)}>+{addedLines}</span>
      <span {...stylex.props(styles.removed)}>−{deletedLines}</span>
    </span>
  ) : null;
  const cardProps = stylex.props(
    styles.card,
    standalone && styles.size,
    standalone && styles.standalone
  );

  return (
    <div
      className={[cardProps.className, className].filter(Boolean).join(' ')}
      style={cardProps.style}
    >
      <div {...stylex.props(styles.header)}>
        {title ? (
          <span {...stylex.props(styles.title)} title={title}>
            {title}
          </span>
        ) : null}
        <span {...stylex.props(styles.time)}>{relative}</span>
      </div>

      {rows.length > 0 ? (
        <div {...stylex.props(styles.facts)}>
          {rows.map((row) => (
            <div key={row.key} {...stylex.props(styles.row)}>
              <span
                role="img"
                aria-label={row.label}
                title={row.label}
                {...stylex.props(styles.mark)}
              >
                {row.mark}
              </span>
              {row.value}
            </div>
          ))}
        </div>
      ) : null}

      {showStatus ? (
        <>
          <Separator />
          <div {...stylex.props(styles.status)}>
            {showPr && PrIcon && prMeta ? (
              <>
                <PrIcon
                  {...stylex.props(styles.prGlyph, PR_TONE[prStatus!])}
                  strokeWidth={2.25}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={canOpenPr ? openPr : undefined}
                  disabled={!canOpenPr}
                  aria-label={`${t('sessions.pr.openTab', 'Open pull request')}${
                    typeof prNumber === 'number' ? ` #${prNumber}` : ''
                  }`}
                  {...stylex.props(styles.action, styles.fixed, !canOpenPr && styles.actionStatic)}
                >
                  <span {...stylex.props(styles.prNumber)}>
                    {typeof prNumber === 'number' ? `#${prNumber}` : 'PR'}
                  </span>
                  <span>{t(prMeta.labelKey, prMeta.labelFallback)}</span>
                </button>
                {hasCi ? (
                  <>
                    <span {...stylex.props(styles.dot)} aria-hidden="true">
                      ·
                    </span>
                    <InfoCardCi runs={prCiRuns} state={prCiState} />
                  </>
                ) : null}
              </>
            ) : null}
            {diff}
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

/** Pointer travel that ends a press suppression; a still pointer never does. */
const PRESS_MOVE_TOLERANCE_PX = 4;

/**
 * Where the last press on a card trigger happened, while cards are suppressed.
 * A press navigates, and navigation re-renders the rows under a pointer that has
 * not moved, which re-fires `pointerenter`. While warm, that would open a card in
 * the very commit that switches the conversation, and mounting a card reads
 * layout (its positioner measures the anchor), forcing the whole switch's
 * pending style work synchronously (~30ms per open on a large workspace, measured
 * on the Radix popover this card used to sit on). Cards stay shut until the
 * pointer really moves.
 */
let pressSuppression: { x: number; y: number } | null = null;

function releasePressSuppressionOnMove(event: PointerEvent) {
  if (
    pressSuppression &&
    Math.hypot(event.clientX - pressSuppression.x, event.clientY - pressSuppression.y) <
      PRESS_MOVE_TOLERANCE_PX
  ) {
    return;
  }
  pressSuppression = null;
  document.removeEventListener('pointermove', releasePressSuppressionOnMove, true);
}

function suppressCardsUntilPointerMoves(x: number, y: number) {
  if (!pressSuppression) {
    document.addEventListener('pointermove', releasePressSuppressionOnMove, true);
  }
  pressSuppression = { x, y };
}

/**
 * Wraps a trigger with hover-to-open behavior and renders {@link SessionInfoCard}
 * beside it (see {@link SidebarHoverCard}).
 */
export function SessionInfoHoverCard({
  children,
  disabled,
  now,
  ...cardProps
}: SessionInfoHoverCardProps) {
  return (
    <SidebarHoverCard
      disabled={disabled}
      content={<SessionInfoCardWithNow {...cardProps} now={now} />}
    >
      {children}
    </SidebarHoverCard>
  );
}

/**
 * The sidebar's hover card shell, shared by conversation rows and machine group
 * headers so only one card is ever open across both. The first hover warms up
 * (~650ms) before opening; while the pointer keeps hitting cards, later opens
 * are instant. A short close grace lets the cursor travel from the trigger into
 * the card without it closing. `content` mounts only while the card is open,
 * on `PreviewCard`'s surface: it lays out its facts and draws no frame.
 */
export function SidebarHoverCard({
  children,
  disabled,
  content,
}: {
  /** The trigger. Hovering it opens the card. */
  children: ReactNode;
  /** Skip the hover card entirely (e.g. on touch devices with no hover). */
  disabled?: boolean;
  content: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
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
    if (openRef.current || pressSuppression) return;
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

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      suppressCardsUntilPointerMoves(event.clientX, event.clientY);
      closeSelf();
    },
    [closeSelf]
  );

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
    <PreviewCard.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSelf();
      }}
    >
      <div
        ref={anchorRef}
        onPointerEnter={requestOpen}
        onPointerLeave={scheduleClose}
        onPointerDown={handlePointerDown}
      >
        {children}
      </div>
      <PreviewCard.Content
        anchor={anchorRef}
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        onPointerEnter={clearClose}
        onPointerLeave={scheduleClose}
        className={stylex.props(styles.size).className}
      >
        {content}
      </PreviewCard.Content>
    </PreviewCard.Root>
  );
}

/**
 * Renders the card with a `now`. When the caller didn't pin one, the card ticks
 * itself — and because the card's popup unmounts while closed, that
 * subscription only exists while the card is actually open.
 */
function SessionInfoCardWithNow(props: Omit<SessionInfoCardProps, 'now'> & { now?: Date }) {
  const { now: pinnedNow, ...cardProps } = props;
  const tickingNow = useStableNow();
  return <SessionInfoCard {...cardProps} now={pinnedNow ?? tickingNow} />;
}
