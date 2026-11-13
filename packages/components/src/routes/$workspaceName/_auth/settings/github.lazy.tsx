import { createLazyFileRoute } from '@tanstack/react-router';
import { IntegrationsSettingsComponent } from '@/components/settings/integrations-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/github')({
  component: IntegrationsSettingsComponent,
});
