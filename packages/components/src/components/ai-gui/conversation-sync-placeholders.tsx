import { useTranslation } from 'react-i18next';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { Skeleton } from '@lody/ui/skeleton';

/** Alternating user bubble / reply lines, sized like a real exchange. */
const SKELETON_TURNS = [
  { bubble: '40%', lines: ['92%', '80%', '60%'] },
  { bubble: '33%', lines: ['100%', '83%', '67%', '50%'] },
  { bubble: '50%', lines: ['92%', '75%'] },
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
          <Skeleton shape="block" width={turn.bubble} height={36} className="self-end" />
          <div className="flex flex-col gap-2">
            {turn.lines.map((width, line) => (
              // eslint-disable-next-line react/no-array-index-key
              <Skeleton key={line} width={width} height={14} />
            ))}
          </div>
        </div>
      ))}
    </ConversationColumn>
  );
}
