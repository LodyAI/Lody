import { createLazyFileRoute } from '@tanstack/react-router';
import { PluginsSettings } from '@/components/settings/plugin-inspector';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/plugins')({
  component: PluginsSettings,
});
