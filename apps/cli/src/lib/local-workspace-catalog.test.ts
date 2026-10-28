import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, ManagedRuntime } from 'effect';
import { fileLockLayer, type FileLocks } from '@/utils/file-lock';

let runtime: ManagedRuntime.ManagedRuntime<FileLocks, never>;
const runCatalog = <A, E>(effect: Effect.Effect<A, E, FileLocks>) => runtime.runPromise(effect);
import {
  localCatalogWorkspaceToWorkspaceListItem,
  CatalogCorruptError,
  CatalogPermissionError,
  makeLocalWorkspaceCatalog,
} from './local-workspace-catalog';

const legacyCatalogSchema = z.object({
  version: z.literal(1),
  identity: z.object({ userId: z.string() }),
  machine: z.object({ machineId: z.string() }),
  workspaces: z.array(
    z.object({
      workspaceId: z.string(),
      name: z.string(),
      slug: z.string().nullable(),
      role: z.string(),
      state: z.enum(['active', 'remote_missing']),
      cachedAt: z.number(),
    })
  ),
  sessions: z.array(z.unknown()),
});

let tempDir: string | undefined;
const originalLocksDir = process.env.LODY_LOCKS_DIR;

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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-local-catalog-'));
    process.env.LODY_LOCKS_DIR = path.join(tempDir, 'locks');
    runtime = ManagedRuntime.make(fileLockLayer);
  });

  afterEach(async () => {
    await runtime.dispose();
    if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
    else process.env.LODY_LOCKS_DIR = originalLocksDir;
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

  it('retains encrypted workspace evidence across restart without changing ordinary entries', async () => {
    const normal = { id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' };
    const encrypted = {
      id: 'encrypted',
      name: 'Encrypted',
      slug: null,
      role: 'owner',
      contentMode: 'e2ee',
      genesisHash: 'ab'.repeat(32),
    };
    await runCatalog(
      makeCatalog().cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [normal, encrypted],
      })
    );
    const reopened = await runCatalog(makeCatalog().listActiveWorkspaces());
    expect(reopened.map(localCatalogWorkspaceToWorkspaceListItem)).toEqual([normal, encrypted]);

    // The released v1 reader strips unknown row fields. Exercise that same
    // parsing behavior against the saved file rather than inspecting source.
    if (!tempDir) throw new Error('tempDir not initialized');
    const catalogPath = path.join(tempDir, 'workspace-catalog.json');
    const legacy = legacyCatalogSchema.parse(JSON.parse(await fs.readFile(catalogPath, 'utf8')));
    expect(legacy.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['ordinary']);
    // An old daemon may rewrite its own catalog; it cannot erase E2EE discovery.
    await fs.writeFile(catalogPath, JSON.stringify(legacy));
    expect(
      (await runCatalog(makeCatalog().listActiveWorkspaces())).map(
        localCatalogWorkspaceToWorkspaceListItem
      )
    ).toEqual([normal, encrypted]);
    // A different login cannot adopt the preserved sidecar's encrypted rows.
    await fs.writeFile(
      catalogPath,
      JSON.stringify({ ...legacy, identity: { userId: 'other-account' } })
    );
    expect(
      (await runCatalog(makeCatalog().listActiveWorkspaces())).map(
        localCatalogWorkspaceToWorkspaceListItem
      )
    ).toEqual([normal]);
  });

  it('never caches an unsupported content mode, so offline restarts cannot open it as plaintext', async () => {
    const normal = { id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' };
    const encrypted = {
      id: 'future',
      name: 'Future',
      slug: null,
      role: 'owner',
      contentMode: 'e2ee',
      genesisHash: 'ab'.repeat(32),
    };
    const identity = { userId: 'user-1' };
    const machine = { machineId: 'machine-1', machineName: 'host' };
    await runCatalog(
      makeCatalog().cacheRemoteWorkspaces({ identity, machine, workspaces: [normal, encrypted] })
    );
    // The same workspace later reports a mode this client does not implement.
    await runCatalog(
      makeCatalog().cacheRemoteWorkspaces({
        identity,
        machine,
        workspaces: [normal, { ...encrypted, contentMode: 'e2ee-v2' }],
      })
    );
    const reopened = await runCatalog(makeCatalog().listActiveWorkspaces());
    expect(reopened.map(localCatalogWorkspaceToWorkspaceListItem)).toEqual([normal]);
    const snapshot = await runCatalog(makeCatalog().read());
    expect(snapshot.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['ordinary']);
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

  it.each(['corrupt', 'EACCES'])(
    'isolates an unreadable %s encrypted index and recovers only corrupt bytes from an online list',
    async (condition) => {
      if (!tempDir) throw new Error('tempDir not initialized');
      const filePath = path.join(tempDir, 'workspace-catalog.json');
      const sidecarPath = `${filePath}.e2ee`;
      const workspaces = [
        { id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' },
        {
          id: 'encrypted',
          name: 'Encrypted',
          slug: null,
          role: 'owner',
          contentMode: 'e2ee',
          genesisHash: 'ab'.repeat(32),
        },
      ];
      const input = {
        authenticatedOnline: true as const,
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1' },
        workspaces,
      };
      await runCatalog(makeCatalog().cacheRemoteWorkspaces(input));
      const healthy = await fs.readFile(sidecarPath, 'utf8');
      const readFile = fs.readFile;
      const originalFailure = Object.assign(
        new Error('synthetic encrypted index permission failure'),
        { code: 'EACCES' }
      );
      let restore = () => {};
      if (condition === 'corrupt') await fs.writeFile(sidecarPath, '{damaged encrypted index');
      else {
        const spy = vi
          .spyOn(fs, 'readFile')
          .mockImplementation((...args) =>
            args[0] === sidecarPath ? Promise.reject(originalFailure) : readFile(...args)
          );
        restore = () => spy.mockRestore();
      }
      const originalBytes = await readFile(sidecarPath, 'utf8');
      try {
        const catalog = makeCatalog();
        const snapshot = await runCatalog(catalog.read());
        expect(snapshot.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['ordinary']);
        expect(snapshot.encryptedCatalogError).toBeInstanceOf(
          condition === 'corrupt' ? CatalogCorruptError : CatalogPermissionError
        );
        if (condition === 'EACCES')
          expect(snapshot.encryptedCatalogError?.cause).toBe(originalFailure);
        await runCatalog(
          catalog.recordWorkspaceAccessSnapshot({
            workspaceId: 'ordinary',
            accessSnapshot: { ownerUserId: 'user-1', verifiedAt: '2026-10-24T00:00:00Z' },
          })
        );
        expect((await runCatalog(catalog.read())).workspaces[0]?.accessSnapshot?.ownerUserId).toBe(
          'user-1'
        );
        if (condition === 'corrupt') {
          const { authenticatedOnline: _online, ...localInput } = input;
          const local = await runCatalog(catalog.cacheRemoteWorkspaces(localInput));
          expect(local?.encryptedCatalogError).toBeInstanceOf(CatalogCorruptError);
          expect(await readFile(sidecarPath, 'utf8')).toBe(originalBytes);
        }
        const receipt = await runCatalog(catalog.cacheRemoteWorkspaces(input));
        if (condition === 'corrupt') {
          expect(receipt).toBeUndefined();
          const archives = (await fs.readdir(tempDir)).filter((entry) =>
            entry.startsWith('workspace-catalog.json.e2ee.corrupt-')
          );
          expect(archives).toHaveLength(1);
          expect(await fs.readFile(path.join(tempDir, archives[0] ?? ''), 'utf8')).toBe(
            originalBytes
          );
          const reopened = await runCatalog(makeCatalog().read());
          expect(reopened.encryptedCatalogUnavailable).toBeUndefined();
          expect(reopened.encryptedCatalogError).toBeUndefined();
          expect(reopened.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
            'ordinary',
            'encrypted',
          ]);
          return;
        }
        expect(receipt?.encryptedCatalogError).toBeInstanceOf(CatalogPermissionError);
        expect(await readFile(sidecarPath, 'utf8')).toBe(originalBytes);
      } finally {
        restore();
      }
      await fs.writeFile(sidecarPath, healthy);
      const unconfirmed = await runCatalog(makeCatalog().read());
      expect(unconfirmed.encryptedCatalogUnavailable).toBe(true);
      expect(unconfirmed.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
        'ordinary',
      ]);
      await expect(runCatalog(makeCatalog().cacheRemoteWorkspaces(input))).resolves.toBeUndefined();
      const repaired = await runCatalog(makeCatalog().read());
      expect(repaired.encryptedCatalogUnavailable).toBeUndefined();
      expect(repaired.encryptedCatalogError).toBeUndefined();
      expect(repaired.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
        'ordinary',
        'encrypted',
      ]);
    }
  );

  it.each(['archive', 'publish'])(
    'keeps encrypted discovery fenced when recovery fails at %s, then retries from the online list',
    async (failure) => {
      if (!tempDir) throw new Error('tempDir not initialized');
      const filePath = path.join(tempDir, 'workspace-catalog.json');
      const sidecar = `${filePath}.e2ee`;
      const input = {
        authenticatedOnline: true as const,
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1' },
        workspaces: [
          { id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' },
          {
            id: 'encrypted',
            name: 'Encrypted',
            slug: null,
            role: 'owner',
            contentMode: 'e2ee',
            genesisHash: 'ab'.repeat(32),
          },
        ],
      };
      await runCatalog(makeCatalog().cacheRemoteWorkspaces(input));
      const damaged = '{damaged original';
      await fs.writeFile(sidecar, damaged);
      const rename = fs.rename;
      const fault = Object.assign(new Error('synthetic recovery write failure'), {
        code: 'EACCES',
      });
      const spy = vi
        .spyOn(fs, 'rename')
        .mockImplementation((source, target) =>
          (failure === 'archive' ? source === sidecar : target === sidecar)
            ? Promise.reject(fault)
            : rename(source, target)
        );
      try {
        const receipt = await runCatalog(
          makeCatalog().cacheRemoteWorkspaces({
            ...input,
            workspaces: input.workspaces.map((workspace) => ({ ...workspace, name: 'Updated' })),
          })
        );
        expect(receipt?.encryptedCatalogError).toBeDefined();
        const cold = await runCatalog(makeCatalog().read());
        expect(cold.encryptedCatalogUnavailable).toBe(true);
        expect(cold.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['ordinary']);
        expect(cold.workspaces[0]?.name).toBe('Updated');
        const archives = (await fs.readdir(tempDir)).filter((entry) =>
          entry.startsWith('workspace-catalog.json.e2ee.corrupt-')
        );
        if (failure === 'archive') {
          expect(archives).toEqual([]);
          expect(await fs.readFile(sidecar, 'utf8')).toBe(damaged);
        } else {
          expect(archives).toHaveLength(1);
          expect(await fs.readFile(path.join(tempDir, archives[0] ?? ''), 'utf8')).toBe(damaged);
        }
      } finally {
        spy.mockRestore();
      }
      await expect(runCatalog(makeCatalog().cacheRemoteWorkspaces(input))).resolves.toBeUndefined();
      expect(
        (await runCatalog(makeCatalog().read())).workspaces.map(
          (workspace) => workspace.workspaceId
        )
      ).toEqual(['ordinary', 'encrypted']);
    }
  );

  it('rebuilds only the current account and machine online list without reviving removed or unknown-mode rows', async () => {
    if (!tempDir) throw new Error('tempDir not initialized');
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    await runCatalog(
      makeCatalog().cacheRemoteWorkspaces({
        identity: { userId: 'old-account' },
        machine: { machineId: 'old-machine' },
        workspaces: [
          {
            id: 'old',
            name: 'Old',
            slug: null,
            role: 'owner',
            contentMode: 'e2ee',
            genesisHash: 'ab'.repeat(32),
          },
        ],
      })
    );
    await fs.writeFile(`${filePath}.e2ee`, '{damaged old sidecar');
    await expect(
      runCatalog(
        makeCatalog().cacheRemoteWorkspaces({
          authenticatedOnline: true,
          identity: { userId: 'new-account' },
          machine: { machineId: 'new-machine' },
          workspaces: [
            {
              id: 'unknown',
              name: 'Unknown',
              slug: null,
              role: 'owner',
              contentMode: 'future-encrypted',
            },
            {
              id: 'new',
              name: 'New',
              slug: null,
              role: 'owner',
              contentMode: 'e2ee',
              genesisHash: 'cd'.repeat(32),
            },
          ],
        })
      )
    ).resolves.toBeUndefined();
    const cold = await runCatalog(makeCatalog().read());
    expect(cold.identity?.userId).toBe('new-account');
    expect(cold.machine?.machineId).toBe('new-machine');
    expect(cold.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['new']);
    const ordinary = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(ordinary.workspaces).toEqual([]);
  });

  it('does not rewrite the encrypted sidecar for an ordinary mutation', async () => {
    if (!tempDir) throw new Error('tempDir not initialized');
    const sidecarPath = path.join(tempDir, 'workspace-catalog.json.e2ee');
    const catalog = makeCatalog();
    await runCatalog(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1' },
        workspaces: [
          { id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' },
          {
            id: 'encrypted',
            name: 'Encrypted',
            slug: null,
            role: 'owner',
            contentMode: 'e2ee',
            genesisHash: 'ab'.repeat(32),
          },
        ],
      })
    );
    const original = await fs.readFile(sidecarPath, 'utf8');
    const writeFile = fs.writeFile;
    const writeFailure = Object.assign(new Error('synthetic encrypted index write failure'), {
      code: 'EACCES',
    });
    const spy = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation((...args) =>
        String(args[0]).startsWith(`${sidecarPath}.`)
          ? Promise.reject(writeFailure)
          : writeFile(...args)
      );
    try {
      await runCatalog(
        catalog.upsertSession({
          sessionId: 'ordinary-session',
          workspaceId: 'ordinary',
          authorUserId: 'user-1',
          origin: 'offline',
        })
      );
      expect(
        (await runCatalog(makeCatalog().read())).sessions.map((session) => session.sessionId)
      ).toEqual(['ordinary-session']);
      expect(await fs.readFile(sidecarPath, 'utf8')).toBe(original);
      const receipt = await runCatalog(
        catalog.cacheRemoteWorkspaces({
          identity: { userId: 'user-1' },
          machine: { machineId: 'machine-1' },
          workspaces: [{ id: 'ordinary', name: 'Still usable', slug: null, role: 'owner' }],
        })
      );
      expect(receipt?.encryptedCatalogError.cause).toBe(writeFailure);
      expect(await fs.readFile(sidecarPath, 'utf8')).toBe(original);
      // A released CLI parses non-strict v1 and rewrites only known fields.
      // The independent fence must survive this actual parse/serialize cycle.
      const ordinaryPath = path.join(tempDir, 'workspace-catalog.json');
      const legacy = legacyCatalogSchema.parse(JSON.parse(await fs.readFile(ordinaryPath, 'utf8')));
      await fs.writeFile(ordinaryPath, JSON.stringify(legacy));
      const markerPath = `${ordinaryPath}.e2ee-invalid`;
      expect(JSON.parse(await fs.readFile(markerPath, 'utf8')).identity.userId).toBe('user-1');
      // The old encrypted row is physically retained but cannot reappear as
      // active on a new offline read after its revocation failed to cache.
      const reopened = await runCatalog(makeCatalog().read());
      expect(reopened.encryptedCatalogUnavailable).toBe(true);
      expect(reopened.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['ordinary']);
      expect(reopened.workspaces[0]?.name).toBe('Still usable');
    } finally {
      spy.mockRestore();
    }
    await expect(
      runCatalog(
        makeCatalog().cacheRemoteWorkspaces({
          identity: { userId: 'user-1' },
          machine: { machineId: 'machine-1' },
          workspaces: [{ id: 'ordinary', name: 'Still usable', slug: null, role: 'owner' }],
        })
      )
    ).resolves.toBeUndefined();
    expect((await runCatalog(makeCatalog().read())).encryptedCatalogUnavailable).toBeUndefined();
    await expect(
      fs.stat(`${path.join(tempDir, 'workspace-catalog.json')}.e2ee-invalid`)
    ).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('retains the invalid marker cleanup owner without losing successfully published cache results', async () => {
    if (!tempDir) throw new Error('tempDir not initialized');
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    const markerPath = `${filePath}.e2ee-invalid`;
    const input = {
      identity: { userId: 'user-1' },
      machine: { machineId: 'machine-1' },
      workspaces: [
        { id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' },
        {
          id: 'encrypted',
          name: 'Encrypted',
          slug: null,
          role: 'owner',
          contentMode: 'e2ee',
          genesisHash: 'ab'.repeat(32),
        },
      ],
    };
    const catalog = makeCatalog();
    await runCatalog(catalog.cacheRemoteWorkspaces(input));
    const unlink = fs.unlink;
    const originalError = Object.assign(new Error('synthetic invalid marker EBUSY'), {
      code: 'EBUSY',
    });
    const spy = vi
      .spyOn(fs, 'unlink')
      .mockImplementation((file) =>
        file === markerPath ? Promise.reject(originalError) : unlink(file)
      );
    const updated = {
      ...input,
      workspaces: input.workspaces.map((workspace) => ({
        ...workspace,
        name: `${workspace.name} updated`,
      })),
    };
    try {
      const receipt = await runCatalog(catalog.cacheRemoteWorkspaces(updated));
      expect(receipt?.encryptedCatalogError.cause).toBe(originalError);
      expect(JSON.parse(await fs.readFile(filePath, 'utf8')).workspaces[0].name).toBe(
        'Ordinary updated'
      );
      expect(JSON.parse(await fs.readFile(`${filePath}.e2ee`, 'utf8')).workspaces[0].name).toBe(
        'Encrypted updated'
      );
      expect((await runCatalog(makeCatalog().read())).encryptedCatalogUnavailable).toBe(true);
      expect(JSON.parse(await fs.readFile(markerPath, 'utf8')).machine.machineId).toBe('machine-1');
    } finally {
      spy.mockRestore();
    }
    await expect(runCatalog(makeCatalog().cacheRemoteWorkspaces(updated))).resolves.toBeUndefined();
    expect(
      (await runCatalog(makeCatalog().listActiveWorkspaces())).map((workspace) => workspace.name)
    ).toEqual(['Ordinary updated', 'Encrypted updated']);
    await expect(fs.stat(markerPath)).rejects.toHaveProperty('code', 'ENOENT');
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
