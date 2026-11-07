import { createFileRoute } from '@tanstack/react-router';
import { LodyAgentSetting } from '@/components/settings/lody-agent-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/lody-agent')({
  component: LodyAgentSetting,
});
