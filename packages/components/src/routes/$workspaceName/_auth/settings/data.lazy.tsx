import { createLazyFileRoute } from '@tanstack/react-router';
import { WorkspaceDataSetting } from '@/components/settings/workspace-data-setting';
export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/data')({
  component: WorkspaceDataSetting,
});
