import { useEffect, useMemo, useState } from 'react';
import {
  GitHubFileNotFoundError,
  githubFetchDefaultBranch,
  githubFetchFileAtCommit,
  type ProjectMemberId,
  type ProjectMemberSource,
} from '@lody/shared';
import { withGitHubTokenRetry } from '@/lib/github-token';
import { parseGitmodules, resolveSubmoduleRepo } from '@/lib/gitmodules';
import type { DetectedProjectSubmodule, ProjectGroupMemberDraft } from '@/lib/project-group-form';
import { getProjectMemberSourceKey } from '@/lib/project-group-form';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';

const GITMODULES_MAX_BYTES = 64 * 1024;

/** What one member's repository declares, and which GitHub repository it is. */
export type ProjectSubmoduleProbeResult = {
  repoFullName?: string;
  /** False for a local directory that is not a Git repository. */
  isGit?: boolean;
  submodules: DetectedProjectSubmodule[];
};

/**
 * Reads one member's declared submodules.
 * - `undefined`: this source cannot be read here; the editor marks it "not checked".
 * - `null`: deliberately not asked (its machine is offline); no mark, no error —
 *   an offline remote is not something the editor should report.
 */
export type ProjectSubmoduleProbe = (
  source: ProjectMemberSource
) => Promise<ProjectSubmoduleProbeResult | undefined | null>;

export type ProjectSubmoduleDetection = {
  detected: ReadonlyMap<ProjectMemberId, readonly DetectedProjectSubmodule[]>;
  /** The GitHub repository each member was found to be, local members included. */
  repositories: ReadonlyMap<ProjectMemberId, string>;
  /** Members found to be local directories without Git. */
  nonGit: ReadonlySet<ProjectMemberId>;
  /** Members still being read. */
  pending: ReadonlySet<ProjectMemberId>;
  /** Members whose repository could not be read; their placement stays manual. */
  unavailable: ReadonlySet<ProjectMemberId>;
};

// Per source and base branch, for the life of the page: reopening the editor
// or adding a member must not re-read every other member's `.gitmodules`.
const probeCache = new Map<string, Promise<ProjectSubmoduleProbeResult | undefined | null>>();

const probeKey = (source: ProjectMemberSource) =>
  `${getProjectMemberSourceKey(source)}@${source.baseBranch ?? ''}`;

export function createGitHubSubmoduleProbe(workspaceId: string): ProjectSubmoduleProbe {
  return async (source) => {
    if (source.kind !== 'github') return undefined;
    const repo = source.repoFullName;
    return await withGitHubTokenRetry(workspaceId, repo, async (token) => {
      const ref = source.baseBranch ?? (await githubFetchDefaultBranch(token, repo));
      let text: string;
      try {
        text = await githubFetchFileAtCommit(token, repo, '.gitmodules', ref, {
          maxBytes: GITMODULES_MAX_BYTES,
        });
      } catch (error) {
        if (error instanceof GitHubFileNotFoundError) return { repoFullName: repo, submodules: [] };
        throw error;
      }
      return {
        repoFullName: repo,
        submodules: parseGitmodules(text).map((entry) => ({
          path: entry.path,
          repoFullName: resolveSubmoduleRepo(entry.url, repo),
        })),
      };
    });
  };
}

/**
 * Detect submodule relationships for the members of an open editor.
 *
 * Detection only reads; applying its result to the form is the caller's
 * decision (see `applyDetectedProjectSubmodules`), so a member the user placed
 * by hand is never moved by a late answer.
 */
export function useProjectSubmoduleDetection(
  members: readonly ProjectGroupMemberDraft[],
  options: {
    enabled: boolean;
    probeLocal?: ProjectSubmoduleProbe;
    /**
     * A local copy to read a repository Member from instead of GitHub: the
     * same `.gitmodules`, without a GitHub token, so it also works where GitHub
     * integration does not exist.
     */
    localCopyOf?: (
      source: Extract<ProjectMemberSource, { kind: 'github' }>
    ) => Extract<ProjectMemberSource, { kind: 'local' }> | undefined;
  }
): ProjectSubmoduleDetection {
  const { workspaceId } = useResolvedWorkspaceScope();
  const githubProbe = useMemo(
    () => (workspaceId ? createGitHubSubmoduleProbe(workspaceId) : undefined),
    [workspaceId]
  );
  const { enabled, probeLocal, localCopyOf } = options;

  // Only the sources matter; a placement edit must not restart detection.
  const sourcesKey = members.map((member) => `${member.id}=${probeKey(member.source)}`).join('\n');
  const [results, setResults] = useState<
    ReadonlyMap<ProjectMemberId, ProjectSubmoduleProbeResult | undefined | null | 'error'>
  >(new Map());

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const targets = members.map((member) => ({ id: member.id, source: member.source }));
    for (const { id, source } of targets) {
      const repoFullName = source.kind === 'github' ? source.repoFullName : undefined;
      const copy = source.kind === 'github' && probeLocal ? localCopyOf?.(source) : undefined;
      const probe: ProjectSubmoduleProbe | undefined =
        copy && probeLocal
          ? async () => {
              const result = await probeLocal(copy);
              // The member is the repository, whatever the copy's remote says.
              return result ? { ...result, repoFullName } : result;
            }
          : source.kind === 'github'
            ? githubProbe
            : probeLocal;
      if (!probe) {
        setResults((previous) => new Map(previous).set(id, undefined));
        continue;
      }
      const key = copy
        ? `${probeKey(source)}@${getProjectMemberSourceKey(copy)}`
        : probeKey(source);
      let request = probeCache.get(key);
      if (!request) {
        request = probe(source);
        probeCache.set(key, request);
        // A failure is not an answer worth keeping: the next open retries.
        request.catch(() => probeCache.delete(key));
      }
      void request.then(
        (value) => {
          if (!cancelled) setResults((previous) => new Map(previous).set(id, value));
        },
        () => {
          if (!cancelled) setResults((previous) => new Map(previous).set(id, 'error'));
        }
      );
    }
    return () => {
      cancelled = true;
    };
    // `sourcesKey` stands for `members`' sources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, githubProbe, localCopyOf, probeLocal, sourcesKey]);

  return useMemo(() => {
    const detected = new Map<ProjectMemberId, readonly DetectedProjectSubmodule[]>();
    const repositories = new Map<ProjectMemberId, string>();
    const nonGit = new Set<ProjectMemberId>();
    const pending = new Set<ProjectMemberId>();
    const unavailable = new Set<ProjectMemberId>();
    for (const member of members) {
      if (!results.has(member.id)) {
        if (enabled) pending.add(member.id);
        continue;
      }
      const value = results.get(member.id);
      if (value === null) continue;
      if (value === 'error' || value === undefined) {
        unavailable.add(member.id);
        continue;
      }
      detected.set(member.id, value.submodules);
      if (value.isGit === false) nonGit.add(member.id);
      if (value.repoFullName) repositories.set(member.id, value.repoFullName);
    }
    return { detected, repositories, nonGit, pending, unavailable };
  }, [enabled, members, results]);
}
