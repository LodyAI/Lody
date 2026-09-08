import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import type { MachineId } from '@lody/shared';
import { RouteSuspense } from '@/components/route-suspense';

const LazyProjectSettings = lazy(async () => {
  const module = await import('@/components/settings/project-settings');
  return { default: module.ProjectSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/projects')({
  component: ProjectSettingsRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    machine: typeof search.machine === 'string' ? search.machine : undefined,
    project: typeof search.project === 'string' ? search.project : undefined,
  }),
});

function ProjectSettingsRoute() {
  const search = Route.useSearch();
  return (
    <RouteSuspense>
      <LazyProjectSettings
        initialMachineId={(search.machine ?? null) as MachineId | null}
        initialProjectKey={search.project ?? null}
      />
    </RouteSuspense>
  );
}
