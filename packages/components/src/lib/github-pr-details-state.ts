import type { GitHubPullRequestDetails, PrStatus } from '@lody/shared';

export const GITHUB_REPOSITORY_CONNECTION_GUIDANCE =
  'Lody cannot confirm this PR’s repository connection to the current workspace. In Settings > GitHub, ask a workspace administrator to connect the GitHub App and check access to this repository, then retry. If it is already connected, ask them to verify the original repository and PR association. Signing in with the local GitHub CLI does not establish this connection.';

/** A verified PR still needs a workspace repository/association check before hosted operations. */
export class GitHubRepositoryIdentityError extends Error {
  override name = 'GitHubRepositoryIdentityError';
}

export function isGitHubRepositoryConnectionError(error: unknown): boolean {
  return (
    error instanceof GitHubRepositoryIdentityError ||
    (error instanceof Error && 'code' in error && error.code === 'repo_not_linked')
  );
}

/**
 * A PR counts as draft when GitHub reports it via the explicit `draft` flag or
 * the `mergeableState === 'draft'` signal (the REST details payload sometimes
 * carries only the latter). Single source of truth for that predicate, shared
 * by `derivePrStatusFromDetails`, `resolvePrAnalyticsStatus`, and
 * `resolveMergeKind` so the three derivations can't drift apart.
 */
export function isDraftPr(pullRequest: GitHubPullRequestDetails): boolean {
  return pullRequest.draft || pullRequest.mergeableState === 'draft';
}

/**
 * Collapse live GitHub PR details into the coarse {@link PrStatus} used by the
 * persisted session meta and every PR badge (sidebar, session header, task
 * list, archive, mobile).
 */
export function derivePrStatusFromDetails(pullRequest: GitHubPullRequestDetails): PrStatus {
  if (pullRequest.merged) return 'merged';
  if (pullRequest.state === 'closed') return 'closed';
  if (isDraftPr(pullRequest)) return 'draft';
  return 'open';
}

export function isPullRequestMergeabilityPending(
  pullRequest: GitHubPullRequestDetails | null | undefined
): boolean {
  if (!pullRequest) return false;
  if (pullRequest.merged || pullRequest.state === 'closed' || pullRequest.draft) return false;
  return pullRequest.mergeable === null || pullRequest.mergeableState === 'unknown';
}

export function isPullRequestReadyForReviewTransitionPending(
  pullRequest: GitHubPullRequestDetails | null | undefined
): boolean {
  if (!pullRequest) return false;
  if (pullRequest.merged || pullRequest.state === 'closed') return false;
  if (isDraftPr(pullRequest)) return true;
  return isPullRequestMergeabilityPending(pullRequest);
}

function parseUpdatedAt(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isIncomingNewer(
  previous: GitHubPullRequestDetails,
  incoming: GitHubPullRequestDetails
): boolean {
  const previousUpdatedAt = parseUpdatedAt(previous.updatedAt);
  const incomingUpdatedAt = parseUpdatedAt(incoming.updatedAt);
  if (previousUpdatedAt === null || incomingUpdatedAt === null) return true;
  return incomingUpdatedAt > previousUpdatedAt;
}

function isStaleDraftRollback(
  previous: GitHubPullRequestDetails,
  incoming: GitHubPullRequestDetails
): boolean {
  if (isDraftPr(previous)) return false;
  if (!isDraftPr(incoming)) return false;
  return !isIncomingNewer(previous, incoming);
}

export function mergePullRequestDetailsState(
  previous: GitHubPullRequestDetails | null | undefined,
  incoming: GitHubPullRequestDetails
): GitHubPullRequestDetails {
  if (!previous || previous.number !== incoming.number) {
    return incoming;
  }

  if (previous.merged && !incoming.merged) {
    const mergedAt = previous.mergedAt ?? incoming.mergedAt;

    return {
      ...incoming,
      merged: true,
      state: 'closed',
      mergedAt,
      closedAt: previous.closedAt ?? incoming.closedAt ?? mergedAt,
    };
  }

  if (isStaleDraftRollback(previous, incoming)) {
    return {
      ...incoming,
      draft: false,
      mergeable: previous.mergeable,
      mergeableState: previous.mergeableState,
      updatedAt: previous.updatedAt,
    };
  }

  return incoming;
}
