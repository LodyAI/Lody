import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyMcpSetting = lazy(async () => {
  const module = await import('@/components/settings/mcp-setting');
  return { default: module.McpSetting };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/mcp')({
  component: McpSettingsRoute,
});

function McpSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyMcpSetting />
    </RouteSuspense>
  );
}
