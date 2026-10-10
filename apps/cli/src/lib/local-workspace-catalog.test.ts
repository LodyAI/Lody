import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, ManagedRuntime } from 'effect';
import { fileLockLayer, type FileLocks } from '@/utils/file-lock';

let runtime: ManagedRuntime.ManagedRuntime<FileLocks, never>;
const runCatalog = <A, E>(effect: Effect.Effect<A, E, FileLocks>) => runtime.runPromise(effect);
import {
  localCatalogWorkspaceToWorkspaceListItem,
  makeLocalWorkspaceCatalog,
} from './local-workspace-catalog';

let tempDir: string | undefined;

const makeCatalog = () => {
  if (!tempDir) {
    throw new Error('tempDir not initialized');
  }
  return makeLocalWorkspaceCatalog({
    filePath: path.join(tempDir, 'workspace-catalog.json'),
    lockName: `local-workspace-catalog-test-${path.basename(tempDir)}`,
  });
};

describe('LocalWorkspaceCatalog', () => {
  beforeEach(async () => {
    runtime = ManagedRuntime.make(fileLockLayer);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-local-catalog-'));
  });

  afterEach(async () => {
    await runtime.dispose();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('treats a missing catalog as empty', async () => {
    const catalog = makeCatalog();

    await expect(runCatalog(catalog.read())).resolves.toEqual({
      version: 1,
      identity: null,
      machine: null,
      workspaces: [],
      sessions: [],
    });
  });

  it('caches remote workspaces and marks omitted workspaces as remote_missing', async () => {
    const catalog = makeCatalog();
    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1', email: 'user@example.com', name: 'User One' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [
          { id: 'workspace-1', name: 'Alpha', slug: 'alpha', role: 'owner' },
          { id: 'workspace-2', name: 'Beta', slug: null, role: 'member' },
        ],
      })
    );

    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1', email: 'user@example.com', name: 'User One' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [{ id: 'workspace-2', name: 'Beta', slug: null, role: 'admin' }],
      })
    );

    const snapshot = await runCatalog(catalog.read());
    expect(snapshot.workspaces).toHaveLength(2);
    expect(
      snapshot.workspaces.find((workspace) => workspace.workspaceId === 'workspace-2')
    ).toMatchObject({
      workspaceId: 'workspace-2',
      state: 'active',
      role: 'admin',
    });
    expect(
      snapshot.workspaces.find((workspace) => workspace.workspaceId === 'workspace-1')
    ).toMatchObject({
      workspaceId: 'workspace-1',
      state: 'remote_missing',
    });

    const active = await runCatalog(catalog.listActiveWorkspaces());
    expect(active.map(localCatalogWorkspaceToWorkspaceListItem)).toEqual([
      { id: 'workspace-2', name: 'Beta', slug: null, role: 'admin' },
    ]);
  });

  it('records workspace access snapshots and preserves them across remote refreshes', async () => {
    const catalog = makeCatalog();
    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [{ id: 'workspace-1', name: 'Alpha', slug: 'alpha', role: 'owner' }],
      })
    );
    await runCatalog(
      catalog.recordWorkspaceAccessSnapshot({
        workspaceId: 'workspace-1',
        accessSnapshot: {
          ownerUserId: 'user-1',
          verifiedAt: '2026-07-02T00:00:00.000Z',
        },
      })
    );
    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [{ id: 'workspace-1', name: 'Alpha Renamed', slug: 'alpha', role: 'admin' }],
      })
    );

    const active = (await runCatalog(catalog.read())).workspaces.find(
      (workspace) => workspace.workspaceId === 'workspace-1'
    );
    expect(active).toMatchObject({
      workspaceId: 'workspace-1',
      name: 'Alpha Renamed',
      accessSnapshot: {
        ownerUserId: 'user-1',
        verifiedAt: '2026-07-02T00:00:00.000Z',
      },
    });

    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [],
      })
    );
    const missing = (await runCatalog(catalog.read())).workspaces.find(
      (workspace) => workspace.workspaceId === 'workspace-1'
    );
    expect(missing).toMatchObject({
      state: 'remote_missing',
      accessSnapshot: {
        ownerUserId: 'user-1',
      },
    });
  });

  it('clears a cached allow when recordWorkspaceAccessSnapshot is called with null', async () => {
    const catalog = makeCatalog();
    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [{ id: 'workspace-1', name: 'Alpha', slug: 'alpha', role: 'owner' }],
      })
    );
    await runCatalog(
      catalog.recordWorkspaceAccessSnapshot({
        workspaceId: 'workspace-1',
        accessSnapshot: { ownerUserId: 'user-1', verifiedAt: '2026-07-02T00:00:00.000Z' },
      })
    );
    await runCatalog(
      catalog.recordWorkspaceAccessSnapshot({ workspaceId: 'workspace-1', accessSnapshot: null })
    );

    const workspace = (await runCatalog(catalog.read())).workspaces.find(
      (item) => item.workspaceId === 'workspace-1'
    );
    expect(workspace?.accessSnapshot).toBeUndefined();
  });

  it('backs up corrupt catalog files and rebuilds an empty catalog', async () => {
    if (!tempDir) {
      throw new Error('tempDir not initialized');
    }
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    await fs.writeFile(filePath, '{not-json', 'utf8');

    const catalog = makeCatalog();
    await expect(runCatalog(catalog.read())).resolves.toMatchObject({
      version: 1,
      workspaces: [],
    });

    const entries = await fs.readdir(tempDir);
    expect(entries.some((entry) => entry.startsWith('workspace-catalog.json.corrupt-'))).toBe(true);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('"version": 1');
  });

  it('serializes concurrent writes in one process', async () => {
    const catalog = makeCatalog();

    await Promise.all(
      ['session-1', 'session-2', 'session-3'].map((sessionId) =>
        runCatalog(
          catalog.upsertSession({
            sessionId,
            workspaceId: 'workspace-1',
            origin: 'offline',
            authorUserId: 'user-1',
          })
        )
      )
    );

    const snapshot = await runCatalog(catalog.read());
    expect(snapshot.sessions.map((session) => session.sessionId).sort()).toEqual([
      'session-1',
      'session-2',
      'session-3',
    ]);
  });

  it('serves repeated reads from the process cache', async () => {
    if (!tempDir) {
      throw new Error('tempDir not initialized');
    }
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    const catalog = makeLocalWorkspaceCatalog({
      filePath,
      lockName: `local-workspace-catalog-cache-test-${path.basename(tempDir)}`,
      cacheTtlMs: 60_000,
    });

    await expect(runCatalog(catalog.read())).resolves.toMatchObject({ version: 1 });
    await fs.writeFile(filePath, '{invalid-after-cache-warm', 'utf8');

    await expect(runCatalog(catalog.read())).resolves.toMatchObject({ version: 1 });
    expect((await fs.readdir(tempDir)).some((entry) => entry.includes('.corrupt-'))).toBe(false);
  });

  it('refreshes an expired cache in the background without blocking the current read', async () => {
    if (!tempDir) {
      throw new Error('tempDir not initialized');
    }
    let now = 0;
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    const catalog = makeLocalWorkspaceCatalog({
      filePath,
      lockName: `local-workspace-catalog-refresh-test-${path.basename(tempDir)}`,
      cacheTtlMs: 10,
      now: () => now,
    });
    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1' },
        workspaces: [{ id: 'workspace-1', name: 'Alpha', slug: 'alpha', role: 'owner' }],
      })
    );
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1' },
        workspaces: [
          {
            workspaceId: 'workspace-1',
            name: 'Alpha Updated',
            slug: 'alpha',
            role: 'owner',
            state: 'active',
            cachedAt: 1,
          },
        ],
        sessions: [],
      })}\n`,
      'utf8'
    );

    now = 11;
    const stale = await runCatalog(catalog.read());
    expect(stale.workspaces[0]?.name).toBe('Alpha');
    await vi.waitFor(async () => {
      const refreshed = await runCatalog(catalog.read());
      expect(refreshed.workspaces[0]?.name).toBe('Alpha Updated');
    });
  });
});
