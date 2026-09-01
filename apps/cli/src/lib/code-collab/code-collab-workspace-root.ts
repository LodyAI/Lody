import type { SessionId } from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { getWorktreeManager } from '@/session/worktree/worktree-manager';
import type { Logger } from '@/utils/logger';

export function resolveCodeCollabLocalProjectWorkspaceRoot(options: {
  readonly originalRootPath: string;
  readonly ownerSessionId: SessionId;
  readonly isWorktree: boolean;
  readonly logger: Logger;
}): string | null {
  if (!options.isWorktree) {
    return options.originalRootPath;
  }

  const worktreeManager = getWorktreeManager({
    repoId: deriveRepoIdFromLocalProjectPath(options.originalRootPath),
    source: {
      kind: 'local-shared',
      originalRootPath: options.originalRootPath,
    },
    logger: options.logger,
  });
  if (!worktreeManager.hasWorktree(options.ownerSessionId)) {
    return null;
  }
  return worktreeManager.getWorktreeHostPath(options.ownerSessionId);
}
