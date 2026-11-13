import { createLazyFileRoute } from '@tanstack/react-router';
import { GeneralSettingsComponent } from '@/components/settings/general-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/preferences')({
  component: GeneralSettingsComponent,
});
