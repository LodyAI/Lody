import { parseGitHubPullRequestUrl } from './github-url';
import type {
  PrStatus,
  SessionMeta,
  SessionPullRequestLifecycle,
  SessionPullRequestLifecycleFields,
  SessionPullRequestMeta,
} from './schema';

// GitHub revisions have second precision. Conflicting observations of the same
// revision converge deterministically. Live machine reads win equal-revision
// webhook ties; ambiguous webhook-only ties prefer terminal states. A later
// provider revision can reopen a closed PR. Arrival time is never a revision.
const STATUS_ORDER: Record<PrStatus, number> = { draft: 0, open: 1, closed: 2, merged: 3 };

export type PullRequestLifecycleObservation = { url: string; status: PrStatus; updatedAt: string };
export type SessionPullRequestSource = Pick<SessionMeta, 'pullRequests'> &
  SessionPullRequestLifecycleFields;

export function pullRequestLifecycleField(
  url: string,
  source: 'machine' | 'webhook' = 'machine'
): `prLifecycle:${string}` | null {
  const pr = parseGitHubPullRequestUrl(url);
  return pr
    ? `prLifecycle:${source}:https://github.com/${pr.repoFullName.toLowerCase()}/pull/${pr.prNumber}`
    : null;
}

function parseLifecycle(value: unknown): SessionPullRequestLifecycle | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SessionPullRequestLifecycle>;
  return typeof candidate.s === 'string' &&
    Object.hasOwn(STATUS_ORDER, candidate.s) &&
    typeof candidate.u === 'number' &&
    Number.isSafeInteger(candidate.u) &&
    candidate.u > 0
    ? { s: candidate.s, u: candidate.u }
    : undefined;
}

export function readPullRequestLifecycle(
  meta: SessionPullRequestLifecycleFields | undefined,
  url: string
): SessionPullRequestLifecycle | undefined {
  const values = (['machine', 'webhook'] as const).flatMap((source) => {
    const field = pullRequestLifecycleField(url, source);
    const value = parseLifecycle(field ? meta?.[field] : undefined);
    return value ? [value] : [];
  });
  // Stable sort retains the live-read source first when provider revisions tie.
  return values.sort((a, b) => b.u - a.u)[0];
}

/** Machine and webhook registers never overwrite each other. Compare provider revisions on read. */
export function planPullRequestLifecycle(
  observation: PullRequestLifecycleObservation,
  meta?: SessionPullRequestLifecycleFields,
  source: 'machine' | 'webhook' = 'machine'
) {
  const field = pullRequestLifecycleField(observation.url, source);
  const u = Date.parse(observation.updatedAt);
  if (
    !field ||
    !Number.isSafeInteger(u) ||
    u <= 0 ||
    !Object.hasOwn(STATUS_ORDER, observation.status)
  ) {
    return null;
  }
  const value: SessionPullRequestLifecycle = { s: observation.status, u };
  const newest = readPullRequestLifecycle(meta, observation.url);
  const existing = parseLifecycle(meta?.[field]);
  if (
    (newest && newest.u > u) ||
    (existing &&
      (existing.u > u ||
        (existing.u === u &&
          (existing.s === value.s ||
            (source === 'webhook' && STATUS_ORDER[existing.s] >= STATUS_ORDER[value.s])))))
  ) {
    return null;
  }
  return { field, value, peerId: `github-pr-lifecycle-v1-${STATUS_ORDER[value.s]}` };
}

/** Membership/order come ONLY from the association list. Orphan observations cannot resurrect it. */
export function resolveSessionPullRequests(
  meta: SessionPullRequestSource | null | undefined
): SessionPullRequestMeta[] {
  return (meta?.pullRequests ?? []).map((pr) => {
    const lifecycle = readPullRequestLifecycle(meta ?? undefined, pr.url);
    return lifecycle && lifecycle.s !== pr.status ? { ...pr, status: lifecycle.s } : pr;
  });
}
