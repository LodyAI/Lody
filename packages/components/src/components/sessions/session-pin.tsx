import { memo, useCallback, useMemo } from 'react';
import { Pin, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import type { SessionHistoryParsed } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { ConversationColumn } from '@/components/shared/conversation-column';

interface SessionPinProps {
  pinnedHistoryId: string | null;
  /** The pinned user turn, hydrated by the caller through the conversation view. */
  pinnedMessage: SessionHistoryParsed | null;
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
  pinnedMessage,
  onUnpin,
  onScrollToMessage,
}: SessionPinProps) {
  const { t } = useTranslation();

  const pinnedEntry = useMemo(() => {
    if (!pinnedHistoryId || !pinnedMessage) return null;
    return pinnedMessage.id === pinnedHistoryId && pinnedMessage.role === 'user'
      ? pinnedMessage
      : null;
  }, [pinnedHistoryId, pinnedMessage]);

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
          className="flex-1 min-w-0 truncate h-auto py-2 px-0 text-sm text-left text-foreground/80 cursor-pointer hover:text-foreground hover:bg-transparent transition-colors justify-start"
          onClick={handleClick}
          title={pinnedText}
        >
          {pinnedText}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 h-6 w-6 text-muted-foreground hover:text-foreground"
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
