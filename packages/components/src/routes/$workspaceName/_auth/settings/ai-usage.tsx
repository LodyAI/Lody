import { createFileRoute } from '@tanstack/react-router';
import { AiUsageSettingsComponent } from '@/components/settings/ai-usage-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/ai-usage')({
  component: AiUsageSettingsComponent,
});
