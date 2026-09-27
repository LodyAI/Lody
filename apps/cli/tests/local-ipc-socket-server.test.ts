import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { LocalSessionControlRequest, LocalSessionControlResponse } from '@lody/shared';
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
  machineId: 'machine-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
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
    sessionId: 'session-1',
    success: true,
  };

  return {
    probe: {
      machineId: 'machine-1',
      cliVersion: '0.0.0-test',
      logger,
      getRuntimeState: () => ({
        schemaVersion: 1 as const,
        phase: 'running' as const,
        startupStage: 'ready' as const,
        machineId: 'machine-1',
        pid: process.pid,
        updatedAtMs: 1,
        issues: [],
      }),
    },
    control: {
      machineId: 'machine-1',
      logger,
      dispatchSession: vi.fn(async (_message, options) => {
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
      Effect.runPromise(makeLocalProbeClientSocket({ socketPath: paths.probeSocketPath }).health())
    ).resolves.toMatchObject({
      ok: true,
      machineId: 'machine-1',
      pid: process.pid,
      cliVersion: '0.0.0-test',
    });

    await expect(
      Effect.runPromise(
        makeLocalControlClientSocket({
          socketPath: paths.controlSocketPath,
        }).sessionControl(createSessionRequest())
      )
    ).resolves.toEqual([
      { type: 'session/create_ack', sessionId: 'session-1' },
      { type: 'session/create_response', sessionId: 'session-1', success: true },
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
      Effect.runPromise(makeLocalProbeClientSocket({ socketPath: paths.probeSocketPath }).health())
    ).resolves.toMatchObject({ machineId: 'machine-1' });
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
        Effect.runPromise(
          makeLocalProbeClientSocket({ socketPath: paths.probeSocketPath }).health()
        )
      ).resolves.toMatchObject({ machineId: 'machine-1' });
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
      Effect.runPromise(makeLocalProbeClientSocket({ socketPath: paths.probeSocketPath }).health())
    ).resolves.toMatchObject({ machineId: 'machine-1' });
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
      Effect.runPromise(makeLocalProbeClientSocket({ socketPath: paths.probeSocketPath }).health())
    ).resolves.toMatchObject({ machineId: 'machine-1', pid: process.pid });
  });

  it('enforces the control request body limit over sockets', async () => {
    const paths = makePaths();
    await startLocalIpcSocketServers(makeServerConfig(paths));

    await expect(postOversizedControlBody(paths.controlSocketPath)).resolves.toEqual({
      status: 413,
      payload: { ok: false, error: 'payload_too_large' },
    });
  });
});
