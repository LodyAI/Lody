'use client';

import { useState, useCallback, useMemo } from 'react';
import {
  Check,
  ChevronDown,
  ExternalLink,
  Github,
  MessageSquare,
  SendHorizontal,
} from 'lucide-react';
import type { CommentReferencePayload } from '@lody/shared';
import { useTranslation } from 'react-i18next';

import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Button } from '@lody/ui/button';
import { Textarea } from '@/ui/textarea';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import type { GitHubReviewThread, GitHubReviewComment } from './session-comment-types';
import { SessionCommentMarkdown } from './session-comment-markdown';
import { useSendToChatState } from '@/components/chat/comment-reference-state';

// -- GitHubCommentItem --

interface GitHubCommentItemProps {
  comment: GitHubReviewComment;
  className?: string;
}

function formatGitHubTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function GitHubCommentItem({ comment, className }: GitHubCommentItemProps) {
  const login = comment.user?.login ?? 'ghost';
  const avatarUrl = comment.user?.avatarUrl;

  return (
    <div className={cn('group/gh-comment flex gap-2 px-3 py-2', className)}>
      <Avatar className="h-6 w-6 shrink-0 mt-0.5">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={login} />}
        <AvatarFallback className="text-[10px]">{login.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium leading-none text-foreground">{login}</span>
          <span className="shrink-0 text-[11px] leading-none text-muted-foreground">
            {formatGitHubTime(comment.createdAt)}
          </span>
          <a
            href={comment.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 opacity-0 group-hover/gh-comment:opacity-100 transition-opacity"
          >
            <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-foreground" />
          </a>
        </div>
        <div className="mt-0.5">
          <SessionCommentMarkdown body={comment.body} allowHtml />
        </div>
      </div>
    </div>
  );
}

// -- GitHubCommentThread --

interface GitHubCommentThreadProps {
  thread: GitHubReviewThread;
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

  return (
    <div
      data-diff-comment-thread-source="github"
      data-diff-comment-thread-id={String(thread.id)}
      className={cn(
        'rounded-lg border border-border/60 bg-card shadow-xs overflow-hidden',
        className
      )}
    >
      {/* Header — always clickable to toggle collapse */}
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/40 cursor-pointer hover:bg-muted/50"
        onClick={() => setIsCollapsed((v) => !v)}
      >
        {onSendToChat && (
          <Button
            variant="ghost"
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              handleSendToChat();
            }}
            title={t('comments.sendToChat', 'Send to chat')}
            aria-pressed={isSentToChat}
          >
            {isSentToChat ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <SendHorizontal className="h-3 w-3 -scale-x-100" />
            )}
          </Button>
        )}
        <Github className="h-3 w-3 shrink-0 text-muted-foreground" />
        <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">
          {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
        </span>
        {thread.outdated && (
          <Badge variant="outline" className="ml-1 h-4 text-[9px] px-1">
            {t('comments.outdated', 'Outdated')}
          </Badge>
        )}
        {isCollapsed && (
          <span className="truncate text-xs text-muted-foreground ml-1">
            — {firstComment?.body.slice(0, 40)}
            {(firstComment?.body.length ?? 0) > 40 ? '...' : ''}
          </span>
        )}
        <div className="flex-1" />
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            isCollapsed && '-rotate-90'
          )}
        />
      </div>

      {isCollapsed ? null : (
        <>
          {/* Comments */}
          <div className="divide-y divide-border/30">
            {thread.comments.map((comment) => (
              <GitHubCommentItem key={comment.id} comment={comment} />
            ))}
          </div>

          {/* Reply */}
          {onReply && (
            <div className="border-t border-border/40 px-3 py-2">
              {isReplying ? (
                <div className="space-y-1.5">
                  <Textarea
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    onKeyDown={handleReplyKeyDown}
                    placeholder={t('comments.replyOnGitHub', 'Reply (will be posted to GitHub)...')}
                    className="min-h-[48px] text-xs"
                    disabled={isSubmittingReply}
                    autoFocus
                  />
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground hidden sm:block">
                      Ctrl+Enter
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={isSubmittingReply}
                        onClick={() => {
                          setIsReplying(false);
                          setReplyBody('');
                        }}
                      >
                        {t('comments.cancel', 'Cancel')}
                      </Button>
                      <Button
                        size="small"
                        disabled={!replyBody.trim() || isSubmittingReply}
                        onClick={() => void handleSubmitReply()}
                      >
                        <Github className="h-3 w-3" />
                        {t('comments.replyToGitHub', 'Reply on GitHub')}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsReplying(true)}
                  className="w-full text-left text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5"
                >
                  {t('comments.writeReply', 'Write a reply...')}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
