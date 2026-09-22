import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, MessageSquareReply } from 'lucide-react';
import type { SessionId } from '@lody/shared';

import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { useOperationTargetTitle } from './created-session-operation-card';
import { MarkdownRenderer } from './markdown-renderer';

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
    <p className="truncate text-xs leading-5 text-destructive" title={props.error}>
      {props.error}
    </p>
  ) : reply ? (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={t('sessions.operationReply.expand', 'View full reply')}
      className={cn(
        'block w-full min-w-0 truncate rounded-sm text-left text-xs leading-5 text-muted-foreground',
        'transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40'
      )}
    >
      {opening || reply}
    </button>
  ) : null;

  return (
    <div
      data-operation-reply-card={props.status}
      className="flex min-w-0 items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2"
    >
      <MessageSquareReply
        className={cn('h-4 w-4 shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={cn(
              'shrink-0 text-xs',
              failed ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {label}
          </span>
          <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground/60">
            ·
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-foreground" title={title}>
            {title}
          </span>
        </div>
        {secondLine}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="small"
        className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        disabled={!navigate}
        onClick={navigate}
      >
        {viewSessionLabel}
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>

      {reply ? (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Content className="flex max-h-[80vh] max-w-2xl flex-col gap-0 p-0 sm:p-0">
            <div className="flex min-w-0 items-center gap-3 border-b border-border/60 py-3 pl-5 pr-12">
              <div className="min-w-0 flex-1">
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
                  className="h-7 shrink-0 gap-1 px-2.5 text-xs"
                  onClick={() => {
                    setOpen(false);
                    navigate();
                  }}
                >
                  {viewSessionLabel}
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <div className="min-h-0 overflow-y-auto px-5 py-4 text-sm">
              <MarkdownRenderer text={reply} />
            </div>
          </Dialog.Content>
        </Dialog.Root>
      ) : null}
    </div>
  );
}
