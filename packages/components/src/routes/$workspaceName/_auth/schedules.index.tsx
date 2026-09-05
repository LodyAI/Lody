import { createFileRoute } from '@tanstack/react-router';
import { SchedulesWorkspace } from '@/components/schedules/schedules-workspace';
export const Route = createFileRoute('/$workspaceName/_auth/schedules/')({
  component: SchedulesWorkspace,
});
