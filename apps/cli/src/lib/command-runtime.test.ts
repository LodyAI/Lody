import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalSessionControlRequest } from '@lody/shared';
import {
  IpcConnectError,
  IpcProtocolError,
  IpcTimeoutError,
  writeLocalDaemonRunFile,
} from '@lody/shared/node/local-ipc';
import {
  DAEMON_NOT_RUNNING_MESSAGE,
  classifyLocalDaemonIpcError,
  dispatchLocalControl,
  ensureWorkspaceMetaSynced,
  ensureDaemonReachable,
  listAliveDocMetas,
  listAliveRoomIds,
  listAliveSessionMetas,
  selectWorkspaceSummary,
  syncWorkspaceMetaForRead,
  WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
  WorkspaceSyncUnavailableError,
} from './command-runtime';
import { makeWorkspaceCommandManagers } from './workspace-command-manager';

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
  it('joins pending creation and keeps a surviving command usable until the last release', async () => {
    const withManager = makeWorkspaceCommandManagers<ReturnType<typeof makeCommandManager>>();
    const created = Promise.withResolvers<ReturnType<typeof makeCommandManager>>();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const manager = makeCommandManager();
    const first = withManager(
      'workspace',
      commandScope,
      () => created.promise,
      async (owner) => {
        owner.write('first');
      },
      () => {}
    );
    const second = withManager(
      'workspace',
      commandScope,
      async () => {
        throw new Error('Duplicate owner');
      },
      async (owner) => {
        entered.resolve();
        await finish.promise;
        owner.write('survivor');
      },
      () => {}
    );
    created.resolve(manager);
    try {
      await entered.promise;
      await first;
      expect(manager.live).toBe(true);
      finish.resolve();
      await second;
      expect(manager.writes).toEqual(['first', 'survivor']);
      expect(manager.live).toBe(false);
    } finally {
      finish.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it('waits for actual cleanup before replacement without blocking another workspace', async () => {
    const withManager = makeWorkspaceCommandManagers<ReturnType<typeof makeCommandManager>>();
    const closing = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const old = makeCommandManager();
    old.cleanUp = async () => {
      closing.resolve();
      await released.promise;
      old.live = false;
    };
    const first = withManager(
      'workspace',
      commandScope,
      async () => old,
      async () => 'first',
      () => {}
    );
    await closing.promise;
    const next = makeCommandManager();
    let admitted = false;
    const incoming = withManager(
      'workspace',
      commandScope,
      async () => {
        expect(old.live).toBe(false);
        admitted = true;
        return next;
      },
      async (owner) => owner.write('replacement'),
      () => {}
    );
    try {
      const unrelated = makeCommandManager();
      await withManager(
        'other-workspace',
        commandScope,
        async () => unrelated,
        async (owner) => owner.write('independent'),
        () => {}
      );
      expect(unrelated.writes).toEqual(['independent']);
      expect(admitted).toBe(false);
      released.resolve();
      await Promise.all([first, incoming]);
      expect(next.writes).toEqual(['replacement']);
    } finally {
      released.resolve();
      await Promise.allSettled([first, incoming]);
    }
  });

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

  it('allows a new attempt after shared creation fails', async () => {
    const withManager = makeWorkspaceCommandManagers<ReturnType<typeof makeCommandManager>>();
    const creating = Promise.withResolvers<ReturnType<typeof makeCommandManager>>();
    const failure = new Error('Synthetic creation failure');
    const create = () => creating.promise;
    const run = async (manager: ReturnType<typeof makeCommandManager>) => manager.write('ready');
    const outcomes = Promise.allSettled([
      withManager('workspace', commandScope, create, run, () => {}),
      withManager('workspace', commandScope, create, run, () => {}),
    ]);
    creating.reject(failure);
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    const manager = makeCommandManager();
    await withManager(
      'workspace',
      commandScope,
      async () => manager,
      run,
      () => {}
    );
    expect(manager.writes).toEqual(['ready']);
    expect(manager.live).toBe(false);
  });

  it('preserves callback failures while releasing the manager', async () => {
    const withManager = makeWorkspaceCommandManagers<ReturnType<typeof makeCommandManager>>();
    const manager = makeCommandManager();
    const failure = new Error('Synthetic command failure');
    await expect(
      withManager(
        'workspace',
        commandScope,
        async () => manager,
        async () => {
          throw failure;
        },
        () => {}
      )
    ).rejects.toBe(failure);
    expect(manager.live).toBe(false);
  });

  it('reports a failed cleanup once and never fences waiting or later commands', async () => {
    const withManager = makeWorkspaceCommandManagers<ReturnType<typeof makeCommandManager>>();
    const closing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const failure = new Error('Synthetic presence release failure');
    const old = makeCommandManager();
    old.cleanUp = async () => {
      closing.resolve();
      await finish.promise;
      throw failure;
    };
    const errors: unknown[] = [];
    const first = withManager(
      'workspace',
      commandScope,
      async () => old,
      async (owner) => {
        owner.write('accepted');
        return 'accepted';
      },
      (error) => errors.push(error)
    );
    await closing.promise;
    const waiting = makeCommandManager();
    const incoming = withManager(
      'workspace',
      commandScope,
      async () => waiting,
      async (owner) => owner.write('waiting command'),
      (error) => errors.push(error)
    );
    try {
      finish.resolve();
      expect(await first).toBe('accepted');
      await incoming;
      expect(waiting.writes).toEqual(['waiting command']);
      const later = makeCommandManager();
      await withManager(
        'workspace',
        commandScope,
        async () => later,
        async (owner) => owner.write('later command'),
        (error) => errors.push(error)
      );
      expect(later.writes).toEqual(['later command']);
      expect(errors).toEqual([failure]);
    } finally {
      finish.resolve();
      await Promise.allSettled([first, incoming]);
    }
  });

  it('keeps the accepted result and later commands when the failure reporter throws', async () => {
    const withManager = makeWorkspaceCommandManagers<ReturnType<typeof makeCommandManager>>();
    const old = makeCommandManager();
    old.cleanUp = async () => {
      throw new Error('Synthetic cleanup failure');
    };
    const throwingReporter = () => {
      throw new Error('Synthetic closed logger');
    };
    expect(
      await withManager(
        'workspace',
        commandScope,
        async () => old,
        async () => 'accepted',
        throwingReporter
      )
    ).toBe('accepted');
    const next = makeCommandManager();
    await withManager(
      'workspace',
      commandScope,
      async () => next,
      async (owner) => owner.write('next command'),
      throwingReporter
    );
    expect(next.writes).toEqual(['next command']);
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

  it('selects a workspace by id, slug, or exact name', () => {
    const workspaces = [
      { id: 'ws-1', slug: 'alpha', name: 'Alpha Team', role: 'owner' },
      { id: 'ws-2', slug: 'beta', name: 'Beta Team', role: 'member' },
    ];

    expect(selectWorkspaceSummary(workspaces, 'ws-1')).toEqual(workspaces[0]);
    expect(selectWorkspaceSummary(workspaces, 'beta')).toEqual(workspaces[1]);
    expect(selectWorkspaceSummary(workspaces, 'Alpha Team')).toEqual(workspaces[0]);
  });

  it('prefers stable workspace ids and slugs over names', () => {
    const workspaces = [
      { id: 'ws-1', slug: 'alpha', name: 'beta', role: 'owner' },
      { id: 'ws-2', slug: 'beta', name: 'ws-1', role: 'member' },
    ];

    expect(selectWorkspaceSummary(workspaces, 'ws-1')).toEqual(workspaces[0]);
    expect(selectWorkspaceSummary(workspaces, 'beta')).toEqual(workspaces[1]);
  });

  it('rejects ambiguous workspace names and shows stable selectors', () => {
    const workspaces = [
      { id: 'ws-1', slug: 'alpha', name: 'Shared Team', role: 'owner' },
      { id: 'ws-2', slug: 'beta', name: 'Shared Team', role: 'member' },
    ];

    expect(() => selectWorkspaceSummary(workspaces, 'Shared Team')).toThrow(
      'Workspace selector is ambiguous: Shared Team. Matches: Shared Team (slug: alpha, id: ws-1), Shared Team (slug: beta, id: ws-2). Use a workspace id or slug instead.'
    );
  });

  it('rejects malformed daemon responses with a clear validation error', async () => {
    const options = await makeDaemonOptions({
      control: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ responses: 'not-an-array' }));
      },
    });

    await expect(dispatchLocalControl(createControlRequest(), options)).rejects.toThrow(
      'Invalid response from local CLI daemon (HTTP 200).'
    );
  });

  it('returns parsed local control responses after schema validation', async () => {
    let healthRequests = 0;
    const options = await makeDaemonOptions({
      healthz: (_req, res) => {
        healthRequests += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      control: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            responses: [
              {
                type: 'session/create_response',
                sessionId: 'session-1',
                success: true,
              },
            ],
          })
        );
      },
    });

    await expect(dispatchLocalControl(createControlRequest(), options)).resolves.toEqual([
      {
        type: 'session/create_response',
        sessionId: 'session-1',
        success: true,
      },
    ]);
    expect(healthRequests).toBe(0);
  });

  it('fails fast with a friendly message when the daemon probe is unreachable', async () => {
    await expect(ensureDaemonReachable(missingRunFileOptions())).rejects.toThrow(
      DAEMON_NOT_RUNNING_MESSAGE
    );
    await expect(
      dispatchLocalControl(createControlRequest(), missingRunFileOptions())
    ).rejects.toThrow(DAEMON_NOT_RUNNING_MESSAGE);
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

  it('classifies missing, timeout, and protocol failures without lying about daemon state', () => {
    expect(
      classifyLocalDaemonIpcError(new IpcConnectError({ message: 'connect failed' }))
    ).toMatchObject({ code: 'DAEMON_NOT_RUNNING', retryable: false });
    expect(
      classifyLocalDaemonIpcError(new IpcTimeoutError({ message: 'timed out', timeoutMs: 2_000 }))
    ).toMatchObject({ code: 'DAEMON_BUSY', retryable: true });
    expect(
      classifyLocalDaemonIpcError(
        new IpcProtocolError({
          message: 'bad request: details: /private/path',
          status: 400,
          errorCode: 'INVALID_REQUEST',
        })
      )
    ).toMatchObject({
      code: 'DAEMON_PROTOCOL_ERROR',
      message: 'Local CLI daemon request failed: INVALID_REQUEST',
      retryable: false,
    });
  });

  it('passes when the daemon probe responds with 2xx', async () => {
    const options = await makeDaemonOptions({
      healthz: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      },
    });

    await expect(ensureDaemonReachable(options)).resolves.toBeUndefined();
  });

  it('filters docs using explicit existence state from getDocMeta', async () => {
    const scan = vi.fn(async ({ prefix }: { prefix: string[]; includeRaw?: boolean }) => {
      if (prefix[0] === 'e') {
        return [
          {
            key: ['e', 'machine-1'],
            value: true,
          },
          {
            key: ['e', 'machine-2'],
            value: true,
          },
        ];
      }
      return [];
    });
    const manager = {
      repo: {
        getMeta: () => ({
          scan,
        }),
        getDocMeta: vi.fn(async (roomId: string) =>
          roomId === 'machine-1'
            ? {
                meta: { id: 'machine-1' },
                exists: true,
              }
            : {
                meta: { id: 'machine-2' },
                exists: false,
              }
        ),
      },
    } as any;

    await expect(
      listAliveDocMetas<{ id: string }>(manager, (roomId) => roomId.startsWith('machine-'))
    ).resolves.toEqual([{ roomId: 'machine-1', meta: { id: 'machine-1' } }]);
    expect(scan).toHaveBeenCalledWith({ prefix: ['e'], includeRaw: false });
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

  it('rejects when workspace metadata writes are not confirmed synced', async () => {
    const manager = {
      waitUntilMetaSynced: vi.fn(async () => false),
    };

    await expect(
      ensureWorkspaceMetaSynced(manager as any, 'session.archive:session-1')
    ).rejects.toThrow('Workspace metadata changes were not confirmed by Loro Streams');
    expect(manager.waitUntilMetaSynced).toHaveBeenCalledWith({
      reason: 'session.archive:session-1',
    });
  });

  it('passes when workspace metadata writes are confirmed synced', async () => {
    const manager = {
      waitUntilMetaSynced: vi.fn(async () => true),
    };

    await expect(
      ensureWorkspaceMetaSynced(manager as any, 'session.archive:session-1')
    ).resolves.toBeUndefined();
  });

  it('adds an explicit offline hint when read metadata sync fails', async () => {
    const syncError = new Error('sync failed');
    const manager = {
      syncMetaOrThrow: vi.fn(async () => {
        throw syncError;
      }),
    };

    const error = await syncWorkspaceMetaForRead(manager, 'session.list:workspace-1').catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(WorkspaceSyncUnavailableError);
    expect(error).toMatchObject({ cause: syncError });
    expect(error).toHaveProperty('message', expect.stringMatching(/--offline/));
    expect((error as WorkspaceSyncUnavailableError).toLodyError()).toEqual({
      code: 'SYNC_UNAVAILABLE',
      message: WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
      retryable: true,
    });
    expect(manager.syncMetaOrThrow).toHaveBeenCalledWith({ reason: 'session.list:workspace-1' });
  });
});
