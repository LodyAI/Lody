'use client';

import type { DiffLineAnnotation } from '@pierre/diffs';
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
      className="space-y-2 py-2 px-1 font-sans text-sm text-foreground max-w-full overflow-hidden"
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
          onSendToChat={callbacks.onSendToChat}
          onCancel={onCancelDraft}
        />
      )}
    </div>
  );
}
