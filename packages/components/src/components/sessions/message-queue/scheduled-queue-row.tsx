import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Clock, Pencil, Trash2, X } from 'lucide-react';
import { Menu } from '@lody/ui/menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { formatUpcoming } from '../../schedules/schedule-format';
import { queueSurface } from './surface';
import { IconAction, MoreTrigger, ROW_REVEAL_CLASS } from './message-queue-row';

export type ScheduledQueueItem = {
  scheduleId: string;
  title: string;
  at: number;
  timeZone: string;
  state: 'pending' | 'failed';
};

/**
 * A reservation is not an executable queue item: no index, drag, steer or
 * reorder. Its send time is the row's one direct control (it opens the time
 * editor); details and cancellation sit beside it like a queued row's actions.
 */
export function ScheduledQueueRow({
  item,
  onOpen,
  onEditTime,
  onCancel,
}: {
  item: ScheduledQueueItem;
  onOpen?: (item: ScheduledQueueItem) => void;
  onEditTime?: (item: ScheduledQueueItem) => void;
  onCancel?: (item: ScheduledQueueItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const mobile = useIsMobile();
  const failed = item.state === 'failed';
  const upcoming = formatUpcoming(item.at, item.timeZone, Date.now(), i18n.language);
  // Standalone label: "tomorrow 9:00 AM" opens the line, so it starts capitalized.
  const time = upcoming.charAt(0).toLocaleUpperCase(i18n.language) + upcoming.slice(1);
  const editTime = onEditTime ?? onOpen;
  const failedLabel = t('sessions.messageQueue.scheduledFailed', 'Not sent');
  const timeLabel = [
    time,
    failed ? failedLabel : null,
    t('sessions.messageQueue.editScheduledTime', 'Edit scheduled time'),
  ]
    .filter(Boolean)
    .join(' · ');
  const failedMark = failed ? <CircleAlert size={12} strokeWidth={2} aria-hidden="true" /> : null;

  if (mobile) {
    const rowProps = stylex.props(
      queueSurface.row,
      queueSurface.roomyRow,
      queueSurface.roomyScheduledRow
    );
    return (
      <div data-scheduled-row="" title={item.title} {...rowProps}>
        <span aria-hidden="true" {...stylex.props(queueSurface.gutter)} />
        <button
          type="button"
          aria-label={`${item.title} · ${timeLabel}`}
          onClick={() => editTime?.(item)}
          {...stylex.props(queueSurface.stackButton)}
        >
          <span {...stylex.props(queueSurface.stackTitle)}>{item.title}</span>
          <span {...stylex.props(queueSurface.stackTime, failed && queueSurface.failed)}>
            {failedMark}
            {time}
          </span>
        </button>
        {onOpen || onCancel || onEditTime ? (
          <Menu.Root>
            <Menu.Trigger render={<MoreTrigger />} />
            <Menu.Content align="end" width="compact">
              {onEditTime ? (
                <Menu.Item icon={Clock} onClick={() => onEditTime(item)}>
                  {t('sessions.messageQueue.editScheduledTime', 'Edit scheduled time')}
                </Menu.Item>
              ) : null}
              {onOpen ? (
                <Menu.Item icon={Pencil} onClick={() => onOpen(item)}>
                  {t('common.edit', 'Edit')}
                </Menu.Item>
              ) : null}
              {onCancel ? (
                <Menu.Item icon={Trash2} tone="destructive" onClick={() => onCancel(item)}>
                  {t('scheduledMessage.cancel')}
                </Menu.Item>
              ) : null}
            </Menu.Content>
          </Menu.Root>
        ) : null}
      </div>
    );
  }

  const rowProps = stylex.props(queueSurface.row, queueSurface.scheduledRow);
  return (
    <div
      data-scheduled-row=""
      title={item.title}
      {...rowProps}
      className={cn(rowProps.className, 'group/row')}
    >
      <span aria-hidden="true" {...stylex.props(queueSurface.gutter)} />
      <span {...stylex.props(queueSurface.text, queueSurface.scheduledTitle)}>{item.title}</span>
      {onOpen || onCancel ? (
        <div className={cn(stylex.props(queueSurface.actions).className, ROW_REVEAL_CLASS)}>
          {onOpen ? (
            <IconAction
              icon={Pencil}
              label={t('common.edit', 'Edit')}
              onClick={() => onOpen(item)}
            />
          ) : null}
          {onCancel ? (
            <IconAction
              icon={X}
              label={t('scheduledMessage.cancel')}
              destructive
              onClick={() => onCancel(item)}
            />
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => editTime?.(item)}
        aria-label={timeLabel}
        {...stylex.props(queueSurface.timeChip, failed && queueSurface.failed)}
      >
        {failedMark}
        {time}
      </button>
    </div>
  );
}
