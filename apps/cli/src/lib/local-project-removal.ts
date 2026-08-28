import {
  getServerNow,
  type LocalProjectId,
  type LocalProjectWorktreeCleanupItem,
  type LocalProjectWorktreeCleanupPreflightResult,
  type LocalProjectWorktreeCleanupResult,
  type MachineId,
  type SessionMeta,
} from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { getWorktreeManager } from '@/session/worktree/worktree-manager';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

type LocalProjectWorktreeRemovalTarget = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  originalRootPath: string;
  sessions: readonly SessionMeta[];
  logger: Logger;
};

function getTargetSessions(target: LocalProjectWorktreeRemovalTarget): SessionMeta[] {
  return target.sessions.filter(
    (session) =>
      session.machineId === target.machineId &&
      !session.parentSessionId &&
      session.isWorktree === true &&
      session.project?.kind === 'local' &&
      session.project.localProjectId === target.localProjectId
  );
}

function toCleanupItem(session: SessionMeta, path: string): LocalProjectWorktreeCleanupItem {
  return {
    sessionId: session.id,
    title: session.title?.trim() || session.id,
    path,
  };
}

function getManager(target: LocalProjectWorktreeRemovalTarget) {
  return getWorktreeManager({
    repoId: deriveRepoIdFromLocalProjectPath(target.originalRootPath),
    source: { kind: 'local-shared', originalRootPath: target.originalRootPath },
    logger: target.logger,
  });
}

export async function preflightLocalProjectWorktreeRemoval(
  target: LocalProjectWorktreeRemovalTarget
): Promise<LocalProjectWorktreeCleanupPreflightResult> {
  const result: LocalProjectWorktreeCleanupPreflightResult = {
    clean: [],
    dirty: [],
    failed: [],
  };
  const manager = getManager(target);

  for (const session of getTargetSessions(target)) {
    const inspection = await manager.inspectWorktree(session.id);
    if (inspection.state === 'missing') continue;
    const item = toCleanupItem(session, inspection.path);
    if (inspection.state === 'clean') result.clean.push(item);
    if (inspection.state === 'dirty') result.dirty.push(item);
    if (inspection.state === 'failed') {
      result.failed.push({ ...item, message: inspection.message });
    }
  }

  return result;
}

/**
 * Remove only clean Lody-owned worktrees. Every worktree is inspected again
 * immediately before removal, and `removeWorktree(..., false)` performs its
 * own clean check under the repository lock. Dirty worktrees are never forced
 * or backup-committed by this workflow.
 */
export async function cleanupLocalProjectWorktrees(
  target: LocalProjectWorktreeRemovalTarget
): Promise<LocalProjectWorktreeCleanupResult> {
  const result: LocalProjectWorktreeCleanupResult = {
    completedAt: getServerNow(),
    deleted: [],
    skippedDirty: [],
    failed: [],
  };
  const manager = getManager(target);

  for (const session of getTargetSessions(target)) {
    const inspection = await manager.inspectWorktree(session.id);
    if (inspection.state === 'missing') continue;
    const item = toCleanupItem(session, inspection.path);
    if (inspection.state === 'dirty') {
      result.skippedDirty.push(item);
      continue;
    }
    if (inspection.state === 'failed') {
      result.failed.push({ ...item, message: inspection.message });
      continue;
    }

    try {
      await manager.removeWorktree(session.id, false, session.branchName, {
        baseBranchName: session.baseBranch,
      });
      result.deleted.push(item);
    } catch (error) {
      const latest = await manager.inspectWorktree(session.id);
      if (latest.state === 'dirty') {
        result.skippedDirty.push(toCleanupItem(session, latest.path));
      } else if (latest.state !== 'missing') {
        result.failed.push({ ...item, message: formatErrorMessage(error) });
      }
    }
  }

  result.completedAt = getServerNow();
  return result;
}
