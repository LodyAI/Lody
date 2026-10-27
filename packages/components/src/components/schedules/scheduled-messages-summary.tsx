import { memo } from 'react';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Clock } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { getDeviceTimeZone } from '@lody/shared';
import { currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { useSchedules } from '@/hooks/use-schedules';
import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import { matchingScheduleRuntime } from './schedule-list';
import { formatInstant } from './schedule-format';

const styles = stylex.create({ row: { paddingBottom: space[2], minWidth: 0 } });

/** A leaf subscription: Registry activity must not rerender the whole conversation. */
export const ScheduledMessagesSummary = memo(function ScheduledMessagesSummary({
  sessionId,
  timeZone,
}: {
  sessionId: string;
  timeZone: string;
}) {
  const registry = useSchedules();
  const allowed = useWorkspaceFeature('schedules');
  const user = useAtomValue(userAtom);
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const rows = registry.rows
    .filter(
      (row) =>
        row.scheduledMessage &&
        row.enabled &&
        row.ownerId === user?.id &&
        row.destination.kind === 'existing_session' &&
        row.destination.sessionId === sessionId &&
        !['sent', 'cancelled'].includes(
          matchingScheduleRuntime(row, registry.runtimes)?.messageState ?? ''
        )
    )
    .sort(
      (a, b) =>
        (a.trigger.kind === 'once' ? Date.parse(a.trigger.at) : Infinity) -
        (b.trigger.kind === 'once' ? Date.parse(b.trigger.at) : Infinity)
    );
  const first = rows[0];
  if (!allowed || !first || !slug) return null;
  return (
    <div {...stylex.props(styles.row)}>
      <Button
        variant="ghost"
        size="small"
        onClick={() =>
          void navigate({
            to: '/$workspaceName/schedules/$scheduleId',
            params: { workspaceName: slug, scheduleId: first.scheduleId },
          })
        }
      >
        <Clock size={14} />
        {matchingScheduleRuntime(first, registry.runtimes)?.messageState === 'failed'
          ? t('scheduledMessage.failed')
          : t('scheduledMessage.pending', { count: rows.length })}
        {first.trigger.kind === 'once'
          ? ` · ${formatInstant(Date.parse(first.trigger.at), getDeviceTimeZone(timeZone), i18n.language)}`
          : ''}
      </Button>
    </div>
  );
});
