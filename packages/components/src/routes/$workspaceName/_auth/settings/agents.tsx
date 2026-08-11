import { useCallback } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { MachineId } from '@lody/shared';
import { MachineAgentSettings } from '@/components/settings/machine-agent-settings';

type AgentsSearch = { machine?: string };

export const Route = createFileRoute('/$workspaceName/_auth/settings/agents')({
  component: AgentsSettingsRoute,
  validateSearch: (search: Record<string, unknown>): AgentsSearch => ({
    machine: typeof search.machine === 'string' ? search.machine : undefined,
  }),
});

function AgentsSettingsRoute() {
  const { workspaceName } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const selectedMachineId = (search.machine ?? null) as MachineId | null;
  const onSelectedMachineChange = useCallback(
    (machine: MachineId | null) => {
      void navigate({
        to: '/$workspaceName/settings/agents',
        params: { workspaceName },
        search: (previous) => ({ ...previous, machine: machine ?? undefined }),
        replace: true,
      });
    },
    [navigate, workspaceName]
  );
  return (
    <MachineAgentSettings
      mode="agents"
      selectedMachineId={selectedMachineId}
      onSelectedMachineChange={onSelectedMachineChange}
    />
  );
}
