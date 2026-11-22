import * as stylex from '@stylexjs/stylex';
import type { CoordinatorReplyRef } from '@lody/shared';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  Check,
  ChevronRight,
  Copy,
  CornerDownRight,
  MessageSquareText,
  PencilLine,
  Reply,
  X,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

  sidePill: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    height: 28,
    marginTop: 4,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.raised,
    overflow: 'hidden',
    opacity: {
      default: 0,
      ':focus-within': 1,
    },
    pointerEvents: {
      default: 'none',
      ':focus-within': 'auto',
    },
    transitionProperty: 'opacity, transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  sidePillVisible: {
    opacity: 1,
    pointerEvents: 'auto',
  },
  sideCellBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: '100%',
    padding: 0,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  sideCellCopied: {
    color: colors.success,
  },
  sideDivider: {
    width: 1,
    height: 14,
    flexShrink: 0,
    backgroundColor: colors.separator,
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
      <span {...stylex.props(styles.inlineQuoteText)}>{replyTo.previewText || '…'}</span>
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

/**
 * Feishu-style compact segmented action toolbar floating beside a chat bubble on
 * hover, occupying zero vertical height underneath the message.
 */
export function CoordinatorBubbleSideActions({
  copyText,
  isHovered = false,
  alwaysRevealActions = false,
  onEdit,
  onReply,
}: {
  copyText: string;
  isHovered?: boolean;
  alwaysRevealActions?: boolean;
  onEdit?: () => void;
  onReply?: () => void;
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
  const items: Array<{
    key: string;
    label: string;
    dataAttr: Record<string, string>;
    isCopied?: boolean;
    icon: ReactNode;
    onClick: () => void;
  }> = [];

  if (onEdit) {
    items.push({
      key: 'edit',
      label: t('sessions.editMessage', 'Edit message'),
      dataAttr: { 'data-coordinator-bubble-edit': '' },
      icon: <PencilLine size={13.5} aria-hidden="true" />,
      onClick: onEdit,
    });
  }
  if (hasCopy) {
    const copyLabel = copied
      ? t('projectMode.reply.copied', 'Copied')
      : t('projectMode.reply.copy', 'Copy');
    items.push({
      key: 'copy',
      label: copyLabel,
      dataAttr: { 'data-coordinator-bubble-copy': '' },
      isCopied: copied,
      icon: copied ? (
        <Check size={13.5} aria-hidden="true" />
      ) : (
        <Copy size={13.5} aria-hidden="true" />
      ),
      onClick: () => {
        void handleCopy();
      },
    });
  }
  if (onReply) {
    const replyLabel = t('projectMode.reply.action', 'Reply');
    items.push({
      key: 'reply',
      label: replyLabel,
      dataAttr: {
        'data-coordinator-bubble-reply': '',
        'data-user-message-reply': '',
      },
      icon: <Reply size={13.5} aria-hidden="true" />,
      onClick: onReply,
    });
  }

  if (items.length === 0) return null;

  return (
    <div
      {...stylex.props(
        styles.sidePill,
        (isHovered || alwaysRevealActions || copied) && styles.sidePillVisible
      )}
      data-coordinator-bubble-actions=""
    >
      {items.map((item, idx) => (
        <Fragment key={item.key}>
          {idx > 0 ? <span {...stylex.props(styles.sideDivider)} aria-hidden="true" /> : null}
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger
                delay={300}
                render={
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      item.onClick();
                    }}
                    aria-label={item.label}
                    {...item.dataAttr}
                    {...stylex.props(styles.sideCellBtn, item.isCopied && styles.sideCellCopied)}
                  >
                    {item.icon}
                  </button>
                }
              />
              <Tooltip.Content>{item.label}</Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
        </Fragment>
      ))}
    </div>
  );
}
