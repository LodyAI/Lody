import { createLazyFileRoute } from '@tanstack/react-router';
import { PluginsSettings } from '@/components/settings/plugin-inspector';
export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/plugins_/$pluginId')({
  component: PluginRoute,
});
function PluginRoute() {
  return <PluginsSettings pluginId={Route.useParams().pluginId} page={Route.useSearch().page} />;
}
