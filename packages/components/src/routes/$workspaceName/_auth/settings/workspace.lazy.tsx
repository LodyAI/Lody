import { createLazyFileRoute } from '@tanstack/react-router';
import { WorkspaceSettings } from '@/components/settings/e2ee/workspace-security';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/workspace')({
  component: WorkspaceGeneralSettingsRoute,
});

function WorkspaceGeneralSettingsRoute() {
  return <WorkspaceSettings />;
}
