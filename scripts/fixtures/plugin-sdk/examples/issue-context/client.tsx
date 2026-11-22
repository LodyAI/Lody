import {
  defineClientPlugin,
  hostQueries,
  useHost,
  useMutation,
  useQuery,
  type SessionPanelProps,
  type SessionSummary,
} from '@lody/plugin-sdk/client';
import { Alert, Badge, Button, Card } from '@lody/ui';
import {
  issueAttachmentSource,
  listIssuesQuery,
  sessionScratchpadQuery,
  togglePinMutation,
} from './shared';

const ISSUE_READY_WAIT_PROGRAM = `async ({ ctx }) => {
  const identifier = String(ctx.params.identifier ?? '');
  const { value } = await ctx.read('plugin.issue-context.issues.state', { identifier });
  if (value.state !== 'ready') return false;
  return {
    resumeText: 'Tracker marked ' + identifier + ' ready; begin implementation and open a PR.',
    payload: value,
  };
}`;

function IssueSidePanel({ session, project, params }: SessionPanelProps) {
  const host = useHost();
  const scratchpad = useQuery(session, sessionScratchpadQuery, {});

  if (!project) {
    return (
      <Alert.Root tone="neutral">
        <Alert.Description>
          {scratchpad.status === 'ready' && scratchpad.data.linkedIdentifier
            ? `Linked tracker issue: ${scratchpad.data.linkedIdentifier}`
            : 'Bind this session to a project to browse and watch tracker issues.'}
        </Alert.Description>
      </Alert.Root>
    );
  }

  return (
    <ProjectIssuesList
      session={session}
      project={project}
      focusedIdentifier={params.identifier}
      host={host}
    />
  );
}

function ProjectIssuesList({
  session,
  project,
  focusedIdentifier,
  host,
}: {
  session: SessionPanelProps['session'];
  project: NonNullable<SessionPanelProps['project']>;
  focusedIdentifier?: string;
  host: ReturnType<typeof useHost>;
}) {
  const issues = useQuery(project, listIssuesQuery, { query: focusedIdentifier ?? '' });
  const watchedSessions = useQuery(project, hostQueries.sessions, {
    createdByPlugin: true,
    archived: false,
  });
  const pin = useMutation(project, togglePinMutation);

  if (issues.status === 'loading') return <div>Loading issues…</div>;
  if (issues.status === 'unavailable') {
    return (
      <Alert.Root tone="warning">
        <Alert.Description>Tracker unavailable ({issues.reason}).</Alert.Description>
      </Alert.Root>
    );
  }
  if (issues.status === 'error') {
    return (
      <Alert.Root tone="danger">
        <Alert.Description>{issues.message}</Alert.Description>
      </Alert.Root>
    );
  }

  const sessionsByKey = new Map<string, SessionSummary>();
  if (watchedSessions.status === 'ready') {
    for (const item of watchedSessions.data.items) {
      if (item.businessKey) sessionsByKey.set(item.businessKey, item);
    }
  }

  return (
    <div>
      {issues.data.map((issue) => {
        const watchKey = `issue-ready:${issue.identifier}`;
        const existingWatch = sessionsByKey.get(watchKey);
        return (
          <Card.Root key={issue.id}>
            <Card.Header>
              <Card.Title>
                {issue.identifier}: {issue.title}
              </Card.Title>
              <Badge tone={issue.state === 'done' ? 'success' : 'neutral'}>{issue.state}</Badge>
            </Card.Header>
            <Card.Footer>
              <Button
                size="small"
                variant="ghost"
                disabled={pin.pending}
                onClick={() => void pin.mutate({ issueId: issue.id, pinned: !issue.pinned })}
              >
                {issue.pinned ? 'Unpin' : 'Pin'}
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() =>
                  host.drafts.append(session, {
                    kind: 'text',
                    text: `Context: ${issue.identifier} (${issue.url})`,
                  })
                }
              >
                Quote in draft
              </Button>
              {existingWatch ? (
                <>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => host.sessions.open(existingWatch.session)}
                  >
                    Open watch ({existingWatch.status})
                  </Button>
                  {existingWatch.status === 'busy' && (
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() => void host.sessions.requestStop(existingWatch.session)}
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
                    void host.sessions.create(project, {
                      requestId: crypto.randomUUID(),
                      businessKey: watchKey,
                      businessKeyScope: 'project',
                      pullRequestUrl: issue.pullRequestUrl,
                      prompt: `Implement ${issue.identifier} (${issue.title}) once unblocked.`,
                      waitCondition: {
                        program: ISSUE_READY_WAIT_PROGRAM,
                        params: { identifier: issue.identifier },
                        reason: `Wait until ${issue.identifier} reaches ready state`,
                      },
                    })
                  }
                >
                  Start when ready
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
    id: 'issues',
    title: 'Issues',
    Component: IssueSidePanel,
  });
});
