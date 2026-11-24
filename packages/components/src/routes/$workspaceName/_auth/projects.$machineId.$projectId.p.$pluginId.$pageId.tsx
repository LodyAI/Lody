import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { PluginRoute } from '../../../plugins/plugin-route';
export const Route = createFileRoute(
  '/$workspaceName/_auth/projects/$machineId/$projectId/p/$pluginId/$pageId'
)({ component: Page });
function Page() {
  const p = Route.useParams();
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return (
    <PluginRoute
      {...p}
      id={p.pageId}
      kind="project"
      params={Object.fromEntries(new URLSearchParams(search))}
    />
  );
}
