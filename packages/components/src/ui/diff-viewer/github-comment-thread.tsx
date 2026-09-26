'use client';

import { useState, useCallback, useMemo } from 'react';
import { Check, ChevronDown, ExternalLink, SendHorizontal } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { CommentReferencePayload } from '@lody/shared';
import { useTranslation } from 'react-i18next';

import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Avatar } from '@lody/ui/avatar';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { withClassName } from '@/lib/stylex';
import type { GitHubReviewThread, GitHubReviewComment } from './session-comment-types';
import { SessionCommentMarkdown } from './session-comment-markdown';
import { useSendToChatState } from '@/components/chat/comment-reference-state';

const MONO = 'var(--font-mono)';
const FOCUS_RING = `0 0 0 ${focus.ringWidth} ${colors.accent}`;
/** Lines of the diff hunk a single-line thread quotes, ending at its line. */
const EXCERPT_LINES = 4;
/** A multi-line thread quotes its range, up to this many lines. */
const EXCERPT_MAX_LINES = 8;

const styles = stylex.create({
  // Beside the code a thread is a card: it floats over the diff it annotates.
  card: {
    overflow: 'hidden',
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  // Inside another card (a PR review) it is a region of that card: a fill, no edge.
  inset: {
    overflow: 'hidden',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3.5%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  root: { color: colors.label },

  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    paddingInlineEnd: space[1.5],
    minHeight: '32px',
  },
  toggle: {
    display: 'flex',
    flexGrow: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: space[1.5],
    margin: 0,
    borderWidth: 0,
    paddingInline: space[3],
    paddingBlock: space[1.5],
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: '0.8em',
    color: colors.secondaryLabel,
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
    borderRadius: radius.small,
    cornerShape: corner.shape,
    boxShadow: { default: 'none', ':focus-visible': `inset ${FOCUS_RING}` },
  },
  chevron: {
    flexShrink: 0,
    width: '12px',
    height: '12px',
    color: colors.tertiaryLabel,
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevronCollapsed: { transform: 'rotate(-90deg)' },
  path: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    fontFamily: MONO,
    color: colors.label,
  },
  // `direction: rtl` keeps the file name visible when the path truncates;
  // this keeps the characters themselves in reading order.
  pathText: { direction: 'ltr', unicodeBidi: 'plaintext' },
  lineNo: { flexShrink: 0, fontFamily: MONO, color: colors.tertiaryLabel },
  count: { flexShrink: 0 },
  // The preview takes only what the path leaves, so the file name survives.
  preview: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.tertiaryLabel,
  },
  glyph: { width: '100%', height: '100%' },
  mirrored: { transform: 'scaleX(-1)' },
  sent: { color: colors.success },

  excerpt: {
    marginInline: space[3],
    marginBottom: space[1],
    paddingBlock: space[1],
    overflowX: 'auto',
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 4%)`,
    fontFamily: MONO,
    fontSize: '0.75em',
    lineHeight: 1.6,
  },
  excerptLine: {
    display: 'block',
    minWidth: 'max-content',
    paddingInline: space[2],
    whiteSpace: 'pre',
    color: colors.secondaryLabel,
  },
  excerptAdded: {
    backgroundColor: 'hsl(var(--github-addition) / 0.1)',
    color: colors.label,
  },
  excerptRemoved: {
    backgroundColor: 'hsl(var(--github-deletion) / 0.1)',
    color: colors.label,
  },

  comments: { display: 'flex', flexDirection: 'column', paddingBottom: space[1] },
  comment: {
    display: 'grid',
    gridTemplateColumns: '20px minmax(0, 1fr)',
    columnGap: space[2],
    paddingInline: space[3],
    paddingBlock: space[1.5],
  },
  commentAvatar: { marginTop: '1px' },
  commentHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[1.5],
    minHeight: '20px',
    minWidth: 0,
  },
  commentAuthor: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
    fontWeight: 500,
    lineHeight: '20px',
  },
  commentTime: { flexShrink: 0, fontSize: '0.8em', color: colors.tertiaryLabel },
  commentLink: {
    display: 'inline-flex',
    alignSelf: 'center',
    flexShrink: 0,
    marginInlineStart: 'auto',
    width: '12px',
    height: '12px',
    borderRadius: radius.mini,
    color: { default: colors.tertiaryLabel, ':hover': colors.label },
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      ':focus-visible': 1,
    },
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': FOCUS_RING },
    transitionProperty: 'opacity, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  commentBody: { minWidth: 0 },

  replyArea: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[3],
    paddingBottom: space[3],
  },
  replyActions: { display: 'flex', alignItems: 'center', gap: space[1.5] },
  hint: {
    display: { default: 'block', '@media (max-width: 640px)': 'none' },
    fontSize: '0.75em',
    color: colors.tertiaryLabel,
  },
  pushEnd: { marginInlineStart: 'auto' },
  replyPrompt: {
    boxSizing: 'border-box',
    display: 'block',
    width: '100%',
    margin: 0,
    borderWidth: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, transparent, ${colors.label} 4%)`,
    },
    boxShadow: {
      default: `inset 0 1px 0 ${colors.separator}`,
      ':focus-visible': `inset ${FOCUS_RING}`,
    },
    fontFamily: 'inherit',
    fontSize: '0.8em',
    color: { default: colors.tertiaryLabel, ':hover': colors.secondaryLabel },
    textAlign: 'start',
    cursor: 'text',
    outlineStyle: 'none',
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
});

type RelativeTimeT = (key: string, fallback: string, opts?: Record<string, unknown>) => string;

/** "5m ago", in the product language. Shared by every GitHub comment surface. */
export function formatGitHubRelativeTime(isoString: string, t: RelativeTimeT): string {
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

/**
 * The lines of a thread's diff hunk the thread is about. GitHub cuts a review
 * comment's hunk at the commented line, so the excerpt is the hunk's tail: the
 * range for a multi-line thread, a few lines of lead-in for a single one.
 */
export function threadHunkExcerpt(thread: GitHubReviewThread): string[] {
  if (thread.subjectType !== 'line' || !thread.diffHunk) return [];
  const lines = thread.diffHunk.split('\n').filter((line) => !line.startsWith('@@'));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const { line, startLine } = thread.anchor;
  const span =
    startLine != null && startLine < line
      ? Math.min(line - startLine + 1, EXCERPT_MAX_LINES)
      : EXCERPT_LINES;
  return lines.slice(-span);
}

// -- GitHubCommentItem --

interface GitHubCommentItemProps {
  comment: GitHubReviewComment;
}

export function GitHubCommentItem({ comment }: GitHubCommentItemProps) {
  const { t } = useTranslation();
  const login = comment.user?.login ?? 'ghost';
  const avatarUrl = comment.user?.avatarUrl;

  return (
    <div {...stylex.props(stylex.defaultMarker(), styles.comment)}>
      <Avatar.Root size="small" {...stylex.props(styles.commentAvatar)}>
        {avatarUrl && <Avatar.Image src={avatarUrl} alt={login} />}
        <Avatar.Fallback>{login.slice(0, 2).toUpperCase()}</Avatar.Fallback>
      </Avatar.Root>
      <div {...stylex.props(styles.commentBody)}>
        <div {...stylex.props(styles.commentHead)}>
          <span {...stylex.props(styles.commentAuthor)}>{login}</span>
          <span {...stylex.props(styles.commentTime)}>
            {formatGitHubRelativeTime(comment.createdAt, t)}
          </span>
          <a
            href={comment.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
            {...stylex.props(styles.commentLink)}
          >
            <ExternalLink {...stylex.props(styles.glyph)} />
          </a>
        </div>
        <SessionCommentMarkdown body={comment.body} allowHtml />
      </div>
    </div>
  );
}

// -- GitHubCommentThread --

interface GitHubCommentThreadProps {
  thread: GitHubReviewThread;
  /**
   * `card` beside the code in a diff; `inset` inside a surface that is already
   * a card, such as a review in the PR tab.
   */
  surface?: 'card' | 'inset';
  /**
   * Name the file and line and quote the code. A thread drawn beside its own
   * line needs neither; one listed away from the diff needs both.
   */
  showAnchor?: boolean;
  onReply?: (input: { githubCommentId: number; body: string }) => void | Promise<void>;
  onSendToChat?: (reference: CommentReferencePayload) => boolean | void;
  commentReferenceKeys?: readonly string[];
  className?: string;
}

function githubSideToLody(side: 'LEFT' | 'RIGHT'): 'additions' | 'deletions' {
  return side === 'RIGHT' ? 'additions' : 'deletions';
}

export function GitHubCommentThread({
  thread,
  surface = 'card',
  showAnchor = false,
  onReply,
  onSendToChat,
  commentReferenceKeys,
  className,
}: GitHubCommentThreadProps) {
  const { t } = useTranslation();
  const [isReplying, setIsReplying] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(thread.outdated);
  const commentCount = thread.comments.length;
  const firstComment = thread.comments[0];
  const excerpt = useMemo(
    () => (showAnchor ? threadHunkExcerpt(thread) : []),
    [showAnchor, thread]
  );

  const chatReference = useMemo<CommentReferencePayload | null>(() => {
    if (!firstComment) return null;
    return {
      source: 'github',
      path: thread.anchor.path,
      lineNumber: thread.anchor.line,
      side: githubSideToLody(thread.anchor.side),
      commentBody: firstComment.body,
      authorName: firstComment.user?.login ?? 'ghost',
      authorImage: firstComment.user?.avatarUrl,
      replies: thread.comments.slice(1).map((c) => ({
        authorName: c.user?.login ?? 'ghost',
        body: c.body,
      })),
      githubThreadId: thread.id,
    };
  }, [firstComment, thread]);

  const { isSentToChat, handleSendToChat } = useSendToChatState(
    chatReference,
    commentReferenceKeys,
    onSendToChat
  );

  const handleSubmitReply = useCallback(async () => {
    const trimmed = replyBody.trim();
    if (!trimmed || !onReply || isSubmittingReply) return;
    setIsSubmittingReply(true);
    try {
      await onReply({ githubCommentId: thread.id, body: trimmed });
      setReplyBody('');
      setIsReplying(false);
    } catch {
      // The parent owns user-visible error reporting; keep the reply text intact.
    } finally {
      setIsSubmittingReply(false);
    }
  }, [isSubmittingReply, onReply, replyBody, thread.id]);

  const handleReplyKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmitReply();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isSubmittingReply) return;
        setIsReplying(false);
        setReplyBody('');
      }
    },
    [handleSubmitReply, isSubmittingReply]
  );

  const countLabel =
    commentCount === 1
      ? t('comments.countOne', '1 comment')
      : t('comments.count', '{{count}} comments', { count: commentCount });
  const hasLine = thread.subjectType === 'line' && thread.anchor.line > 0;
  const sendLabel = t('comments.sendToChat', 'Send to chat');

  return (
    <div
      data-diff-comment-thread-source="github"
      data-diff-comment-thread-id={String(thread.id)}
      {...withClassName(
        stylex.props(styles.root, surface === 'inset' ? styles.inset : styles.card),
        className
      )}
    >
      <div {...stylex.props(styles.header)}>
        <button
          type="button"
          aria-expanded={!isCollapsed}
          onClick={() => setIsCollapsed((v) => !v)}
          {...stylex.props(styles.toggle)}
        >
          <ChevronDown
            aria-hidden
            {...stylex.props(styles.chevron, isCollapsed && styles.chevronCollapsed)}
          />
          {showAnchor ? (
            <>
              <span {...stylex.props(styles.path)} title={thread.anchor.path}>
                <span {...stylex.props(styles.pathText)}>{thread.anchor.path}</span>
              </span>
              {hasLine && <span {...stylex.props(styles.lineNo)}>:{thread.anchor.line}</span>}
            </>
          ) : (
            <span {...stylex.props(styles.count)}>{countLabel}</span>
          )}
          {thread.outdated && <Badge>{t('comments.outdated', 'Outdated')}</Badge>}
          {isCollapsed && firstComment && (
            <span {...stylex.props(styles.preview)}>
              {firstComment.user?.login ?? 'ghost'}: {firstComment.body}
            </span>
          )}
        </button>
        {onSendToChat && (
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            onClick={handleSendToChat}
            title={sendLabel}
            aria-label={sendLabel}
            aria-pressed={isSentToChat}
          >
            {isSentToChat ? (
              <Check {...stylex.props(styles.glyph, styles.sent)} />
            ) : (
              <SendHorizontal {...stylex.props(styles.glyph, styles.mirrored)} />
            )}
          </Button>
        )}
      </div>

      {isCollapsed ? null : (
        <>
          {excerpt.length > 0 && (
            <pre data-thread-excerpt="" {...stylex.props(styles.excerpt)}>
              {excerpt.map((line, index) => (
                <code
                  key={index}
                  {...stylex.props(
                    styles.excerptLine,
                    line.startsWith('+') && styles.excerptAdded,
                    line.startsWith('-') && styles.excerptRemoved
                  )}
                >
                  {line || ' '}
                </code>
              ))}
            </pre>
          )}

          <div {...stylex.props(styles.comments)}>
            {thread.comments.map((comment) => (
              <GitHubCommentItem key={comment.id} comment={comment} />
            ))}
          </div>

          {onReply &&
            (isReplying ? (
              <div {...stylex.props(styles.replyArea)}>
                <Textarea
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  onKeyDown={handleReplyKeyDown}
                  placeholder={t('comments.replyOnGitHub', 'Reply (will be posted to GitHub)...')}
                  rows={2}
                  resize="none"
                  disabled={isSubmittingReply}
                  autoFocus
                />
                <div {...stylex.props(styles.replyActions)}>
                  <span {...stylex.props(styles.hint)}>Ctrl+Enter</span>
                  <span {...stylex.props(styles.pushEnd)} />
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    disabled={isSubmittingReply}
                    onClick={() => {
                      setIsReplying(false);
                      setReplyBody('');
                    }}
                  >
                    {t('comments.cancel', 'Cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="small"
                    variant="primary"
                    disabled={!replyBody.trim() || isSubmittingReply}
                    onClick={() => void handleSubmitReply()}
                  >
                    {t('comments.replyToGitHub', 'Reply on GitHub')}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsReplying(true)}
                {...stylex.props(styles.replyPrompt)}
              >
                {t('comments.writeReply', 'Write a reply...')}
              </button>
            ))}
        </>
      )}
    </div>
  );
}
