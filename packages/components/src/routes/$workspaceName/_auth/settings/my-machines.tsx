import { createFileRoute, Navigate } from '@tanstack/react-router';

type MyMachinesSearch = { machine?: string };

export const Route = createFileRoute('/$workspaceName/_auth/settings/my-machines')({
  component: LegacyMyMachinesSettingsRoute,
  validateSearch: (search: Record<string, unknown>): MyMachinesSearch => ({
    machine: typeof search.machine === 'string' ? search.machine : undefined,
  }),
});

function LegacyMyMachinesSettingsRoute() {
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
