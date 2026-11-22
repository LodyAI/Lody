import { createLazyFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/stats')({
  component: LegacyStatsSettingsRoute,
});

function LegacyStatsSettingsRoute() {
  const { workspaceName } = Route.useParams();
  return (
    <Navigate
      to="/$workspaceName/settings/ai-usage"
      params={{ workspaceName }}
      search={(previous) => previous}
      replace
    />
  );
}
