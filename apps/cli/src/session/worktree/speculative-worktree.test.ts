import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, RepoId, SessionId, WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { WorktreeInfo, WorktreeManager } from './worktree-manager';
import {
  claimSpeculativeWorktreeForDurableSession,
  completeSpeculativeWorktreeSetup,
  materializeSpeculativeWorktree,
  recoverStaleSpeculativeWorktrees,
} from './speculative-worktree';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as Logger;
}

function createManager(args: { sessionId: SessionId; alreadyExists?: boolean }) {
  const info: WorktreeInfo = {
    sessionId: args.sessionId,
    hostPath: `/tmp/${args.sessionId}`,
    branch: `lody/${args.sessionId}`,
    headSha: 'abc123',
    isClean: true,
  };
  const manager = {
    hasWorktree: vi.fn(() => args.alreadyExists ?? false),
    ensureRepo: vi.fn(async () => undefined),
    createWorktree: vi.fn(async () => info),
    removeWorktree: vi.fn(async () => undefined),
  } as unknown as WorktreeManager;
  return { manager, info };
}

function materializeArgs(manager: WorktreeManager, sessionId: SessionId) {
  return {
    preparationId: `prepare-${sessionId}`,
    sessionId,
    workspaceId: 'workspace-1' as WorkspaceId,
    machineId: 'machine-1' as MachineId,
    manager,
    managerConfig: {
      repoId: 'repo-1' as RepoId,
      source: {
        kind: 'local-shared' as const,
        originalRootPath: '/tmp/source',
      },
    },
    baseBranch: 'main',
    logger: createLogger(),
  };
}

function durableTarget(repoId: RepoId = 'repo-1' as RepoId) {
  return {
    repoId,
    source: {
      kind: 'local-shared' as const,
      originalRootPath: '/tmp/source',
    },
    baseBranch: 'main',
  };
}

describe('speculative worktree ownership', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'lody-speculative-worktree-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('removes a newly-created worktree when an unclaimed preparation is disposed', async () => {
    const sessionId = 'session-owned' as SessionId;
    const { manager, info } = createManager({ sessionId });
    const prepared = await materializeSpeculativeWorktree(materializeArgs(manager, sessionId));

    expect(prepared.info).toEqual(info);
    expect(manager.ensureRepo).toHaveBeenCalledTimes(1);
    expect(manager.createWorktree).toHaveBeenCalledWith(sessionId, 'main', undefined);

    await prepared.dispose();
    expect(manager.removeWorktree).toHaveBeenCalledWith(sessionId, true, undefined, {
      baseBranchName: 'main',
    });
  });

  it('preserves a pre-existing worktree when preparation is cancelled', async () => {
    const sessionId = 'session-existing' as SessionId;
    const { manager } = createManager({ sessionId, alreadyExists: true });
    const prepared = await materializeSpeculativeWorktree(materializeArgs(manager, sessionId));

    await prepared.dispose();
    expect(manager.removeWorktree).not.toHaveBeenCalled();
  });

  it('transfers ownership to the durable session', async () => {
    const sessionId = 'session-claimed' as SessionId;
    const { manager } = createManager({ sessionId });
    const prepared = await materializeSpeculativeWorktree(materializeArgs(manager, sessionId));

    await prepared.claim();
    await prepared.dispose();
    expect(manager.removeWorktree).not.toHaveBeenCalled();
  });

  it('does not recover an old marker while the session is active', async () => {
    const sessionId = 'session-active' as SessionId;
    const { manager } = createManager({ sessionId });
    const prepared = await materializeSpeculativeWorktree(materializeArgs(manager, sessionId));
    const isDurableSession = vi.fn(async () => false);

    await recoverStaleSpeculativeWorktrees({
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      logger: createLogger(),
      isActiveSession: (candidate) => candidate === sessionId,
      isDurableSession,
      nowMs: Date.now() + 11 * 60_000,
    });

    expect(isDurableSession).not.toHaveBeenCalled();
    await prepared.dispose();
    expect(manager.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it('claims an old marker when durable session metadata exists', async () => {
    const sessionId = 'session-durable' as SessionId;
    const { manager } = createManager({ sessionId });
    const prepared = await materializeSpeculativeWorktree(materializeArgs(manager, sessionId));

    await recoverStaleSpeculativeWorktrees({
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      logger: createLogger(),
      isDurableSession: async () => true,
      nowMs: Date.now() + 11 * 60_000,
    });

    expect(manager.removeWorktree).not.toHaveBeenCalled();
    await expect(
      claimSpeculativeWorktreeForDurableSession({
        sessionId,
        workspaceId: 'workspace-1' as WorkspaceId,
        machineId: 'machine-1' as MachineId,
        target: durableTarget(),
        logger: createLogger(),
      })
    ).resolves.toBe('claimed');
    await completeSpeculativeWorktreeSetup({
      sessionId,
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      target: durableTarget(),
    });
    await prepared.dispose();
    expect(manager.removeWorktree).not.toHaveBeenCalled();
  });

  it('discards a marker instead of transferring it to an incompatible durable target', async () => {
    const sessionId = 'session-incompatible-target' as SessionId;
    const { manager } = createManager({ sessionId, alreadyExists: true });
    const prepared = await materializeSpeculativeWorktree(materializeArgs(manager, sessionId));

    await expect(
      claimSpeculativeWorktreeForDurableSession({
        sessionId,
        workspaceId: 'workspace-1' as WorkspaceId,
        machineId: 'machine-1' as MachineId,
        target: durableTarget('repo-2' as RepoId),
        logger: createLogger(),
      })
    ).resolves.toBe('mismatch');
    await expect(
      claimSpeculativeWorktreeForDurableSession({
        sessionId,
        workspaceId: 'workspace-1' as WorkspaceId,
        machineId: 'machine-1' as MachineId,
        target: durableTarget(),
        logger: createLogger(),
      })
    ).resolves.toBe('no-marker');

    await prepared.dispose();
    expect(manager.removeWorktree).not.toHaveBeenCalled();
  });

  it('a superseded preparation dispose cannot delete its replacement worktree', async () => {
    const sessionId = 'session-superseded' as SessionId;
    const { manager } = createManager({ sessionId });
    const first = await materializeSpeculativeWorktree({
      ...materializeArgs(manager, sessionId),
      preparationId: 'prepare-1',
    });

    // The replacement starts materializing while the superseded preparation's
    // dispose is in flight — the exact overlap where an unserialized dispose
    // reads the old marker, loses the rewrite race, and deletes the worktree
    // the replacement just produced.
    const replacementPromise = materializeSpeculativeWorktree({
      ...materializeArgs(manager, sessionId),
      preparationId: 'prepare-2',
    });
    const disposePromise = first.dispose();
    await replacementPromise;
    await disposePromise;

    expect(manager.removeWorktree).not.toHaveBeenCalled();
    await expect(
      claimSpeculativeWorktreeForDurableSession({
        sessionId,
        workspaceId: 'workspace-1' as WorkspaceId,
        machineId: 'machine-1' as MachineId,
        target: durableTarget(),
        logger: createLogger(),
      })
    ).resolves.toBe('claimed');
  });
});
