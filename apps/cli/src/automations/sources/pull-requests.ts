import type { SessionMeta } from '@lody/shared';
import type { PrObservation } from '@/lib/pr-poller/github-graphql-client';
import { AutomationLedger, automationIdentity } from '../storage/ledger';

export const pullRequestCheckpointId = (sessionId: string, url: string) =>
  automationIdentity('github.pr', sessionId, url);

export function observePullRequests(
  ledger: AutomationLedger,
  meta: SessionMeta,
  repoFullName: string,
  observations: readonly PrObservation[],
  now: number
): void {
  for (const observation of observations) {
    const checkpointId = pullRequestCheckpointId(meta.id, observation.url);
    const previous = ledger.checkpoint(checkpointId);
    const providerUpdatedAt = Date.parse(observation.updatedAt);
    if (
      !Number.isFinite(providerUpdatedAt) ||
      (typeof previous?.data.providerUpdatedAt === 'number' &&
        previous.data.providerUpdatedAt > providerUpdatedAt)
    )
      continue;
    const changed = previous && previous.data.status !== observation.status;
    ledger.observe(
      checkpointId,
      {
        revision: `${observation.updatedAt}:${observation.status}`,
        observedAt: now,
        data: {
          status: observation.status,
          providerUpdatedAt,
          repoFullName,
          prUrl: observation.url,
          prNumber: observation.number,
          branch: observation.headRefName,
          headSha: observation.headSha ?? null,
          headRepository: observation.headRepository ?? null,
        },
      },
      changed
        ? [
            {
              id: `${meta.id}:${observation.number}:${observation.updatedAt}:${observation.status}`,
              source: `github/repo/${repoFullName}`,
              type: `github.pr.${observation.status}`,
              version: 1,
              subject: `pr/${observation.number}`,
              occurredAt: providerUpdatedAt,
              observedAt: now,
              scope: {
                workspaceId: ledger.workspaceId,
                sessionId: meta.id,
                ...(meta.project?.kind === 'local'
                  ? { projectId: meta.project.localProjectId }
                  : {}),
              },
              data: {
                repoFullName,
                prUrl: observation.url,
                prNumber: observation.number,
                status: observation.status,
                branch: observation.headRefName,
                headSha: observation.headSha ?? null,
                headRepository: observation.headRepository ?? null,
              },
              provenance: 'poll',
              completeness:
                previous && now - previous.observedAt > 10 * 60_000 ? 'gap' : 'observed',
              correlationId: `github/repo/${repoFullName}/pr/${observation.number}`,
              depth: 0,
            },
          ]
        : []
    );
  }
}
