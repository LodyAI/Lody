import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatUpcoming } from '../../schedules/schedule-format';
import { queueSurface } from './surface';

export type ScheduledQueueItem = {
  scheduleId: string;
  title: string;
  at: number;
  timeZone: string;
  state: 'pending' | 'failed';
};

/**
 * A reservation is not an executable queue item: no index, drag, steer or
 * reorder. The row is a read-only projection; opening it is the only action.
 */
export function ScheduledQueueRow({
  item,
  onOpen,
  divided = true,
}: {
  item: ScheduledQueueItem;
  onOpen?: (item: ScheduledQueueItem) => void;
  divided?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const rowProps = stylex.props(queueSurface.scheduledRow);
  return (
    <button
      type="button"
      onClick={() => onOpen?.(item)}
      disabled={!onOpen}
      title={item.title}
      {...rowProps}
      className={cn(rowProps.className, divided && 'border-t border-border/30')}
    >
      <Clock size={12} aria-hidden="true" {...stylex.props(queueSurface.scheduledIcon)} />
      <span {...stylex.props(queueSurface.scheduledTime)}>
        {formatUpcoming(item.at, item.timeZone, Date.now(), i18n.language)}
      </span>
      <span {...stylex.props(queueSurface.scheduledTitle)}>{item.title}</span>
      <span
        {...stylex.props(
          queueSurface.scheduledState,
          item.state === 'failed' && queueSurface.scheduledFailed
        )}
      >
        {item.state === 'failed'
          ? t('sessions.messageQueue.scheduledFailed', 'Not sent')
          : t('sessions.messageQueue.scheduledPending', 'Pending')}
      </span>
    </button>
  );
}
