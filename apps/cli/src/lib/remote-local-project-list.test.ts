import { describe, expect, it, vi } from 'vitest';
import {
  machineFlockKeys,
  writeMachineFlockRowToFlock,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

import type { AuthContext } from '@/lib/command-runtime';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { WorkspaceSummary } from '@/lib/workspace';
import { shouldUseRemoteProjectCatalog } from '@/commands/project';

import { listRemoteLocalProjects, selectRemoteProjectMachine } from './remote-local-project-list';

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

const workspaceId = 'workspace-fixture' as WorkspaceId;
const authMachineId = '11111111-1111-4111-8111-111111111111' as MachineId;
const targetMachineId = '22222222-2222-4222-8222-222222222222' as MachineId;
const targetMachine: MachineMeta = {
  id: targetMachineId,
  name: 'developer-host',
  cliVersion: '0.92.1',
  os: 'linux',
  sessions: [],
};
const auth: AuthContext = {
  token: 'synthetic-token-do-not-send',
  userId: 'synthetic-user',
  userName: 'Fixture User',
  userEmail: 'fixture@example.invalid',
  machineId: authMachineId,
  machineName: 'headless-client',
};
const workspace: WorkspaceSummary = {
  id: workspaceId,
  slug: 'fixture',
  name: 'Fixture workspace',
  role: 'member',
};

function project(
  id: string,
  name: string,
  rootPath: string,
  createdAtMs: number
): LocalProjectMeta {
  return { id: id as LocalProjectId, name, rootPath, createdAtMs };
}

function createFixtureManager(options: { syncError?: Error } = {}) {
  const flock = new FakeMachineFlock();
  const legacy = {
    'local-project-legacy': project('local-project-legacy', 'legacy', '/synthetic/legacy', 100),
    'local-project-shared': project('local-project-shared', 'stale-name', '/synthetic/stale', 100),
  } as Record<LocalProjectId, LocalProjectMeta>;
  const repo = {
    getDocMeta: vi.fn(async () => ({ meta: { localProjects: legacy } })),
    openFlockDoc: vi.fn(async () => ({ flock })),
  } as unknown as LoroRepo;
  const manager = {
    repo,
    syncMetaOrThrow: vi.fn(async () => undefined),
    syncFlockDocOrThrow: vi.fn(async () => {
      if (options.syncError) throw options.syncError;
      writeMachineFlockRowToFlock(
        flock,
        {
          key: machineFlockKeys.localProject('local-project-shared' as LocalProjectId),
          value: project('local-project-shared', 'fresh-name', '/synthetic/fresh', 200),
        },
        200
      );
      writeMachineFlockRowToFlock(
        flock,
        {
          key: machineFlockKeys.localProject('local-project-denied' as LocalProjectId),
          value: project('local-project-denied', 'denied', '/synthetic/denied', 200),
        },
        200
      );
    }),
  } as unknown as LoroDocumentManager;
  return { manager, repo };
}

const fixtureDependencies = {
  listMachines: async () => [targetMachine],
  verifyAccess: async (input: { localProjectId?: LocalProjectId }) => ({
    allowed: input.localProjectId !== ('local-project-denied' as LocalProjectId),
    ...(input.localProjectId === ('local-project-denied' as LocalProjectId)
      ? { reason: 'project_not_shared' as const }
      : {}),
  }),
};

describe('remote local project list', () => {
  it('uses the remote path for any explicit selector, including the auth machine id', () => {
    expect(shouldUseRemoteProjectCatalog({})).toBe(false);
    expect(shouldUseRemoteProjectCatalog({ workspace: 'fixture' })).toBe(true);
    expect(shouldUseRemoteProjectCatalog({ machine: authMachineId })).toBe(true);
  });

  it('awaits the target Flock sync, merges legacy rows, and hides denied paths', async () => {
    const { manager } = createFixtureManager();

    const response = await listRemoteLocalProjects({
      manager,
      auth,
      workspace,
      machineSelector: 'developer-host',
      dependencies: fixtureDependencies,
    });

    expect(response).toEqual({
      ok: true,
      type: 'local-project/list',
      result: {
        workspaces: [
          {
            workspaceId,
            workspaceName: 'Fixture workspace',
            projects: [
              {
                localProjectId: 'local-project-shared',
                name: 'fresh-name',
                rootPath: '/synthetic/fresh',
              },
              {
                localProjectId: 'local-project-legacy',
                name: 'legacy',
                rootPath: '/synthetic/legacy',
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain('/synthetic/denied');
  });

  it('fails instead of returning a stale catalog when the target sync rejects', async () => {
    const { manager, repo } = createFixtureManager({ syncError: new Error('offline') });

    await expect(
      listRemoteLocalProjects({
        manager,
        auth,
        workspace,
        machineSelector: targetMachineId,
        dependencies: fixtureDependencies,
      })
    ).rejects.toThrow('offline');
    expect(repo.openFlockDoc).not.toHaveBeenCalled();
  });

  it('requires a unique machine name while accepting an exact id', () => {
    const duplicate = { ...targetMachine, id: authMachineId };
    expect(selectRemoteProjectMachine([targetMachine, duplicate], targetMachineId)).toBe(
      targetMachine
    );
    expect(() => selectRemoteProjectMachine([targetMachine, duplicate], 'developer-host')).toThrow(
      'Machine selector is ambiguous'
    );
  });
});
