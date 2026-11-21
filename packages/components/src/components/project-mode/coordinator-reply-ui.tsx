import * as stylex from '@stylexjs/stylex';
import type { CoordinatorReplyRef } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Check, ChevronRight, Copy, CornerDownRight, MessageSquareText, Reply, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { writeTextToClipboard } from '@/lib/clipboard';
import { Tooltip } from '@/ui/armed-overlays';

const styles = stylex.create({
  composerBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[1.5],
    paddingInline: space[2],
    marginBottom: space[1.5],
    borderRadius: radius.medium,
    backgroundColor: colors.wellBackground,
    borderLeftWidth: 2,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.accent,
  },
  composerBannerMain: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    flex: 1,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    textAlign: 'left',
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
  },
  composerBannerInteractive: {
    opacity: { default: 1, ':hover': 0.85 },
  },
  composerBannerStatic: {
    cursor: 'default',
  },
  composerBannerIcon: {
    flexShrink: 0,
    color: colors.accent,
  },
  composerBannerAuthor: {
    flexShrink: 0,
    fontWeight: 500,
    color: colors.label,
  },
  composerBannerPreview: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  composerBannerClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 22,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    cursor: 'pointer',
  },

  inlineQuote: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    maxWidth: '100%',
    paddingBlock: 4,
    paddingInline: space[2],
    borderWidth: 0,
    borderLeftWidth: 2,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.accent,
    borderRadius: radius.small,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    textAlign: 'left',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  inlineQuoteStatic: {
    backgroundColor: colors.wellBackground,
    cursor: 'default',
  },
  inlineQuoteAuthor: {
    flexShrink: 0,
    fontWeight: 500,
    color: colors.label,
  },
  inlineQuoteText: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  inlineQuoteChevron: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
  },

  footerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minHeight: 22,
    paddingInline: 2,
  },
  footerRowEnd: {
    justifyContent: 'flex-end',
  },
  hoverGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    opacity: {
      default: 0,
      ':focus-within': 1,
    },
    pointerEvents: {
      default: 'none',
      ':focus-within': 'auto',
    },
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  hoverGroupVisible: {
    opacity: 1,
    pointerEvents: 'auto',
  },
  actionBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingBlock: 0,
    paddingInline: space[1.5],
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
  },
  threadCountPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingBlock: 0,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.accent,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
  },
});

export function CoordinatorComposerReplyBanner({
  reply,
  onClear,
  onOpenThread,
}: {
  reply: CoordinatorReplyRef;
  onClear?: () => void;
  onOpenThread?: (threadRootId: string, previewHint?: string) => void;
}) {
  const { t } = useTranslation();
  const authorLabel =
    reply.author === 'coordinator'
      ? t('projectMode.reply.replyingToCoordinator', 'Replying to coordinator')
      : t('projectMode.reply.replyingToYou', 'Replying to you');

  return (
    <div {...stylex.props(styles.composerBanner)} data-coordinator-reply-banner="">
      <button
        type="button"
        disabled={!onOpenThread}
        onClick={() => onOpenThread?.(reply.threadRootId, reply.previewText)}
        {...stylex.props(
          styles.composerBannerMain,
          onOpenThread ? styles.composerBannerInteractive : styles.composerBannerStatic
        )}
      >
        <CornerDownRight size={13} {...stylex.props(styles.composerBannerIcon)} aria-hidden="true" />
        <span {...stylex.props(styles.composerBannerAuthor)}>{authorLabel}</span>
        {reply.previewText ? (
          <span {...stylex.props(styles.composerBannerPreview)}>{reply.previewText}</span>
        ) : null}
      </button>
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={t('projectMode.reply.clearDraft', 'Cancel reply')}
          title={t('projectMode.reply.clearDraft', 'Cancel reply')}
          {...stylex.props(styles.composerBannerClose)}
        >
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function CoordinatorInlineQuoteChip({
  replyTo,
  onOpenThread,
}: {
  replyTo: CoordinatorReplyRef;
  onOpenThread?: (threadRootId: string, previewHint?: string) => void;
}) {
  const { t } = useTranslation();
  const authorName =
    replyTo.author === 'coordinator'
      ? t('projectMode.reply.quotedCoordinator', 'Coordinator')
      : t('projectMode.reply.quotedYou', 'You');
  const interactive = Boolean(onOpenThread);

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={(event) => {
        event.stopPropagation();
        onOpenThread?.(replyTo.threadRootId, replyTo.previewText);
      }}
      title={interactive ? t('projectMode.reply.openThread', 'Open thread') : undefined}
      data-coordinator-inline-quote=""
      {...stylex.props(styles.inlineQuote, !interactive && styles.inlineQuoteStatic)}
    >
      <CornerDownRight size={12} {...stylex.props(styles.composerBannerIcon)} aria-hidden="true" />
      <span {...stylex.props(styles.inlineQuoteAuthor)}>{authorName}:</span>
      <span {...stylex.props(styles.inlineQuoteText)}>
        {replyTo.previewText || '…'}
      </span>
      {interactive ? (
        <ChevronRight size={12} {...stylex.props(styles.inlineQuoteChevron)} aria-hidden="true" />
      ) : null}
    </button>
  );
}

export function CoordinatorThreadReplyCountPill({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  const label =
    count === 1
      ? t('projectMode.thread.replyCountOne', { count, defaultValue: '{{count}} reply' })
      : t('projectMode.thread.replyCountMany', { count, defaultValue: '{{count}} replies' });
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      data-coordinator-thread-pill=""
      {...stylex.props(styles.threadCountPill)}
    >
      <MessageSquareText size={12} aria-hidden="true" />
      <span>{label}</span>
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  );
}

export function CoordinatorBubbleFooterActions({
  copyText,
  replyCount = 0,
  isHovered = false,
  alwaysRevealActions = false,
  align = 'start',
  onReply,
  onOpenThread,
}: {
  copyText: string;
  replyCount?: number;
  isHovered?: boolean;
  alwaysRevealActions?: boolean;
  align?: 'start' | 'end';
  onReply?: () => void;
  onOpenThread?: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = useCallback(async () => {
    if (!copyText.trim()) return;
    const ok = await writeTextToClipboard(copyText);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  }, [copyText]);

  const hasCopy = copyText.trim().length > 0;
  if (!hasCopy && !onReply && (replyCount <= 0 || !onOpenThread)) {
    return null;
  }

  return (
    <div
      {...stylex.props(styles.footerRow, align === 'end' && styles.footerRowEnd)}
      data-coordinator-bubble-actions=""
    >
      {replyCount > 0 && onOpenThread ? (
        <CoordinatorThreadReplyCountPill count={replyCount} onClick={onOpenThread} />
      ) : null}
      <div
        {...stylex.props(
          styles.hoverGroup,
          (isHovered || alwaysRevealActions || copied) && styles.hoverGroupVisible
        )}
      >
        {hasCopy ? (
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger
                delay={400}
                render={
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCopy();
                    }}
                    aria-label={
                      copied
                        ? t('projectMode.reply.copied', 'Copied')
                        : t('projectMode.reply.copy', 'Copy')
                    }
                    data-coordinator-bubble-copy=""
                    {...stylex.props(styles.actionBtn)}
                  >
                    {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    <span>
                      {copied
                        ? t('projectMode.reply.copied', 'Copied')
                        : t('projectMode.reply.copy', 'Copy')}
                    </span>
                  </button>
                }
              />
              <Tooltip.Content>
                {copied
                  ? t('projectMode.reply.copied', 'Copied')
                  : t('projectMode.reply.copy', 'Copy')}
              </Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
        ) : null}
        {onReply ? (
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger
                delay={400}
                render={
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onReply();
                    }}
                    aria-label={t('projectMode.reply.action', 'Reply')}
                    data-coordinator-bubble-reply=""
                    {...stylex.props(styles.actionBtn)}
                  >
                    <Reply size={12} aria-hidden="true" />
                    <span>{t('projectMode.reply.action', 'Reply')}</span>
                  </button>
                }
              />
              <Tooltip.Content>{t('projectMode.reply.action', 'Reply')}</Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
        ) : null}
      </div>
    </div>
  );
}
