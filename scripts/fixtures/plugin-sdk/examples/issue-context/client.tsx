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
import { issueAttachmentSource, listIssuesQuery, togglePinMutation } from './shared';

const CI_FAILURE_WAIT_PROGRAM = `async ({ ctx }) => {
  const { value } = await ctx.read('github.workflowRuns');
  if (value.status !== 'observed') return false;
  const failed = value.pullRequests.flatMap((pr) =>
    pr.runs.filter((run) => run.status === 'completed' && run.conclusion === 'failure')
  );
  if (!failed.length) return false;
  return { resumeText: 'CI failed on the associated PR; inspect failures and propose a fix.', payload: failed };
}`;

function IssueSidePanel({ session, project }: SessionPanelProps) {
  const host = useHost();
  if (!project) {
    return (
      <Alert.Root tone="neutral">
        <Alert.Description>
          Bind this session to a project to view tracker issues.
        </Alert.Description>
      </Alert.Root>
    );
  }

  return <ProjectIssuesList session={session} project={project} host={host} />;
}

function ProjectIssuesList({
  session,
  project,
  host,
}: {
  session: SessionPanelProps['session'];
  project: NonNullable<SessionPanelProps['project']>;
  host: ReturnType<typeof useHost>;
}) {
  const issues = useQuery(project, listIssuesQuery, {});
  const watchedSessions = useQuery(project, hostQueries.sessions, {
    createdByMe: true,
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
      if (item.idempotencyKey) sessionsByKey.set(item.idempotencyKey, item);
    }
  }

  return (
    <div>
      {issues.data.map((issue) => {
        const watchKey = `ci-watch:${issue.identifier}`;
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
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => host.sessions.open(existingWatch.session)}
                >
                  Open watch ({existingWatch.status})
                </Button>
              ) : (
                <Button
                  size="small"
                  variant="primary"
                  onClick={() =>
                    void host.sessions.create(project, {
                      idempotencyKey: watchKey,
                      prompt: `Watch CI for ${issue.identifier} and investigate the first failure.`,
                      waitCondition: {
                        program: CI_FAILURE_WAIT_PROGRAM,
                        reason: `Wait for CI failure on ${issue.identifier}`,
                      },
                    })
                  }
                >
                  Review on CI failure
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
