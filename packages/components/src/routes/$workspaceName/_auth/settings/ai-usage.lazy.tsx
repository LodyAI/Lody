import { createLazyFileRoute } from '@tanstack/react-router';
import { StatsSettingsComponent } from '@/components/settings/stats-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/ai-usage')({
  component: StatsSettingsComponent,
});
