import {
  resolveProjectGitHubRepo,
  readPullRequestLifecycle,
  type SessionPullRequestLifecycleFields,
  type LocalProjectId,
  type ProjectRef,
  type SessionMeta,
} from '@lody/shared';

export type DiffStatsMetadata = {
  readonly project?: unknown;
  readonly repoFullName?: unknown;
  readonly diffStats?: SessionMeta['diffStats'];
  readonly pullRequests?: unknown;
};

export type GitHubDiffStatsTarget = {
  kind: 'github';
  ownerRoomId: string;
  repoFullName: string;
};

export type LocalDiffStatsTarget = {
  kind: 'local';
  ownerRoomId: string;
  localProjectId: LocalProjectId;
};

export type UnknownDiffStatsTarget = {
  kind: 'unknown';
  ownerRoomId: string;
  reason: 'unresolved-project';
};

export type DiffStatsTarget = GitHubDiffStatsTarget | LocalDiffStatsTarget | UnknownDiffStatsTarget;

function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const next = value.trim();
  return next ? next : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLocalProjectId(value: unknown): value is LocalProjectId {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSessionDiffStats(value: unknown): value is NonNullable<SessionMeta['diffStats']> {
  if (!isObjectRecord(value) || !isObjectRecord(value.allChange)) return false;
  return typeof value.allChange.add === 'number' && typeof value.allChange.del === 'number';
}

export function readDiffStatsMetadata(value: unknown): DiffStatsMetadata | undefined {
  if (!isObjectRecord(value)) return undefined;
  return {
    ...(value.project === undefined ? {} : { project: value.project }),
    ...(typeof value.repoFullName === 'string' ? { repoFullName: value.repoFullName } : {}),
    ...(isSessionDiffStats(value.diffStats) ? { diffStats: value.diffStats } : {}),
    ...(value.pullRequests === undefined
      ? {}
      : {
          pullRequests: Array.isArray(value.pullRequests)
            ? value.pullRequests.map((pr) => {
                if (!isObjectRecord(pr) || typeof pr.url !== 'string') return pr;
                const lifecycle = readPullRequestLifecycle(
                  value as SessionPullRequestLifecycleFields,
                  pr.url
                );
                return lifecycle ? { ...pr, status: lifecycle.s } : pr;
              })
            : value.pullRequests,
        }),
  };
}

function metaGitHubRepo(meta: DiffStatsMetadata | undefined): string | undefined {
  if (!meta) return undefined;
  return resolveProjectGitHubRepo(meta.project) ?? trimmed(meta.repoFullName);
}

function localProjectIdFromProject(project: ProjectRef | undefined): LocalProjectId | undefined {
  return project?.kind === 'local' ? project.localProjectId : undefined;
}

function localProjectIdFromMeta(meta: DiffStatsMetadata | undefined): LocalProjectId | undefined {
  const project = meta?.project;
  if (!isObjectRecord(project) || project.kind !== 'local') return undefined;
  return isLocalProjectId(project.localProjectId) ? project.localProjectId : undefined;
}

export function resolveDiffStatsTarget(options: {
  ownerRoomId: string;
  project?: ProjectRef;
  activeMeta?: DiffStatsMetadata;
  ownerMeta?: DiffStatsMetadata;
}): DiffStatsTarget {
  const repoFullName =
    resolveProjectGitHubRepo(options.project) ??
    metaGitHubRepo(options.ownerMeta) ??
    metaGitHubRepo(options.activeMeta);
  if (repoFullName) {
    return {
      kind: 'github',
      ownerRoomId: options.ownerRoomId,
      repoFullName,
    };
  }

  const localProjectId =
    localProjectIdFromProject(options.project) ??
    localProjectIdFromMeta(options.ownerMeta) ??
    localProjectIdFromMeta(options.activeMeta);
  if (localProjectId) {
    return {
      kind: 'local',
      ownerRoomId: options.ownerRoomId,
      localProjectId,
    };
  }

  return {
    kind: 'unknown',
    ownerRoomId: options.ownerRoomId,
    reason: 'unresolved-project',
  };
}

export function resolveCodeCollabAllChangesDiffStatsPatch(options: {
  target: DiffStatsTarget;
  ownerMeta?: DiffStatsMetadata;
  diffStats: NonNullable<SessionMeta['diffStats']>;
}): Pick<SessionMeta, 'diffStats'> | null {
  if (options.target.kind === 'unknown') {
    return null;
  }
  if (
    options.target.kind === 'github' &&
    Array.isArray(options.ownerMeta?.pullRequests) &&
    options.ownerMeta.pullRequests.some(
      (pullRequest) => isObjectRecord(pullRequest) && pullRequest.status === 'open'
    )
  ) {
    return null;
  }

  const current = options.ownerMeta?.diffStats?.allChange;
  const next = options.diffStats.allChange;
  if (current?.add === next.add && current.del === next.del) {
    return null;
  }
  return { diffStats: options.diffStats };
}
