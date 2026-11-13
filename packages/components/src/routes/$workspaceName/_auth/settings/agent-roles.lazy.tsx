import { createLazyFileRoute } from '@tanstack/react-router';
import { AgentRolesSetting } from '@/components/settings/agent-roles-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/agent-roles')({
  component: AgentRolesSetting,
});
