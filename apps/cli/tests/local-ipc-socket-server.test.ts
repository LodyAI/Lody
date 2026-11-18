import type { MachineId, WorkspaceId, SessionId } from '@lody/shared';
import {
  getLocalIpcServerCredentials,
  LOCAL_IPC_TOKEN_HEADER,
} from '@lody/shared/node/local-ipc-auth';
import {
  type LocalE2eePrepareReply,
  type LocalE2eePrepareResponse,
} from '@lody/shared/e2ee-local-pairing';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import {
  LOCAL_MACHINE_RPC_PATH,
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
} from '@lody/shared';
import {
  LOCAL_CONTROL_HEADER,
  LOCAL_SESSION_CONTROL_PATH,
  makeLocalControlClientSocket,
  makeLocalProbeClientSocket,
  readLocalDaemonRunFile,
} from '@lody/shared/node/local-ipc';
import {
  getLocalIpcSocketServersForTest,
  startLocalIpcSocketServers,
  stopLocalIpcSocketServers,
} from '../src/lib/local-ipc-socket-server';
import { MAX_REQUEST_BODY_BYTES } from '../src/lib/local-session-control';
import type { Logger } from '../src/utils/logger';

const tempDirs: string[] = [];

const logger: Logger = {
  debug: vi.fn(),
  trace: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  setLevel: vi.fn(),
  setDebug: vi.fn(),
  child: vi.fn(() => logger),
  close: vi.fn(async () => {}),
};

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-ipc-server-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function makePaths() {
  const tempDir = makeTempDir();
  if (process.platform === 'win32') {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
      probeSocketPath: `\\\\.\\pipe\\lody-probe-test-${suffix}`,
      controlSocketPath: `\\\\.\\pipe\\lody-control-test-${suffix}`,
      runFilePath: path.join(tempDir, 'run', 'daemon.json'),
      lockFilePath: path.join(tempDir, 'run', 'daemon.lock'),
    };
  }
  return {
    probeSocketPath: path.join(tempDir, 'probe.sock'),
    controlSocketPath: path.join(tempDir, 'control.sock'),
    runFilePath: path.join(tempDir, 'run', 'daemon.json'),
    lockFilePath: path.join(tempDir, 'run', 'daemon.lock'),
  };
}

const createSessionRequest = (): LocalSessionControlRequest => ({
  type: 'session/create',
  machineId: 'machine-1' as MachineId,
  workspaceId: 'workspace-1' as WorkspaceId,
  sessionId: 'session-1' as SessionId,
  acpSessionConfig: {
    prompt: 'hello',
    cliType: 'builtin',
    agentType: 'codex',
  },
  userId: 'user-1',
  userName: 'User One',
  userEmail: 'user@example.com',
});

function makeServerConfig(paths: ReturnType<typeof makePaths>) {
  const dispatchResponse: LocalSessionControlResponse = {
    type: 'session/create_response',
    sessionId: 'session-1' as SessionId,
    success: true,
  };

  return {
    probe: {
      machineId: 'machine-1' as MachineId,
      cliVersion: '0.0.0-test',
      logger,
      getRuntimeState: () => ({
        schemaVersion: 1 as const,
        phase: 'running' as const,
        startupStage: 'ready' as const,
        machineId: 'machine-1' as MachineId,
        pid: process.pid,
        updatedAtMs: 1,
        issues: [],
      }),
    },
    control: {
      machineId: 'machine-1' as MachineId,
      logger,
      dispatchSession: vi.fn<
        import('../src/lib/local-control-handler').LocalSessionControlConfig['dispatchSession']
      >(async (_message, options) => {
        options?.onResponse?.(dispatchResponse);
        return [dispatchResponse];
      }),
      dispatchProject: vi.fn(),
    },
    version: '0.0.0-test',
    paths,
  };
}

function postOversizedControlBody(
  socketPath: string
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const request = http.request(
      {
        socketPath,
        path: LOCAL_SESSION_CONTROL_PATH,
        method: 'POST',
        headers: {
          [LOCAL_CONTROL_HEADER]: '1',
          [LOCAL_IPC_TOKEN_HEADER]: getLocalIpcServerCredentials().token,
          'Content-Type': 'application/json',
        },
      },
      (response) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      }
    );
    request.on('error', (error) => {
      if (!responseStarted) {
        reject(error);
      }
    });
    request.write(Buffer.alloc(MAX_REQUEST_BODY_BYTES, 'x'));
    request.end('x');
  });
}

describe('local IPC socket server', () => {
  afterEach(async () => {
    await stopLocalIpcSocketServers();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('authenticates the finite local Session freeze endpoint before changing per-room admission', async () => {
    const paths = makePaths(),
      config = makeServerConfig(paths);
    const held = new Set<string>();
    const request = {
      accountId: 'local:synthetic',
      workspaceId: 'lw_synthetic',
      sessionId: 'synthetic-session',
      nonce: '00000000-0000-4000-8000-000000000001',
      phase: 'prepare' as const,
    };
    await startLocalIpcSocketServers({
      ...config,
      control: {
        ...config.control,
        dispatchSessionBodyFreeze: async (value) => {
          if (value.accountId !== request.accountId || value.workspaceId !== request.workspaceId)
            return { ok: false as const, error: 'scope_unavailable' as const };
          if (value.phase !== 'prepare')
            return { ok: false as const, error: 'freeze_unconfirmed' as const };
          held.add(value.sessionId);
          return {
            ...value,
            phase: 'prepare' as const,
            ok: true as const,
            prepared: true as const,
            ownerGeneration: 'original-owner',
          };
        },
      },
    });
    const make = (token: string) =>
      makeLocalControlClientSocket({ socketPath: paths.controlSocketPath, token });
    const denied = make('incorrect');
    if (!denied.sessionBodyFreeze) throw new Error('Session freeze client missing');
    expect(await Effect.runPromise(Effect.flip(denied.sessionBodyFreeze(request)))).toMatchObject({
      _tag: 'IpcProtocolError',
      status: 401,
    });
    expect([...held]).toEqual([]);
    const client = make(getLocalIpcServerCredentials().token);
    if (!client.sessionBodyFreeze) throw new Error('Session freeze client missing');
    const malformed = { ...request, path: '/arbitrary/storage' };
    expect(await Effect.runPromise(client.sessionBodyFreeze(malformed as never))).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect([...held]).toEqual([]);
    expect(
      await Effect.runPromise(client.sessionBodyFreeze({ ...request, workspaceId: 'lw_foreign' }))
    ).toEqual({ ok: false, error: 'scope_unavailable' });
    expect([...held]).toEqual([]);
    expect(await Effect.runPromise(client.sessionBodyFreeze(request))).toMatchObject({
      ok: true,
      phase: 'prepare',
      prepared: true,
      nonce: request.nonce,
      ownerGeneration: 'original-owner',
    });
    expect([...held]).toEqual(['synthetic-session']);
  });

  it('refuses missing and incorrect tokens before dispatch, and accepts the published token', async () => {
    const paths = makePaths();
    const config = makeServerConfig(paths);
    const run = await startLocalIpcSocketServers(config);
    for (const token of ['', 'b'.repeat(64)]) {
      const result = await Effect.runPromise(
        Effect.flip(
          makeLocalControlClientSocket({
            socketPath: paths.controlSocketPath,
            token,
          }).sessionControl(createSessionRequest())
        )
      );
      expect(result).toMatchObject({ _tag: 'IpcProtocolError', status: 401 });
    }
    const responses = await Effect.runPromise(
      makeLocalControlClientSocket({ runFilePath: paths.runFilePath }).sessionControl(
        createSessionRequest()
      )
    );
    expect(responses.at(-1)).toMatchObject({ type: 'session/create_response', success: true });
    expect(run.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('aborts an in-flight machine RPC when the local socket disconnects', async () => {
    const paths = makePaths();
    const config = makeServerConfig(paths);
    let markStarted: (() => void) | undefined;
    let markAborted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    await startLocalIpcSocketServers({
      ...config,
      control: {
        ...config.control,
        dispatchMachineRpc: async (_message, signal) => {
          markStarted?.();
          if (signal?.aborted) markAborted?.();
          else signal?.addEventListener('abort', () => markAborted?.(), { once: true });
          await aborted;
          return { ok: false, error: 'cancelled' };
        },
      },
    });
    const request = http.request({
      socketPath: paths.controlSocketPath,
      path: LOCAL_MACHINE_RPC_PATH,
      method: 'POST',
      headers: {
        [LOCAL_CONTROL_HEADER]: '1',
        [LOCAL_IPC_TOKEN_HEADER]: getLocalIpcServerCredentials().token,
        'Content-Type': 'application/json',
      },
    });
    request.on('error', () => {});
    request.end(
      JSON.stringify({
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        method: 'sorbet/credentials-logout',
        params: { configId: 'provider', providerId: 'example' },
      })
    );
    await started;
    request.destroy();
    await aborted;
  });

  it('serves probe and control requests over sockets and cleans the run-file', async () => {
    const paths = makePaths();
    await startLocalIpcSocketServers(makeServerConfig(paths));

    expect(readLocalDaemonRunFile(paths.runFilePath)).toMatchObject({
      pid: process.pid,
      socketPath: paths.probeSocketPath,
      controlSocketPath: paths.controlSocketPath,
      version: '0.0.0-test',
    });

    await expect(
      Effect.runPromise(makeLocalProbeClientSocket({ runFilePath: paths.runFilePath }).health())
    ).resolves.toMatchObject({
      ok: true,
      machineId: 'machine-1' as MachineId,
      pid: process.pid,
      cliVersion: '0.0.0-test',
    });

    await expect(
      Effect.runPromise(
        makeLocalControlClientSocket({
          runFilePath: paths.runFilePath,
        }).sessionControl(createSessionRequest())
      )
    ).resolves.toEqual([
      { type: 'session/create_ack', sessionId: 'session-1' as SessionId },
      { type: 'session/create_response', sessionId: 'session-1' as SessionId, success: true },
    ]);

    await stopLocalIpcSocketServers();

    expect(fs.existsSync(paths.runFilePath)).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.existsSync(paths.probeSocketPath)).toBe(false);
      expect(fs.existsSync(paths.controlSocketPath)).toBe(false);
    }
  });

  it('deduplicates concurrent startup attempts in one process', async () => {
    const paths = makePaths();
    const config = makeServerConfig(paths);

    const [first, second] = await Promise.all([
      startLocalIpcSocketServers(config),
      startLocalIpcSocketServers(config),
    ]);

    expect(second).toMatchObject({
      socketPath: first.socketPath,
      controlSocketPath: first.controlSocketPath,
      version: first.version,
    });
    await expect(
      Effect.runPromise(makeLocalProbeClientSocket({ runFilePath: paths.runFilePath }).health())
    ).resolves.toMatchObject({ machineId: 'machine-1' as MachineId });
  });

  it.skipIf(process.platform === 'win32')(
    'removes stale Unix socket files before listening',
    async () => {
      const paths = makePaths();
      // Simulate a crash leftover: bind elsewhere, rename the live socket file
      // to the target path, then close — the file survives with no listener.
      const stalePath = `${paths.probeSocketPath}.orig`;
      const staleServer = net.createServer();
      await new Promise<void>((resolve, reject) => {
        staleServer.once('error', reject);
        staleServer.listen(stalePath, resolve);
      });
      fs.renameSync(stalePath, paths.probeSocketPath);
      await new Promise<void>((resolve) => staleServer.close(() => resolve()));
      expect(fs.lstatSync(paths.probeSocketPath).isSocket()).toBe(true);

      await startLocalIpcSocketServers(makeServerConfig(paths));

      await expect(
        Effect.runPromise(makeLocalProbeClientSocket({ runFilePath: paths.runFilePath }).health())
      ).resolves.toMatchObject({ machineId: 'machine-1' as MachineId });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to start when a regular file occupies the socket path and does not delete it',
    async () => {
      const paths = makePaths();
      fs.writeFileSync(paths.probeSocketPath, 'planted');

      await expect(startLocalIpcSocketServers(makeServerConfig(paths))).rejects.toThrow(
        /local_ipc_socket_path_not_socket/
      );
      expect(fs.readFileSync(paths.probeSocketPath, 'utf8')).toBe('planted');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to start when a symlink occupies the socket path and does not delete it',
    async () => {
      const paths = makePaths();
      const targetPath = path.join(path.dirname(paths.controlSocketPath), 'symlink-target');
      fs.writeFileSync(targetPath, 'target');
      fs.symlinkSync(targetPath, paths.controlSocketPath);

      await expect(startLocalIpcSocketServers(makeServerConfig(paths))).rejects.toThrow(
        /local_ipc_socket_path_not_socket/
      );
      expect(fs.lstatSync(paths.controlSocketPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('target');
    }
  );

  it('fails fast when the startup lock is already held', async () => {
    const paths = makePaths();
    fs.mkdirSync(path.dirname(paths.lockFilePath), { recursive: true });
    fs.writeFileSync(paths.lockFilePath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await expect(startLocalIpcSocketServers(makeServerConfig(paths))).rejects.toThrow(
        /local_ipc_lock_in_use/
      );
    } finally {
      fs.unlinkSync(paths.lockFilePath);
    }
  });

  it('recovers a startup lock whose owner process is gone', async () => {
    const paths = makePaths();
    fs.mkdirSync(path.dirname(paths.lockFilePath), { recursive: true });
    fs.writeFileSync(paths.lockFilePath, '99999999\n', { mode: 0o600 });

    await startLocalIpcSocketServers(makeServerConfig(paths));

    await expect(
      Effect.runPromise(makeLocalProbeClientSocket({ runFilePath: paths.runFilePath }).health())
    ).resolves.toMatchObject({ machineId: 'machine-1' as MachineId });
  });

  it('destroys live client connections on stop instead of waiting for them to end', async () => {
    const paths = makePaths();
    await startLocalIpcSocketServers(makeServerConfig(paths));

    // A raw connection that never sends a request: `server.close()` alone
    // would wait for it to end on its own and hang shutdown.
    const client = net.createConnection(paths.controlSocketPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const clientClosed = new Promise<void>((resolve) => {
      client.once('close', () => resolve());
    });
    client.on('error', () => {});

    await stopLocalIpcSocketServers();
    await clientClosed;
    expect(fs.existsSync(paths.runFilePath)).toBe(false);
  });

  it('clears the running state after a post-listen server error so a later start restarts', async () => {
    const paths = makePaths();
    await startLocalIpcSocketServers(makeServerConfig(paths));

    const servers = getLocalIpcSocketServersForTest();
    expect(servers).not.toBeNull();
    servers?.probeServer.emit('error', new Error('boom'));

    expect(getLocalIpcSocketServersForTest()).toBeNull();
    // Cleanup is async; the run-file removal is its last step.
    await vi.waitFor(() => {
      expect(fs.existsSync(paths.runFilePath)).toBe(false);
    });

    await startLocalIpcSocketServers(makeServerConfig(paths));
    await expect(
      Effect.runPromise(makeLocalProbeClientSocket({ runFilePath: paths.runFilePath }).health())
    ).resolves.toMatchObject({ machineId: 'machine-1' as MachineId, pid: process.pid });
  });

  it('enforces the control request body limit over sockets', async () => {
    const paths = makePaths();
    const config = makeServerConfig(paths);
    const bytes = Buffer.alloc(20 * 1024 * 1024, 42);
    config.control.dispatchSession.mockImplementation(async (message, options) => {
      expect(message.type).toBe('session/image-prepare-local');
      if (message.type !== 'session/image-prepare-local')
        throw new Error('Unexpected control command');
      expect(Buffer.from(message.source.base64, 'base64').equals(bytes)).toBe(true);
      const response: LocalSessionControlResponse = {
        type: 'session/image-prepare-local_response',
        sessionId: 'session-1' as SessionId,
        success: true,
      };
      options?.onResponse?.(response);
      return [response];
    });
    await startLocalIpcSocketServers(config);
    await expect(
      Effect.runPromise(
        makeLocalControlClientSocket({ runFilePath: paths.runFilePath }).sessionControl({
          type: 'session/image-prepare-local',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          sessionId: 'session-1' as SessionId,
          imageId: '11111111-1111-4111-8111-111111111111',
          fileName: 'image.png',
          mimeType: 'image/png',
          source: { base64: bytes.toString('base64') },
        })
      )
    ).resolves.toContainEqual({
      type: 'session/image-prepare-local_response',
      sessionId: 'session-1' as SessionId,
      success: true,
    });

    await expect(postOversizedControlBody(paths.controlSocketPath)).resolves.toEqual({
      status: 413,
      payload: { ok: false, error: 'payload_too_large' },
    });
  });
});

describe('local E2EE pairing transport', () => {
  afterEach(async () => {
    await stopLocalIpcSocketServers();
    for (const directory of tempDirs.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });
  it('carries only the explicit superseded receipt over the real local prepare route', async () => {
    const paths = makePaths();
    const config = makeServerConfig(paths);
    const receipt = {
      ok: true as const,
      type: 'prepare-superseded' as const,
      machineId: 'machine-1' as MachineId,
      pairingSessionId: '12'.repeat(16),
    };
    let reply: LocalE2eePrepareReply = receipt;
    let calls = 0;
    await startLocalIpcSocketServers({
      ...config,
      control: {
        ...config.control,
        dispatchE2eePairing: async (message) => {
          expect(message.type).toBe('prepare');
          calls++;
          return reply;
        },
      },
    });
    const client = makeLocalControlClientSocket({ runFilePath: paths.runFilePath });
    const request = {
      type: 'prepare' as const,
      machineId: 'machine-1' as MachineId,
      accountId: 'account',
      workspaceId: 'workspace',
      genesisHash: '78'.repeat(32),
      genesisRecordHex: '01',
      membershipId: '89'.repeat(16),
      pairingSessionId: receipt.pairingSessionId,
      frontendSigningPublicKey: 'ab'.repeat(32),
    };
    expect(await Effect.runPromise(client.e2eePrepare(request))).toEqual(receipt);
    expect(calls).toBe(1);

    // A material-shaped or malformed response cannot become a retirement receipt.
    reply = Object.assign({}, receipt, { credentialHash: '67'.repeat(32) });
    expect((await Effect.runPromise(Effect.result(client.e2eePrepare(request))))._tag).toBe(
      'Failure'
    );
    reply = { ...receipt, pairingSessionId: 'not-a-session' };
    expect((await Effect.runPromise(Effect.result(client.e2eePrepare(request))))._tag).toBe(
      'Failure'
    );
    expect(calls).toBe(3);
  });
  it('exchanges public pairing evidence and activation only over the same-user socket', async () => {
    const paths = makePaths();
    const config = makeServerConfig(paths);
    const material: LocalE2eePrepareResponse = {
      ok: true,
      type: 'prepare',
      machineId: 'machine-1' as MachineId,
      pairingSessionId: '12'.repeat(16),
      signingPublicKey: '23'.repeat(32),
      encryptionPublicKey: '34'.repeat(32),
      possessionSignature: '45'.repeat(64),
      bindingSignature: '56'.repeat(64),
      credentialHash: '67'.repeat(32),
      protection: 'file',
    };
    let activated = false;
    await startLocalIpcSocketServers({
      ...config,
      control: {
        ...config.control,
        dispatchE2eePairing: async (message) => {
          if (message.type === 'prepare') return material;
          activated = true;
          return { ok: true, type: 'activate' };
        },
      },
    });
    const client = makeLocalControlClientSocket({ runFilePath: paths.runFilePath });
    const request = {
      type: 'prepare' as const,
      machineId: 'machine-1' as MachineId,
      accountId: 'account',
      workspaceId: 'workspace',
      genesisHash: '78'.repeat(32),
      genesisRecordHex: '01',
      membershipId: '89'.repeat(16),
      pairingSessionId: material.pairingSessionId,
      frontendSigningPublicKey: 'ab'.repeat(32),
    };
    expect(await Effect.runPromise(client.e2eePrepare(request))).toEqual(material);
    expect(activated).toBe(false);
    const { genesisRecordHex: _genesis, membershipId: _member, ...activation } = request;
    expect(
      await Effect.runPromise(
        client.e2eeActivate({
          ...activation,
          type: 'activate',
          signingPublicKey: material.signingPublicKey,
        })
      )
    ).toEqual({ ok: true, type: 'activate' });
    expect(activated).toBe(true);
    const mismatch = await Effect.runPromise(
      Effect.result(client.e2eePrepare({ ...request, machineId: 'different-machine' }))
    );
    expect(mismatch._tag).toBe('Failure');
  });
});
