import {
  isDirectLocalProject,
  parseGitHubPullRequestUrl,
  resolveProjectGitHubRepo,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

/**
 * Target projection (spec `specs/pr-status-reconciler.md` — Target 投影).
 *
 * Pure function from the local metadata replica to the reconciler's target
 * set. Knows nothing about priority, quota, or GitHub — those are separate
 * concepts consuming this output.
 */

/**
 * An associated PR whose last known status is open/draft: refresh lifecycle,
 * CI rollup, and merge/conflict state. Keyed by the canonical PR URL exactly
 * as stored in session meta (also the write-back upsert key).
 */
export type PrPollStatusTarget = {
  url: string;
  repoFullName: string;
  prNumber: number;
  status: 'open' | 'draft';
};

/**
 * A `(repository, runtime head branch)` query for the newest PR on that
 * branch. Exists whenever the repository context is resolvable, the branch is
 * Session-owned, and the owner is not idle-terminal — including when an
 * open/draft PR is already associated (a newer PR on the same branch must
 * still be discovered).
 */
export type PrPollDiscoveryTarget = {
  repoFullName: string;
  branch: string;
};

/** Polling view of one owner session (child tabs folded into their owner). */
export type PrPollSessionEntry = {
  ownerSessionId: SessionId;
  /** Owner + all child tab session ids; any of them being viewed counts. */
  memberSessionIds: SessionId[];
  /** Newest `lastMessageAt` across members — the conversation-activity signal. */
  lastMessageAtMs: number | null;
  /** Runtime head branch (never `baseBranch`); null when unresolvable. */
  runtimeBranch: string | null;
  statusTargets: PrPollStatusTarget[];
  discoveryTarget: PrPollDiscoveryTarget | null;
};

export type AliveSessionMeta = {
  sessionId: SessionId;
  meta: SessionMeta;
};

/** Repo resolution is injectable so callers can cache per session. */
export type ResolveSessionGitHubRepo = (meta: SessionMeta) => string | undefined;

const defaultResolveGitHubRepo: ResolveSessionGitHubRepo = (meta) =>
  resolveProjectGitHubRepo(meta.project);

/**
 * Working branch for discovery: the runtime branch ONLY. Never fall back to
 * `baseBranch` — that is the session's starting ref (often `main`), and
 * querying PRs headed by it can permanently associate an unrelated PR through
 * the backend.
 */
export function resolveDiscoveryBranch(meta: SessionMeta): string | undefined {
  const branch = meta.branchName?.trim();
  return branch ? branch : undefined;
}

/**
 * The idle-terminal fingerprint: "this exact `(repository, branch)` context
 * has already had a successful discovery". Stored per owner in the local
 * scheduling state; a branch switch changes the fingerprint and re-enables
 * discovery automatically.
 */
export function computeDiscoveryFingerprint(repoFullName: string, branch: string): string {
  return `${repoFullName}|${branch}`;
}

/**
 * Repository context of an owner meta (used both by target projection and by
 * the pre-write revalidation: a branch/repo switch while a GitHub request was
 * in flight must invalidate that request's discovery results).
 */
export function resolveOwnerRepositoryContext(
  meta: SessionMeta,
  resolveGitHubRepo: ResolveSessionGitHubRepo = defaultResolveGitHubRepo
): { repoFullName: string | null; branch: string | null } {
  return {
    repoFullName: resolveGitHubRepo(meta) ?? null,
    branch: resolveDiscoveryBranch(meta) ?? null,
  };
}

/** The current PR is the LAST item of `pullRequests` (shared metadata contract). */
export function getCurrentPullRequest(
  meta: Pick<SessionMeta, 'pullRequests'> | undefined
): NonNullable<SessionMeta['pullRequests']>[number] | null {
  return (meta?.pullRequests ?? []).at(-1) ?? null;
}

/**
 * Enumerate per-owner targets from the workspace's alive session metas.
 *
 * Owner normalization follows `turn-post-processing-service.ts`:
 * `parentSessionId ?? sessionId`. A child whose owner meta is not in the
 * alive set is skipped — there is no owner doc to poll or write back to.
 *
 * `discoveryFingerprints` is the persisted per-owner fingerprint map (see
 * `computeDiscoveryFingerprint`); it drives the idle-terminal rule.
 */
export function enumeratePrPollTargets(
  sessions: readonly AliveSessionMeta[],
  discoveryFingerprints: Readonly<Record<string, string>> = {},
  resolveGitHubRepo: ResolveSessionGitHubRepo = defaultResolveGitHubRepo
): PrPollSessionEntry[] {
  const metaBySessionId = new Map<SessionId, SessionMeta>();
  for (const { sessionId, meta } of sessions) {
    metaBySessionId.set(sessionId, meta);
  }

  const entries = new Map<SessionId, PrPollSessionEntry>();
  for (const { sessionId, meta } of sessions) {
    const ownerSessionId = meta.parentSessionId ?? sessionId;
    const existing = entries.get(ownerSessionId);
    if (existing) {
      existing.memberSessionIds.push(sessionId);
      existing.lastMessageAtMs = maxNullable(existing.lastMessageAtMs, meta.lastMessageAt ?? null);
      continue;
    }

    const ownerMeta = metaBySessionId.get(ownerSessionId);
    if (!ownerMeta || ownerMeta.isArchived) {
      // No owner doc to write back to, or the owner is archived (excluded
      // from tracking entirely — no targets, no quota).
      continue;
    }

    const runtimeBranch = resolveDiscoveryBranch(ownerMeta) ?? null;
    const prPollingEnabled = !isDirectLocalProject(ownerMeta.project, ownerMeta.isWorktree);
    entries.set(ownerSessionId, {
      ownerSessionId,
      memberSessionIds: [sessionId],
      lastMessageAtMs: maxNullable(
        ownerMeta.lastMessageAt ?? null,
        sessionId === ownerSessionId ? null : (meta.lastMessageAt ?? null)
      ),
      runtimeBranch,
      statusTargets: prPollingEnabled ? collectStatusTargets(ownerMeta) : [],
      discoveryTarget: prPollingEnabled
        ? collectDiscoveryTarget(
            ownerMeta,
            runtimeBranch,
            discoveryFingerprints[ownerSessionId],
            resolveGitHubRepo
          )
        : null,
    });
  }

  return Array.from(entries.values());
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function collectStatusTargets(ownerMeta: SessionMeta): PrPollStatusTarget[] {
  const targets: PrPollStatusTarget[] = [];
  const seen = new Set<string>();
  for (const pr of ownerMeta.pullRequests ?? []) {
    if (pr.status !== 'open' && pr.status !== 'draft') {
      continue;
    }
    const parsed = parseGitHubPullRequestUrl(pr.url);
    if (!parsed || seen.has(pr.url)) {
      // Malformed/duplicate association: target-local skip, never fatal.
      continue;
    }
    seen.add(pr.url);
    targets.push({
      url: pr.url,
      repoFullName: parsed.repoFullName,
      prNumber: parsed.prNumber,
      status: pr.status,
    });
  }
  return targets;
}

function collectDiscoveryTarget(
  ownerMeta: SessionMeta,
  runtimeBranch: string | null,
  ownerFingerprint: string | undefined,
  resolveGitHubRepo: ResolveSessionGitHubRepo
): PrPollDiscoveryTarget | null {
  const repoFullName = resolveGitHubRepo(ownerMeta);
  if (!repoFullName || !runtimeBranch) {
    // Unresolvable repository context: explicit skip, no guessing.
    return null;
  }
  // Idle-terminal: the current PR (last array item) is terminal AND this exact
  // (repo, branch) context has already had a successful discovery. Only a
  // context change (fingerprint mismatch) re-enables discovery.
  const current = (ownerMeta.pullRequests ?? []).at(-1);
  if (
    current &&
    (current.status === 'merged' || current.status === 'closed') &&
    ownerFingerprint === computeDiscoveryFingerprint(repoFullName, runtimeBranch)
  ) {
    return null;
  }
  return { repoFullName, branch: runtimeBranch };
}
