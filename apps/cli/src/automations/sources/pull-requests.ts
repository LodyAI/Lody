import type {
  PrPromptProvider,
  SessionMeta,
  SessionPullRequestCiState,
  SessionPullRequestMergeState,
} from '@lody/shared';
import type { PrObservation } from '@/lib/pr-poller/github-graphql-client';
import { AutomationLedger, automationIdentity } from '../storage/ledger';

export type PullRequestCheckStatus = 'passed' | 'failed' | 'pending' | 'none';
export type PullRequestMergeability = 'clean' | 'conflicts' | 'behind' | 'blocked' | 'unknown';

export type NormalizedPullRequestObservation = {
  provider: PrPromptProvider;
  url: string;
  repoFullName?: string;
  number?: number;
  status: 'open' | 'draft' | 'merged' | 'closed';
  headSha?: string;
  branch?: string;
  headRepository?: string;
  checks: PullRequestCheckStatus;
  mergeability: PullRequestMergeability;
  observedAt: number;
  providerUpdatedAt?: number;
};

export const pullRequestCheckpointId = (sessionId: string, url: string) =>
  automationIdentity('github.pr', sessionId, url);

export function inferPullRequestProvider(url: string): PrPromptProvider {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
    if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab';
    if (url.includes('/-/merge_requests/')) return 'gitlab';
    return 'other';
  } catch {
    return 'other';
  }
}

export function mapGitHubCiState(
  ciState: SessionPullRequestCiState | null | undefined
): PullRequestCheckStatus {
  if (ciState === 's') return 'passed';
  if (ciState === 'f' || ciState === 'e') return 'failed';
  if (ciState === 'p' || ciState === 'x') return 'pending';
  return 'none';
}

export function mapGitHubMergeState(
  mergeState: SessionPullRequestMergeState | null | undefined
): PullRequestMergeability {
  if (mergeState === 'c' || mergeState === 'u') return 'clean';
  if (mergeState === 'd') return 'conflicts';
  if (mergeState === 'h') return 'behind';
  if (mergeState === 'b') return 'blocked';
  return 'unknown';
}

/** Provider-neutral PR/MR observation writer consumed by Auto delivery and policies. */
export function observeNormalizedPullRequest(
  ledger: AutomationLedger,
  meta: SessionMeta,
  observation: NormalizedPullRequestObservation,
  extra?: {
    ciState?: SessionPullRequestCiState | null;
    mergeState?: SessionPullRequestMergeState | null;
    updatedAtRaw?: string;
  }
): void {
  const checkpointId = pullRequestCheckpointId(meta.id, observation.url);
  const previous = ledger.checkpoint(checkpointId);
  const providerUpdatedAt = observation.providerUpdatedAt ?? observation.observedAt;
  if (
    !Number.isFinite(providerUpdatedAt) ||
    (typeof previous?.data.providerUpdatedAt === 'number' &&
      previous.data.providerUpdatedAt > providerUpdatedAt)
  )
    return;
  const changed = previous && previous.data.status !== observation.status;
  const updatedKey = extra?.updatedAtRaw ?? String(providerUpdatedAt);
  const repoFullName = observation.repoFullName ?? observation.url;
  const prNumber = observation.number ?? 0;
  ledger.observe(
    checkpointId,
    {
      revision: `${updatedKey}:${observation.status}:${observation.headSha ?? ''}:${observation.checks}:${observation.mergeability}`,
      observedAt: observation.observedAt,
      data: {
        provider: observation.provider,
        status: observation.status,
        providerUpdatedAt,
        ...(observation.repoFullName ? { repoFullName: observation.repoFullName } : {}),
        prUrl: observation.url,
        ...(observation.number !== undefined ? { prNumber: observation.number } : {}),
        ...(observation.branch ? { branch: observation.branch } : {}),
        headSha: observation.headSha ?? null,
        headRepository: observation.headRepository ?? null,
        checks: observation.checks,
        mergeability: observation.mergeability,
        ...(extra?.ciState !== undefined ? { ciState: extra.ciState } : {}),
        ...(extra?.mergeState !== undefined ? { mergeState: extra.mergeState } : {}),
      },
    },
    changed
      ? [
          {
            id: `${meta.id}:${prNumber}:${updatedKey}:${observation.status}`,
            source: `${observation.provider}/repo/${repoFullName}`,
            type: `github.pr.${observation.status}`,
            version: 1,
            subject: `pr/${prNumber}`,
            occurredAt: providerUpdatedAt,
            observedAt: observation.observedAt,
            scope: {
              workspaceId: ledger.workspaceId,
              sessionId: meta.id,
              ...(meta.project?.kind === 'local' ? { projectId: meta.project.localProjectId } : {}),
            },
            data: {
              provider: observation.provider,
              repoFullName,
              prUrl: observation.url,
              prNumber,
              status: observation.status,
              branch: observation.branch ?? null,
              headSha: observation.headSha ?? null,
              headRepository: observation.headRepository ?? null,
            },
            provenance: 'poll',
            completeness:
              previous && observation.observedAt - previous.observedAt > 10 * 60_000
                ? 'gap'
                : 'observed',
            correlationId: `${observation.provider}/repo/${repoFullName}/pr/${prNumber}`,
            depth: 0,
          },
        ]
      : []
  );
}

export function observePullRequests(
  ledger: AutomationLedger,
  meta: SessionMeta,
  repoFullName: string,
  observations: readonly PrObservation[],
  now: number
): void {
  for (const observation of observations) {
    const providerUpdatedAt = Date.parse(observation.updatedAt);
    if (!Number.isFinite(providerUpdatedAt)) continue;
    observeNormalizedPullRequest(
      ledger,
      meta,
      {
        provider: 'github',
        url: observation.url,
        repoFullName,
        number: observation.number,
        status: observation.status,
        ...(observation.headSha ? { headSha: observation.headSha } : {}),
        branch: observation.headRefName,
        ...(observation.headRepository ? { headRepository: observation.headRepository } : {}),
        checks: mapGitHubCiState(observation.ciState),
        mergeability: mapGitHubMergeState(observation.mergeState),
        observedAt: now,
        providerUpdatedAt,
      },
      {
        ciState: observation.ciState,
        mergeState: observation.mergeState,
        updatedAtRaw: observation.updatedAt,
      }
    );
  }
}
