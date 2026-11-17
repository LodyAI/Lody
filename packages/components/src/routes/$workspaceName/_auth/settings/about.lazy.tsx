import { createLazyFileRoute } from '@tanstack/react-router';
import { AboutSettingsComponent } from '@/components/settings/about-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/about')({
  component: AboutSettingsComponent,
});
