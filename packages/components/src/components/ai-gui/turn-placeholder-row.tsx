import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnIndexRow } from '@/lib/conversation-view';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { estimateTurnHeightPx } from './turn-placeholder-estimate';

/**
 * Stand-in for a turn the `ConversationView` has not hydrated: the role, the
 * sealed summary's opening words and activity counts when the turn carries
 * them, and otherwise a quiet skeleton. Its height is the estimate Virtua
 * measures, so the scrollbar and far jumps land near where the hydrated rows
 * will. It carries no interaction: the stream replaces it under the same key
 * as soon as the turn is in the hydration window.
 */
export const TurnPlaceholderRow = memo(function TurnPlaceholderRow({ row }: { row: TurnIndexRow }) {
  const { t } = useTranslation();
  const summary = row.summary;
  const headText = typeof summary?.headText === 'string' ? summary.headText.trim() : '';
  const commandCount = summary?.activity?.commandCount ?? 0;
  const editFileCount = summary?.activity?.editFileCount ?? 0;
  const roleLabel =
    row.role === 'user'
      ? t('sessions.turnPlaceholder.user', 'You')
      : row.role === 'assistant'
        ? t('sessions.turnPlaceholder.assistant', 'Agent')
        : t('sessions.turnPlaceholder.system', 'System');

  return (
    <ConversationColumn className="py-2 sm:py-3">
      <div
        data-turn-placeholder={row.role}
        aria-busy="true"
        aria-label={t('sessions.turnPlaceholder.loading', 'Loading turn')}
        className="flex flex-col gap-2 text-muted-foreground"
        style={{ minHeight: estimateTurnHeightPx(row) }}
      >
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">{roleLabel}</span>
          {row.timestamp ? (
            <time dateTime={row.timestamp} className="tabular-nums opacity-70">
              {formatPlaceholderTime(row.timestamp)}
            </time>
          ) : null}
        </div>
        {headText ? (
          <p className="line-clamp-3 text-sm leading-relaxed opacity-70">{headText}</p>
        ) : (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <div className="h-3 w-2/3 rounded bg-muted/60" />
            <div className="h-3 w-1/3 rounded bg-muted/40" />
          </div>
        )}
        {commandCount > 0 || editFileCount > 0 ? (
          <div className="flex flex-wrap gap-x-3 text-xs opacity-70">
            {commandCount > 0 ? (
              <span>{t('sessions.toolActivity.commands', { count: commandCount })}</span>
            ) : null}
            {editFileCount > 0 ? (
              <span>{t('sessions.toolActivity.editedFiles', { count: editFileCount })}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </ConversationColumn>
  );
});

/** Hour and minute in the reader's locale; the row is a sketch, not a timestamp surface. */
const formatPlaceholderTime = (timestamp: string): string => {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
