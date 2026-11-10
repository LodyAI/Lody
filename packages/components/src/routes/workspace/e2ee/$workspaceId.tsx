import { createFileRoute } from '@tanstack/react-router';
// Relative on purpose: the e2ee-client browser suite bundles this route and replaces
// every `@/` import with its injected ports.
import { E2eeWorkspaceConsole } from '../../../components/pages/e2ee-workspace-console';

export const Route = createFileRoute('/workspace/e2ee/$workspaceId')({
  component: WorkspaceControlRoute,
});

function WorkspaceControlRoute() {
  const { workspaceId } = Route.useParams();
  return <E2eeWorkspaceConsole workspaceId={workspaceId} presentation="page" />;
}
