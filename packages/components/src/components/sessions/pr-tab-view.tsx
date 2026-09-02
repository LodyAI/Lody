'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Copy,
  CircleDot,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Github,
  Loader2,
  MessageSquare,
  MinusCircle,
  RefreshCcw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
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

import { cn } from '@/lib/utils';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  derivePrStatusFromDetails,
  isDraftPr,
  isPullRequestMergeabilityPending,
} from '@/lib/github-pr-details-state';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Button } from '@lody/ui/button';
import { ScrollArea } from '@/ui/scroll-area';
import { Skeleton } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';
import { SessionCommentMarkdown } from '@/ui/diff-viewer/session-comment-markdown';
import { GitHubCommentThread } from '@/ui/diff-viewer/github-comment-thread';
import { PullRequestBadge } from '@/components/sessions/pull-request-badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

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
  size = 'md',
}: {
  user: { login: string; avatarUrl: string } | null | undefined;
  size?: 'xs' | 'sm' | 'md';
}) {
  const login = user?.login ?? 'ghost';
  const sizeClass = size === 'xs' ? 'h-4 w-4' : size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';
  const fallbackTextClass =
    size === 'xs' ? 'text-[8px]' : size === 'sm' ? 'text-[10px]' : 'text-[11px]';
  return (
    <Avatar className={cn('shrink-0', sizeClass)}>
      {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt={login} />}
      <AvatarFallback className={fallbackTextClass}>
        {login.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function InlineCopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring'
      )}
      title={label}
      aria-label={label}
    >
      {copied ? (
        <CheckCircle2 className="h-3 w-3 text-status-success" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

function CheckRunIcon({ run }: { run: GitHubCheckRun }) {
  if (run.status !== 'completed') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-status-warning" />;
  }
  if (run.conclusion === 'success' || run.conclusion === 'skipped') {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-success" />;
  }
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-status-danger" />;
  }
  if (run.conclusion === 'cancelled') {
    return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <CircleDashed className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

const CheckRunRow = memo(function CheckRunRow({ run }: { run: GitHubCheckRun }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <CheckRunIcon run={run} />
      <span className="min-w-0 flex-1 truncate" title={run.name}>
        {run.name}
      </span>
      {run.appName && (
        <span className="shrink-0 text-[11px] text-muted-foreground">{run.appName}</span>
      )}
      {run.htmlUrl && (
        <a
          href={run.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={t('sessions.prTab.openCheck', 'Open check on GitHub')}
        >
          <Github className="h-3 w-3" />
        </a>
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
    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-status-warning" />
  ) : summary.conclusion === 'success' ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-status-success" />
  ) : summary.conclusion === 'failure' ? (
    <XCircle className="h-4 w-4 shrink-0 text-status-danger" />
  ) : (
    <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />
  );
  const countLabel =
    summary.total === 1
      ? t('sessions.prTab.checksCountOne', '1 check')
      : t('sessions.prTab.checksCount', '{{count}} checks', { count: summary.total });

  return (
    <section className="overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40',
          open && 'border-b border-border'
        )}
      >
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
          {headerIcon}
          <span className="truncate">{headerLabel}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
          {countLabel}
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-border">
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
    <section className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-xs">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {t('sessions.prTab.checksPermissionTitle', "Can't read CI checks")}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {t(
            'sessions.prTab.checksPermissionBody',
            'The GitHub App installation is missing the Checks read permission. Update it to show CI status here.'
          )}
        </p>
      </div>
      {onGrantChecksPermission && (
        <Button type="button" variant="secondary" size="small" onClick={onGrantChecksPermission}>
          <Github className="h-3 w-3" />
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
      <section className="flex items-start gap-2 rounded-md border border-status-danger/40 bg-status-danger/5 px-3 py-2 text-xs text-foreground">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-danger" />
        <p className="min-w-0 flex-1">
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
      <section className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-xs text-foreground">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
        <p className="min-w-0 flex-1">
          {t(
            'sessions.prTab.mergeBlockedNotice',
            'Merging is blocked until required reviews and checks pass.'
          )}
        </p>
      </section>
    );
  }
  return (
    <section className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      <p className="min-w-0 flex-1">
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
    <article className="group/pr-issue-comment overflow-hidden rounded-md border border-border bg-background">
      <header className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <UserAvatar
          user={comment.user ? { login, avatarUrl: comment.user.avatarUrl } : null}
          size="md"
        />
        <span className="text-sm font-medium leading-none">{login}</span>
        <span className="text-[11px] text-muted-foreground leading-none">
          {t('sessions.prTab.commented', 'commented')} · {formatRelativeTime(comment.createdAt, t)}
        </span>
        <a
          href={comment.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto shrink-0 opacity-0 transition-opacity group-hover/pr-issue-comment:opacity-100"
          aria-label={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
        >
          <Github className="h-3 w-3 text-muted-foreground hover:text-foreground" />
        </a>
      </header>
      <div className="px-3 py-2">
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
  /** When nested inside a review submission card, drop the outer border so the
   *  parent's border + padding provides the frame. */
  nested?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <article
      className={cn('rounded-md border border-border', nested ? 'bg-muted/20' : 'bg-background')}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono" title={thread.anchor.path}>
          {thread.anchor.path}
          <span className="ml-1 text-muted-foreground/70">:{thread.anchor.line}</span>
        </span>
        {thread.outdated && (
          <span className="shrink-0 rounded-sm bg-muted px-1 py-px font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('sessions.prTab.outdated', 'outdated')}
          </span>
        )}
      </header>
      <GitHubCommentThread thread={thread} className="px-1 py-1" />
    </article>
  );
});

function ReviewStateBadge({ state }: { state: GitHubReview['state'] }) {
  const { t } = useTranslation();
  if (state === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-status-success/40 bg-status-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-status-success">
        <CheckCircle2 className="h-3 w-3" />
        {t('sessions.prTab.reviewApproved', 'approved')}
      </span>
    );
  }
  if (state === 'changes_requested') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-status-danger/40 bg-status-danger/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-status-danger">
        <CircleDot className="h-3 w-3" />
        {t('sessions.prTab.reviewChangesRequested', 'changes requested')}
      </span>
    );
  }
  if (state === 'dismissed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <MinusCircle className="h-3 w-3" />
        {t('sessions.prTab.reviewDismissed', 'dismissed')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      <MessageSquare className="h-3 w-3" />
      {t('sessions.prTab.reviewCommented', 'commented')}
    </span>
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
    <article className="group/pr-review overflow-hidden rounded-md border border-border bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <UserAvatar
          user={review.user ? { login, avatarUrl: review.user.avatarUrl } : null}
          size="md"
        />
        <span className="text-sm font-medium leading-none">{login}</span>
        <ReviewStateBadge state={review.state} />
        {when && (
          <span className="text-[11px] leading-none text-muted-foreground">
            {formatRelativeTime(when, t)}
          </span>
        )}
        <a
          href={review.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto shrink-0 opacity-0 transition-opacity group-hover/pr-review:opacity-100"
          aria-label={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
        >
          <Github className="h-3 w-3 text-muted-foreground hover:text-foreground" />
        </a>
      </header>
      {hasBody && (
        <div className="px-3 py-2">
          <SessionCommentMarkdown body={review.body} allowHtml />
        </div>
      )}
      {threads.length > 0 && (
        <ul className={cn('space-y-2 px-3', hasBody ? 'pb-3' : 'py-3')}>
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
  // whose review submission got dropped) render as standalone cards.
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
  descKey: string;
  descFallback: string;
}> = [
  {
    value: 'merge',
    labelKey: 'sessions.prTab.mergeMerge',
    labelFallback: 'Create a merge commit',
    descKey: 'sessions.prTab.mergeMergeDesc',
    descFallback: 'All commits from this branch will be added to the base branch.',
  },
  {
    value: 'squash',
    labelKey: 'sessions.prTab.mergeSquash',
    labelFallback: 'Squash and merge',
    descKey: 'sessions.prTab.mergeSquashDesc',
    descFallback: 'The commits from this branch will be combined into a single commit.',
  },
  {
    value: 'rebase',
    labelKey: 'sessions.prTab.mergeRebase',
    labelFallback: 'Rebase and merge',
    descKey: 'sessions.prTab.mergeRebaseDesc',
    descFallback: 'The commits will be rebased and added to the base branch.',
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

const PR_ACTION_BTN = 'h-7 gap-1.5 px-2.5 text-xs';

/**
 * Filled-green merge button. `--status-success` is authored as a FOREGROUND color
 * (VS Code themes map it to gitDecoration.addedResourceForeground / ansiGreen), so in
 * dark themes it lands bright and white-on-green drops to ~2:1. Dark text on a bright
 * accent is this design system's own dark convention (see `--primary` /
 * `--primary-foreground`), and the split divider has to flip with it.
 */
const PR_MERGE_BTN_GREEN =
  'bg-status-success text-white hover:bg-status-success/90 dark:text-background';
const PR_SPLIT_DIVIDER = 'border-l border-white/25 dark:border-black/25';

/**
 * The single primary-action control for a PR, rendered in the header top-right.
 * Consolidates merge (with method switch), close, reopen, ready-for-review and
 * delete-branch into one split button so the body never carries an action box.
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
  const menuClassName = cn('min-w-[280px]', menuContentClassName);

  const closeItem = canClose ? (
    <DropdownMenuItem
      onClick={() => void onSetState?.('closed')}
      className="gap-2 text-status-danger focus:text-status-danger"
    >
      <GitPullRequestClosed className="h-3.5 w-3.5" />
      {t('sessions.prTab.closeAction', 'Close pull request')}
    </DropdownMenuItem>
  ) : null;

  // Ready to merge — green split button with a method switch + Close.
  if (kind === 'ready' && onMerge) {
    return (
      <div data-pr-merge-action="" className="flex items-stretch overflow-hidden rounded-md">
        <Button
          type="button"
          size="small"
          onClick={() => void onMerge(mergeMethod)}
          disabled={busy}
          className={cn(PR_ACTION_BTN, PR_MERGE_BTN_GREEN)}
        >
          {isMerging ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitMerge className="h-3.5 w-3.5" />
          )}
          {mergeMethodShortLabel(mergeMethod, t)}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="small"
              disabled={busy}
              aria-label={t('sessions.prTab.moreActions', 'More actions')}
              className={cn(PR_MERGE_BTN_GREEN, PR_SPLIT_DIVIDER)}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={menuClassName}>
            <DropdownMenuLabel>
              {t('sessions.prTab.chooseMergeMethod', 'Choose merge method')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={mergeMethod}
              onValueChange={(value) => onSelectMergeMethod?.(value as GitHubMergeMethod)}
            >
              {HEADER_MERGE_METHODS.map((method) => (
                <DropdownMenuRadioItem
                  key={method.value}
                  value={method.value}
                  className="items-start"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {t(method.labelKey, method.labelFallback)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t(method.descKey, method.descFallback)}
                    </span>
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {closeItem && (
              <>
                <DropdownMenuSeparator />
                {closeItem}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
      <div className="flex items-stretch overflow-hidden rounded-md">
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={canResolve ? onResolveConflicts : undefined}
          disabled={!canResolve}
          title={tip}
          className={cn(PR_ACTION_BTN, canClose && '')}
        >
          {resolving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" />
          )}
          {t('sessions.prTab.resolveConflicts', 'Resolve conflicts')}
        </Button>
        {closeItem && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={busy}
                aria-label={t('sessions.prTab.moreActions', 'More actions')}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={menuContentClassName}>
              {closeItem}
            </DropdownMenuContent>
          </DropdownMenu>
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
      <div className="flex items-stretch overflow-hidden rounded-md">
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled
          title={tip}
          className={cn(PR_ACTION_BTN, canClose && '')}
        >
          {kind === 'checking' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitMerge className="h-3.5 w-3.5" />
          )}
          {mergeMethodShortLabel(mergeMethod, t)}
        </Button>
        {closeItem && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={busy}
                aria-label={t('sessions.prTab.moreActions', 'More actions')}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={menuContentClassName}>
              {closeItem}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }

  // Draft — mark ready for review, Close via the chevron.
  if (kind === 'draft' && onMarkReadyForReview) {
    return (
      <div className="flex items-stretch overflow-hidden rounded-md">
        <Button
          type="button"
          size="small"
          onClick={() => void onMarkReadyForReview()}
          disabled={busy}
          className={cn(PR_ACTION_BTN, canClose && '')}
        >
          {isMarkingReady ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitPullRequestArrow className="h-3.5 w-3.5" />
          )}
          {t('sessions.prTab.readyForReview', 'Ready for review')}
        </Button>
        {closeItem && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="small"
                disabled={busy}
                aria-label={t('sessions.prTab.moreActions', 'More actions')}
                className={cn(PR_SPLIT_DIVIDER)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={menuContentClassName}>
              {closeItem}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }

  // Closed — offer Reopen when allowed.
  if (kind === 'closed' && canReopen) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={() => void onSetState?.('open')}
        disabled={busy}
        className={PR_ACTION_BTN}
      >
        {isUpdatingState ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitPullRequestArrow className="h-3.5 w-3.5 text-github-open" />
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
    return (
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={() => void onDeleteBranch?.()}
        disabled={busy}
        className={PR_ACTION_BTN}
      >
        {isDeletingBranch ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
        {t('sessions.prTab.deleteBranch', 'Delete branch')}
      </Button>
    );
  }

  // No merge callback but still closeable (e.g. read-only merge state).
  if (canClose) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={() => void onSetState?.('closed')}
        disabled={busy}
        className={cn(PR_ACTION_BTN, 'text-status-danger')}
      >
        {isUpdatingState ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitPullRequestClosed className="h-3.5 w-3.5" />
        )}
        {t('sessions.prTab.closeAction', 'Close pull request')}
      </Button>
    );
  }

  return null;
}

function PrBodySkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
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
    const styles = window.getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const borderY = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
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
    <div className="space-y-2">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('sessions.prTab.composerPlaceholder', 'Leave a comment')}
        rows={3}
        className="min-h-[72px] resize-none overflow-hidden rounded-md bg-background transition-colors focus-visible:border-ring/70 focus-visible:ring-0"
        disabled={isPending}
      />
      <div className="flex justify-end">
        <Button type="button" size="small" onClick={() => void submit()} disabled={!canSubmit}>
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
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
  return (
    <div className="border-b border-border px-4 py-2">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="uppercase tracking-wide text-muted-foreground/80">
            {t('sessions.prTab.base', 'base')}
          </span>
          <code className="rounded-sm bg-muted px-1 py-px font-mono text-foreground">
            {pr.baseRef}
          </code>
          <InlineCopyButton
            value={pr.baseRef}
            label={t('sessions.prTab.copyBranch', 'Copy branch name')}
          />
        </span>
        <span aria-hidden className="text-muted-foreground/60">
          ←
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="uppercase tracking-wide text-muted-foreground/80">
            {t('sessions.prTab.head', 'head')}
          </span>
          <code className="rounded-sm bg-muted px-1 py-px font-mono text-foreground">
            {pr.headRef}
          </code>
          <InlineCopyButton
            value={pr.headRef}
            label={t('sessions.prTab.copyBranch', 'Copy branch name')}
          />
        </span>
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
    <div
      className={cn(
        'mx-auto w-full max-w-3xl px-4',
        embedded
          ? 'space-y-3.5 px-5 pt-5 pb-5'
          : 'space-y-5 pt-5 pb-[calc(1.25rem+var(--safe-area-bottom))]'
      )}
    >
      {state === 'loading' && !pr && <PrBodySkeleton />}

      {state === 'error' && !pr && (
        <div className="flex items-start gap-2 rounded-md border border-status-danger/40 bg-status-danger/5 px-3 py-2 text-xs text-status-danger">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {t('sessions.prTab.loadError', 'Failed to load pull request')}
            </p>
            {error && <p className="mt-0.5 text-[11px] opacity-80">{error}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onRefresh && (
              <Button type="button" variant="secondary" size="small" onClick={onRefresh}>
                {t('sessions.prTab.retry', 'Retry')}
              </Button>
            )}
          </div>
        </div>
      )}

      {pr && (
        <>
          <section className={cn(embedded ? 'space-y-1' : 'space-y-2.5')}>
            <h2
              className={cn(
                'font-semibold leading-snug text-pretty',
                embedded ? 'text-[0.95rem]' : 'text-lg'
              )}
            >
              {pr.title}
              <span
                className={cn(
                  'ml-2 font-normal text-muted-foreground',
                  embedded ? 'text-sm' : 'text-base'
                )}
              >
                #{pr.number}
              </span>
            </h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              {pr.user && (
                <>
                  <UserAvatar
                    user={{ login: pr.user.login, avatarUrl: pr.user.avatarUrl }}
                    size="xs"
                  />
                  <span className="font-medium text-foreground">{pr.user.login}</span>
                </>
              )}
              <span>
                {t('sessions.prTab.opened', 'opened {{when}}', {
                  when: formatRelativeTime(pr.createdAt, t),
                })}
              </span>
              <span>·</span>
              <span>
                {t('sessions.prTab.commitsSummary', '{{count}} commits', {
                  count: pr.commits,
                })}
              </span>
              <span>·</span>
              <span className="tabular-nums">
                <span className="text-status-success">+{pr.additions}</span>
                {' / '}
                <span className="text-status-danger">-{pr.deletions}</span>
                {' · '}
                {t('sessions.prTab.filesChanged', '{{count}} files', {
                  count: pr.changedFiles,
                })}
              </span>
            </div>
            {pr.body ? (
              embedded ? (
                <div className="mt-1 text-[13px] leading-relaxed text-foreground/90">
                  <SessionCommentMarkdown body={pr.body} allowHtml />
                </div>
              ) : (
                <div
                  data-pr-description=""
                  className="mt-2.5 pr-1 text-sm leading-relaxed text-foreground/90"
                >
                  <SessionCommentMarkdown body={pr.body} allowHtml />
                </div>
              )
            ) : (
              <p className="mt-2.5 text-xs italic text-muted-foreground">
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

          <section className={cn(embedded ? 'space-y-2' : 'space-y-3')}>
            {conversation.length > 0 && (
              <ul className={cn(embedded ? 'space-y-1.5' : 'space-y-2.5')}>
                {conversation.map((item) => {
                  if (item.kind === 'issue') {
                    return (
                      <li key={`issue-${item.comment.id}`}>
                        <IssueCommentItem comment={item.comment} />
                      </li>
                    );
                  }
                  if (item.kind === 'review-thread') {
                    return (
                      <li key={`thread-${item.thread.id}`}>
                        <ReviewThreadCard thread={item.thread} />
                      </li>
                    );
                  }
                  return (
                    <li key={`review-${item.review.id}`}>
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
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
      {embedded ? (
        /* Landing: slim bar — badge + merge only (no branch row / github chrome). */
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-5">
          <div className="flex min-w-0 items-center gap-2">
            <PullRequestBadge pr={badgeMeta} size="sm" />
            <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
              {repoFullName}
            </span>
          </div>
          <div className="shrink-0">{mergeAction}</div>
        </div>
      ) : (
        <header className="flex h-[calc(3.75rem+var(--safe-area-top))] shrink-0 items-center border-b border-border/60 px-4 pt-[var(--safe-area-top)]">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
            {leadingSlot}
            <PullRequestBadge pr={badgeMeta} size="md" />
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {repoFullName}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
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
                  <RefreshCcw
                    className={cn(
                      'h-3.5 w-3.5',
                      (isRefreshing || state === 'loading') && 'animate-spin'
                    )}
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
                title={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
                size="small"
                icon
              >
                <Github className="h-3.5 w-3.5" />
              </Button>
              {mergeAction}
            </div>
          </div>
        </header>
      )}

      {!embedded && pr && <BranchRow pr={pr} />}

      <ScrollArea data-pr-content-scroll-area="" className="min-h-0 flex-1">
        {body}
      </ScrollArea>

      {!embedded && onPostComment && (
        <div
          data-pr-comment-composer=""
          className="shrink-0 border-t border-border/60 bg-background px-4 pt-4 pb-[calc(1rem+var(--safe-area-bottom))]"
        >
          <div className="mx-auto w-full max-w-3xl">
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
