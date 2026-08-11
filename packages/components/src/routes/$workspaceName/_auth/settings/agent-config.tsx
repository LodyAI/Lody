import { createFileRoute, Navigate } from '@tanstack/react-router';

export type AgentConfigSearch = {
  machine?: string;
};

export const Route = createFileRoute('/$workspaceName/_auth/settings/agent-config')({
  component: LegacyAgentSettingsRoute,
  validateSearch: (search: Record<string, unknown>): AgentConfigSearch => ({
    machine: typeof search.machine === 'string' ? search.machine : undefined,
  }),
});

function LegacyAgentSettingsRoute() {
  const { workspaceName } = Route.useParams();
  const search = Route.useSearch();
  return (
    <Navigate
      to="/$workspaceName/settings/agents"
      params={{ workspaceName }}
      search={{ machine: search.machine }}
      replace
    />
  );
}
