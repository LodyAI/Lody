import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyAgentRolesSetting = lazy(async () => {
  const module = await import('@/components/settings/agent-roles-setting');
  return { default: module.AgentRolesSetting };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/agent-roles')({
  component: AgentRolesSettingsRoute,
});

function AgentRolesSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyAgentRolesSetting />
    </RouteSuspense>
  );
}
