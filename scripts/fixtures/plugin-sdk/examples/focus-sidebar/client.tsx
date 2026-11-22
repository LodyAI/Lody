import {
  defineClientPlugin,
  lodyQueries,
  useHost,
  useLodyQuery,
  type SessionSummary,
  type SidebarReplaceProps,
  type SidebarViewProps,
} from '@lody/plugin-sdk/client';
import { Alert, Badge, Button } from '@lody/ui';

function FocusSidebarView({ workspace, activeSession, taskScope, filters }: SidebarViewProps) {
  const host = useHost();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, {
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

/**
 * Full custom sidebar replacement built purely on raw `lodyQueries` data (`openedByRootSessionId`
 * and `agentRoleId`) — organizing multi-Agent parent/child runs without any bespoke host `swarm` group.
 */
function SwarmSidebarReplacement({ workspace, activeSession }: SidebarReplaceProps) {
  const host = useHost();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, { archived: false, limit: 100 });
  const roles = useLodyQuery(workspace, lodyQueries.agentRoles);

  if (sessions.status !== 'ready') return <div>Loading workspace sessions…</div>;

  const roleById = new Map(
    roles.status === 'ready' ? roles.data.items.map((role) => [role.roleId, role]) : []
  );
  const childrenByRoot = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];

  for (const item of sessions.data.items) {
    const rootId = item.openedByRootSessionId ?? item.openedBySessionId;
    if (!rootId) {
      roots.push(item);
      continue;
    }
    const bucket = childrenByRoot.get(rootId) ?? [];
    bucket.push(item);
    childrenByRoot.set(rootId, bucket);
  }

  return (
    <div>
      {roots.map((root) => {
        const subagents = childrenByRoot.get(root.session.sessionId) ?? [];
        return (
          <div key={root.session.sessionId}>
            <Button
              size="small"
              variant={activeSession?.sessionId === root.session.sessionId ? 'secondary' : 'ghost'}
              onClick={() => host.sessions.open(root.session)}
            >
              {root.title}
            </Button>
            {subagents.map((child) => {
              const role = child.agentRoleId ? roleById.get(child.agentRoleId) : undefined;
              return (
                <div key={child.session.sessionId}>
                  <Button
                    size="mini"
                    variant="ghost"
                    onClick={() => host.sessions.open(child.session)}
                  >
                    {role?.emoji ? `${role.emoji} ` : ''}
                    {child.title}
                  </Button>
                </div>
              );
            })}
          </div>
        );
      })}
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

  lody.sidebar.replace({
    id: 'swarm-tree',
    title: 'Agent Tree',
    Component: SwarmSidebarReplacement,
  });
});
