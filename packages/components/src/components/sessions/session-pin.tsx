import { memo, useCallback, useMemo } from 'react';
import { Pin, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import type { SessionHistoryParsed } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { ConversationColumn } from '@/components/shared/conversation-column';

interface SessionPinProps {
  pinnedHistoryId: string | null;
  history: SessionHistoryParsed[];
  onUnpin: () => void;
  onScrollToMessage?: (historyId: string) => void;
}

/** Extract plain text from a parsed history entry's items. */
function getTextFromHistory(entry: SessionHistoryParsed): string {
  return entry.items
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join(' ')
    .trim();
}

/**
 * Static pin banner below the tab bar.
 * Only rendered when user has explicitly pinned a message.
 */
export const SessionPin = memo(function SessionPin({
  pinnedHistoryId,
  history,
  onUnpin,
  onScrollToMessage,
}: SessionPinProps) {
  const { t } = useTranslation();

  const pinnedEntry = useMemo(() => {
    if (!pinnedHistoryId) return null;
    return history.find((h) => h.id === pinnedHistoryId && h.role === 'user') ?? null;
  }, [pinnedHistoryId, history]);

  const pinnedText = useMemo(() => {
    if (!pinnedEntry) return '';
    return getTextFromHistory(pinnedEntry);
  }, [pinnedEntry]);

  const handleClick = useCallback(() => {
    if (pinnedEntry && onScrollToMessage) {
      onScrollToMessage(pinnedEntry.id);
    }
  }, [pinnedEntry, onScrollToMessage]);

  if (!pinnedEntry || !pinnedText) {
    return null;
  }

  return (
    <div className={cn('relative z-10 w-full', 'border-b border-border/50', 'bg-muted/20')}>
      <ConversationColumn className="flex items-center gap-2">
        <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Button
          type="button"
          variant="ghost"
          className="flex-1 min-w-0 truncate text-left cursor-pointer justify-start"
          onClick={handleClick}
          title={pinnedText}
        >
          {pinnedText}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          className="shrink-0"
          onClick={onUnpin}
          aria-label={t('sessions.pin.unpin', 'Unpin message')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </ConversationColumn>
    </div>
  );
});

SessionPin.displayName = 'SessionPin';
