import { createLazyFileRoute } from '@tanstack/react-router';
import { LodyAgentSetting } from '@/components/settings/lody-agent-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/lody-agent')({
  component: LodyAgentSetting,
});
