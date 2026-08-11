import { createFileRoute } from '@tanstack/react-router';
import { GeneralSettingsComponent } from '@/components/settings/general-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/preferences')({
  component: GeneralSettingsComponent,
});
