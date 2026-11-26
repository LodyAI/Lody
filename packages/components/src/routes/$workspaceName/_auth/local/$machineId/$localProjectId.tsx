import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/$workspaceName/_auth/local/$machineId/$localProjectId')({
  component: LocalProjectRedirect,
});

function LocalProjectRedirect() {
  const { workspaceName, machineId, localProjectId } = Route.useParams();
  return (
    <Navigate
      to="/$workspaceName/chat"
      params={{ workspaceName }}
      search={{ context: 'local' as const, machine: machineId, project: localProjectId }}
      replace
    />
  );
}
