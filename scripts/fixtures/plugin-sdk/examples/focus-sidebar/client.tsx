import {
  SessionRow,
  SidebarRow,
  defineClientPlugin,
  lodyCommands,
  lodyQueries,
  useLody,
  useLodyQuery,
  type ScreenProps,
  type SessionRowSlotProps,
  type SessionSummary,
  type SidebarItemProps,
  type SidebarViewProps,
} from '@lody/plugin-sdk/client';
import { Alert, Badge, Button, Card, Input } from '@lody/ui';
import { useState } from 'react';

/**
 * Layer 1 (`sidebar.sessionRow.decorate`): Composable row-level enhancement.
 * Surfaces a `? Input` / `Approval` pill and an interactive hover popover that can directly
 * settle a pending ACP interaction (`sessions.respondInteraction`) OR send/steer a follow-up
 * message (`sessions.send`) without switching out of the active Session!
 */
function WaitingInteractionBadge({ session }: SessionRowSlotProps) {
  if (!session.pendingInteraction) return null;
  return (
    <Badge tone={session.pendingInteraction.kind === 'elicitation' ? 'running' : 'warning'}>
      {session.pendingInteraction.kind === 'elicitation' ? '? Input' : 'Approval'}
    </Badge>
  );
}

function HoverSessionControlCard({ session }: SessionRowSlotProps) {
  const lody = useLody();
  const [quickReply, setQuickReply] = useState('');
  const pending = session.pendingInteraction;

  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>{session.title}</Card.Title>
      </Card.Header>
      {pending ? (
        <div>
          <Card.Description>{pending.title ?? 'Waiting for your decision'}</Card.Description>
          <div>
            {pending.options.map((opt) => (
              <Button
                key={opt.optionId}
                size="small"
                variant={opt.kind?.startsWith('allow') ? 'primary' : 'secondary'}
                onClick={() =>
                  void lody.sessions.respondInteraction(session.session, {
                    requestId: pending.requestId,
                    turnId: pending.turnId,
                    outcome: { outcome: 'selected', optionId: opt.optionId },
                  })
                }
              >
                {opt.name}
              </Button>
            ))}
            <Button
              size="small"
              variant="ghost"
              onClick={() =>
                void lody.sessions.respondInteraction(session.session, {
                  requestId: pending.requestId,
                  turnId: pending.turnId,
                  outcome: { outcome: 'cancelled' },
                })
              }
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <Card.Footer>
        <Input
          size="small"
          value={quickReply}
          placeholder="Quick message or steer…"
          onChange={(e) => setQuickReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && quickReply.trim()) {
              void lody.sessions.send(session.session, {
                prompt: quickReply.trim(),
                delivery: session.status === 'busy' ? 'steer' : 'queue',
              });
              setQuickReply('');
            }
          }}
        />
      </Card.Footer>
    </Card.Root>
  );
}

/**
 * Layer 2 (`sidebar.headerItems` + `screens.add`): Native `<SidebarRow />` entry opening a
 * full-screen multi-Agent War Room without replacing the user's everyday conversation list.
 */
function SwarmHubHeaderEntry({ workspace }: SidebarItemProps) {
  const lody = useLody();
  const running = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    status: 'busy',
    limit: 50,
  });
  const runningCount = running.status === 'ready' ? running.data.items.length : 0;

  return (
    <SidebarRow
      label="Swarm Hub"
      trailing={runningCount > 0 ? <Badge tone="running">{runningCount}</Badge> : undefined}
      onClick={() => lody.screens.open(workspace, 'swarm-hub')}
    />
  );
}

function SwarmHubScreen({ workspace }: ScreenProps) {
  const lody = useLody();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    limit: 60,
  });

  if (sessions.status === 'loading') return <div>Loading active agents…</div>;
  if (sessions.status !== 'ready') {
    return (
      <Alert.Root tone="warning">
        <Alert.Description>Unable to load workspace sessions.</Alert.Description>
      </Alert.Root>
    );
  }

  return (
    <div>
      {sessions.data.items.map((item) => (
        <Card.Root key={item.session.sessionId}>
          <Card.Header>
            <Card.Title>{item.title}</Card.Title>
            <Badge tone={item.status === 'busy' ? 'running' : 'neutral'}>{item.status}</Badge>
          </Card.Header>
          <Card.Footer>
            <Button
              size="small"
              variant="secondary"
              onClick={() => lody.sessions.open(item.session)}
            >
              Open
            </Button>
            {item.status === 'busy' && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => void lody.sessions.requestStop(item.session)}
              >
                Stop
              </Button>
            )}
            <Button
              size="small"
              variant="ghost"
              onClick={() =>
                void lody.execute(item.session, lodyCommands.sessionSetPinned, {
                  pinned: !item.isPinned,
                })
              }
            >
              {item.isPinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              size="small"
              variant="ghost"
              onClick={() =>
                void lody.execute(
                  item.session,
                  item.settledAt ? lodyCommands.sessionMoveToFocus : lodyCommands.sessionSettle,
                  { includeOpenedSessions: true }
                )
              }
            >
              {item.settledAt ? 'Move to Focus' : 'Settle'}
            </Button>
            <Button
              size="small"
              variant="ghost"
              onClick={() =>
                void lody.execute(item.session, lodyCommands.sessionSnooze, {
                  until: Date.now() + 3_600_000,
                  includeOpenedSessions: true,
                })
              }
            >
              Snooze 1h
            </Button>
          </Card.Footer>
        </Card.Root>
      ))}
    </div>
  );
}

/**
 * Layer 3 (`sidebar.views.add`): Paseo-style pure custom sidebar view over raw `lodyQueries.sessions`
 * (`openedByRootSessionId`, `agentRoleId`). Rendering `<SessionRow />` composes `HoverSessionControlCard`!
 */
function SwarmTreeSidebarView({ workspace, activeSession }: SidebarViewProps) {
  const lody = useLody();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    limit: 100,
  });
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
            <SessionRow
              session={root}
              selected={activeSession?.sessionId === root.session.sessionId}
              onClick={() => lody.sessions.open(root.session)}
            />
            {subagents.map((child) => {
              const role = child.agentRoleId ? roleById.get(child.agentRoleId) : undefined;
              return (
                <SessionRow
                  key={child.session.sessionId}
                  session={child}
                  indent={1}
                  leading={role?.emoji ? <span>{role.emoji}</span> : undefined}
                  selected={activeSession?.sessionId === child.session.sessionId}
                  onClick={() => lody.sessions.open(child.session)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export default defineClientPlugin((lody) => {
  lody.sidebar.sessionRow.decorate({
    id: 'hover-pending-interaction',
    trailing: WaitingInteractionBadge,
    hoverCard: HoverSessionControlCard,
  });

  lody.sidebar.headerItems.add({
    id: 'swarm-hub-entry',
    Component: SwarmHubHeaderEntry,
  });

  lody.screens.add({
    id: 'swarm-hub',
    title: 'Swarm Hub',
    Component: SwarmHubScreen,
  });

  lody.sidebar.views.add({
    id: 'swarm-tree',
    title: 'Agent Tree',
    Component: SwarmTreeSidebarView,
  });
});
