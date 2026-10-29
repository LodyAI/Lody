import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, MessageSquareReply } from 'lucide-react';
import type { SessionId } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import type { TokensFromVarGroup } from '@stylexjs/stylex/lib/types/StyleXTypes';

import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { Button } from '@lody/ui/button';
import { button } from '@lody/ui/button/button.tokens.stylex';
import { cn } from '@/lib/utils';
import { messageActionInkTheme } from '../../style/message-action-button.stylex';
import { Dialog } from '@/ui/dialog';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { useOperationTargetTitle } from './created-session-operation-card';
import { MarkdownRenderer } from './markdown-renderer';

// The locked compiler drops cross-file object spreads in createTheme. Keep this
// complete map local so the two private actions inherit every other button token.
const inheritedButtonTokens = {
  heightMini: 'inherit',
  heightSmall: 'inherit',
  heightMedium: 'inherit',
  heightLarge: 'inherit',
  paddingXMini: 'inherit',
  paddingXSmall: 'inherit',
  paddingXMedium: 'inherit',
  paddingXLarge: 'inherit',
  radiusMini: 'inherit',
  radiusSmall: 'inherit',
  radiusMedium: 'inherit',
  textMini: 'inherit',
  text: 'inherit',
  gap: 'inherit',
  iconSize: 'inherit',
  primaryBackground: 'inherit',
  primaryLabel: 'inherit',
  primaryEdge: 'inherit',
  primarySheen: 'inherit',
  secondaryBackground: 'inherit',
  secondaryShadow: 'inherit',
  secondarySheen: 'inherit',
  pressedEdge: 'inherit',
  ghostLabel: 'inherit',
  ghostHover: 'inherit',
  ring: 'inherit',
  ringWidth: 'inherit',
} satisfies Record<keyof TokensFromVarGroup<typeof button>, 'inherit'>;

const navigationLayoutTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  ghostLabel: 'hsl(var(--muted-foreground))',
  gap: 'calc(var(--spacing) * 1)',
  paddingXSmall: 'calc(var(--spacing) * 2)',
});

const dialogNavigationLayoutTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  gap: 'calc(var(--spacing) * 1)',
  paddingXSmall: 'calc(var(--spacing) * 2.5)',
});

const styles = stylex.create({
  errorLine: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[5],
    color: themeColors.destructive,
  },
  replyButton: {
    display: 'block',
    width: '100%',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    borderRadius: themeRadius.sm,
    textAlign: 'left',
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[5],
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    color: {
      default: themeColors.mutedForeground,
      ':hover': themeColors.foreground,
    },
    // The Tailwind ring painted nothing — the app resets every focus ring —
    // and its `box-shadow` erased the app's own focus indicator as well. The
    // button stays as blind as it was.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  card: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[3],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.7)',
    backgroundColor: 'hsl(var(--muted) / 0.25)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
  },
  glyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },
  glyphFailed: { color: themeColors.destructive },
  glyphIdle: { color: themeColors.mutedForeground },
  smallGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  body: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  heading: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'baseline',
    gap: themeSpace[1.5],
  },
  label: {
    flexShrink: 0,
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  labelFailed: { color: themeColors.destructive },
  labelIdle: { color: themeColors.mutedForeground },
  separator: {
    flexShrink: 0,
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: 'hsl(var(--muted-foreground) / 0.6)',
  },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  dialogHeader: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[3],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.6)',
    paddingBlock: themeSpace[3],
    paddingLeft: themeSpace[5],
    paddingRight: themeSpace[12],
  },
  dialogBody: {
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: themeSpace[5],
    paddingBlock: themeSpace[4],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
});

/** One paragraph of Markdown as plain reading text (no heading, list or code marks). */
const toPlainText = (markdown: string): string =>
  markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The reply's opening, as one line of plain text for the card. */
export const replyOpening = (text: string): string =>
  text
    .split(/\n\s*\n/)
    .map(toPlainText)
    .find(Boolean) ?? '';

export type OperationReplyCardProps = {
  sessionId: SessionId;
  fallbackTitle?: string;
  onNavigateSession?: (target: SessionNavigationTarget) => void;
} & (
  | { status: 'succeeded'; reply?: string }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }
  | { status: 'running' }
);

/**
 * A message Operation's outcome as seen by the Session that sent it: a compact
 * two-line card (which Session replied, how its reply opens). The full reply
 * opens in a dialog instead of growing the conversation.
 */
export function OperationReplyCard(props: OperationReplyCardProps) {
  const { sessionId, fallbackTitle, onNavigateSession } = props;
  const { t } = useTranslation();
  const title = useOperationTargetTitle(sessionId, fallbackTitle);
  const [open, setOpen] = useState(false);
  const reply = props.status === 'succeeded' ? props.reply?.trim() : undefined;
  const opening = reply ? replyOpening(reply) : '';
  const failed = props.status === 'failed';

  const label = failed
    ? t('sessions.operationReply.failed', 'Request failed')
    : props.status === 'cancelled'
      ? t('sessions.operationReply.cancelled', 'Request cancelled')
      : props.status === 'running'
        ? t('sessions.operationReply.waiting', 'Waiting for reply')
        : t('sessions.operationReply.received', 'Reply received');
  const navigate = onNavigateSession ? () => onNavigateSession({ sessionId }) : undefined;
  const viewSessionLabel = t('sessions.openedBy.viewSession', 'View session');

  const secondLine = failed ? (
    <p {...stylex.props(styles.errorLine)} title={props.error}>
      {props.error}
    </p>
  ) : reply ? (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={t('sessions.operationReply.expand', 'View full reply')}
      {...stylex.props(styles.replyButton)}
    >
      {opening || reply}
    </button>
  ) : null;

  return (
    <div data-operation-reply-card={props.status} {...stylex.props(styles.card)}>
      <MessageSquareReply
        {...stylex.props(styles.glyph, failed ? styles.glyphFailed : styles.glyphIdle)}
        aria-hidden="true"
      />
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.heading)}>
          <span {...stylex.props(styles.label, failed ? styles.labelFailed : styles.labelIdle)}>
            {label}
          </span>
          <span aria-hidden="true" {...stylex.props(styles.separator)}>
            ·
          </span>
          <span {...stylex.props(styles.title)} title={title}>
            {title}
          </span>
        </div>
        {secondLine}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="small"
        height="calc(var(--spacing) * 7)"
        className={cn(
          stylex.props(navigationLayoutTheme, messageActionInkTheme).className,
          'text-xs'
        )}
        disabled={!navigate}
        onClick={navigate}
      >
        {viewSessionLabel}
        <ArrowUpRight {...stylex.props(styles.smallGlyph)} aria-hidden="true" />
      </Button>

      {reply ? (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Content width="42rem" padding="none" gap="none" className="max-h-[80vh]">
            <div {...stylex.props(styles.dialogHeader)}>
              <div {...stylex.props(styles.body)}>
                <Dialog.Description className="text-xs">
                  {t('sessions.operationReply.received', 'Reply received')}
                </Dialog.Description>
                <Dialog.Title className="truncate text-base font-medium" title={title}>
                  {title}
                </Dialog.Title>
              </div>
              {navigate ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  height="calc(var(--spacing) * 7)"
                  className={cn(stylex.props(dialogNavigationLayoutTheme).className, 'text-xs')}
                  onClick={() => {
                    setOpen(false);
                    navigate();
                  }}
                >
                  {viewSessionLabel}
                  <ArrowUpRight {...stylex.props(styles.smallGlyph)} aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <div {...stylex.props(styles.dialogBody)}>
              <MarkdownRenderer text={reply} />
            </div>
          </Dialog.Content>
        </Dialog.Root>
      ) : null}
    </div>
  );
}
