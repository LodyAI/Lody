import {
  resolveProjectGitHubRepo,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorktreeCleanupScriptConfig,
  type WorktreeSetupScriptConfig,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { listWorkspaceGitHubRepositoriesForCliToken } from '@/lib/workspace';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import { readLegacySessionLaunchConfig } from '../session-launch-config-resolver';
import { readLocalProjectWorktreeCleanup } from './worktree-setup-config-store';

export type GitHubRepoWorktreeConfig = {
  worktreeSetup?: WorktreeSetupScriptConfig;
  worktreeCleanup?: WorktreeCleanupScriptConfig;
};

export async function resolveGitHubRepoWorktreeConfig(input: {
  token: string;
  workspaceId: WorkspaceId;
  repoFullName: string | undefined;
  logger: Logger;
}): Promise<GitHubRepoWorktreeConfig | null> {
  const normalizedRepo = input.repoFullName?.trim();
  if (!normalizedRepo) {
    return null;
  }
  try {
    const repositories = await listWorkspaceGitHubRepositoriesForCliToken({
      token: input.token,
      workspaceId: input.workspaceId,
    });
    return repositories.find((repo) => repo.fullName === normalizedRepo) ?? null;
  } catch (error) {
    input.logger.debug(
      `[worktree] Failed to read GitHub repo worktree config for ${normalizedRepo}: ${formatErrorMessage(
        error
      )}`
    );
    return null;
  }
}

export async function resolveSessionWorktreeCleanupConfig(input: {
  token: string;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
  sessionMeta: SessionMeta | undefined;
  workspaceDocument: LoroDocumentManager;
  logger: Logger;
}): Promise<WorktreeCleanupScriptConfig | null> {
  const { sessionMeta } = input;
  if (sessionMeta?.project?.kind === 'local' && sessionMeta.isWorktree === true) {
    return await readLocalProjectWorktreeCleanup(sessionMeta.project.localProjectId);
  }
  if (sessionMeta?.project !== undefined && sessionMeta.project.kind !== 'github') {
    return null;
  }

  const repoFullName = resolveProjectGitHubRepo(sessionMeta?.project) ?? sessionMeta?.repoFullName;
  return (
    (
      await resolveGitHubRepoWorktreeConfig({
        token: input.token,
        workspaceId: input.workspaceId,
        repoFullName,
        logger: input.logger,
      })
    )?.worktreeCleanup ??
    (
      await readLegacySessionLaunchConfig({
        repo: input.workspaceDocument.repo,
        workspaceId: input.workspaceId,
        machineId: input.machineId,
        sessionId: input.sessionId,
        sessionMeta,
        logger: input.logger,
      })
    )?.worktreeCleanup ??
    null
  );
}
