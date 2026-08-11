import { useCallback } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { MachineId } from '@lody/shared';
import { MachineAgentSettings } from '@/components/settings/machine-agent-settings';

type MachinesSearch = { machine?: string };

export const Route = createFileRoute('/$workspaceName/_auth/settings/machines')({
  component: MachinesSettingsRoute,
  validateSearch: (search: Record<string, unknown>): MachinesSearch => ({
    machine: typeof search.machine === 'string' ? search.machine : undefined,
  }),
});

function MachinesSettingsRoute() {
  const { workspaceName } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const selectedMachineId = (search.machine ?? null) as MachineId | null;
  const onSelectedMachineChange = useCallback(
    (machine: MachineId | null) => {
      void navigate({
        to: '/$workspaceName/settings/machines',
        params: { workspaceName },
        search: (previous) => ({ ...previous, machine: machine ?? undefined }),
        replace: true,
      });
    },
    [navigate, workspaceName]
  );

  return (
    <MachineAgentSettings
      mode="machines"
      selectedMachineId={selectedMachineId}
      onSelectedMachineChange={onSelectedMachineChange}
    />
  );
}
