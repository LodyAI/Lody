'use client';

import type { DiffLineAnnotation } from '@pierre/diffs';
import * as stylex from '@stylexjs/stylex';
import { cn } from '@/lib/utils';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';
import type {
  CommentAnnotationMeta,
  CommentUser,
  GitHubReviewThread,
  DiffCommentSide,
  DiffViewerCommentCallbacks,
} from './session-comment-types';
import { SessionCommentDraft } from './session-comment-draft';
import { GitHubCommentThread } from './github-comment-thread';
import type { DraftState } from './use-session-comments';

const styles = stylex.create({
  annotation: {
    paddingBlock: themeSpace[2],
    paddingInline: themeSpace[1],
    fontFamily:
      'PingFang SC, -apple-system, BlinkMacSystemFont, "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.foreground,
    maxWidth: '100%',
    overflow: 'hidden',
  },
});

interface SessionCommentAnnotationProps {
  annotation: DiffLineAnnotation<CommentAnnotationMeta>;
  currentUser?: CommentUser | null;
  prLinked?: boolean;
  draft: DraftState | null;
  getGitHubThreadsAtLine: (side: DiffCommentSide, lineNumber: number) => GitHubReviewThread[];
  callbacks: DiffViewerCommentCallbacks;
  commentReferenceKeys?: readonly string[];
  onCancelDraft: () => void;
}

export function SessionCommentAnnotation({
  annotation,
  currentUser,
  prLinked,
  draft,
  getGitHubThreadsAtLine,
  callbacks,
  commentReferenceKeys,
  onCancelDraft,
}: SessionCommentAnnotationProps) {
  const { side, lineNumber } = annotation;
  const ghThreads = getGitHubThreadsAtLine(side, lineNumber);
  const isDraft = draft?.anchor.side === side && draft.anchor.lineNumber === lineNumber;

  return (
    <div
      data-diff-comment-line={lineNumber}
      data-diff-comment-side={side}
      className={cn('space-y-2', stylex.props(styles.annotation).className)}
    >
      {ghThreads.map((thread) => (
        <GitHubCommentThread
          key={`gh-${thread.id}`}
          thread={thread}
          onReply={callbacks.onReplyGitHubThread}
          onSendToChat={callbacks.onSendToChat}
          commentReferenceKeys={commentReferenceKeys}
        />
      ))}

      {isDraft && (
        <SessionCommentDraft
          anchor={draft.anchor}
          currentUser={currentUser}
          prLinked={prLinked}
          onSubmitToGitHub={callbacks.onCreateThreadToGitHub}
          onCancel={onCancelDraft}
        />
      )}
    </div>
  );
}
