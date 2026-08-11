import { createFileRoute } from '@tanstack/react-router';
import { AccountSettingsComponent } from '@/components/settings/account-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/workspace')({
  component: WorkspaceGeneralSettingsRoute,
});

function WorkspaceGeneralSettingsRoute() {
  return <AccountSettingsComponent surface="workspace" />;
}
