import { createFileRoute, Navigate } from '@tanstack/react-router';

type DevicesSearch = {
  machine?: string;
};

export const Route = createFileRoute('/$workspaceName/_auth/settings/devices')({
  component: LegacyDevicesSettingsRoute,
  validateSearch: (search: Record<string, unknown>): DevicesSearch => ({
    machine: typeof search.machine === 'string' ? search.machine : undefined,
  }),
});

function LegacyDevicesSettingsRoute() {
  const { workspaceName } = Route.useParams();
  const search = Route.useSearch();
  return (
    <Navigate
      to="/$workspaceName/settings/machines"
      params={{ workspaceName }}
      search={{ machine: search.machine }}
      replace
    />
  );
}
