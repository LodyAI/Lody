'use client';

import { useState, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';

import { UserAvatar } from '@/components/user-avatar';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { withClassName } from '@/lib/stylex';
import type { CommentAnchor, CommentUser } from './session-comment-types';

const styles = stylex.create({
  // The same card a GitHub thread beside the code is: a draft is a thread-to-be.
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[3],
    overflow: 'hidden',
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    color: colors.label,
  },
  header: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  author: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
    fontWeight: 500,
  },
  destination: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    fontSize: '0.8em',
    color: colors.tertiaryLabel,
  },
  field: { display: 'flex', flexDirection: 'column' },
  footer: { display: 'flex', alignItems: 'center', gap: space[1.5] },
  hint: {
    display: { default: 'block', '@media (max-width: 640px)': 'none' },
    fontSize: '0.75em',
    color: colors.tertiaryLabel,
  },
  pushEnd: { marginInlineStart: 'auto' },
});

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
    <div {...withClassName(stylex.props(styles.card), className)}>
      <div {...stylex.props(styles.header)}>
        {currentUser && (
          <UserAvatar
            user={{
              id: currentUser.id,
              name: currentUser.name,
              image: currentUser.image,
            }}
            size="small"
          />
        )}
        <span {...stylex.props(styles.author)}>
          {currentUser?.name ?? t('comments.anonymous', 'Anonymous')}
        </span>
        <span {...stylex.props(styles.destination)}>
          {t('comments.githubOnly', 'Posts to GitHub')}
        </span>
      </div>

      <div {...stylex.props(styles.field)}>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('comments.placeholder', 'Leave a comment... (Markdown supported)')}
          rows={3}
          resize="none"
          disabled={isSubmitting}
          autoFocus
        />
      </div>

      <div {...stylex.props(styles.footer)}>
        <span {...stylex.props(styles.hint)}>Ctrl+Enter</span>
        <span {...stylex.props(styles.pushEnd)} />
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={isSubmitting}
          onClick={onCancel}
        >
          {t('comments.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          size="small"
          variant="primary"
          disabled={!body.trim() || isSubmitting || !prLinked || !onSubmitToGitHub}
          onClick={() => void handleSubmit()}
        >
          {t('comments.comment', 'Comment')}
        </Button>
      </div>
    </div>
  );
}
