import {
  SessionRow,
  SidebarRow,
  defineClientPlugin,
  lodyQueries,
  useLody,
  useLodyQuery,
  type ScreenProps,
  type SessionRowSlotProps,
  type SessionSummary,
  type SidebarItemProps,
  type SidebarViewProps,
} from "@lody/plugin-sdk/client";
import { Alert, Badge, Button, Card } from "@lody/ui";

/**
 * Layer 1 (`sidebar.sessionRow.decorate`): Composable row-level enhancement.
 * Surfaces a `? Input` / `Approval` pill and a hover summary for sessions paused on user
 * interaction, jumping directly into Lody's native permission/elicitation sheet on click — and
 * works automatically across both Lody's built-in sidebar and custom `<SessionRow />` views!
 */
function WaitingInteractionBadge({ session }: SessionRowSlotProps) {
  if (!session.pendingInteraction) return null;
  return (
    <Badge
      tone={
        session.pendingInteraction.kind === "elicitation"
          ? "running"
          : "warning"
      }
    >
      {session.pendingInteraction.kind === "elicitation"
        ? "? Input"
        : "Approval"}
    </Badge>
  );
}

function HoverInteractionPreviewCard({ session }: SessionRowSlotProps) {
  const lody = useLody();
  if (!session.pendingInteraction) return null;
  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>{session.title}</Card.Title>
      </Card.Header>
      <Card.Description>
        {session.pendingInteraction.title ??
          (session.pendingInteraction.kind === "elicitation"
            ? "Agent is waiting for your input."
            : "Agent is waiting for tool approval.")}
      </Card.Description>
      <Card.Footer>
        <Button
          size="small"
          variant="primary"
          onClick={() => lody.sessions.open(session.session)}
        >
          Open Session to Respond
        </Button>
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
    status: "busy",
    limit: 50,
  });
  const runningCount =
    running.status === "ready" ? running.data.items.length : 0;

  return (
    <SidebarRow
      label="Swarm Hub"
      trailing={
        runningCount > 0 ? (
          <Badge tone="running">{runningCount}</Badge>
        ) : undefined
      }
      onClick={() => lody.screens.open(workspace, "swarm-hub")}
    />
  );
}

function SwarmHubScreen({ workspace }: ScreenProps) {
  const lody = useLody();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    limit: 60,
  });

  if (sessions.status === "loading") return <div>Loading active agents…</div>;
  if (sessions.status !== "ready") {
    return (
      <Alert.Root tone="warning">
        <Alert.Description>
          Unable to load workspace sessions.
        </Alert.Description>
      </Alert.Root>
    );
  }

  return (
    <div>
      {sessions.data.items.map((item) => (
        <Card.Root key={item.session.sessionId}>
          <Card.Header>
            <Card.Title>{item.title}</Card.Title>
            <Badge tone={item.status === "busy" ? "running" : "neutral"}>
              {item.status}
            </Badge>
          </Card.Header>
          <Card.Footer>
            <Button
              size="small"
              variant="secondary"
              onClick={() => lody.sessions.open(item.session)}
            >
              Open
            </Button>
            {item.status === "busy" && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => void lody.sessions.requestStop(item.session)}
              >
                Stop
              </Button>
            )}
          </Card.Footer>
        </Card.Root>
      ))}
    </div>
  );
}

/**
 * Layer 3 (`sidebar.views.add`): Paseo-style pure custom sidebar view over raw `lodyQueries.sessions`
 * (`openedByRootSessionId`, `agentRoleId`). Rendering `<SessionRow />` composes `HoverInteractionPreviewCard`!
 */
function SwarmTreeSidebarView({ workspace, activeSession }: SidebarViewProps) {
  const lody = useLody();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    limit: 100,
  });
  const roles = useLodyQuery(workspace, lodyQueries.agentRoles);

  if (sessions.status !== "ready")
    return <div>Loading workspace sessions…</div>;

  const roleById = new Map(
    roles.status === "ready"
      ? roles.data.items.map((role) => [role.roleId, role])
      : [],
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
              const role = child.agentRoleId
                ? roleById.get(child.agentRoleId)
                : undefined;
              return (
                <SessionRow
                  key={child.session.sessionId}
                  session={child}
                  indent={1}
                  leading={role?.emoji ? <span>{role.emoji}</span> : undefined}
                  selected={
                    activeSession?.sessionId === child.session.sessionId
                  }
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
    id: "hover-pending-interaction",
    trailing: WaitingInteractionBadge,
    hoverCard: HoverInteractionPreviewCard,
  });

  lody.sidebar.headerItems.add({
    id: "swarm-hub-entry",
    Component: SwarmHubHeaderEntry,
  });

  lody.screens.add({
    id: "swarm-hub",
    title: "Swarm Hub",
    Component: SwarmHubScreen,
  });

  lody.sidebar.views.add({
    id: "swarm-tree",
    title: "Agent Tree",
    Component: SwarmTreeSidebarView,
  });
});
