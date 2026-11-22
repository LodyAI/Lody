import {
  defineClientPlugin,
  lodyQueries,
  useLody,
  useLodyQuery,
  useMutation,
  useQuery,
  type SessionPanelProps,
  type SessionSummary,
} from "@lody/plugin-sdk/client";
import { Alert, Badge, Button, Card } from "@lody/ui";
import {
  issueAttachmentSource,
  listIssuesQuery,
  sessionScratchpadQuery,
  togglePinMutation,
} from "./shared";

function IssueSidePanel({ session, project, params }: SessionPanelProps) {
  const lody = useLody();
  const scratchpad = useQuery(session, sessionScratchpadQuery, {});

  if (!project) {
    return (
      <Alert.Root tone="neutral">
        <Alert.Description>
          {scratchpad.status === "ready" && scratchpad.data.linkedIdentifier
            ? `Linked tracker issue: ${scratchpad.data.linkedIdentifier}`
            : "Bind this session to a project to browse and start tracker issues."}
        </Alert.Description>
      </Alert.Root>
    );
  }

  return (
    <ProjectIssuesList
      session={session}
      project={project}
      focusedIdentifier={params.identifier}
      lody={lody}
    />
  );
}

function ProjectIssuesList({
  session,
  project,
  focusedIdentifier,
  lody,
}: {
  session: SessionPanelProps["session"];
  project: NonNullable<SessionPanelProps["project"]>;
  focusedIdentifier?: string;
  lody: ReturnType<typeof useLody>;
}) {
  const issues = useQuery(project, listIssuesQuery, {
    query: focusedIdentifier ?? "",
  });
  const issueSessions = useLodyQuery(project, lodyQueries.sessions, {
    createdByPlugin: true,
    archived: false,
  });
  const pin = useMutation(project, togglePinMutation);

  if (issues.status === "loading") return <div>Loading issues…</div>;
  if (issues.status === "unavailable") {
    return (
      <Alert.Root tone="warning">
        <Alert.Description>
          Tracker unavailable ({issues.reason}).
        </Alert.Description>
      </Alert.Root>
    );
  }
  if (issues.status === "error") {
    return (
      <Alert.Root tone="danger">
        <Alert.Description>{issues.message}</Alert.Description>
      </Alert.Root>
    );
  }

  const sessionsByKey = new Map<string, SessionSummary>();
  if (issueSessions.status === "ready") {
    for (const item of issueSessions.data.items) {
      if (item.businessKey) sessionsByKey.set(item.businessKey, item);
    }
  }

  return (
    <div>
      {issues.data.map((issue) => {
        const taskKey = `issue:${issue.identifier}`;
        const existingSession = sessionsByKey.get(taskKey);
        return (
          <Card.Root key={issue.id}>
            <Card.Header>
              <Card.Title>
                {issue.identifier}: {issue.title}
              </Card.Title>
              <Badge tone={issue.state === "done" ? "success" : "neutral"}>
                {issue.state}
              </Badge>
            </Card.Header>
            <Card.Footer>
              <Button
                size="small"
                variant="ghost"
                disabled={pin.pending}
                onClick={() =>
                  void pin.mutate({ issueId: issue.id, pinned: !issue.pinned })
                }
              >
                {issue.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() =>
                  lody.drafts.append(session, {
                    kind: "text",
                    text: `Context: ${issue.identifier} (${issue.url})`,
                  })
                }
              >
                Quote in draft
              </Button>
              {existingSession ? (
                <>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => lody.sessions.open(existingSession.session)}
                  >
                    Open session ({existingSession.status})
                  </Button>
                  {existingSession.status === "busy" && (
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() =>
                        void lody.sessions.requestStop(existingSession.session)
                      }
                    >
                      Stop
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  size="small"
                  variant="primary"
                  onClick={() =>
                    void lody.sessions.create(project, {
                      requestId: crypto.randomUUID(),
                      businessKey: taskKey,
                      pullRequestUrl: issue.pullRequestUrl,
                      prompt: `Implement ${issue.identifier} (${issue.title}).`,
                    })
                  }
                >
                  Start session
                </Button>
              )}
            </Card.Footer>
          </Card.Root>
        );
      })}
    </div>
  );
}

export default defineClientPlugin((lody) => {
  lody.composer.attachments.add(issueAttachmentSource);
  lody.session.panels.add({
    id: "issues",
    title: "Issues",
    Component: IssueSidePanel,
  });
});
