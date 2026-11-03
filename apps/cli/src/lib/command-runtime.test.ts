import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { LocalSessionControlRequest } from '@lody/shared';
import { writeLocalDaemonRunFile } from '@lody/shared/node/local-ipc';
import {
  ensureDaemonReachable,
  listAliveRoomIds,
  listAliveSessionMetas,
  listWorkspaceCandidates,
  resolveWorkspaceOrThrow,
  selectWorkspaceSummary,
} from './command-runtime';
import { makeWorkspaceCommandManagers } from './workspace-command-manager';
import { Effect } from 'effect';
import type { MachineId } from '@lody/shared';
import * as workspaceApi from './workspace';
import {
  makeLocalWorkspaceCatalog,
  type LocalWorkspaceCatalogSnapshot,
} from './local-workspace-catalog';
import { fileLocksLegacy } from '@/utils/file-lock';

const createControlRequest = (): LocalSessionControlRequest => ({
  type: 'session/create',
  sessionId: 'session-1',
  machineId: 'machine-1',
  workspaceId: 'workspace-1',
  acpSessionConfig: {
    prompt: 'hello',
    cliType: 'builtin',
    agentType: 'codex',
  },
  userId: 'user-1',
  userName: 'User One',
  userEmail: 'user@example.com',
});

const tempDirs: string[] = [];
const servers: http.Server[] = [];

const commandScope = {
  userId: 'synthetic-user',
  token: 'synthetic-token',
  machineId: 'synthetic-machine',
  authBaseUrl: 'https://synthetic.invalid',
};
const makeCommandManager = () => ({
  live: true,
  writes: [] as string[],
  async cleanUp() {
    this.live = false;
  },
  write(value: string) {
    if (!this.live) throw new Error('Manager closed');
    this.writes.push(value);
  },
});

describe('workspace command manager sharing', () => {
  it.each([
    { userId: 'other-user' },
    { token: 'other-token' },
    { machineId: 'other-machine' },
    { authBaseUrl: 'https://other.invalid' },
    { authSiteUrl: 'https://other-site.invalid' },
  ])('does not share an active manager across authorization scopes: %j', async (changed) => {
    const withManager = makeWorkspaceCommandManagers<ReturnType<typeof makeCommandManager>>();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const manager = makeCommandManager();
    const first = withManager(
      'workspace',
      commandScope,
      async () => manager,
      async () => {
        entered.resolve();
        await finish.promise;
      },
      () => {}
    );
    try {
      await entered.promise;
      await expect(
        withManager(
          'workspace',
          { ...commandScope, ...changed },
          async () => {
            throw new Error('Must not create another owner');
          },
          async () => {
            throw new Error('Must not use another identity');
          },
          () => {}
        )
      ).rejects.toThrow('same authorization scope');
      expect(manager.live).toBe(true);
    } finally {
      finish.resolve();
      await first;
    }
  });
});

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-command-runtime-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function makeSocketPath(tempDir: string, name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\lody-command-runtime-test-${process.pid}-${randomUUID()}-${name}`;
  }
  return path.join(tempDir, `${name}.sock`);
}

function listenSocket(socketPath: string, handler: http.RequestListener): Promise<void> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function makeDaemonOptions(handlers: {
  healthz?: http.RequestListener;
  control?: http.RequestListener;
}) {
  const tempDir = makeTempDir();
  const probeSocketPath = makeSocketPath(tempDir, 'probe');
  const controlSocketPath = makeSocketPath(tempDir, 'control');
  const runFilePath = path.join(tempDir, 'run', 'daemon.json');

  await listenSocket(
    probeSocketPath,
    handlers.healthz ??
      ((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            machineId: 'machine-1',
            pid: process.pid,
            cliVersion: '0.0.0',
            homeDir: os.tmpdir(),
          })
        );
      })
  );
  await listenSocket(
    controlSocketPath,
    handlers.control ??
      ((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, responses: [] }));
      })
  );
  writeLocalDaemonRunFile(
    {
      pid: process.pid,
      socketPath: probeSocketPath,
      controlSocketPath,
      version: '0.0.0-test',
      startedAt: '2026-07-03T00:00:00.000Z',
    },
    runFilePath
  );
  return { runFilePath };
}

function missingRunFileOptions() {
  return {
    runFilePath: path.join(
      os.tmpdir(),
      `lody-command-runtime-test-${process.pid}-${randomUUID()}`,
      'daemon.json'
    ),
  };
}

describe('command runtime helpers', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers stable workspace ids and slugs over names', () => {
    const workspaces = [
      { id: 'ws-1', slug: 'alpha', name: 'beta', role: 'owner' },
      { id: 'ws-2', slug: 'beta', name: 'ws-1', role: 'member' },
    ];

    expect(selectWorkspaceSummary(workspaces, 'ws-1')).toEqual(workspaces[0]);
    expect(selectWorkspaceSummary(workspaces, 'beta')).toEqual(workspaces[1]);
  });

  it('resolves standalone workspaces online, or only from this login cache with --offline', async () => {
    const auth = {
      token: 'synthetic-token',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.test',
      machineId: 'machine-1' as MachineId,
      machineName: 'host',
    };
    const online = [
      { id: 'ws-1', slug: 'alpha', name: 'Shared Team', role: 'owner' },
      { id: 'ws-2', slug: 'beta', name: 'Shared Team', role: 'member' },
    ];
    vi.stubEnv('LODY_WORKSPACE_ID', '');
    const list = vi.spyOn(workspaceApi, 'listWorkspacesForToken').mockResolvedValue(online);
    onTestFinished(() => {
      list.mockRestore();
      vi.unstubAllEnvs();
    });
    await expect(resolveWorkspaceOrThrow(auth, 'beta')).resolves.toEqual(online[1]);
    await expect(resolveWorkspaceOrThrow(auth, 'Shared Team')).rejects.toThrow('ambiguous');
    await expect(resolveWorkspaceOrThrow(auth, 'missing')).rejects.toThrow(
      'Workspace not found: missing'
    );
    expect(list).toHaveBeenCalledTimes(3);
    list.mockRejectedValueOnce(new Error('Synthetic discovery outage'));
    // A discovery failure is never reported as an empty workspace list.
    await expect(resolveWorkspaceOrThrow(auth, 'beta')).rejects.toThrow(
      'Synthetic discovery outage'
    );
    list.mockClear();

    const cached = (snapshot: Partial<LocalWorkspaceCatalogSnapshot>) => ({
      read: () =>
        Effect.succeed({
          version: 1 as const,
          identity: { userId: 'user-1' },
          machine: { machineId: 'machine-1' },
          sessions: [],
          workspaces: [
            {
              workspaceId: 'ws-1',
              name: 'Alpha',
              slug: 'alpha',
              role: 'member',
              contentMode: 'e2ee' as const,
              genesisHash: 'ab'.repeat(32),
              state: 'active' as const,
              cachedAt: 1,
            },
            {
              workspaceId: 'ws-2',
              name: 'Removed',
              slug: 'removed',
              role: 'owner',
              state: 'remote_missing' as const,
              cachedAt: 1,
            },
          ],
          ...snapshot,
        }),
    });
    await expect(
      resolveWorkspaceOrThrow(auth, undefined, { offline: true, catalog: cached({}) })
    ).resolves.toEqual({
      id: 'ws-1',
      name: 'Alpha',
      slug: 'alpha',
      role: 'member',
      contentMode: 'e2ee',
      genesisHash: 'ab'.repeat(32),
    });
    // A workspace the cloud no longer lists is not usable offline.
    await expect(
      resolveWorkspaceOrThrow(auth, 'removed', { offline: true, catalog: cached({}) })
    ).rejects.toThrow('Workspace not found: removed');
    // Another login's cache grants nothing to this one.
    await expect(
      resolveWorkspaceOrThrow(auth, 'alpha', {
        offline: true,
        catalog: cached({ identity: { userId: 'user-2' } }),
      })
    ).rejects.toThrow('No workspaces are cached locally for the current CLI login');
    expect(list).not.toHaveBeenCalled();
  });

  it('never resolves an offline selection from a partial cache, but serves explicit ordinary workspaces', async () => {
    vi.stubEnv('LODY_WORKSPACE_ID', '');
    onTestFinished(() => vi.unstubAllEnvs());
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-offline-catalog-'));
    tempDirs.push(directory);
    const filePath = path.join(directory, 'workspace-catalog.json');
    const catalog = makeLocalWorkspaceCatalog({
      filePath,
      lockName: `offline-${path.basename(directory)}`,
      cacheTtlMs: 0,
    });
    const ordinary = { id: 'ws-plain', name: 'Plain', slug: 'plain', role: 'owner' };
    const encrypted = {
      id: 'ws-e2ee',
      name: 'Sealed',
      slug: 'sealed',
      role: 'member',
      contentMode: 'e2ee',
      genesisHash: 'ab'.repeat(32),
    };
    await fileLocksLegacy.runPromise(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [ordinary, encrypted],
      })
    );
    const auth = {
      token: 'synthetic-token',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.test',
      machineId: 'machine-1' as MachineId,
      machineName: 'host',
    };
    const offline = { offline: true, catalog };
    await expect(resolveWorkspaceOrThrow(auth, undefined, offline)).rejects.toThrow(
      'Multiple workspaces are available'
    );
    fs.writeFileSync(`${filePath}.e2ee`, '{synthetic damaged encrypted cache');
    offline.catalog = makeLocalWorkspaceCatalog({ filePath, cacheTtlMs: 0 });

    // The unreadable encrypted half must not shrink the choice to the plain workspace.
    for (const selector of [undefined, 'sealed', 'Plain'])
      await expect(resolveWorkspaceOrThrow(auth, selector, offline)).rejects.toThrow(
        'Encrypted workspace cache is unavailable'
      );
    await expect(listWorkspaceCandidates(auth, offline)).rejects.toThrow(
      'Encrypted workspace cache is unavailable'
    );
    // An explicit plaintext workspace remains readable offline.
    await expect(resolveWorkspaceOrThrow(auth, 'plain', offline)).resolves.toEqual(ordinary);
  });

  it('reports a retryable busy daemon when the probe returns a transient status', async () => {
    const options = await makeDaemonOptions({
      healthz: (_req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      },
    });

    const error = await ensureDaemonReachable(options).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'DAEMON_BUSY', retryable: true });
  });

  it('enumerates metadata-free documents from the existence index and excludes tombstones', async () => {
    const scan = vi.fn(async () => [
      { key: ['e', 'task-1'], value: true },
      { key: ['e', 'task-2'], value: false },
      { key: ['e', 'session-1'], value: true },
      { key: ['m', 'task-legacy', 'title'], value: 'legacy' },
    ]);
    const manager = {
      repo: {
        getMeta: () => ({ scan }),
      },
    } as any;

    await expect(
      listAliveRoomIds(manager, (roomId) => roomId.startsWith('task-'))
    ).resolves.toEqual(['task-1']);
    expect(scan).toHaveBeenCalledWith({ prefix: ['e'], includeRaw: false });
  });

  it('derives Session identity from the room key and excludes legacy comment rooms', async () => {
    const scan = vi.fn(async () => [
      { key: ['e', 'session-real'], value: true },
      { key: ['e', 'session-comment-old'], value: true },
    ]);
    const manager = {
      repo: {
        getMeta: () => ({ scan }),
        getDocMeta: vi.fn(async (roomId: string) => ({
          meta: roomId === 'session-real' ? { latestUserMsgId: 'turn-1' } : { id: 'wrong' },
          exists: true,
        })),
      },
    } as any;

    await expect(listAliveSessionMetas(manager)).resolves.toEqual([
      {
        roomId: 'session-real',
        meta: { id: 'real', latestUserMsgId: 'turn-1' },
      },
    ]);
  });
});
