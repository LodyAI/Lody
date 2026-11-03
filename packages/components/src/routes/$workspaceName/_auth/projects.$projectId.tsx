import { createFileRoute } from '@tanstack/react-router';
import { ProjectHubWorkspace } from '@/components/project-hub/project-hub-workspace';

// Project hub prototype: a project's coordinator conversation beside the board
// of the sub-conversations it runs. Opened from the sidebar's Projects view.
export const Route = createFileRoute('/$workspaceName/_auth/projects/$projectId')({
  component: ProjectHubRoute,
});

function ProjectHubRoute() {
  const { workspaceName, projectId } = Route.useParams();
  return (
    <ProjectHubWorkspace key={projectId} workspaceName={workspaceName} projectId={projectId} />
  );
}
