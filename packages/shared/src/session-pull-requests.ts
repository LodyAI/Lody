import { parseGitHubPullRequestUrl } from './github-url';
import { resolveProjectGitHubRepo } from './project';
import {
  deriveSessionPullRequestReadiness,
  getSessionPullRequestLegacyFields,
  type PrStatus,
  type SessionMeta,
  type SessionPullRequestCiState,
  type SessionPullRequestLifecycle,
  type SessionPullRequestLifecycleFields,
  type SessionPullRequestMergeState,
  type SessionPullRequestMeta,
  type SessionPullRequestReadiness,
  type SessionPullRequestStateMeta,
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

/**
 * Everything a surface needs to summarize one associated PR. Every summary
 * (sidebar, task list, Info Bar, actions) reads these views, so two surfaces
 * showing the same metadata cannot disagree. Live detail reads never feed them.
 */
export type SessionPullRequestView = {
  url: string;
  repoFullName: string | null;
  number: number | null;
  status: PrStatus;
  ci: SessionPullRequestCiState | null;
  merge: SessionPullRequestMergeState | null;
  readiness: SessionPullRequestReadiness | null;
  /** The last associated PR of its repository: the reconciler's current PR. */
  current: boolean;
  /** Resolved association entry, legacy detail fields included. */
  pr: SessionPullRequestMeta;
  state: SessionPullRequestStateMeta | null;
};

/**
 * The metadata the views derive from. Explicit subscribe/unsubscribe records
 * join this type and are merged with the discovered association list in
 * `resolveSessionPullRequestViews` only.
 */
export type SessionPullRequestViewSource = SessionPullRequestSource &
  Partial<Pick<SessionMeta, 'pullRequestState' | 'project' | 'projectRun' | 'repoFullName'>>;

export function resolveSessionPullRequestViews(
  meta: SessionPullRequestViewSource | null | undefined
): SessionPullRequestView[] {
  const prs = resolveSessionPullRequests(meta);
  const lastIndexByRepo = new Map<string, number>();
  const parsed = prs.map((pr) => parseGitHubPullRequestUrl(pr.url));
  parsed.forEach((parts, index) => {
    if (parts) lastIndexByRepo.set(parts.repoFullName.toLowerCase(), index);
  });
  return prs.map((pr, index) => {
    const parts = parsed[index];
    const legacy = getSessionPullRequestLegacyFields(pr);
    const state = meta?.pullRequestState?.[pr.url] ?? null;
    return {
      url: pr.url,
      repoFullName: legacy.repository?.trim() || parts?.repoFullName || null,
      number:
        typeof legacy.number === 'number' && Number.isFinite(legacy.number)
          ? legacy.number
          : (parts?.prNumber ?? null),
      status: pr.status,
      ci: state?.s ?? null,
      merge: state?.m ?? null,
      readiness: deriveSessionPullRequestReadiness(state),
      current: !!parts && lastIndexByRepo.get(parts.repoFullName.toLowerCase()) === index,
      pr,
      state,
    };
  });
}

/**
 * The PR a single-PR surface shows. `repository` undefined keeps the legacy
 * whole-session rule (newest legacy `reportedAt`, else the last association);
 * a name restricts it to that repository; `null` means a Member without a
 * GitHub repository, which has no PR.
 */
export function selectPrimarySessionPullRequest(
  views: readonly SessionPullRequestView[],
  repository?: string | null
): SessionPullRequestView | null {
  if (repository === null) return null;
  const target = repository?.trim().toLowerCase();
  const candidates = target
    ? views.filter(
        (view) => parseGitHubPullRequestUrl(view.url)?.repoFullName.toLowerCase() === target
      )
    : views;
  if (!candidates.some((view) => getSessionPullRequestLegacyFields(view.pr).reportedAt)) {
    return candidates[candidates.length - 1] ?? null;
  }
  return (
    [...candidates].sort((a, b) =>
      (getSessionPullRequestLegacyFields(b.pr).reportedAt ?? '').localeCompare(
        getSessionPullRequestLegacyFields(a.pr).reportedAt ?? ''
      )
    )[0] ?? null
  );
}

/**
 * The session's primary PR as the Info Bar describes it by default. A Project
 * group, or a caller naming the active repository, describes one repository;
 * otherwise the whole session's latest PR.
 */
export function resolveSessionPrimaryPullRequest(
  meta: SessionPullRequestViewSource | null | undefined,
  activeRepository?: string | null
): SessionPullRequestView | null {
  const legacyRepository =
    (resolveProjectGitHubRepo(meta?.project) ?? meta?.repoFullName)?.trim() || null;
  const repository =
    activeRepository !== undefined
      ? activeRepository?.trim() || null
      : meta?.projectRun
        ? legacyRepository
        : undefined;
  return selectPrimarySessionPullRequest(resolveSessionPullRequestViews(meta), repository);
}
