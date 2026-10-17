import { createFileRoute } from '@tanstack/react-router';
import { ProjectGroupsSetting } from '@/components/settings/project-groups-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/project-groups')({
  component: ProjectGroupsSetting,
});
