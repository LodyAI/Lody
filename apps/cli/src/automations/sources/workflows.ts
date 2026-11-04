import type { SessionMeta } from '@lody/shared';
import {
  resolveSessionPullRequests,
  parseGitHubPullRequestUrl,
  getCurrentPullRequestsByRepository,
} from '@lody/shared';
import type { AutomationEvidence, ConditionObservation } from '@lody/shared/automations';
import type { WorkflowRunObservation } from '@/lib/pr-poller/workflow-runs';
import { automationIdentity, type AutomationLedger } from '../storage/ledger';
import { pullRequestCheckpointId } from './pull-requests';

export const workflowCheckpointId = (sessionId: string, repository: string, headSha: string) =>
  automationIdentity('github.workflow', sessionId, repository.toLowerCase(), headSha);

export function observeWorkflows(
  ledger: AutomationLedger,
  meta: SessionMeta,
  repository: string,
  headSha: string,
  runs: readonly WorkflowRunObservation[],
  gap: boolean,
  observedAt: number
): void {
  const id = workflowCheckpointId(meta.id, repository, headSha);
  const previous = ledger.checkpoint(id);
  if (previous && previous.observedAt > observedAt) return;
  const current: Record<string, WorkflowRunObservation> = {};
  const prior = (previous?.data.runs ?? {}) as Record<string, WorkflowRunObservation>;
  for (const next of runs) {
    const old = prior[next.runId];
    current[next.runId] =
      old &&
      (old.attempt > next.attempt ||
        (old.attempt === next.attempt && old.updatedAt > next.updatedAt))
        ? old
        : next;
  }
  const revision = automationIdentity(
    JSON.stringify(Object.values(current).sort((a, b) => a.runId - b.runId)),
    String(gap)
  );
  const events = Object.values(current).flatMap((next) => {
    const old = prior[next.runId];
    if (
      !previous ||
      next.status !== 'completed' ||
      (old?.attempt === next.attempt && old.status === 'completed')
    )
      return [];
    return [
      {
        id: `${meta.id}:${next.runId}:${next.attempt}:${next.conclusion}`,
        source: `github/repo/${repository.toLowerCase()}`,
        type: 'github.workflow_run.completed',
        version: 1,
        subject: `workflow_run/${next.runId}`,
        observedAt,
        occurredAt: next.updatedAt,
        scope: { workspaceId: ledger.workspaceId, sessionId: meta.id },
        data: { ...next },
        provenance: 'poll' as const,
        completeness: gap ? ('gap' as const) : ('observed' as const),
        depth: 0,
      },
    ];
  });
  ledger.observe(
    id,
    { revision, observedAt, data: { runs: current, gap, repository: repository.toLowerCase() } },
    events
  );
  if (previous?.revision !== revision)
    ledger.invalidateReads('github.workflowRuns', meta.id, observedAt);
}

const admissionRevision = (snapshot: { data: Record<string, unknown> }) =>
  automationIdentity(
    JSON.stringify(
      Object.values((snapshot.data.runs ?? {}) as Record<string, WorkflowRunObservation>)
        .map((run) => ({
          runId: run.runId,
          attempt: run.attempt,
          headSha: run.headSha,
          headRepository: run.headRepository,
        }))
        .sort((a, b) => a.runId - b.runId)
    ),
    String(snapshot.data.gap)
  );

export function readWorkflowRuns(ledger: AutomationLedger, meta: SessionMeta, now: number) {
  const evidence: AutomationEvidence[] = [];
  const results: Array<{ prUrl: string; headSha: string; runs: WorkflowRunObservation[] }> = [];
  for (const pr of getCurrentPullRequestsByRepository(resolveSessionPullRequests(meta))) {
    const parsed = parseGitHubPullRequestUrl(pr.url);
    if (!parsed) continue;
    const repository = parsed.repoFullName.toLowerCase();
    const head = ledger.checkpoint(pullRequestCheckpointId(meta.id, pr.url));
    const sourceId = workflowCheckpointId(meta.id, repository, String(head?.data.headSha ?? ''));
    const snapshot = ledger.checkpoint(sourceId);
    if (
      !head ||
      !snapshot ||
      head.observedAt + 120_000 < now ||
      snapshot.observedAt + 120_000 < now ||
      typeof head.data.headSha !== 'string' ||
      head.data.headRepository !== repository
    )
      return {
        value: { status: 'unknown', reason: 'current_ci_evidence_unavailable' },
        evidence: [],
      };
    const runs = Object.values(
      (snapshot.data.runs ?? {}) as Record<string, WorkflowRunObservation>
    ).filter(
      (run) =>
        run.headSha === head.data.headSha &&
        run.repository === repository &&
        run.headRepository === repository &&
        (run.prNumbers.includes(parsed.prNumber) || run.branch === head.data.branch)
    );
    if (snapshot.data.gap === true || !runs.length)
      return { value: { status: 'unknown', reason: 'workflow_coverage_incomplete' }, evidence: [] };
    results.push({ prUrl: pr.url, headSha: head.data.headSha, runs });
    evidence.push({
      sourceId,
      revision: admissionRevision(snapshot),
      sessionId: meta.id,
      prUrl: pr.url,
      repository,
      headSha: head.data.headSha,
    });
  }
  return {
    value: results.length
      ? { status: 'observed', pullRequests: results }
      : { status: 'unknown', reason: 'no_linked_pull_request' },
    evidence,
  };
}

export function checkWorkflowEvidence(
  ledger: AutomationLedger,
  evidence: readonly AutomationEvidence[],
  now: number
): ConditionObservation {
  for (const item of evidence) {
    const source = ledger.checkpoint(item.sourceId);
    const head = ledger.checkpoint(pullRequestCheckpointId(item.sessionId, item.prUrl));
    if (
      head &&
      (head.data.headSha !== item.headSha || head.data.headRepository !== item.repository)
    )
      return { value: 'no', reason: 'workflow_superseded' };
    if (!source || !head || source.observedAt + 120_000 < now || head.observedAt + 120_000 < now)
      return { value: 'unknown', reason: 'workflow_evidence_stale' };
    if (admissionRevision(source) !== item.revision)
      return { value: 'no', reason: 'workflow_superseded' };
  }
  return { value: 'yes', reason: 'workflow_current' };
}
