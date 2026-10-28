import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
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
  onEditTime,
  divided = true,
}: {
  item: ScheduledQueueItem;
  onOpen?: (item: ScheduledQueueItem) => void;
  onEditTime?: (item: ScheduledQueueItem) => void;
  divided?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const rowProps = stylex.props(queueSurface.scheduledRow);
  const time = formatUpcoming(item.at, item.timeZone, Date.now(), i18n.language);
  return (
    <div
      data-scheduled-row=""
      title={item.title}
      {...rowProps}
      className={cn(rowProps.className, divided && 'border-t border-border/30')}
    >
      <button
        type="button"
        onClick={() => (onEditTime ?? onOpen)?.(item)}
        aria-label={`${time} · ${t('sessions.messageQueue.editScheduledTime', 'Edit scheduled time')}`}
        {...stylex.props(queueSurface.scheduledTimeButton)}
      >
        {time}
      </button>
      <span {...stylex.props(queueSurface.scheduledTitle)}>{item.title}</span>
    </div>
  );
}
