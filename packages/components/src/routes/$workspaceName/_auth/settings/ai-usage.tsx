import { createFileRoute } from '@tanstack/react-router';
import { StatsSettingsComponent } from '@/components/settings/stats-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/ai-usage')({
  component: StatsSettingsComponent,
});
