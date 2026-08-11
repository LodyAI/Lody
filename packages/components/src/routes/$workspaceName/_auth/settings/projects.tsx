import { createFileRoute } from '@tanstack/react-router';
import type { MachineId } from '@lody/shared';
import { ProjectSettingsComponent } from '@/components/settings/project-settings';

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
    <ProjectSettingsComponent
      initialMachineId={(search.machine ?? null) as MachineId | null}
      initialProjectKey={search.project ?? null}
    />
  );
}
