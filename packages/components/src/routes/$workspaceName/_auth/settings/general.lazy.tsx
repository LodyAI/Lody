import { createLazyFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/general')({
  component: LegacyGeneralSettingsRoute,
});

function LegacyGeneralSettingsRoute() {
  const { workspaceName } = Route.useParams();
  return (
    <Navigate
      to="/$workspaceName/settings/preferences"
      params={{ workspaceName }}
      search={(previous) => previous}
      replace
    />
  );
}
