import type { SessionMeta, SessionToCreate } from '@lody/shared';
import { resolveProjectGitHubRepo } from '@lody/shared';

function normalizeRepoFullName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export type LinkedWorkspaceGitHubRepo = {
  fullName?: string | null;
  repoFullName?: string | null;
  private?: boolean;
};

export function resolveLinkedWorkspaceGitHubRepo(
  repoFullName: string | null | undefined,
  repositories: Iterable<LinkedWorkspaceGitHubRepo> | null | undefined
): { fullName: string; isPublic?: boolean } | null {
  const trimmed = normalizeRepoFullName(repoFullName);
  if (!trimmed || !repositories) return null;
  const needle = trimmed.toLowerCase();
  for (const repo of repositories) {
    const candidate = normalizeRepoFullName(repo.fullName ?? repo.repoFullName);
    if (!candidate || candidate.toLowerCase() !== needle) continue;
    return {
      fullName: candidate,
      ...(typeof repo.private === 'boolean' ? { isPublic: !repo.private } : {}),
    };
  }
  return null;
}

export function resolveSessionRepoFullName(
  session: Pick<SessionMeta, 'project' | 'repoFullName'>
): string {
  return normalizeRepoFullName(resolveProjectGitHubRepo(session.project) ?? session.repoFullName);
}

export function resolveSessionCreateRepoFullName(
  session: Pick<SessionToCreate, 'project' | 'repoFullName'>
): string {
  return normalizeRepoFullName(resolveProjectGitHubRepo(session.project) ?? session.repoFullName);
}
