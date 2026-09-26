'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleDot,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Github,
  MessageSquare,
  MinusCircle,
  RefreshCcw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@/ui/spinner';
import { useTranslation } from 'react-i18next';
import type {
  GitHubCheckRun,
  GitHubCheckRunsSummary,
  GitHubIssueComment,
  GitHubMergeMethod,
  GitHubPullRequestDetails,
  GitHubReview,
  GitHubReviewThread,
  SessionPullRequestMeta,
} from '@lody/shared';

import { withClassName } from '@/lib/stylex';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  derivePrStatusFromDetails,
  isDraftPr,
  isPullRequestMergeabilityPending,
} from '@/lib/github-pr-details-state';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Avatar, type AvatarSize } from '@lody/ui/avatar';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { ScrollArea } from '@/ui/scroll-area';
import { Skeleton } from '@lody/ui/skeleton';
import { Textarea } from '@lody/ui/textarea';
import { SessionCommentMarkdown } from '@/ui/diff-viewer/session-comment-markdown';
import { GitHubCommentThread } from '@/ui/diff-viewer/github-comment-thread';
import { PullRequestBadge } from '@/components/sessions/pull-request-badge';
import { Menu } from '@/ui/menu';

/** The tab's own width, not the window's: the PR tab lives in a resizable side panel. */
const NARROW = '@container pr-tab (width < 420px)';
const TINY = '@container pr-tab (width < 280px)';
const MONO = 'var(--font-mono)';
/** One column, centred, however wide the panel is dragged. */
const COLUMN = '48rem';
const FOCUS_RING = `0 0 0 ${focus.ringWidth} ${colors.accent}`;

const styles = stylex.create({
  root: {
    containerType: 'inline-size',
    containerName: 'pr-tab',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    backgroundColor: colors.background,
    color: colors.label,
  },
  column: { width: '100%', maxWidth: COLUMN, marginInline: 'auto' },

  // The header and the branch row are the page, not a band: no rule under either.
  header: {
    boxSizing: 'border-box',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    height: 'calc(3.75rem + var(--safe-area-top))',
    paddingInline: space[4],
    paddingTop: 'var(--safe-area-top)',
  },
  headerRow: { display: 'flex', alignItems: 'center', gap: space[2] },
  repoName: {
    display: { default: 'block', [TINY]: 'none' },
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
    color: colors.label,
  },
  headerActions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    marginInlineStart: 'auto',
  },
  embeddedBar: {
    boxSizing: 'border-box',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    height: '3rem',
    paddingInline: '20px',
  },
  embeddedLead: { display: 'flex', minWidth: 0, alignItems: 'center', gap: space[2] },
  embeddedRepo: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  shrink: { flexShrink: 0 },

  branchRow: { paddingInline: space[4], paddingBlock: space[2] },
  branchColumn: { display: 'flex', flexDirection: 'column', gap: space[1] },
  branchRef: {
    display: 'grid',
    gridTemplateColumns: '2.75rem minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: space[2],
    minWidth: 0,
  },
  branchLabel: { fontSize: '0.8em', color: colors.secondaryLabel },
  branchChip: {
    justifySelf: 'start',
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    borderWidth: 0,
    paddingInline: space[1.5],
    paddingBlock: '2px',
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundColor: {
      default: `color-mix(in oklab, transparent, ${colors.label} 6%)`,
      ':hover': `color-mix(in oklab, transparent, ${colors.label} 10%)`,
    },
    fontFamily: MONO,
    fontSize: '0.8em',
    fontWeight: 400,
    color: colors.label,
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': FOCUS_RING },
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },

  scroll: { flexGrow: 1, flexBasis: 0, minHeight: 0 },
  body: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    paddingInline: space[4],
    paddingTop: '20px',
    paddingBottom: 'calc(1.25rem + var(--safe-area-bottom))',
  },
  bodyEmbedded: { gap: '14px', paddingInline: '20px', paddingBottom: '20px' },
  skeleton: { display: 'flex', flexDirection: 'column', gap: space[3] },

  titleSection: { display: 'flex', flexDirection: 'column', gap: '10px' },
  titleSectionEmbedded: { gap: space[1] },
  title: {
    margin: 0,
    fontSize: '1.15em',
    fontWeight: 600,
    lineHeight: 1.375,
    textWrap: 'pretty',
  },
  titleEmbedded: { fontSize: '1em' },
  number: {
    marginInlineStart: space[2],
    fontSize: '1em',
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  numberEmbedded: { fontSize: '0.9em' },
  meta: {
    display: 'flex',
    flexDirection: { default: 'row', [NARROW]: 'column' },
    flexWrap: { default: 'wrap', [NARROW]: 'nowrap' },
    alignItems: { default: 'center', [NARROW]: 'flex-start' },
    rowGap: space[1],
    columnGap: space[2],
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  metaGroup: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[1.5],
    rowGap: '2px',
    minWidth: 0,
  },
  metaStats: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    fontVariantNumeric: 'tabular-nums',
  },
  author: { color: colors.label },
  additions: { color: colors.success },
  deletions: { color: colors.destructive },
  description: {
    paddingInlineEnd: space[1],
    fontSize: '1em',
    lineHeight: 1.625,
    color: colors.label,
  },
  descriptionEmbedded: { paddingInlineEnd: 0, fontSize: '0.9em' },
  noDescription: {
    margin: 0,
    fontSize: '0.8em',
    fontStyle: 'italic',
    color: colors.secondaryLabel,
  },

  // A message is a tint and a mark, never a bordered box.
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: '0.9em',
    color: colors.label,
  },
  noticeDanger: { backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 10%)` },
  noticeWarning: { backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 10%)` },
  noticeQuiet: {
    alignItems: 'center',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    color: colors.secondaryLabel,
  },
  noticeBody: { flexGrow: 1, minWidth: 0, margin: 0 },
  noticeTitle: { margin: 0, fontWeight: 500 },
  noticeTitleDanger: { color: colors.destructive },
  noticeText: { margin: 0, marginTop: '2px', color: colors.secondaryLabel },
  noticeDetail: { margin: 0, marginTop: '2px', fontSize: '0.8em', color: colors.secondaryLabel },
  noticeActions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[1.5] },
  mark: { flexShrink: 0, width: '16px', height: '16px', marginTop: '2px' },
  markCentered: { marginTop: 0 },

  glyph12: { flexShrink: 0, width: '12px', height: '12px' },
  glyph14: { flexShrink: 0, width: '14px', height: '14px' },
  glyph16: { flexShrink: 0, width: '16px', height: '16px' },
  /** A glyph inside an icon-only Button fills the box the button draws. */
  fill: { width: '100%', height: '100%' },
  success: { color: colors.success },
  warning: { color: colors.warning },
  danger: { color: colors.destructive },
  muted: { color: colors.secondaryLabel },

  // The card rung: a lift and no edge.
  card: {
    overflow: 'hidden',
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  list: { margin: 0, padding: 0, listStyle: 'none' },
  /** Every row of a card but the first is ruled from the one above. */
  ruled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },

  checksToggle: {
    boxSizing: 'border-box',
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    margin: 0,
    borderWidth: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    fontFamily: 'inherit',
    fontSize: 'inherit',
    color: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
    },
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `inset ${FOCUS_RING}` },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  checksLabel: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: space[2],
    fontSize: '0.9em',
    fontWeight: 500,
  },
  checksCount: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1.5],
    fontSize: '0.8em',
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  chevron: {
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevronOpen: { transform: 'rotate(180deg)' },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  grow: { flexGrow: 1 },
  runRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[1.5],
    fontSize: '0.9em',
  },
  runApp: { flexShrink: 0, fontSize: '0.8em', color: colors.secondaryLabel },
  iconLink: {
    display: 'inline-flex',
    flexShrink: 0,
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    color: { default: colors.tertiaryLabel, ':hover': colors.label },
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': FOCUS_RING },
    transitionProperty: 'color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  pushEnd: { marginInlineStart: 'auto' },

  // One conversation, one card: each comment, review or thread is a ruled row.
  entry: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  entryHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: '10px',
  },
  entryAuthor: { fontSize: '0.9em', fontWeight: 500, lineHeight: 1 },
  entryMeta: { fontSize: '0.8em', lineHeight: 1, color: colors.secondaryLabel },
  entryBody: { paddingInline: space[3], paddingBottom: '10px' },
  entryThreads: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    margin: 0,
    paddingInline: space[3],
    paddingTop: 0,
    paddingBottom: space[3],
    listStyle: 'none',
  },
  /** A review's thread sits inside its row as a region: a fill, no edge. */
  threadRegion: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  threadHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingTop: space[2],
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  threadPath: { flexGrow: 1, fontFamily: MONO },
  threadLine: { marginInlineStart: space[1], color: colors.tertiaryLabel },
  threadBody: { padding: space[1] },
  sectionStack: { display: 'flex', flexDirection: 'column', gap: space[3] },
  sectionStackEmbedded: { gap: space[2] },

  composer: { display: 'flex', flexDirection: 'column', gap: space[2] },
  composerActions: { display: 'flex', justifyContent: 'flex-end' },
  composerDock: {
    flexShrink: 0,
    paddingInline: space[4],
    paddingTop: space[4],
    paddingBottom: 'calc(1rem + var(--safe-area-bottom))',
    backgroundColor: colors.background,
  },

  /** A split action: the command and its chevron, two buttons of one variant. */
  split: { display: 'flex', alignItems: 'stretch', gap: '2px' },
  /** The labelled and the icon-only form of one action; the tab's width picks. */
  wideOnly: { display: { default: 'contents', [NARROW]: 'none' } },
  narrowOnly: { display: { default: 'none', [NARROW]: 'contents' } },
});

export type PrTabViewState = 'loading' | 'ready' | 'error';

export interface PrTabViewData {
  pullRequest: GitHubPullRequestDetails;
  reviewThreads: GitHubReviewThread[];
  reviews: GitHubReview[];
  issueComments: GitHubIssueComment[];
  checkRuns: GitHubCheckRunsSummary;
}

export interface PrTabViewProps {
  repoFullName: string;
  prNumber: number;
  state: PrTabViewState;
  data?: PrTabViewData | null;
  error?: string | null;
  isRefreshing?: boolean;
  isPostingComment?: boolean;
  checksPermissionError?: boolean;
  leadingSlot?: React.ReactNode;
  mergeMethod?: GitHubMergeMethod;
  isMerging?: boolean;
  isUpdatingState?: boolean;
  isMarkingReady?: boolean;
  isDeletingBranch?: boolean;
  /** `null` while we're still probing GitHub for branch existence, `true`
   *  when it's confirmed present, `false` when the branch is gone. */
  branchExists?: boolean | null;
  onRefresh?: () => void;
  onPostComment?: (body: string) => Promise<void> | void;
  onGrantChecksPermission?: () => void;
  onSelectMergeMethod?: (method: GitHubMergeMethod) => void;
  onMerge?: (method: GitHubMergeMethod) => void | Promise<void>;
  onSetState?: (state: 'open' | 'closed') => void | Promise<void>;
  onMarkReadyForReview?: () => void | Promise<void>;
  onDeleteBranch?: () => void | Promise<void>;
  /**
   * Dispatch the agent "resolve conflicts" prompt (same one the info-bar
   * "Resolve Conflicts" button sends). Provided only while the action is
   * offerable; when absent the conflict button stays a disabled indicator.
   */
  onResolveConflicts?: () => void;
  /** The resolve-conflicts dispatch is in flight — show loading, block clicks. */
  isResolvingConflicts?: boolean;
  /**
   * Landing / marketing frames: drop the chrome header + branch row, tighten
   * spacing, and fill a fixed host height (internal scroll if needed).
   */
  embedded?: boolean;
  className?: string;
}

type RelativeTimeT = (key: string, fallback: string, opts?: Record<string, unknown>) => string;

function formatRelativeTime(isoString: string, t: RelativeTimeT): string {
  const date = new Date(isoString);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return t('sessions.prTab.timeJustNow', 'just now');
  if (minutes < 60) return t('sessions.prTab.timeMinutesAgo', '{{count}}m ago', { count: minutes });
  if (hours < 24) return t('sessions.prTab.timeHoursAgo', '{{count}}h ago', { count: hours });
  if (days < 30) return t('sessions.prTab.timeDaysAgo', '{{count}}d ago', { count: days });
  return date.toLocaleDateString();
}

function prToBadgeMeta(pr: GitHubPullRequestDetails): SessionPullRequestMeta {
  return {
    url: pr.htmlUrl,
    status: derivePrStatusFromDetails(pr),
  };
}

function UserAvatar({
  user,
  size = 'medium',
}: {
  user: { login: string; avatarUrl: string } | null | undefined;
  size?: AvatarSize;
}) {
  const login = user?.login ?? 'ghost';
  return (
    <Avatar.Root size={size}>
      {user?.avatarUrl && <Avatar.Image src={user.avatarUrl} alt={login} />}
      <Avatar.Fallback>{login.slice(0, 2).toUpperCase()}</Avatar.Fallback>
    </Avatar.Root>
  );
}

/** "Open on GitHub": a quiet glyph link at the end of a row. */
function GitHubLink({ href, label, pushEnd }: { href: string; label: string; pushEnd?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      {...stylex.props(styles.iconLink, pushEnd && styles.pushEnd)}
    >
      <Github {...stylex.props(styles.glyph12)} />
    </a>
  );
}

function BranchRefChip({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <div {...stylex.props(styles.branchRef)}>
      <span {...stylex.props(styles.branchLabel)}>{label}</span>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? t('common.copied', 'Copied') : copyLabel}
        aria-label={copied ? t('common.copied', 'Copied') : copyLabel}
        {...stylex.props(styles.branchChip)}
      >
        {copied ? t('common.copied', 'Copied') : value}
      </button>
    </div>
  );
}

function CheckRunIcon({ run }: { run: GitHubCheckRun }) {
  if (run.status !== 'completed') {
    return <Spinner {...stylex.props(styles.glyph14, styles.warning)} />;
  }
  if (run.conclusion === 'success' || run.conclusion === 'skipped') {
    return <CheckCircle2 {...stylex.props(styles.glyph14, styles.success)} />;
  }
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
    return <XCircle {...stylex.props(styles.glyph14, styles.danger)} />;
  }
  if (run.conclusion === 'cancelled') {
    return <MinusCircle {...stylex.props(styles.glyph14, styles.muted)} />;
  }
  return <CircleDashed {...stylex.props(styles.glyph14, styles.muted)} />;
}

const CheckRunRow = memo(function CheckRunRow({ run }: { run: GitHubCheckRun }) {
  const { t } = useTranslation();
  return (
    <li {...stylex.props(styles.runRow, styles.ruled)}>
      <CheckRunIcon run={run} />
      <span {...stylex.props(styles.truncate, styles.grow)} title={run.name}>
        {run.name}
      </span>
      {run.appName && <span {...stylex.props(styles.runApp)}>{run.appName}</span>}
      {run.htmlUrl && (
        <GitHubLink
          href={run.htmlUrl}
          label={t('sessions.prTab.openCheck', 'Open check on GitHub')}
        />
      )}
    </li>
  );
});

const ChecksSection = memo(function ChecksSection({
  summary,
}: {
  summary: GitHubCheckRunsSummary;
}) {
  const { t } = useTranslation();
  const running = summary.status === 'in_progress' || summary.status === 'queued';
  const passed = !running && summary.conclusion === 'success';
  // Collapse the run list once everything is green — the summary line already
  // says "all passed"; expand by default when something needs attention.
  const [open, setOpen] = useState(!passed);
  if (summary.total === 0) {
    return null;
  }
  const headerLabel = running
    ? t('sessions.prTab.checksRunning', 'Checks running')
    : summary.conclusion === 'success'
      ? t('sessions.prTab.checksPassed', 'All checks passed')
      : summary.conclusion === 'failure'
        ? t('sessions.prTab.checksFailed', 'Some checks failed')
        : t('sessions.prTab.checks', 'Checks');
  const headerIcon = running ? (
    <Spinner {...stylex.props(styles.glyph16, styles.warning)} />
  ) : summary.conclusion === 'success' ? (
    <CheckCircle2 {...stylex.props(styles.glyph16, styles.success)} />
  ) : summary.conclusion === 'failure' ? (
    <XCircle {...stylex.props(styles.glyph16, styles.danger)} />
  ) : (
    <CircleDashed {...stylex.props(styles.glyph16, styles.muted)} />
  );
  const countLabel =
    summary.total === 1
      ? t('sessions.prTab.checksCountOne', '1 check')
      : t('sessions.prTab.checksCount', '{{count}} checks', { count: summary.total });

  return (
    <section {...stylex.props(styles.card)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...stylex.props(styles.checksToggle)}
      >
        <span {...stylex.props(styles.checksLabel)}>
          {headerIcon}
          <span {...stylex.props(styles.truncate)}>{headerLabel}</span>
        </span>
        <span {...stylex.props(styles.checksCount)}>
          {countLabel}
          <ChevronDown
            {...stylex.props(styles.glyph14, styles.chevron, open && styles.chevronOpen)}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <ul {...stylex.props(styles.list)}>
          {summary.runs.map((run) => (
            <CheckRunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
});

function ChecksPermissionNotice({
  onGrantChecksPermission,
}: {
  onGrantChecksPermission?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section {...stylex.props(styles.notice, styles.noticeWarning)}>
      <ShieldAlert {...stylex.props(styles.mark, styles.warning)} />
      <div {...stylex.props(styles.noticeBody)}>
        <p {...stylex.props(styles.noticeTitle)}>
          {t('sessions.prTab.checksPermissionTitle', "Can't read CI checks")}
        </p>
        <p {...stylex.props(styles.noticeText)}>
          {t(
            'sessions.prTab.checksPermissionBody',
            'The GitHub App installation is missing the Checks read permission. Update it to show CI status here.'
          )}
        </p>
      </div>
      {onGrantChecksPermission && (
        <Button type="button" size="mini" variant="secondary" onClick={onGrantChecksPermission}>
          <Github {...stylex.props(styles.glyph12)} />
          {t('sessions.prTab.checksPermissionCta', 'Update permissions')}
        </Button>
      )}
    </section>
  );
}

/**
 * Explains why the header merge action is disabled for the non-ready open states.
 * The action itself lives in the header; this is the "why" beneath it.
 */
function MergeStatusNotice({ kind }: { kind: 'conflict' | 'blocked' | 'checking' }) {
  const { t } = useTranslation();
  if (kind === 'conflict') {
    return (
      <section {...stylex.props(styles.notice, styles.noticeDanger)}>
        <AlertCircle {...stylex.props(styles.mark, styles.danger)} />
        <p {...stylex.props(styles.noticeBody)}>
          {t(
            'sessions.prTab.mergeConflictNotice',
            'This branch has conflicts with the base branch — resolve them before it can be merged.'
          )}
        </p>
      </section>
    );
  }
  if (kind === 'blocked') {
    return (
      <section {...stylex.props(styles.notice, styles.noticeWarning)}>
        <ShieldAlert {...stylex.props(styles.mark, styles.warning)} />
        <p {...stylex.props(styles.noticeBody)}>
          {t(
            'sessions.prTab.mergeBlockedNotice',
            'Merging is blocked until required reviews and checks pass.'
          )}
        </p>
      </section>
    );
  }
  return (
    <section {...stylex.props(styles.notice, styles.noticeQuiet)}>
      <Spinner {...stylex.props(styles.mark, styles.markCentered)} />
      <p {...stylex.props(styles.noticeBody)}>
        {t('sessions.prTab.mergeCheckingNotice', 'Checking whether this branch can be merged…')}
      </p>
    </section>
  );
}

const IssueCommentItem = memo(function IssueCommentItem({
  comment,
}: {
  comment: GitHubIssueComment;
}) {
  const { t } = useTranslation();
  const login = comment.user?.login ?? 'ghost';
  return (
    <article {...stylex.props(styles.entry)}>
      <header {...stylex.props(styles.entryHeader)}>
        <UserAvatar
          user={comment.user ? { login, avatarUrl: comment.user.avatarUrl } : null}
          size="medium"
        />
        <span {...stylex.props(styles.entryAuthor)}>{login}</span>
        <span {...stylex.props(styles.entryMeta)}>
          {t('sessions.prTab.commented', 'commented')} · {formatRelativeTime(comment.createdAt, t)}
        </span>
        <GitHubLink
          href={comment.htmlUrl}
          label={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
          pushEnd
        />
      </header>
      <div {...stylex.props(styles.entryBody)}>
        <SessionCommentMarkdown body={comment.body} allowHtml />
      </div>
    </article>
  );
});

const ReviewThreadCard = memo(function ReviewThreadCard({
  thread,
  nested = false,
}: {
  thread: GitHubReviewThread;
  /** Inside a review submission the thread is a region of that row, not a row
   *  of its own, so it takes the region fill. */
  nested?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <article {...stylex.props(styles.entry, nested && styles.threadRegion)}>
      <header {...stylex.props(styles.threadHeader)}>
        <span {...stylex.props(styles.truncate, styles.threadPath)} title={thread.anchor.path}>
          {thread.anchor.path}
          <span {...stylex.props(styles.threadLine)}>:{thread.anchor.line}</span>
        </span>
        {thread.outdated && <Badge>{t('sessions.prTab.outdated', 'outdated')}</Badge>}
      </header>
      <GitHubCommentThread thread={thread} className={stylex.props(styles.threadBody).className} />
    </article>
  );
});

function ReviewStateBadge({ state }: { state: GitHubReview['state'] }) {
  const { t } = useTranslation();
  if (state === 'approved') {
    return (
      <Badge tone="success" icon={<CheckCircle2 {...stylex.props(styles.fill)} />}>
        {t('sessions.prTab.reviewApproved', 'approved')}
      </Badge>
    );
  }
  if (state === 'changes_requested') {
    return (
      <Badge tone="danger" icon={<CircleDot {...stylex.props(styles.fill)} />}>
        {t('sessions.prTab.reviewChangesRequested', 'changes requested')}
      </Badge>
    );
  }
  if (state === 'dismissed') {
    return (
      <Badge icon={<MinusCircle {...stylex.props(styles.fill)} />}>
        {t('sessions.prTab.reviewDismissed', 'dismissed')}
      </Badge>
    );
  }
  return (
    <Badge icon={<MessageSquare {...stylex.props(styles.fill)} />}>
      {t('sessions.prTab.reviewCommented', 'commented')}
    </Badge>
  );
}

const ReviewSubmissionItem = memo(function ReviewSubmissionItem({
  review,
  threads,
}: {
  review: GitHubReview;
  threads: GitHubReviewThread[];
}) {
  const { t } = useTranslation();
  const login = review.user?.login ?? 'ghost';
  const when = review.submittedAt ?? '';
  const hasBody = review.body.trim().length > 0;
  return (
    <article {...stylex.props(styles.entry)}>
      <header {...stylex.props(styles.entryHeader)}>
        <UserAvatar
          user={review.user ? { login, avatarUrl: review.user.avatarUrl } : null}
          size="medium"
        />
        <span {...stylex.props(styles.entryAuthor)}>{login}</span>
        <ReviewStateBadge state={review.state} />
        {when && <span {...stylex.props(styles.entryMeta)}>{formatRelativeTime(when, t)}</span>}
        <GitHubLink
          href={review.htmlUrl}
          label={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
          pushEnd
        />
      </header>
      {hasBody && (
        <div {...stylex.props(styles.entryBody)}>
          <SessionCommentMarkdown body={review.body} allowHtml />
        </div>
      )}
      {threads.length > 0 && (
        <ul {...stylex.props(styles.entryThreads)}>
          {threads.map((thread) => (
            <li key={`thread-${thread.id}`}>
              <ReviewThreadCard thread={thread} nested />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
});

type ConversationItem =
  | { kind: 'issue'; comment: GitHubIssueComment; createdAt: string }
  | { kind: 'review-thread'; thread: GitHubReviewThread; createdAt: string }
  | {
      kind: 'review';
      review: GitHubReview;
      threads: GitHubReviewThread[];
      createdAt: string;
    };

function buildConversation(
  issueComments: GitHubIssueComment[],
  reviewThreads: GitHubReviewThread[],
  reviews: GitHubReview[]
): ConversationItem[] {
  // Index reviews we have submission metadata for, then attach each thread to
  // its parent review via the root comment's pull_request_review_id. Threads
  // without a matching review (older reviews we didn't fetch, or comments
  // whose review submission got dropped) render as standalone rows.
  const reviewById = new Map<number, GitHubReview>();
  for (const review of reviews) reviewById.set(review.id, review);

  const threadsByReviewId = new Map<number, GitHubReviewThread[]>();
  const orphanThreads: GitHubReviewThread[] = [];
  for (const thread of reviewThreads) {
    const reviewId = thread.comments[0]?.pullRequestReviewId ?? null;
    if (reviewId !== null && reviewById.has(reviewId)) {
      const bucket = threadsByReviewId.get(reviewId);
      if (bucket) {
        bucket.push(thread);
      } else {
        threadsByReviewId.set(reviewId, [thread]);
      }
    } else {
      orphanThreads.push(thread);
    }
  }

  const items: ConversationItem[] = [];
  for (const comment of issueComments) {
    items.push({ kind: 'issue', comment, createdAt: comment.createdAt });
  }
  for (const thread of orphanThreads) {
    items.push({
      kind: 'review-thread',
      thread,
      createdAt: thread.comments[0]?.createdAt ?? '',
    });
  }
  for (const review of reviews) {
    const threads = threadsByReviewId.get(review.id) ?? [];
    // Drop submissions that carry no signal: empty body, no threads, and the
    // default "commented" state (GitHub's implicit auto-submission).
    if (!review.body.trim() && threads.length === 0 && review.state === 'commented') continue;
    items.push({
      kind: 'review',
      review,
      threads,
      createdAt: review.submittedAt ?? '',
    });
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const HEADER_MERGE_METHODS: Array<{
  value: GitHubMergeMethod;
  labelKey: string;
  labelFallback: string;
}> = [
  {
    value: 'merge',
    labelKey: 'sessions.prTab.mergeMerge',
    labelFallback: 'Create a merge commit',
  },
  {
    value: 'squash',
    labelKey: 'sessions.prTab.mergeSquash',
    labelFallback: 'Squash and merge',
  },
  {
    value: 'rebase',
    labelKey: 'sessions.prTab.mergeRebase',
    labelFallback: 'Rebase and merge',
  },
];

function mergeMethodShortLabel(method: GitHubMergeMethod, t: RelativeTimeT): string {
  if (method === 'squash') return t('sessions.prTab.mergeShortSquash', 'Squash');
  if (method === 'rebase') return t('sessions.prTab.mergeShortRebase', 'Rebase');
  return t('sessions.prTab.mergeShortMerge', 'Merge');
}

interface PrHeaderActionProps {
  pr: GitHubPullRequestDetails;
  mergeMethod?: GitHubMergeMethod;
  isMerging?: boolean;
  isUpdatingState?: boolean;
  isMarkingReady?: boolean;
  isDeletingBranch?: boolean;
  branchExists?: boolean | null;
  onMerge?: (method: GitHubMergeMethod) => void | Promise<void>;
  onSelectMergeMethod?: (method: GitHubMergeMethod) => void;
  onSetState?: (state: 'open' | 'closed') => void | Promise<void>;
  onMarkReadyForReview?: () => void | Promise<void>;
  onDeleteBranch?: () => void | Promise<void>;
  onResolveConflicts?: () => void;
  isResolvingConflicts?: boolean;
  /** Portaled menu class — landing embeds pass portal tokens so menus match the dark demo shell. */
  menuContentClassName?: string;
}

/** The chevron half of a split action: the same variant as the command it belongs to. */
function MoreActionsMenu({
  variant,
  disabled,
  menuContentClassName,
  children,
}: {
  variant: 'primary' | 'secondary';
  disabled: boolean;
  menuContentClassName?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            type="button"
            size="small"
            variant={variant}
            icon
            disabled={disabled}
            aria-label={t('sessions.prTab.moreActions', 'More actions')}
          />
        }
      >
        <ChevronDown {...stylex.props(styles.fill)} />
      </Menu.Trigger>
      <Menu.Content align="end" className={menuContentClassName}>
        {children}
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * The single primary-action control for a PR, rendered in the header top-right.
 * Consolidates merge (with method switch), close, reopen, ready-for-review and
 * delete-branch into one split button so the body never carries an action box.
 * Only an action that moves the PR forward (merge, ready for review) is primary;
 * a disabled or corrective one is secondary.
 */
function PrHeaderActionButton({
  pr,
  mergeMethod = 'merge',
  isMerging,
  isUpdatingState,
  isMarkingReady,
  isDeletingBranch,
  branchExists,
  onMerge,
  onSelectMergeMethod,
  onSetState,
  onMarkReadyForReview,
  onDeleteBranch,
  onResolveConflicts,
  isResolvingConflicts,
  menuContentClassName,
}: PrHeaderActionProps) {
  const { t } = useTranslation();
  const kind = resolveMergeKind(pr);
  const busy = Boolean(isMerging || isUpdatingState || isMarkingReady || isDeletingBranch);
  const canClose = Boolean(onSetState) && !pr.merged && pr.state !== 'closed';
  const canReopen = Boolean(onSetState) && pr.state === 'closed' && !pr.merged;

  const closeItem = canClose ? (
    <Menu.Item
      tone="destructive"
      icon={<GitPullRequestClosed />}
      onClick={() => void onSetState?.('closed')}
    >
      {t('sessions.prTab.closeAction', 'Close pull request')}
    </Menu.Item>
  ) : null;

  // Ready to merge — split button with a method switch + Close.
  if (kind === 'ready' && onMerge) {
    return (
      <div data-pr-merge-action="" {...stylex.props(styles.split)}>
        <Button
          type="button"
          size="small"
          variant="primary"
          onClick={() => void onMerge(mergeMethod)}
          disabled={busy}
        >
          {isMerging ? (
            <Spinner {...stylex.props(styles.glyph14)} />
          ) : (
            <GitMerge {...stylex.props(styles.glyph14)} />
          )}
          {mergeMethodShortLabel(mergeMethod, t)}
        </Button>
        <MoreActionsMenu
          variant="primary"
          disabled={busy}
          menuContentClassName={menuContentClassName}
        >
          <Menu.GroupLabel>
            {t('sessions.prTab.chooseMergeMethod', 'Choose merge method')}
          </Menu.GroupLabel>
          <Menu.RadioGroup
            value={mergeMethod}
            onValueChange={(value) => onSelectMergeMethod?.(value as GitHubMergeMethod)}
          >
            {HEADER_MERGE_METHODS.map((method) => (
              <Menu.RadioItem key={method.value} value={method.value}>
                {t(method.labelKey, method.labelFallback)}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          {closeItem && (
            <>
              <Menu.Separator />
              {closeItem}
            </>
          )}
        </MoreActionsMenu>
      </div>
    );
  }

  // Conflict — the agent-driven "Resolve conflicts" action. Clickable when the
  // owning session offers it (shared 1:1 with the info-bar button, same prompt +
  // pending); a disabled indicator otherwise, with the reason in the body notice.
  if (kind === 'conflict') {
    const resolving = Boolean(isResolvingConflicts);
    const canResolve = Boolean(onResolveConflicts) && !resolving;
    const tip = t(
      'sessions.prTab.mergeConflictBody',
      'This branch has conflicts that must be resolved on GitHub or your local repo before merging.'
    );
    return (
      <div {...stylex.props(styles.split)}>
        <Button
          type="button"
          size="small"
          variant="secondary"
          onClick={canResolve ? onResolveConflicts : undefined}
          disabled={!canResolve}
          title={tip}
        >
          {resolving ? (
            <Spinner {...stylex.props(styles.glyph14)} />
          ) : (
            <AlertCircle {...stylex.props(styles.glyph14)} />
          )}
          {t('sessions.prTab.resolveConflicts', 'Resolve conflicts')}
        </Button>
        {closeItem && (
          <MoreActionsMenu
            variant="secondary"
            disabled={busy}
            menuContentClassName={menuContentClassName}
          >
            {closeItem}
          </MoreActionsMenu>
        )}
      </div>
    );
  }

  // Blocked / still checking — merge disabled, Close via the chevron.
  if ((kind === 'blocked' || kind === 'checking') && onMerge) {
    const tip =
      kind === 'blocked'
        ? t(
            'sessions.prTab.mergeBlocked',
            'Merging is blocked — required reviews, failing checks, or the branch is behind.'
          )
        : t('sessions.prTab.mergeChecking', 'Checking if the branch can be merged…');
    return (
      <div {...stylex.props(styles.split)}>
        <Button type="button" size="small" variant="secondary" disabled title={tip}>
          {kind === 'checking' ? (
            <Spinner {...stylex.props(styles.glyph14)} />
          ) : (
            <GitMerge {...stylex.props(styles.glyph14)} />
          )}
          {mergeMethodShortLabel(mergeMethod, t)}
        </Button>
        {closeItem && (
          <MoreActionsMenu
            variant="secondary"
            disabled={busy}
            menuContentClassName={menuContentClassName}
          >
            {closeItem}
          </MoreActionsMenu>
        )}
      </div>
    );
  }

  // Draft — mark ready for review, Close via the chevron.
  if (kind === 'draft' && onMarkReadyForReview) {
    return (
      <div {...stylex.props(styles.split)}>
        <Button
          type="button"
          size="small"
          variant="primary"
          onClick={() => void onMarkReadyForReview()}
          disabled={busy}
        >
          {isMarkingReady ? (
            <Spinner {...stylex.props(styles.glyph14)} />
          ) : (
            <GitPullRequestArrow {...stylex.props(styles.glyph14)} />
          )}
          {t('sessions.prTab.readyForReview', 'Ready for review')}
        </Button>
        {closeItem && (
          <MoreActionsMenu
            variant="primary"
            disabled={busy}
            menuContentClassName={menuContentClassName}
          >
            {closeItem}
          </MoreActionsMenu>
        )}
      </div>
    );
  }

  // Closed — offer Reopen when allowed.
  if (kind === 'closed' && canReopen) {
    return (
      <Button
        type="button"
        size="small"
        variant="secondary"
        onClick={() => void onSetState?.('open')}
        disabled={busy}
      >
        {isUpdatingState ? (
          <Spinner {...stylex.props(styles.glyph14)} />
        ) : (
          <GitPullRequestArrow {...stylex.props(styles.glyph14)} />
        )}
        {t('sessions.prTab.reopen', 'Reopen')}
      </Button>
    );
  }

  // Merged — only the delete-branch affordance, and only while the branch lives.
  if (kind === 'merged') {
    const canDeleteBranch =
      Boolean(onDeleteBranch) && branchExists === true && pr.headRef !== pr.baseRef;
    if (!canDeleteBranch) return null;
    const label = t('sessions.prTab.deleteBranch', 'Delete branch');
    // A narrow tab keeps the action and drops its label: the icon-only form is
    // a square Button of its own rather than the labelled one squeezed.
    return (
      <>
        <span {...stylex.props(styles.wideOnly)}>
          <Button
            type="button"
            size="small"
            variant="secondary"
            onClick={() => void onDeleteBranch?.()}
            disabled={busy}
            title={label}
          >
            {isDeletingBranch ? (
              <Spinner {...stylex.props(styles.glyph14)} />
            ) : (
              <Trash2 {...stylex.props(styles.glyph14)} />
            )}
            {label}
          </Button>
        </span>
        <span {...stylex.props(styles.narrowOnly)}>
          <Button
            type="button"
            size="small"
            variant="secondary"
            icon
            onClick={() => void onDeleteBranch?.()}
            disabled={busy}
            aria-label={label}
            title={label}
          >
            {isDeletingBranch ? (
              <Spinner {...stylex.props(styles.fill)} />
            ) : (
              <Trash2 {...stylex.props(styles.fill)} />
            )}
          </Button>
        </span>
      </>
    );
  }

  // No merge callback but still closeable (e.g. read-only merge state).
  if (canClose) {
    return (
      <Button
        type="button"
        size="small"
        variant="secondary"
        tone="destructive"
        onClick={() => void onSetState?.('closed')}
        disabled={busy}
      >
        {isUpdatingState ? (
          <Spinner {...stylex.props(styles.glyph14)} />
        ) : (
          <GitPullRequestClosed {...stylex.props(styles.glyph14)} />
        )}
        {t('sessions.prTab.closeAction', 'Close pull request')}
      </Button>
    );
  }

  return null;
}

function PrBodySkeleton() {
  return (
    <div {...stylex.props(styles.skeleton)}>
      <Skeleton width="66%" height={20} />
      <Skeleton width="50%" height={16} />
      <Skeleton shape="block" width="100%" height={96} />
      <Skeleton shape="block" width="100%" height={64} />
    </div>
  );
}

/** Rows the comment box grows to before it starts scrolling. */
const COMPOSER_MAX_ROWS = 11;

function Composer({
  isPending,
  onSubmit,
}: {
  isPending: boolean;
  onSubmit: (body: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = value.trim().length > 0 && !isPending;

  // Grow the textarea with its content up to COMPOSER_MAX_ROWS, then scroll.
  // No manual resize handle — height tracks the text.
  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const computed = window.getComputedStyle(el);
    const lineHeight = parseFloat(computed.lineHeight) || 20;
    const paddingY = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
    const borderY = parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
    const maxHeight = lineHeight * COMPOSER_MAX_ROWS + paddingY + borderY;
    const next = Math.min(el.scrollHeight + borderY, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight + borderY > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    autosize();
  }, [autosize, value]);

  // Re-measure when the width changes. The desktop side panel keeps this tab
  // mounted while collapsed, so the first measure can happen at ~0 width: the
  // wrapped placeholder pins the box at the max height, and without this the
  // stale height survives the panel expanding. Height-only changes come from
  // autosize itself or typing and must not retrigger the observer.
  const lastWidthRef = useRef(-1);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return undefined;
    lastWidthRef.current = el.clientWidth;
    return observeResizeOnAnimationFrame(el, () => {
      if (el.clientWidth === lastWidthRef.current) return;
      lastWidthRef.current = el.clientWidth;
      autosize();
    });
  }, [autosize]);

  const submit = useCallback(async () => {
    const body = value.trim();
    if (!body || isPending) return;
    await onSubmit(body);
    setValue('');
  }, [isPending, onSubmit, value]);

  return (
    <div {...stylex.props(styles.composer)}>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('sessions.prTab.composerPlaceholder', 'Leave a comment')}
        rows={3}
        resize="none"
        disabled={isPending}
      />
      <div {...stylex.props(styles.composerActions)}>
        {/* The header's merge is the view's one primary; a comment is secondary. */}
        <Button
          type="button"
          size="small"
          variant="secondary"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          {isPending && <Spinner {...stylex.props(styles.glyph14)} />}
          {t('sessions.prTab.composerSubmit', 'Comment')}
        </Button>
      </div>
    </div>
  );
}

type MergeKind = 'ready' | 'conflict' | 'checking' | 'blocked' | 'draft' | 'merged' | 'closed';

function resolveMergeKind(pr: GitHubPullRequestDetails): MergeKind {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (isDraftPr(pr)) return 'draft';
  if (isPullRequestMergeabilityPending(pr)) return 'checking';
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return 'conflict';
  if (pr.mergeableState === 'blocked' || pr.mergeableState === 'behind') return 'blocked';
  return 'ready';
}

function BranchRow({ pr }: { pr: GitHubPullRequestDetails }) {
  const { t } = useTranslation();
  const copyLabel = t('sessions.prTab.copyBranch', 'Copy branch name');
  return (
    <div {...stylex.props(styles.branchRow)}>
      <div {...stylex.props(styles.column, styles.branchColumn)}>
        <BranchRefChip
          label={t('sessions.prTab.base', 'Base')}
          value={pr.baseRef}
          copyLabel={copyLabel}
        />
        <BranchRefChip
          label={t('sessions.prTab.head', 'Head')}
          value={pr.headRef}
          copyLabel={copyLabel}
        />
      </div>
    </div>
  );
}

export const PrTabView = memo(function PrTabView({
  repoFullName,
  prNumber,
  state,
  data,
  error,
  isRefreshing,
  isPostingComment,
  checksPermissionError,
  leadingSlot,
  mergeMethod,
  isMerging,
  isUpdatingState,
  isMarkingReady,
  isDeletingBranch,
  branchExists,
  onRefresh,
  onPostComment,
  onGrantChecksPermission,
  onSelectMergeMethod,
  onMerge,
  onSetState,
  onMarkReadyForReview,
  onDeleteBranch,
  onResolveConflicts,
  isResolvingConflicts,
  embedded = false,
  className,
}: PrTabViewProps) {
  const { t } = useTranslation();
  const pr = data?.pullRequest;
  const mergeKind = pr ? resolveMergeKind(pr) : null;
  const conversation = data
    ? buildConversation(data.issueComments, data.reviewThreads, data.reviews)
    : [];
  const badgeMeta: SessionPullRequestMeta = pr
    ? prToBadgeMeta(pr)
    : {
        url: `https://github.com/${repoFullName}/pull/${prNumber}`,
        status: 'open',
      };

  const body = (
    <div {...stylex.props(styles.column, styles.body, embedded && styles.bodyEmbedded)}>
      {state === 'loading' && !pr && <PrBodySkeleton />}

      {state === 'error' && !pr && (
        <div {...stylex.props(styles.notice, styles.noticeDanger)}>
          <AlertCircle {...stylex.props(styles.mark, styles.danger)} />
          <div {...stylex.props(styles.noticeBody)}>
            <p {...stylex.props(styles.noticeTitle, styles.noticeTitleDanger)}>
              {t('sessions.prTab.loadError', 'Failed to load pull request')}
            </p>
            {error && <p {...stylex.props(styles.noticeDetail)}>{error}</p>}
          </div>
          <div {...stylex.props(styles.noticeActions)}>
            {onRefresh && (
              <Button type="button" size="mini" variant="secondary" onClick={onRefresh}>
                {t('sessions.prTab.retry', 'Retry')}
              </Button>
            )}
          </div>
        </div>
      )}

      {pr && (
        <>
          <section {...stylex.props(styles.titleSection, embedded && styles.titleSectionEmbedded)}>
            <h2 {...stylex.props(styles.title, embedded && styles.titleEmbedded)}>
              {pr.title}
              <span {...stylex.props(styles.number, embedded && styles.numberEmbedded)}>
                #{pr.number}
              </span>
            </h2>
            <div {...stylex.props(styles.meta)}>
              <span {...stylex.props(styles.metaGroup)}>
                {pr.user && (
                  <>
                    <UserAvatar
                      user={{ login: pr.user.login, avatarUrl: pr.user.avatarUrl }}
                      size="mini"
                    />
                    <span {...stylex.props(styles.author)}>{pr.user.login}</span>
                  </>
                )}
                <span>
                  {t('sessions.prTab.opened', 'opened {{when}}', {
                    when: formatRelativeTime(pr.createdAt, t),
                  })}
                </span>
                <span aria-hidden>·</span>
                <span>
                  {t('sessions.prTab.commitsSummary', '{{count}} commits', {
                    count: pr.commits,
                  })}
                </span>
              </span>
              <span {...stylex.props(styles.metaStats)}>
                <span {...stylex.props(styles.additions)}>+{pr.additions}</span>
                <span {...stylex.props(styles.deletions)}>-{pr.deletions}</span>
                <span aria-hidden>·</span>
                <span>
                  {t('sessions.prTab.filesChanged', '{{count}} files', {
                    count: pr.changedFiles,
                  })}
                </span>
              </span>
            </div>
            {pr.body ? (
              embedded ? (
                <div {...stylex.props(styles.description, styles.descriptionEmbedded)}>
                  <SessionCommentMarkdown body={pr.body} allowHtml />
                </div>
              ) : (
                <div data-pr-description="" {...stylex.props(styles.description)}>
                  <SessionCommentMarkdown body={pr.body} allowHtml />
                </div>
              )
            ) : (
              <p {...stylex.props(styles.noDescription)}>
                {t('sessions.prTab.noDescription', 'No description provided.')}
              </p>
            )}
          </section>

          {checksPermissionError ? (
            <ChecksPermissionNotice onGrantChecksPermission={onGrantChecksPermission} />
          ) : (
            data && <ChecksSection summary={data.checkRuns} />
          )}

          {(mergeKind === 'conflict' || mergeKind === 'blocked' || mergeKind === 'checking') && (
            <MergeStatusNotice kind={mergeKind} />
          )}

          <section {...stylex.props(styles.sectionStack, embedded && styles.sectionStackEmbedded)}>
            {conversation.length > 0 && (
              <ul {...stylex.props(styles.list, styles.card)}>
                {conversation.map((item, index) => {
                  const row = stylex.props(index > 0 && styles.ruled);
                  if (item.kind === 'issue') {
                    return (
                      <li key={`issue-${item.comment.id}`} {...row}>
                        <IssueCommentItem comment={item.comment} />
                      </li>
                    );
                  }
                  if (item.kind === 'review-thread') {
                    return (
                      <li key={`thread-${item.thread.id}`} {...row}>
                        <ReviewThreadCard thread={item.thread} />
                      </li>
                    );
                  }
                  return (
                    <li key={`review-${item.review.id}`} {...row}>
                      <ReviewSubmissionItem review={item.review} threads={item.threads} />
                    </li>
                  );
                })}
              </ul>
            )}
            {embedded && onPostComment && (
              <Composer
                isPending={Boolean(isPostingComment)}
                onSubmit={(commentBody) => onPostComment(commentBody)}
              />
            )}
          </section>
        </>
      )}
    </div>
  );

  const mergeAction =
    pr != null ? (
      <PrHeaderActionButton
        pr={pr}
        mergeMethod={mergeMethod}
        isMerging={isMerging}
        isUpdatingState={isUpdatingState}
        isMarkingReady={isMarkingReady}
        isDeletingBranch={isDeletingBranch}
        branchExists={branchExists}
        onMerge={onMerge}
        onSelectMergeMethod={onSelectMergeMethod}
        onSetState={onSetState}
        onMarkReadyForReview={onMarkReadyForReview}
        onDeleteBranch={onDeleteBranch}
        onResolveConflicts={onResolveConflicts}
        isResolvingConflicts={isResolvingConflicts}
        menuContentClassName={embedded ? 'lody-app-preview-portal-dark' : undefined}
      />
    ) : null;

  return (
    <div {...withClassName(stylex.props(styles.root), className)}>
      {embedded ? (
        /* Landing: slim bar — badge + merge only (no branch row / github chrome). */
        <div {...stylex.props(styles.embeddedBar)}>
          <div {...stylex.props(styles.embeddedLead)}>
            <PullRequestBadge pr={badgeMeta} size="sm" />
            <span {...stylex.props(styles.embeddedRepo)}>{repoFullName}</span>
          </div>
          <div {...stylex.props(styles.shrink)}>{mergeAction}</div>
        </div>
      ) : (
        <header {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.column, styles.headerRow)}>
            {leadingSlot}
            <PullRequestBadge pr={badgeMeta} size="md" />
            <span {...stylex.props(styles.repoName)}>{repoFullName}</span>
            <div {...stylex.props(styles.headerActions)}>
              {onRefresh && (
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  icon
                  onClick={onRefresh}
                  aria-label={t('sessions.prTab.refresh', 'Refresh')}
                  title={t('sessions.prTab.refresh', 'Refresh')}
                >
                  <Spinner
                    icon={RefreshCcw}
                    spinning={isRefreshing || state === 'loading'}
                    {...stylex.props(styles.fill)}
                  />
                </Button>
              )}
              <Button
                render={
                  <a
                    href={badgeMeta.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
                  />
                }
                variant="ghost"
                size="small"
                icon
                title={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
              >
                <Github {...stylex.props(styles.fill)} />
              </Button>
              {mergeAction}
            </div>
          </div>
        </header>
      )}

      {!embedded && pr && <BranchRow pr={pr} />}

      <ScrollArea data-pr-content-scroll-area="" {...stylex.props(styles.scroll)}>
        {body}
      </ScrollArea>

      {!embedded && onPostComment && (
        <div data-pr-comment-composer="" {...stylex.props(styles.composerDock)}>
          <div {...stylex.props(styles.column)}>
            <Composer
              isPending={Boolean(isPostingComment)}
              onSubmit={(commentBody) => onPostComment(commentBody)}
            />
          </div>
        </div>
      )}
    </div>
  );
});
