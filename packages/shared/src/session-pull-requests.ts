import { parseGitHubPullRequestUrl } from './github-url';
import { resolveProjectGitHubRepo } from './project';
import { isPullRequestUnlinked, readSessionPullRequestLinks } from './session-pull-request-links';
import { parsePullRequestUrl } from './pull-request-url';
// The PR field types/helpers live in a loro-free module so boot-path consumers
// of this file (session list atoms, notifications) do not pull the
// loro-mirror/loro-crdt graph through `./schema`.
import {
  deriveSessionPullRequestReadiness,
  getSessionPullRequestLegacyFields,
  type PrStatus,
  type SessionPullRequestCiState,
  type SessionPullRequestLifecycle,
  type SessionPullRequestLifecycleFields,
  type SessionPullRequestLinkFields,
  type SessionPullRequestMergeState,
  type SessionPullRequestMeta,
  type SessionPullRequestReadiness,
  type SessionPullRequestStateMeta,
} from './session-pull-request-meta';
import type { SessionMeta } from './schema';

// GitHub revisions have second precision. Conflicting observations of the same
// revision converge deterministically. Live machine reads win equal-revision
// webhook ties; ambiguous webhook-only ties prefer terminal states. A later
// provider revision can reopen a closed PR. Arrival time is never a revision.
const STATUS_ORDER: Record<PrStatus, number> = { draft: 0, open: 1, closed: 2, merged: 3 };

export type PullRequestLifecycleObservation = { url: string; status: PrStatus; updatedAt: string };
export type SessionPullRequestSource = Pick<SessionMeta, 'pullRequests'> &
  SessionPullRequestLifecycleFields &
  Partial<SessionPullRequestLinkFields>;

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

/**
 * Membership/order come ONLY from the association list. Orphan observations
 * cannot resurrect it, and an unlinked URL is hidden here (for every reader)
 * before the reconciler removes it from the list.
 */
export function resolveSessionPullRequests(
  meta: SessionPullRequestSource | null | undefined
): SessionPullRequestMeta[] {
  return (meta?.pullRequests ?? [])
    .flatMap((pr) => (isPullRequestUnlinked(meta, pr.url) ? [] : [pr]))
    .map((pr) => {
      const lifecycle = readPullRequestLifecycle(meta ?? undefined, pr.url);
      return lifecycle && lifecycle.s !== pr.status ? { ...pr, status: lifecycle.s } : pr;
    });
}

/** Summary of one associated PR. Identity comes from its URL; deprecated legacy
 *  `repository`/`number` fields apply only when the URL does not parse. */
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

export type SessionPullRequestViewSource = SessionPullRequestSource &
  Partial<Pick<SessionMeta, 'pullRequestState' | 'project' | 'projectRun' | 'repoFullName'>>;

export function resolveSessionPullRequestViews(
  meta: SessionPullRequestViewSource | null | undefined
): SessionPullRequestView[] {
  const prs = resolveSessionPullRequests(meta);
  const identities = prs.map((pr) => {
    const parts = parseGitHubPullRequestUrl(pr.url);
    const legacy = getSessionPullRequestLegacyFields(pr);
    return {
      repoFullName: parts?.repoFullName ?? (legacy.repository?.trim() || null),
      number:
        parts?.prNumber ??
        (typeof legacy.number === 'number' && Number.isFinite(legacy.number)
          ? legacy.number
          : null),
    };
  });
  const lastIndexByRepo = new Map<string, number>();
  identities.forEach(({ repoFullName }, index) => {
    if (repoFullName) lastIndexByRepo.set(repoFullName.toLowerCase(), index);
  });
  return prs.map((pr, index) => {
    const { repoFullName, number } = identities[index]!;
    const state = meta?.pullRequestState?.[pr.url] ?? null;
    return {
      url: pr.url,
      repoFullName,
      number,
      status: pr.status,
      ci: state?.s ?? null,
      merge: state?.m ?? null,
      readiness: deriveSessionPullRequestReadiness(state),
      current: !!repoFullName && lastIndexByRepo.get(repoFullName.toLowerCase()) === index,
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
    ? views.filter((view) => view.repoFullName?.toLowerCase() === target)
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
  const views = resolveSessionPullRequestViews(meta);
  return selectPrimarySessionPullRequest(
    views,
    resolveDescribedRepository(meta, activeRepository, views)
  );
}

/**
 * The repository a single-PR surface describes; see `selectPrimarySessionPullRequest`.
 * A single-project Session describes its project repository whenever it holds a
 * PR there, so a PR linked in another repository never takes the primary slot.
 */
function resolveDescribedRepository(
  meta: SessionPullRequestViewSource | null | undefined,
  activeRepository: string | null | undefined,
  views: readonly SessionPullRequestView[]
): string | null | undefined {
  if (activeRepository !== undefined) return activeRepository?.trim() || null;
  const project = (resolveProjectGitHubRepo(meta?.project) ?? meta?.repoFullName)?.trim() || null;
  if (meta?.projectRun) return project;
  return project && views.some((view) => view.repoFullName?.toLowerCase() === project.toLowerCase())
    ? project
    : undefined;
}

/**
 * Every PR a single-PR surface can list as its history, in the scope
 * `resolveSessionPrimaryPullRequest` describes. Associations are append-only,
 * so an older PR stays listed after a newer one becomes primary. The primary
 * PR comes first; the rest follow newest association first.
 */
export function resolveSessionPullRequestHistory(
  meta: SessionPullRequestViewSource | null | undefined,
  activeRepository?: string | null
): SessionPullRequestView[] {
  const all = resolveSessionPullRequestViews(meta);
  const repository = resolveDescribedRepository(meta, activeRepository, all);
  if (repository === null) return [];
  const target = repository?.toLowerCase();
  const views = all.filter((view) => !target || view.repoFullName?.toLowerCase() === target);
  const primary = selectPrimarySessionPullRequest(views);
  return primary ? [primary, ...views.filter((view) => view !== primary).reverse()] : [];
}

export type SessionPullRequestLinkListItem =
  | {
      kind: 'associated';
      url: string;
      view: SessionPullRequestView;
      /** The PR single-PR surfaces show (`resolveSessionPrimaryPullRequest`). */
      primary: boolean;
    }
  | {
      kind: 'pending';
      url: string;
      repoFullName: string | null;
      number: number | null;
      /**
       * `checking`: linked, not yet confirmed by the provider; `unreadable`: the
       * machine's provider account could not read it; `unsupported`: no provider
       * Lody supports accepts this URL yet.
       */
      reason: 'checking' | 'unreadable' | 'unsupported';
    };

/**
 * Every pull request a Session holds, across repositories, for the linked-PR
 * list: the primary PR first, other associations newest first, then linked
 * records the reconciler has not associated (oldest first) with a reason.
 */
export function resolveSessionPullRequestLinkList(
  meta: (SessionPullRequestViewSource & Partial<SessionPullRequestLinkFields>) | null | undefined,
  activeRepository?: string | null
): SessionPullRequestLinkListItem[] {
  const views = resolveSessionPullRequestViews(meta);
  const primary = resolveSessionPrimaryPullRequest(meta, activeRepository);
  const ordered = [
    ...(primary ? [primary] : []),
    ...views.filter((view) => view.url !== primary?.url).reverse(),
  ];
  const associatedKeys = new Set(
    views.map((view) => parsePullRequestUrl(view.url)?.key ?? view.url.toLowerCase())
  );
  const items: SessionPullRequestLinkListItem[] = ordered.map((view) => ({
    kind: 'associated',
    url: view.url,
    view,
    primary: view.url === primary?.url,
  }));
  for (const record of readSessionPullRequestLinks(meta)) {
    if (record.state !== 'linked' || associatedKeys.has(record.key)) continue;
    const parts = parsePullRequestUrl(record.url);
    items.push({
      kind: 'pending',
      url: record.url,
      repoFullName: parts?.repoFullName ?? null,
      number: parts?.number ?? null,
      reason: !record.supported ? 'unsupported' : record.unreadableAt ? 'unreadable' : 'checking',
    });
  }
  return items;
}
