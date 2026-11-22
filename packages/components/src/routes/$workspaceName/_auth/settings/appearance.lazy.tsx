import { createLazyFileRoute } from '@tanstack/react-router';
import { AppearanceSettingsComponent } from '@/components/settings/appearance-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/appearance')({
  component: AppearanceSettingsComponent,
});
