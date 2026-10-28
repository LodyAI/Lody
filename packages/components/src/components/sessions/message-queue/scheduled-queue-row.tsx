import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { Menu } from '@lody/ui/menu';
import { Button } from '@lody/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { formatUpcoming } from '../../schedules/schedule-format';
import { queueSurface } from './surface';
import { IconAction } from './message-queue-row';

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
  onCancel,
  divided = true,
}: {
  item: ScheduledQueueItem;
  onOpen?: (item: ScheduledQueueItem) => void;
  onEditTime?: (item: ScheduledQueueItem) => void;
  onCancel?: (item: ScheduledQueueItem) => void;
  divided?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const mobile = useIsMobile();
  const hasActions = !!onOpen || !!onCancel;
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
      {hasActions ? (
        mobile ? (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  icon
                  variant="ghost"
                  aria-label={t('common.more', 'More')}
                  className="size-8 shrink-0"
                >
                  <MoreHorizontal size={16} />
                </Button>
              }
            />
            <Menu.Content align="end" width="compact">
              {onOpen ? (
                <Menu.Item icon={Pencil} onClick={() => onOpen(item)}>
                  {t('common.edit', 'Edit')}
                </Menu.Item>
              ) : null}
              {onCancel ? (
                <Menu.Item
                  icon={Trash2}
                  tone="destructive"
                  onClick={() => {
                    void onCancel(item);
                  }}
                >
                  {t('scheduledMessage.cancel')}
                </Menu.Item>
              ) : null}
            </Menu.Content>
          </Menu.Root>
        ) : (
          <div {...stylex.props(queueSurface.scheduledActions)}>
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
                onClick={() => {
                  void onCancel(item);
                }}
              />
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
