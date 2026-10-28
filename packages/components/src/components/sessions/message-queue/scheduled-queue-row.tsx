import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Clock, Pencil, Trash2, X } from 'lucide-react';
import { Menu } from '@lody/ui/menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { formatUpcoming } from '../../schedules/schedule-format';
import { queueSurface } from './surface';
import { IconAction, MoreTrigger } from './message-queue-row';

export type ScheduledQueueItem = {
  scheduleId: string;
  title: string;
  at: number;
  timeZone: string;
  state: 'pending' | 'failed';
};

/**
 * A reservation is not an executable queue item: no index, drag, steer or
 * reorder. Otherwise it is laid out like a queued row: its send time leads the
 * text inline (and opens the time editor), and actions end the row, folded into
 * More on phones and in a narrow sheet.
 */
export function ScheduledQueueRow({
  item,
  roomy,
  compact,
  onOpen,
  onEditTime,
  onCancel,
}: {
  item: ScheduledQueueItem;
  roomy?: boolean | 'airy';
  compact?: boolean;
  onOpen?: (item: ScheduledQueueItem) => void;
  onEditTime?: (item: ScheduledQueueItem) => void;
  onCancel?: (item: ScheduledQueueItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const mobile = useIsMobile();
  const failed = item.state === 'failed';
  const upcoming = formatUpcoming(item.at, item.timeZone, Date.now(), i18n.language);
  // It opens the line, so a relative label ("tomorrow 9:00 AM") starts capitalized.
  const time = upcoming.charAt(0).toLocaleUpperCase(i18n.language) + upcoming.slice(1);
  const editTime = onEditTime ?? onOpen;
  const timeLabel = [
    time,
    failed ? t('sessions.messageQueue.scheduledFailed', 'Not sent') : null,
    t('sessions.messageQueue.editScheduledTime', 'Edit scheduled time'),
  ]
    .filter(Boolean)
    .join(' · ');
  const menu = (mobile && roomy) || compact;
  const hasActions = !!onOpen || !!onCancel || (menu && !!onEditTime);

  return (
    <div
      data-scheduled-row=""
      title={item.title}
      {...stylex.props(queueSurface.row, roomy && queueSurface.roomyRow)}
    >
      <span {...stylex.props(roomy && queueSurface.leading)}>
        <span aria-hidden="true" {...stylex.props(queueSurface.gutter)} />
      </span>
      <div
        className={cn(
          'min-w-0 flex-1 overflow-hidden',
          stylex.props(
            queueSurface.text,
            roomy && queueSurface.roomyText,
            roomy && queueSurface.roomyBody
          ).className
        )}
        style={{
          display: '-webkit-box',
          WebkitLineClamp: roomy ? 1 : 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        <button
          type="button"
          aria-label={timeLabel}
          onClick={() => editTime?.(item)}
          {...stylex.props(queueSurface.time, failed && queueSurface.failed)}
        >
          {failed ? <CircleAlert size={12} strokeWidth={2} aria-hidden="true" /> : null}
          {time}
        </button>{' '}
        {item.title}
      </div>
      {hasActions ? (
        <div {...stylex.props(queueSurface.actions, roomy && queueSurface.roomyActions)}>
          {menu ? (
            <Menu.Root>
              <Menu.Trigger render={<MoreTrigger fine={!roomy} />} />
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
          ) : (
            <>
              {onOpen ? (
                <IconAction
                  roomy={roomy}
                  icon={Pencil}
                  label={t('common.edit', 'Edit')}
                  onClick={() => onOpen(item)}
                />
              ) : null}
              {onCancel ? (
                <IconAction
                  roomy={roomy}
                  icon={X}
                  label={t('scheduledMessage.cancel')}
                  destructive
                  onClick={() => onCancel(item)}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
