'use client';

import { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@lody/ui/button';
import { Textarea } from '@/ui/textarea';
import { cn } from '@/lib/utils';
import type { CommentAnchor, CommentUser } from './session-comment-types';

interface SessionCommentDraftProps {
  anchor: CommentAnchor;
  currentUser?: CommentUser | null;
  /** Whether a PR is linked to this session */
  prLinked?: boolean;
  onSubmitToGitHub?: (input: { anchor: CommentAnchor; body: string }) => void | Promise<void>;
  onCancel?: () => void;
  className?: string;
}

export function SessionCommentDraft({
  anchor,
  currentUser,
  prLinked = false,
  onSubmitToGitHub,
  onCancel,
  className,
}: SessionCommentDraftProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || isSubmitting) return;

    if (!prLinked || !onSubmitToGitHub) {
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmitToGitHub({ anchor, body: trimmed });
      setBody('');
      onCancel?.();
    } catch {
      // The parent owns user-visible error reporting; keep the draft text intact.
    } finally {
      setIsSubmitting(false);
    }
  }, [anchor, body, isSubmitting, onCancel, onSubmitToGitHub, prLinked]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel?.();
      }
    },
    [handleSubmit, onCancel]
  );

  return (
    <div
      className={cn(
        'rounded-lg border border-primary/30 bg-card shadow-md overflow-hidden',
        className
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        {currentUser && (
          <UserAvatar
            user={{
              id: currentUser.id,
              name: currentUser.name,
              image: currentUser.image,
            }}
            className="h-5 w-5 shrink-0"
          />
        )}
        <span className="text-xs font-medium text-foreground truncate">
          {currentUser?.name ?? t('comments.anonymous', 'Anonymous')}
        </span>
        <Button
          variant="ghost"
          size="mini"
          icon
          className="ml-auto shrink-0"
          disabled={isSubmitting}
          onClick={onCancel}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      <div className="px-3 py-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('comments.placeholder', 'Leave a comment... (Markdown supported)')}
          className="min-h-[64px] text-xs resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          autoFocus
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          {t('comments.githubOnly', 'Posts to GitHub')}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground hidden sm:block">Ctrl+Enter</span>
        <Button
          size="small"
          disabled={!body.trim() || isSubmitting || !prLinked || !onSubmitToGitHub}
          onClick={() => void handleSubmit()}
        >
          {t('comments.comment', 'Comment')}
        </Button>
      </div>
    </div>
  );
}
