import { useTranslation } from 'react-i18next';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { Skeleton } from '@/ui/skeleton';
import { Spinner } from '@/ui/spinner';

/** Alternating user bubble / reply lines, sized like a real exchange. */
const SKELETON_TURNS = [
  { bubble: 'w-2/5', lines: ['w-11/12', 'w-4/5', 'w-3/5'] },
  { bubble: 'w-1/3', lines: ['w-full', 'w-10/12', 'w-2/3', 'w-1/2'] },
  { bubble: 'w-1/2', lines: ['w-11/12', 'w-3/4'] },
] as const;

/**
 * Stands in for a conversation that has messages but nothing cached locally
 * yet. Shape, not text: it reads as "content is on its way" without a status
 * message competing with the header.
 */
export function ConversationSkeleton() {
  const { t } = useTranslation();
  return (
    <ConversationColumn
      className="flex flex-col gap-6 py-2"
      role="status"
      aria-label={t('sessions.contentSync.loadingConversation', 'Loading conversation')}
      data-conversation-skeleton=""
    >
      {SKELETON_TURNS.map((turn, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={index} className="flex flex-col gap-3">
          <Skeleton className={`h-9 self-end rounded-2xl ${turn.bubble}`} />
          <div className="flex flex-col gap-2">
            {turn.lines.map((width, line) => (
              // eslint-disable-next-line react/no-array-index-key
              <Skeleton key={line} className={`h-3.5 ${width}`} />
            ))}
          </div>
        </div>
      ))}
    </ConversationColumn>
  );
}

/**
 * The last row of a cached conversation that is still catching up: newer
 * messages land right here, where a reader following the end is looking.
 */
export function ConversationLoadingNewerRow() {
  const { t } = useTranslation();
  return (
    <ConversationColumn
      className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
      role="status"
      data-conversation-loading-newer=""
    >
      <Spinner className="h-3 w-3" aria-hidden="true" />
      <span>{t('sessions.contentSync.loadingNewer', 'Loading newer messages')}</span>
    </ConversationColumn>
  );
}
