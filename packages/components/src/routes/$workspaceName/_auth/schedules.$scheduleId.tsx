import { createFileRoute } from '@tanstack/react-router';

// Rendered by the `schedules` layout route, which reads `scheduleId`.
export const Route = createFileRoute('/$workspaceName/_auth/schedules/$scheduleId')({
  component: () => null,
});
