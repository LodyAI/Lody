import { describe, expect, it, vi } from 'vitest';
import {
  machineFlockKeys,
  writeMachineFlockRowToFlock,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
  type MachineId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

import {
  resolveWorkspaceLocalProjectRootPathWithRetry,
  resolveWorkspaceLocalProjectWithSyncOnMiss,
  shouldArchiveSessionForLocalProjectRemoval,
  shouldApplyMachineDeleteLocalProjectCommand,
} from './local-project-meta';

describe('local project meta helpers', () => {
  it('does not apply a stale delete command to a newer re-added project', () => {
    const project: LocalProjectMeta = {
      id: 'local-project-newer' as LocalProjectId,
      name: 'Project',
      rootPath: '/repo',
      createdAtMs: 200,
    };

    expect(
      shouldApplyMachineDeleteLocalProjectCommand(project, {
        requestedAt: 100,
      })
    ).toBe(false);
    expect(
      shouldApplyMachineDeleteLocalProjectCommand(project, {
        requestedAt: 200,
      })
    ).toBe(true);
  });

  it('archives only unarchived sessions owned by the removed machine project', () => {
    const target = {
      machineId: 'machine-1' as MachineId,
      localProjectId: 'local-project-1' as LocalProjectId,
    };
    const session = {
      machineId: target.machineId,
      project: { kind: 'local', localProjectId: target.localProjectId },
      isArchived: false,
    } as SessionMeta;

    expect(shouldArchiveSessionForLocalProjectRemoval(session, target)).toBe(true);
    expect(
      shouldArchiveSessionForLocalProjectRemoval({ ...session, isArchived: true }, target)
    ).toBe(false);
    expect(
      shouldArchiveSessionForLocalProjectRemoval(
        { ...session, machineId: 'machine-2' as MachineId },
        target
      )
    ).toBe(false);
    expect(
      shouldArchiveSessionForLocalProjectRemoval(
        {
          ...session,
          project: {
            kind: 'local',
            localProjectId: 'local-project-2' as LocalProjectId,
          },
        },
        target
      )
    ).toBe(false);
    expect(
      shouldArchiveSessionForLocalProjectRemoval(
        {
          ...session,
          project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
        },
        target
      )
    ).toBe(false);
  });
});

class FakeMachineFlock implements MachineFlockWritableFlock {
  readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();

  scan(options?: { prefix?: readonly unknown[] }) {
    return [...this.rows.values()].filter((row) =>
      options?.prefix ? options.prefix.every((part, index) => row.key[index] === part) : true
    );
  }

  set(key: MachineFlockKey, value: unknown): void {
    this.rows.set(JSON.stringify(key), { key: [...key] as MachineFlockKey, value });
  }

  delete(key: MachineFlockKey): void {
    this.rows.delete(JSON.stringify(key));
  }

  commit(): void {}
}

const workspaceId = 'workspace-1' as WorkspaceId;
const machineId = 'machine-1' as MachineId;
const localProjectId = 'local-project-1' as LocalProjectId;
const projectMeta: LocalProjectMeta = {
  id: localProjectId,
  name: 'Local Project',
  rootPath: '/local/repo',
  createdAtMs: 1,
};

function seedLocalProject(flock: FakeMachineFlock): void {
  writeMachineFlockRowToFlock(
    flock,
    { key: machineFlockKeys.localProject(localProjectId), value: projectMeta },
    1
  );
}

function createRepo(flock: FakeMachineFlock) {
  const openFlockDoc = vi.fn(async () => ({ flock }));
  const repo = {
    getDocMeta: vi.fn(async () => undefined),
    openFlockDoc,
  } as unknown as LoroRepo;
  return { repo, openFlockDoc };
}

const instantSleep = () => vi.fn(async (_ms: number) => {});

describe('resolveWorkspaceLocalProjectWithSyncOnMiss', () => {
  it('re-reads the complete existing project after a confirmed sync', async () => {
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);
    const existing = {
      ...projectMeta,
      history: { codex: { lastListedAt: 2, sessions: {} } },
    } as LocalProjectMeta;
    const requestSync = vi.fn(async () => {
      writeMachineFlockRowToFlock(
        flock,
        { key: machineFlockKeys.localProject(localProjectId), value: existing },
        1
      );
      return true;
    });

    await expect(
      resolveWorkspaceLocalProjectWithSyncOnMiss(repo, workspaceId, machineId, localProjectId, {
        requestSync,
      })
    ).resolves.toEqual(existing);
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it('returns null when a confirmed sync still has no registration', async () => {
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);
    const requestSync = vi.fn(async () => true);

    await expect(
      resolveWorkspaceLocalProjectWithSyncOnMiss(repo, workspaceId, machineId, localProjectId, {
        requestSync,
      })
    ).resolves.toBeNull();
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it('allows a new local project when cloud sync is offline', async () => {
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);
    const requestSync = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      resolveWorkspaceLocalProjectWithSyncOnMiss(repo, workspaceId, machineId, localProjectId, {
        requestSync,
      })
    ).resolves.toBeNull();
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it('allows a new local project when the coordinator reports an incomplete sync', async () => {
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);

    await expect(
      resolveWorkspaceLocalProjectWithSyncOnMiss(repo, workspaceId, machineId, localProjectId, {
        requestSync: async () => false,
      })
    ).resolves.toBeNull();
  });

  it('does not let a stalled cloud sync block a new local project', async () => {
    vi.useFakeTimers();
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);

    try {
      const result = resolveWorkspaceLocalProjectWithSyncOnMiss(
        repo,
        workspaceId,
        machineId,
        localProjectId,
        {
          requestSync: () => new Promise<never>(() => {}),
          syncTimeoutMs: 1_500,
        }
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveWorkspaceLocalProjectRootPathWithRetry', () => {
  it('resolves on the first read without syncing or sleeping', async () => {
    const flock = new FakeMachineFlock();
    seedLocalProject(flock);
    const { repo, openFlockDoc } = createRepo(flock);
    const requestSync = vi.fn(async () => undefined);
    const sleep = instantSleep();
    const onRetry = vi.fn();

    const result = await resolveWorkspaceLocalProjectRootPathWithRetry(
      repo,
      workspaceId,
      machineId,
      localProjectId,
      { requestSync, sleep, onRetry, maxAttempts: 4, retryDelayMs: 400 }
    );

    expect(result).toBe('/local/repo');
    expect(openFlockDoc).toHaveBeenCalledTimes(1);
    expect(requestSync).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('resolves after the row arrives through a later sync', async () => {
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);
    let syncCalls = 0;
    const requestSync = vi.fn(async () => {
      syncCalls += 1;
      if (syncCalls === 2) {
        seedLocalProject(flock);
      }
    });
    const sleep = instantSleep();
    const onRetry = vi.fn();

    const result = await resolveWorkspaceLocalProjectRootPathWithRetry(
      repo,
      workspaceId,
      machineId,
      localProjectId,
      { requestSync, sleep, onRetry, maxAttempts: 4, retryDelayMs: 400 }
    );

    expect(result).toBe('/local/repo');
    expect(requestSync).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(400);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting all attempts', async () => {
    const flock = new FakeMachineFlock();
    const { repo, openFlockDoc } = createRepo(flock);
    const requestSync = vi.fn(async () => undefined);
    const sleep = instantSleep();
    const onRetry = vi.fn();

    const result = await resolveWorkspaceLocalProjectRootPathWithRetry(
      repo,
      workspaceId,
      machineId,
      localProjectId,
      { requestSync, sleep, onRetry, maxAttempts: 3, retryDelayMs: 250 }
    );

    expect(result).toBeNull();
    expect(openFlockDoc).toHaveBeenCalledTimes(3);
    expect(requestSync).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });

  it('keeps retrying when the sync attempt throws', async () => {
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);
    let syncCalls = 0;
    const requestSync = vi.fn(() => {
      syncCalls += 1;
      if (syncCalls === 1) {
        // Synchronous throw, not a rejection — worst-case stub behavior.
        throw new Error('sync unavailable');
      }
      seedLocalProject(flock);
      return Promise.resolve();
    });

    const result = await resolveWorkspaceLocalProjectRootPathWithRetry(
      repo,
      workspaceId,
      machineId,
      localProjectId,
      { requestSync, sleep: instantSleep(), maxAttempts: 4, retryDelayMs: 400 }
    );

    expect(result).toBe('/local/repo');
    expect(requestSync).toHaveBeenCalledTimes(2);
  });

  it('does not let an unbounded sync stall the retry loop', async () => {
    const flock = new FakeMachineFlock();
    const { repo, openFlockDoc } = createRepo(flock);
    // Never resolves — simulates the coordinator deduping onto an in-flight
    // sync with a much larger timeout of its own.
    const requestSync = vi.fn(() => new Promise<never>(() => {}));
    const sleep = instantSleep();

    const result = await resolveWorkspaceLocalProjectRootPathWithRetry(
      repo,
      workspaceId,
      machineId,
      localProjectId,
      { requestSync, sleep, maxAttempts: 3, retryDelayMs: 400, syncTimeoutMs: 1 }
    );

    // The helper must give up on the sync wait (not on the resolve): all
    // attempts still run, then null.
    expect(result).toBeNull();
    expect(openFlockDoc).toHaveBeenCalledTimes(3);
    expect(requestSync).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when speculative preparation is cancelled', async () => {
    const flock = new FakeMachineFlock();
    const { repo } = createRepo(flock);
    const controller = new AbortController();
    const sleep = instantSleep();
    const requestSync = vi.fn(async () => {
      controller.abort(new Error('preparation cancelled'));
    });

    await expect(
      resolveWorkspaceLocalProjectRootPathWithRetry(repo, workspaceId, machineId, localProjectId, {
        requestSync,
        sleep,
        signal: controller.signal,
      })
    ).rejects.toThrow('preparation cancelled');
    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
