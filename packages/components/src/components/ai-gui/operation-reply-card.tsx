import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ChevronDown, MessageSquareReply } from 'lucide-react';
import type { SessionId } from '@lody/shared';

import type { SessionNavigationTarget } from '@/lib/session-navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { useOperationTargetTitle } from './created-session-operation-card';
import { MarkdownRenderer } from './markdown-renderer';

/** Characters kept from each end of a reply in the collapsed excerpt. */
const EXCERPT_EDGE_CHARS = 150;

/** One paragraph of Markdown as plain reading text (no heading, list or code marks). */
const toPlainText = (markdown: string): string =>
  markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Collapsed view of a reply: its opening and its conclusion, as plain text.
 * Short edge paragraphs are kept whole (a reply usually opens with its plan
 * and closes with its result); long ones are cut to `EXCERPT_EDGE_CHARS`.
 */
export const excerptReply = (text: string): { head: string; tail: string } | { full: string } => {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(toPlainText)
    .filter(Boolean);
  const whole = paragraphs.join(' ');
  // Only a reply that fits the excerpt's own footprint (about two lines) is
  // shown whole; anything longer gets its two ends and an expand affordance.
  if (whole.length <= EXCERPT_EDGE_CHARS) return { full: whole };
  const first = paragraphs[0] ?? whole;
  const last = paragraphs.at(-1) ?? whole;
  const head =
    first.length <= EXCERPT_EDGE_CHARS * 1.5 ? first : `${first.slice(0, EXCERPT_EDGE_CHARS)}…`;
  const tail =
    last.length <= EXCERPT_EDGE_CHARS * 1.5 ? last : `…${last.slice(-EXCERPT_EDGE_CHARS)}`;
  return { head, tail };
};

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
 * A message Operation's outcome as seen by the Session that sent it: the target
 * Session replied, here is the gist, and the full reply is one click away.
 */
export function OperationReplyCard(props: OperationReplyCardProps) {
  const { sessionId, fallbackTitle, onNavigateSession } = props;
  const { t } = useTranslation();
  const title = useOperationTargetTitle(sessionId, fallbackTitle);
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const reply = props.status === 'succeeded' ? props.reply?.trim() : undefined;
  const excerpt = reply ? excerptReply(reply) : null;
  const canExpand = Boolean(excerpt && 'head' in excerpt);

  const label =
    props.status === 'failed'
      ? t('sessions.operationReply.failed', 'Request failed')
      : props.status === 'cancelled'
        ? t('sessions.operationReply.cancelled', 'Request cancelled')
        : props.status === 'running'
          ? t('sessions.operationReply.waiting', 'Waiting for reply')
          : t('sessions.operationReply.received', 'Reply received');

  return (
    <div
      data-operation-reply-card={props.status}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-muted/25"
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <MessageSquareReply
          className={cn(
            'h-4 w-4 shrink-0',
            props.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'text-xs leading-4',
              props.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {label}
          </div>
          <div className="truncate text-sm font-medium text-foreground" title={title}>
            {title}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={!onNavigateSession}
          onClick={onNavigateSession ? () => onNavigateSession({ sessionId }) : undefined}
        >
          {t('sessions.openedBy.viewSession', 'View session')}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>

      {props.status === 'failed' ? (
        <p className="border-t border-border/60 px-3 py-2 pl-10 text-xs leading-5 break-words text-destructive">
          {props.error}
        </p>
      ) : null}

      {excerpt ? (
        canExpand ? (
          <div className="border-t border-border/60">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((value) => !value)}
              className={cn(
                'group flex w-full flex-col gap-1 px-3 py-2 pl-10 text-left',
                'transition-colors hover:bg-foreground/[0.03] focus-visible:outline-hidden focus-visible:bg-foreground/[0.03]'
              )}
            >
              {expanded ? null : (
                <span className="flex flex-col gap-1 text-xs leading-5 text-muted-foreground">
                  <span className="line-clamp-2 break-words">
                    {'head' in excerpt ? excerpt.head : ''}
                  </span>
                  <span aria-hidden="true" className="leading-none text-muted-foreground/60">
                    ⋯
                  </span>
                  <span className="line-clamp-2 break-words">
                    {'tail' in excerpt ? excerpt.tail : ''}
                  </span>
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground group-hover:text-foreground">
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 transition-transform duration-150',
                    expanded && 'rotate-180'
                  )}
                  aria-hidden="true"
                />
                {expanded
                  ? t('sessions.operationReply.collapse', 'Show less')
                  : t('sessions.operationReply.expand', 'Show full reply')}
              </span>
            </button>
            {expanded ? (
              <div id={bodyId} className="px-3 pb-3 pl-10 text-sm">
                <MarkdownRenderer text={reply!} />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="border-t border-border/60 px-3 py-2 pl-10 text-xs leading-5 break-words text-muted-foreground">
            {'full' in excerpt ? excerpt.full : ''}
          </p>
        )
      ) : null}
    </div>
  );
}
