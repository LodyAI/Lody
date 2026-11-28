import {
  defineClientPlugin,
  hostQueries,
  useHost,
  useQuery,
  type SidebarViewProps,
} from '@lody/plugin-sdk/client';
import { Alert, Badge, Button } from '@lody/ui';

function FocusSidebarView({ workspace, activeSession, taskScope, filters }: SidebarViewProps) {
  const host = useHost();
  const sessions = useQuery(workspace, hostQueries.sessions, {
    archived: false,
    createdByMe: taskScope === 'mine' ? true : undefined,
    status: filters.busyOnly ? 'busy' : undefined,
    limit: 30,
  });

  if (sessions.status === 'loading') return <div>Loading…</div>;
  if (sessions.status === 'unavailable') {
    return (
      <Alert.Root tone="warning">
        <Alert.Description>Sessions unavailable ({sessions.reason}).</Alert.Description>
      </Alert.Root>
    );
  }
  if (sessions.status === 'error') {
    return (
      <Alert.Root tone="danger">
        <Alert.Description>{sessions.message}</Alert.Description>
      </Alert.Root>
    );
  }

  const visible = filters.withPullRequest
    ? sessions.data.items.filter((row) => row.pullRequests.length > 0)
    : sessions.data.items;

  return (
    <div>
      {visible.map((row) => (
        <div key={row.session.sessionId}>
          <Button
            size="small"
            variant={activeSession?.sessionId === row.session.sessionId ? 'secondary' : 'ghost'}
            onClick={() => host.sessions.open(row.session)}
          >
            {row.title}
          </Button>
          <Badge tone={row.status === 'busy' ? 'running' : 'neutral'}>{row.status}</Badge>
        </div>
      ))}
    </div>
  );
}

export default defineClientPlugin((lody) => {
  lody.sidebar.views.add({
    id: 'focus',
    title: 'Focus',
    taskScope: true,
    filters: [
      { id: 'busyOnly', label: 'Running only', defaultValue: false },
      { id: 'withPullRequest', label: 'Has Pull Request', defaultValue: false },
    ],
    Component: FocusSidebarView,
  });
});
