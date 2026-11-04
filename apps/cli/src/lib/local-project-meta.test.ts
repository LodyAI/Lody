import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  machineFlockKeys,
  writeMachineFlockRowToFlock,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { localProjectsLegacy } from '@lody/shared/node/local-project';

import {
  readMachineLocalProjects,
  reconcileMachineLocalProjectRootPaths,
  resolveWorkspaceLocalProjectRootPathWithRetry,
  resolveWorkspaceLocalProjectWithSyncOnMiss,
  shouldApplyMachineDeleteLocalProjectCommand,
  upsertMachineLocalProject,
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
  const openFlockDoc = vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => {}) }));
  const repo = {
    getDocMeta: vi.fn(async () => undefined),
    openFlockDoc,
    flush: vi.fn(async () => {}),
  } as unknown as LoroRepo;
  return { repo, openFlockDoc };
}

describe('local project root path publishing', () => {
  it('preserves display state during catalog refresh and promotes only on explicit add', async () => {
    const { repo } = createRepo(new FakeMachineFlock());
    const sync = { markMachineFlockDocDirty() {} };
    const read = async () =>
      (await readMachineLocalProjects(repo, workspaceId, machineId))[projectMeta.id];
    await upsertMachineLocalProject(
      repo,
      workspaceId,
      machineId,
      { ...projectMeta, standaloneVisible: false },
      1,
      { sync }
    );
    await upsertMachineLocalProject(repo, workspaceId, machineId, projectMeta, 2, { sync });
    expect((await read())?.standaloneVisible).toBe(false);
    await upsertMachineLocalProject(repo, workspaceId, machineId, projectMeta, 3, {
      sync,
      standaloneVisible: true,
    });
    expect((await read())?.standaloneVisible).toBe(true);
    // A stale history/catalog writer must not undo the explicit addition.
    await upsertMachineLocalProject(
      repo,
      workspaceId,
      machineId,
      { ...projectMeta, standaloneVisible: false },
      4,
      { sync }
    );
    expect((await read())?.standaloneVisible).toBe(true);
  });

  it('publishes, refreshes and removes GitHub identity without losing it on other row writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'local-remote-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: rootPath, env: { ...process.env, GIT_CONFIG_COUNT: '0' } });
    try {
      git(['init']);
      git(['remote', 'add', 'origin', 'https://github.com/example/first.git']);
      const { repo } = createRepo(new FakeMachineFlock());
      const project = { ...projectMeta, rootPath };
      const sync = { markMachineFlockDocDirty() {} };
      const read = async () =>
        (await readMachineLocalProjects(repo, workspaceId, machineId))[project.id];
      await upsertMachineLocalProject(repo, workspaceId, machineId, project, 1, {
        sync,
        reason: 'local-project-add',
        refreshGitHubRemote: true,
      });
      expect((await read())?.githubRepoFullName).toBe('example/first');
      await upsertMachineLocalProject(
        repo,
        workspaceId,
        machineId,
        { ...project, name: 'Renamed' },
        2,
        { sync }
      );
      expect((await read())?.githubRepoFullName).toBe('example/first');
      git(['remote', 'set-url', 'origin', 'git@github.com:example/second.git']);
      await reconcileMachineLocalProjectRootPaths(repo, workspaceId, machineId, sync);
      expect((await read())?.githubRepoFullName).toBe('example/second');
      expect((await read())?.name).toBe('Renamed');
      git(['remote', 'remove', 'origin']);
      await reconcileMachineLocalProjectRootPaths(repo, workspaceId, machineId, sync);
      expect((await read())?.githubRepoFullName).toBeUndefined();
      await upsertMachineLocalProject(
        repo,
        workspaceId,
        machineId,
        { ...project, githubRepoFullName: 'example/first' },
        3,
        { sync }
      );
      expect((await read())?.githubRepoFullName).toBeUndefined();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('repairs an older symlink row and canonicalizes later writes without changing its identity', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'lody-project-path-'));
    try {
      const target = join(temp, 'target');
      const alias = join(temp, 'alias');
      mkdirSync(target);
      symlinkSync(target, alias, 'dir');
      const flock = new FakeMachineFlock();
      const { repo } = createRepo(flock);
      const oldProject = {
        ...projectMeta,
        rootPath: alias,
        history: { codex: { lastListedAt: 1, sessions: {} } },
      } as LocalProjectMeta;
      writeMachineFlockRowToFlock(
        flock,
        { key: machineFlockKeys.localProject(localProjectId), value: oldProject },
        1
      );
      const sync = { markMachineFlockDocDirty: vi.fn() };

      await reconcileMachineLocalProjectRootPaths(repo, workspaceId, machineId, sync);
      const repaired = (await readMachineLocalProjects(repo, workspaceId, machineId))[
        localProjectId
      ];
      expect(repaired).toEqual({
        ...oldProject,
        rootPath: realpathSync.native(target),
      });
      expect(deriveRepoIdFromLocalProjectPath(repaired.rootPath)).toBe(
        deriveRepoIdFromLocalProjectPath(realpathSync.native(target))
      );

      await upsertMachineLocalProject(
        repo,
        workspaceId,
        machineId,
        {
          ...oldProject,
          lastOpenedAtMs: 2,
        },
        2,
        { sync }
      );
      expect(
        (await readMachineLocalProjects(repo, workspaceId, machineId))[localProjectId]
      ).toEqual({
        ...oldProject,
        rootPath: realpathSync.native(target),
        lastOpenedAtMs: 2,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

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
  it('ignores an encrypted registry row whose path no longer hashes to its project ID', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lody-project-identity-')));
    try {
      const shared = join(root, 'shared');
      const privateRoot = join(root, 'private');
      mkdirSync(shared);
      mkdirSync(privateRoot);
      const sharedId = localProjectsLegacy.createLocalProjectId(shared);
      const flock = new FakeMachineFlock();
      const write = (rootPath: string) =>
        writeMachineFlockRowToFlock(
          flock,
          {
            key: machineFlockKeys.localProject(sharedId),
            value: { id: sharedId, name: 'Shared', rootPath, createdAtMs: 1 },
          },
          1
        );
      const { repo } = createRepo(flock);
      const resolve = (verifyProjectIdentity: boolean) =>
        resolveWorkspaceLocalProjectRootPathWithRetry(repo, workspaceId, machineId, sharedId, {
          verifyProjectIdentity,
          sleep: instantSleep(),
          maxAttempts: 1,
        });
      write(shared);
      expect(await resolve(true)).toBe(shared);
      // Another member rewrites the synced row to point at a private directory.
      write(privateRoot);
      expect(await resolve(true)).toBeNull();
      // Ordinary workspaces keep their existing behavior.
      expect(await resolve(false)).toBe(privateRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('gives a row that is still syncing at least 30s by default before failing', async () => {
    vi.useFakeTimers();
    try {
      const flock = new FakeMachineFlock();
      const { repo } = createRepo(flock);
      const requestSync = vi.fn(() => new Promise<never>(() => {}));
      let settled = false;
      const resolving = resolveWorkspaceLocalProjectRootPathWithRetry(
        repo,
        workspaceId,
        machineId,
        localProjectId,
        { requestSync, sleep: instantSleep() }
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await resolving).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
