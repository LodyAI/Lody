import { createFileRoute } from '@tanstack/react-router';
import { SchedulesWorkspace } from '@/components/schedules/schedules-workspace';
export const Route = createFileRoute('/$workspaceName/_auth/schedules/$scheduleId')({
  component: ScheduleRoute,
});
function ScheduleRoute() {
  const { scheduleId } = Route.useParams();
  return <SchedulesWorkspace scheduleId={scheduleId} />;
}
