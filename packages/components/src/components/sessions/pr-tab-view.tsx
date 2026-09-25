'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleDot,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Github,
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
import { Button, ButtonGroup } from '@lody/ui/button';
import { ScrollArea } from '@/ui/scroll-area';
import { Skeleton } from '@lody/ui/skeleton';
import { Textarea } from '@lody/ui/textarea';
import { SessionCommentMarkdown } from '@/ui/diff-viewer/session-comment-markdown';
import {
  GitHubCommentThread,
  formatGitHubRelativeTime,
} from '@/ui/diff-viewer/github-comment-thread';
import { PR_STATUS_META, PullRequestBadge } from '@/components/sessions/pull-request-badge';
import { Menu } from '@/ui/menu';

/** The tab's own width, not the window's: the PR tab lives in a resizable side panel. */
const NARROW = '@container pr-tab (width < 420px)';
const TINY = '@container pr-tab (width < 280px)';
const MONO = 'var(--font-mono)';
/** One column, centred, however wide the panel is dragged. */
const COLUMN = '48rem';
/** Where an activity row's text starts: its padding, the 20px avatar and the gap. */
const ENTRY_GUTTER = 'calc(12px + 20px + 8px)';
/** Descriptions taller than this fold behind "Show more". */
const DESCRIPTION_FOLD = '22rem';
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
  headerRow: { display: 'flex', minWidth: 0, alignItems: 'center', gap: space[2] },
  /** Where this PR lives, as a path: the repository, then the number. */
  crumbs: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'baseline',
    gap: space[1],
    fontSize: '0.9em',
    fontVariantNumeric: 'tabular-nums',
  },
  repoName: {
    display: { default: 'block', [TINY]: 'none' },
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  crumbSeparator: { display: { default: 'inline', [TINY]: 'none' }, color: colors.tertiaryLabel },
  crumbNumber: { flexShrink: 0, fontWeight: 500, color: colors.label },
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

  /** The PR's state, then where it goes: `main ← feat/x`. */
  stateLine: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    rowGap: space[1.5],
    columnGap: space[2],
    minWidth: 0,
  },
  statePill: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    height: '22px',
    paddingInline: '8px 9px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    fontSize: '0.8em',
    fontWeight: 500,
    lineHeight: 1,
    whiteSpace: 'nowrap',
  },
  stateOpen: {
    backgroundColor: 'hsl(var(--github-open) / 0.14)',
    color: 'hsl(var(--github-open))',
  },
  stateMerged: {
    backgroundColor: 'hsl(var(--github-merged) / 0.16)',
    color: 'hsl(var(--github-merged))',
  },
  stateClosed: {
    backgroundColor: 'hsl(var(--github-closed) / 0.14)',
    color: 'hsl(var(--github-closed))',
  },
  stateDraft: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 8%)`,
    color: colors.secondaryLabel,
  },
  refs: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1],
  },
  refArrow: { flexShrink: 0, width: '12px', height: '12px', color: colors.tertiaryLabel },
  branchChip: {
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
  /** The base is where it lands, so it reads quieter than the branch it takes. */
  branchChipBase: { color: colors.secondaryLabel },

  scroll: { flexGrow: 1, flexBasis: 0, minHeight: 0 },
  body: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    paddingInline: space[4],
    // The header bar's own lower half is already the space above the title.
    paddingTop: space[1],
    paddingBottom: 'calc(1.25rem + var(--safe-area-bottom))',
  },
  bodyEmbedded: { gap: '14px', paddingInline: '20px', paddingTop: '20px', paddingBottom: '20px' },
  skeleton: { display: 'flex', flexDirection: 'column', gap: space[3] },

  // A document, not a band of chips: the title leads, one line says what state
  // the PR is in and where it goes, one line says who and how much.
  titleSection: { display: 'flex', flexDirection: 'column', gap: space[3] },
  titleSectionEmbedded: { gap: space[2] },
  title: {
    margin: 0,
    fontSize: '1.4em',
    fontWeight: 600,
    lineHeight: 1.3,
    letterSpacing: '-0.012em',
    textWrap: 'pretty',
  },
  titleEmbedded: { fontSize: '1.1em' },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    rowGap: space[1],
    columnGap: space[1.5],
    fontSize: '0.8em',
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  metaDot: { color: colors.tertiaryLabel },
  author: { color: colors.label, fontWeight: 500 },
  additions: { color: colors.success },
  deletions: { color: colors.destructive },
  description: {
    position: 'relative',
    marginTop: space[1],
    paddingInlineEnd: space[1],
    fontSize: '1em',
    lineHeight: 1.625,
    color: colors.label,
  },
  /**
   * A long PR template would push checks and reviews — what the panel is
   * opened for — below the fold, so a tall description is clipped until asked.
   */
  descriptionFolded: {
    maxHeight: DESCRIPTION_FOLD,
    overflow: 'hidden',
    maskImage: 'linear-gradient(to bottom, black calc(100% - 4.5rem), transparent)',
  },
  descriptionToggle: { display: 'flex', marginTop: `calc(-1 * ${space[1]})` },
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
    flexGrow: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: '10px',
    margin: 0,
    borderWidth: 0,
    paddingInline: space[3],
    paddingBlock: '10px',
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
  /** A card without check runs has nothing to expand: same row, no pointer. */
  checksStatic: { cursor: 'default', backgroundColor: 'transparent' },
  mergeRow: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  verdict: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flexGrow: 1,
    minWidth: 0,
  },
  verdictTitle: { fontSize: '0.9em', fontWeight: 500, lineHeight: 1.35 },
  verdictDetail: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    fontSize: '0.8em',
    lineHeight: 1.35,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  merged: { color: 'hsl(var(--github-merged))' },
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
  // A row reads as a sentence — who, did what, when — and what they wrote sits
  // under their name, not under their avatar.
  entry: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  entryHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInline: space[3],
    paddingTop: space[3],
    paddingBottom: space[1.5],
  },
  entrySentence: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[1.5],
    rowGap: '2px',
    minWidth: 0,
  },
  entryAuthor: { fontSize: '0.9em', fontWeight: 500 },
  entryVerb: {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'center',
    gap: space[1],
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  entryMeta: { fontSize: '0.8em', color: colors.tertiaryLabel },
  entryBody: {
    paddingInlineStart: ENTRY_GUTTER,
    paddingInlineEnd: space[3],
    paddingBottom: space[3],
  },
  entryThreads: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    margin: 0,
    paddingInlineStart: ENTRY_GUTTER,
    paddingInlineEnd: space[3],
    paddingTop: 0,
    paddingBottom: space[3],
    listStyle: 'none',
  },
  /** A thread with no review to sit under is its own row. */
  orphanThread: { padding: space[3] },
  revealOnRowHover: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      ':focus-visible': 1,
    },
  },
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

const formatRelativeTime = formatGitHubRelativeTime;

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
function GitHubLink({
  href,
  label,
  pushEnd,
  revealOnHover,
}: {
  href: string;
  label: string;
  pushEnd?: boolean;
  /** Show only while the row is hovered or the link focused. */
  revealOnHover?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      {...stylex.props(
        styles.iconLink,
        pushEnd && styles.pushEnd,
        revealOnHover && styles.revealOnRowHover
      )}
    >
      <Github {...stylex.props(styles.glyph12)} />
    </a>
  );
}

/** A branch name that copies itself; `role` names which end of the PR it is. */
function BranchChip({ role, value }: { role: 'base' | 'head'; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [value]);
  const roleLabel =
    role === 'base' ? t('sessions.prTab.base', 'Base') : t('sessions.prTab.head', 'Head');
  const copyLabel = `${roleLabel} · ${t('sessions.prTab.copyBranch', 'Copy branch name')}`;
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? t('common.copied', 'Copied') : `${roleLabel}: ${value}`}
      aria-label={copied ? t('common.copied', 'Copied') : copyLabel}
      {...stylex.props(styles.branchChip, role === 'base' && styles.branchChipBase)}
    >
      {copied ? t('common.copied', 'Copied') : value}
    </button>
  );
}

const STATE_PILL_STYLES = {
  open: styles.stateOpen,
  merged: styles.stateMerged,
  closed: styles.stateClosed,
  draft: styles.stateDraft,
} as const;

/** The one place the PR's state is a word; everywhere else it is a colour. */
function PrStateLine({ pr }: { pr: GitHubPullRequestDetails }) {
  const { t } = useTranslation();
  const status = derivePrStatusFromDetails(pr);
  const meta = PR_STATUS_META[status] ?? PR_STATUS_META.open;
  const Icon = meta.icon;
  return (
    <div {...stylex.props(styles.stateLine)}>
      <span data-pr-state={status} {...stylex.props(styles.statePill, STATE_PILL_STYLES[status])}>
        <Icon {...stylex.props(styles.glyph12)} strokeWidth={2.25} aria-hidden />
        {t(meta.labelKey, meta.labelFallback)}
      </span>
      <span {...stylex.props(styles.refs)}>
        <BranchChip role="base" value={pr.baseRef} />
        <ArrowLeft {...stylex.props(styles.refArrow)} aria-hidden />
        <BranchChip role="head" value={pr.headRef} />
      </span>
    </div>
  );
}

function PrMetaLine({ pr }: { pr: GitHubPullRequestDetails }) {
  const { t } = useTranslation();
  const dot = (
    <span aria-hidden {...stylex.props(styles.metaDot)}>
      ·
    </span>
  );
  return (
    <div {...stylex.props(styles.meta)}>
      {pr.user && (
        <>
          <UserAvatar user={{ login: pr.user.login, avatarUrl: pr.user.avatarUrl }} size="mini" />
          <span {...stylex.props(styles.author)}>{pr.user.login}</span>
        </>
      )}
      <span>
        {t('sessions.prTab.opened', 'opened {{when}}', {
          when: formatRelativeTime(pr.createdAt, t),
        })}
      </span>
      {dot}
      <span>
        {t('sessions.prTab.commitsSummary', '{{count}} commits', {
          count: pr.commits,
        })}
      </span>
      {dot}
      <span {...stylex.props(styles.additions)}>+{pr.additions}</span>
      <span {...stylex.props(styles.deletions)}>−{pr.deletions}</span>
      {dot}
      <span>
        {t('sessions.prTab.filesChanged', '{{count}} files', {
          count: pr.changedFiles,
        })}
      </span>
    </div>
  );
}

/**
 * The PR body, folded when it is taller than {@link DESCRIPTION_FOLD}. The fold
 * is measured, not guessed from the text: a short body with one big image is tall.
 */
function PrDescription({ body }: { body: string }) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return undefined;
    const measure = () => {
      const limit = parseFloat(window.getComputedStyle(el).fontSize) * 22;
      // Fold only when it hides a meaningful amount, never a line or two.
      setOverflows(el.scrollHeight > limit * 1.25);
    };
    measure();
    return observeResizeOnAnimationFrame(el, measure);
  }, []);

  const folded = overflows && !expanded;
  return (
    <>
      <div
        data-pr-description=""
        {...stylex.props(styles.description, folded && styles.descriptionFolded)}
      >
        <div ref={contentRef}>
          <SessionCommentMarkdown body={body} allowHtml />
        </div>
      </div>
      {overflows && (
        <div {...stylex.props(styles.descriptionToggle)}>
          <Button
            type="button"
            size="mini"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown
              {...stylex.props(styles.glyph12, styles.chevron, expanded && styles.chevronOpen)}
              aria-hidden
            />
            {expanded
              ? t('sessions.prTab.showLess', 'Show less')
              : t('sessions.prTab.showMore', 'Show more')}
          </Button>
        </div>
      )}
    </>
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

function EntryHeader({
  user,
  verb,
  when,
  href,
}: {
  user: { login: string; avatarUrl: string } | null;
  verb: React.ReactNode;
  when: string;
  href: string;
}) {
  const { t } = useTranslation();
  const login = user?.login ?? 'ghost';
  return (
    <header {...stylex.props(styles.entryHeader)}>
      <UserAvatar user={user} size="small" />
      <span {...stylex.props(styles.entrySentence)}>
        <span {...stylex.props(styles.entryAuthor)}>{login}</span>
        {verb}
        {when && <span {...stylex.props(styles.entryMeta)}>{formatRelativeTime(when, t)}</span>}
      </span>
      <GitHubLink
        href={href}
        label={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
        pushEnd
        revealOnHover
      />
    </header>
  );
}

const IssueCommentItem = memo(function IssueCommentItem({
  comment,
}: {
  comment: GitHubIssueComment;
}) {
  const { t } = useTranslation();
  return (
    <article {...stylex.props(stylex.defaultMarker(), styles.entry)}>
      <EntryHeader
        user={
          comment.user ? { login: comment.user.login, avatarUrl: comment.user.avatarUrl } : null
        }
        verb={
          <span {...stylex.props(styles.entryVerb)}>
            {t('sessions.prTab.commented', 'commented')}
          </span>
        }
        when={comment.createdAt}
        href={comment.htmlUrl}
      />
      <div {...stylex.props(styles.entryBody)}>
        <SessionCommentMarkdown body={comment.body} allowHtml />
      </div>
    </article>
  );
});

/** What a review did, as the verb of its row. Only a verdict takes a colour. */
function ReviewVerb({ state }: { state: GitHubReview['state'] }) {
  const { t } = useTranslation();
  if (state === 'approved') {
    return (
      <span {...stylex.props(styles.entryVerb, styles.success)}>
        <CheckCircle2 {...stylex.props(styles.glyph12)} aria-hidden />
        {t('sessions.prTab.reviewApproved', 'approved')}
      </span>
    );
  }
  if (state === 'changes_requested') {
    return (
      <span {...stylex.props(styles.entryVerb, styles.danger)}>
        <CircleDot {...stylex.props(styles.glyph12)} aria-hidden />
        {t('sessions.prTab.reviewChangesRequested', 'requested changes')}
      </span>
    );
  }
  if (state === 'dismissed') {
    return (
      <span {...stylex.props(styles.entryVerb)}>
        {t('sessions.prTab.reviewDismissed', 'dismissed')}
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.entryVerb)}>
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
  const hasBody = review.body.trim().length > 0;
  return (
    <article {...stylex.props(stylex.defaultMarker(), styles.entry)}>
      <EntryHeader
        user={review.user ? { login: review.user.login, avatarUrl: review.user.avatarUrl } : null}
        verb={<ReviewVerb state={review.state} />}
        when={review.submittedAt ?? ''}
        href={review.htmlUrl}
      />
      {hasBody && (
        <div {...stylex.props(styles.entryBody)}>
          <SessionCommentMarkdown body={review.body} allowHtml />
        </div>
      )}
      {threads.length > 0 && (
        <ul {...stylex.props(styles.entryThreads)}>
          {threads.map((thread) => (
            <li key={`thread-${thread.id}`}>
              <GitHubCommentThread thread={thread} surface="inset" showAnchor />
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

interface PrPrimaryActionProps {
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

function isPrBusy(
  p: Pick<
    PrPrimaryActionProps,
    'isMerging' | 'isUpdatingState' | 'isMarkingReady' | 'isDeletingBranch'
  >
): boolean {
  return Boolean(p.isMerging || p.isUpdatingState || p.isMarkingReady || p.isDeletingBranch);
}

/** The checks' say on a merge, as the colour of the merge glyph. */
function mergeGlyphTone(checks: GitHubCheckRunsSummary | null) {
  if (!checks || checks.total === 0) return styles.muted;
  if (checks.status === 'in_progress' || checks.status === 'queued') return styles.warning;
  if (checks.conclusion === 'failure') return styles.danger;
  if (checks.conclusion === 'success') return styles.success;
  return styles.muted;
}

/**
 * The PR's next step, top right, as one quiet joined control: the command and
 * its chevron are segments of one `ButtonGroup`, secondary, so it stands up
 * like every control without being the loudest thing on the page. The merge
 * glyph takes the checks' colour, so the button says whether merging is wise
 * before the card below says why. The chevron carries the merge method and
 * Close — closing is never the next step, so it never gets a button of its own.
 */
function PrPrimaryAction({
  pr,
  checks,
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
}: PrPrimaryActionProps & { checks: GitHubCheckRunsSummary | null }) {
  const { t } = useTranslation();
  const kind = resolveMergeKind(pr);
  const busy = isPrBusy({ isMerging, isUpdatingState, isMarkingReady, isDeletingBranch });
  const canClose = Boolean(onSetState) && !pr.merged && pr.state !== 'closed';

  const closeItem = canClose ? (
    <Menu.Item
      tone="destructive"
      icon={<GitPullRequestClosed />}
      onClick={() => void onSetState?.('closed')}
    >
      {t('sessions.prTab.closeAction', 'Close pull request')}
    </Menu.Item>
  ) : null;

  const chevron = (children: React.ReactNode) => (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            type="button"
            size="small"
            variant="secondary"
            icon
            disabled={busy}
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

  /** A command with, when there is anything to put there, its chevron. */
  const split = (command: React.ReactNode, menu: React.ReactNode, attr?: boolean) =>
    menu ? (
      <ButtonGroup data-pr-merge-action={attr ? '' : undefined}>
        {command}
        {chevron(menu)}
      </ButtonGroup>
    ) : (
      command
    );

  if (kind === 'ready' && onMerge) {
    return split(
      <Button
        type="button"
        size="small"
        variant="secondary"
        onClick={() => void onMerge(mergeMethod)}
        disabled={busy}
      >
        {isMerging ? (
          <Spinner {...stylex.props(styles.glyph14)} />
        ) : (
          <GitMerge {...stylex.props(styles.glyph14, mergeGlyphTone(checks))} />
        )}
        {mergeMethodShortLabel(mergeMethod, t)}
      </Button>,
      <>
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
      </>,
      true
    );
  }

  // Conflict — the agent-driven "Resolve conflicts" action. Clickable when the
  // owning session offers it (shared 1:1 with the info-bar button, same prompt +
  // pending); a disabled indicator otherwise.
  if (kind === 'conflict') {
    const resolving = Boolean(isResolvingConflicts);
    const canResolve = Boolean(onResolveConflicts) && !resolving;
    return split(
      <Button
        type="button"
        size="small"
        variant="secondary"
        onClick={canResolve ? onResolveConflicts : undefined}
        disabled={!canResolve}
        title={t(
          'sessions.prTab.mergeConflictBody',
          'This branch has conflicts that must be resolved on GitHub or your local repo before merging.'
        )}
      >
        {resolving ? (
          <Spinner {...stylex.props(styles.glyph14)} />
        ) : (
          <AlertCircle {...stylex.props(styles.glyph14, styles.danger)} />
        )}
        {t('sessions.prTab.resolveConflicts', 'Resolve conflicts')}
      </Button>,
      closeItem
    );
  }

  // Blocked / still checking — merge stays in place, disabled, so the header
  // keeps its shape while GitHub decides; the card below says why.
  if ((kind === 'blocked' || kind === 'checking') && onMerge) {
    return split(
      <Button
        type="button"
        size="small"
        variant="secondary"
        disabled
        title={
          kind === 'blocked'
            ? t(
                'sessions.prTab.mergeBlocked',
                'Merging is blocked — required reviews, failing checks, or the branch is behind.'
              )
            : t('sessions.prTab.mergeChecking', 'Checking if the branch can be merged…')
        }
      >
        <GitMerge {...stylex.props(styles.glyph14)} />
        {mergeMethodShortLabel(mergeMethod, t)}
      </Button>,
      closeItem
    );
  }

  if (kind === 'draft' && onMarkReadyForReview) {
    return split(
      <Button
        type="button"
        size="small"
        variant="secondary"
        onClick={() => void onMarkReadyForReview()}
        disabled={busy}
      >
        {isMarkingReady ? (
          <Spinner {...stylex.props(styles.glyph14)} />
        ) : (
          <GitPullRequestArrow {...stylex.props(styles.glyph14)} />
        )}
        {t('sessions.prTab.readyForReview', 'Ready for review')}
      </Button>,
      closeItem
    );
  }

  if (kind === 'closed' && onSetState) {
    return (
      <Button
        type="button"
        size="small"
        variant="secondary"
        onClick={() => void onSetState('open')}
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

type Verdict = { mark: React.ReactNode; title: string };

function mergeVerdict(kind: MergeKind, t: RelativeTimeT): Verdict {
  switch (kind) {
    case 'ready':
      return {
        mark: <CheckCircle2 {...stylex.props(styles.glyph16, styles.success)} />,
        title: t('sessions.prTab.verdictReady', 'Ready to merge'),
      };
    case 'conflict':
      return {
        mark: <AlertCircle {...stylex.props(styles.glyph16, styles.danger)} />,
        title: t('sessions.prTab.verdictConflict', 'Conflicts with the base branch'),
      };
    case 'blocked':
      return {
        mark: <ShieldAlert {...stylex.props(styles.glyph16, styles.warning)} />,
        title: t('sessions.prTab.verdictBlocked', 'Merging is blocked'),
      };
    case 'checking':
      return {
        mark: <Spinner {...stylex.props(styles.glyph16, styles.muted)} />,
        title: t('sessions.prTab.mergeChecking', 'Checking if the branch can be merged…'),
      };
    case 'draft':
      return {
        mark: <GitPullRequestDraft {...stylex.props(styles.glyph16, styles.muted)} />,
        title: t('sessions.prTab.verdictDraft', 'Draft — not ready for review'),
      };
    case 'merged':
      return {
        mark: <GitMerge {...stylex.props(styles.glyph16, styles.merged)} />,
        title: t('sessions.prTab.mergedAlready', 'Pull request merged'),
      };
    case 'closed':
      return {
        mark: <GitPullRequestClosed {...stylex.props(styles.glyph16, styles.danger)} />,
        title: t('sessions.prTab.closed', 'Closed without merging'),
      };
  }
  return assertNever(kind);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled merge kind: ${value}`);
}

/**
 * "Can this merge, and what is left?" answered in one place: the verdict and
 * the checks behind it. It replaces a checks card and a separate conflict /
 * blocked notice; the action it allows stays in the header, where it is
 * reachable without scrolling.
 */
function MergeCard({
  pr,
  checks,
}: {
  pr: GitHubPullRequestDetails;
  checks: GitHubCheckRunsSummary | null;
}) {
  const { t } = useTranslation();
  const kind = resolveMergeKind(pr);
  const total = checks?.total ?? 0;
  const running = checks?.status === 'in_progress' || checks?.status === 'queued';
  const failed = !running && checks?.conclusion === 'failure';
  const passed = !running && checks?.conclusion === 'success';
  const base = mergeVerdict(kind, t);
  // GitHub lets a PR merge past checks that are not required; the verdict still
  // says it can merge, but its mark must not be a green tick beside a red line.
  const verdict: Verdict =
    kind === 'ready' && failed
      ? { ...base, mark: <AlertCircle {...stylex.props(styles.glyph16, styles.warning)} /> }
      : kind === 'ready' && running
        ? { ...base, mark: <CircleDashed {...stylex.props(styles.glyph16, styles.muted)} /> }
        : base;
  // Collapse the run list once everything is green — the detail line already
  // says so; expand by default when something needs attention.
  const [open, setOpen] = useState(!passed);

  const countLabel =
    total === 1
      ? t('sessions.prTab.checksCountOne', '1 check')
      : t('sessions.prTab.checksCount', '{{count}} checks', { count: total });
  const detail =
    total === 0
      ? null
      : `${
          running
            ? t('sessions.prTab.checksRunning', 'Checks running')
            : passed
              ? t('sessions.prTab.checksPassed', 'All checks passed')
              : failed
                ? t('sessions.prTab.checksFailed', 'Some checks failed')
                : t('sessions.prTab.checks', 'Checks')
        } · ${countLabel}`;
  const detailMark =
    total === 0 ? null : running ? (
      <Spinner {...stylex.props(styles.glyph12, styles.warning)} />
    ) : passed ? (
      <CheckCircle2 {...stylex.props(styles.glyph12, styles.success)} />
    ) : failed ? (
      <XCircle {...stylex.props(styles.glyph12, styles.danger)} />
    ) : (
      <CircleDashed {...stylex.props(styles.glyph12, styles.muted)} />
    );

  const summary = (
    <>
      {verdict.mark}
      <span {...stylex.props(styles.verdict)}>
        <span {...stylex.props(styles.verdictTitle)}>{verdict.title}</span>
        {detail && (
          <span {...stylex.props(styles.verdictDetail, failed && styles.danger)}>
            {detailMark}
            <span {...stylex.props(styles.truncate)}>{detail}</span>
          </span>
        )}
      </span>
      {total > 0 && (
        <ChevronDown
          {...stylex.props(
            styles.glyph14,
            styles.muted,
            styles.chevron,
            open && styles.chevronOpen
          )}
          aria-hidden
        />
      )}
    </>
  );

  return (
    <section data-pr-merge-card={kind} {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.mergeRow)}>
        {total > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            {...stylex.props(styles.checksToggle)}
          >
            {summary}
          </button>
        ) : (
          <div {...stylex.props(styles.checksToggle, styles.checksStatic)}>{summary}</div>
        )}
      </div>
      {open && total > 0 && checks && (
        <ul {...stylex.props(styles.list)}>
          {checks.runs.map((run) => (
            <CheckRunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
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
  const conversation = data
    ? buildConversation(data.issueComments, data.reviewThreads, data.reviews)
    : [];
  const badgeMeta: SessionPullRequestMeta = pr
    ? prToBadgeMeta(pr)
    : {
        url: `https://github.com/${repoFullName}/pull/${prNumber}`,
        status: 'open',
      };

  const primaryAction =
    pr != null ? (
      <PrPrimaryAction
        pr={pr}
        checks={checksPermissionError ? null : (data?.checkRuns ?? null)}
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
            <h2 {...stylex.props(styles.title, embedded && styles.titleEmbedded)}>{pr.title}</h2>
            <PrStateLine pr={pr} />
            <PrMetaLine pr={pr} />
            {pr.body ? (
              embedded ? (
                <div {...stylex.props(styles.description, styles.descriptionEmbedded)}>
                  <SessionCommentMarkdown body={pr.body} allowHtml />
                </div>
              ) : (
                <PrDescription body={pr.body} />
              )
            ) : (
              <p {...stylex.props(styles.noDescription)}>
                {t('sessions.prTab.noDescription', 'No description provided.')}
              </p>
            )}
          </section>

          {checksPermissionError && (
            <ChecksPermissionNotice onGrantChecksPermission={onGrantChecksPermission} />
          )}

          <MergeCard pr={pr} checks={checksPermissionError ? null : (data?.checkRuns ?? null)} />

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
                        <div {...stylex.props(styles.orphanThread)}>
                          <GitHubCommentThread thread={item.thread} surface="inset" showAnchor />
                        </div>
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

  return (
    <div {...withClassName(stylex.props(styles.root), className)}>
      {embedded ? (
        /* Landing: slim bar — badge + next step only (no github chrome). */
        <div {...stylex.props(styles.embeddedBar)}>
          <div {...stylex.props(styles.embeddedLead)}>
            <PullRequestBadge pr={badgeMeta} size="sm" />
            <span {...stylex.props(styles.embeddedRepo)}>{repoFullName}</span>
          </div>
          <div {...stylex.props(styles.shrink)}>{primaryAction}</div>
        </div>
      ) : (
        <header {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.column, styles.headerRow)}>
            {leadingSlot}
            <span {...stylex.props(styles.crumbs)}>
              <span {...stylex.props(styles.repoName)} title={repoFullName}>
                {repoFullName}
              </span>
              <span aria-hidden {...stylex.props(styles.crumbSeparator)}>
                /
              </span>
              <span {...stylex.props(styles.crumbNumber)}>#{prNumber}</span>
            </span>
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
              {primaryAction}
            </div>
          </div>
        </header>
      )}

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
