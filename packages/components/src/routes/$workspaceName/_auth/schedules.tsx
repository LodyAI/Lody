import { createFileRoute, useParams } from '@tanstack/react-router';
import { SchedulesWorkspace } from '@/components/schedules/schedules-workspace';

// One mount for the list and an open schedule: opening or closing a schedule
// only changes the param, so the side panel can animate in and out instead of
// the whole page remounting.
export const Route = createFileRoute('/$workspaceName/_auth/schedules')({
  component: SchedulesLayout,
});

function SchedulesLayout() {
  const { scheduleId } = useParams({ strict: false }) as { scheduleId?: string };
  return <SchedulesWorkspace scheduleId={scheduleId} />;
}
