import {
  getLocalIpcServerCredentials,
  makeWindowsLocalPipePath,
  matchesLocalIpcToken,
  LOCAL_IPC_TOKEN_HEADER,
} from '../src/node/local-ipc-auth';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { LocalSessionControlRequest } from '../src/message';
import {
  LOCAL_IPC_MAX_RESPONSE_BODY_BYTES,
  IpcProtocolError,
  getLocalControlSocketPath,
  getLocalDaemonRunDir,
  getLocalDaemonRunFilePath,
  getLocalLoroDataPlaneSocketPath,
  getLocalProbeSocketPath,
  makeLocalControlClientAuto,
  makeLocalControlClientSocket,
  makeLocalProbeClientSocket,
  readLocalDaemonRunFile,
  writeLocalDaemonRunFile,
} from '../src/node/local-ipc';
import { getLocalTerminalSocketPath } from '../src/node/local-terminal';

const servers: http.Server[] = [];
const tempDirs: string[] = [];

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function makeSocketPath(name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\lody-test-${process.pid}-${randomUUID()}-${name}`;
  }
  return path.join(makeTempDir('lody-ipc-'), `${name}.sock`);
}

function listenSocket(socketPath: string, handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
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

describe('local IPC socket client', () => {
  afterEach(async () => {
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

  it('rejects oversized responses with a typed protocol error instead of buffering them', async () => {
    const socketPath = makeSocketPath('control');
    await listenSocket(socketPath, (_req, res) => {
      // Swallow write errors: the client destroys the connection mid-body once
      // the cap trips, which is exactly what this test provokes.
      res.on('error', () => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(Buffer.alloc(LOCAL_IPC_MAX_RESPONSE_BODY_BYTES + 1, 0x61));
    });

    const error = await Effect.runPromise(
      Effect.flip(
        makeLocalControlClientSocket({ socketPath }).sessionControl(createSessionRequest())
      )
    );
    expect(error).toBeInstanceOf(IpcProtocolError);
    expect(error.message).toContain(`exceeded ${LOCAL_IPC_MAX_RESPONSE_BODY_BYTES} bytes`);
  });

  it('auto control client is socket-only', async () => {
    await expect(
      Effect.runPromise(
        Effect.flip(
          makeLocalControlClientAuto({
            socketPath: makeSocketPath('missing-control'),
          }).sessionControl(createSessionRequest())
        )
      )
    ).resolves.toMatchObject({ _tag: 'IpcConnectError' });
  });

  it('derives Windows endpoints from a 256-bit random suffix, independently of the token', () => {
    const { pipeSuffix, token } = getLocalIpcServerCredentials();
    const endpoint = makeWindowsLocalPipePath('lody-control', pipeSuffix);
    expect(pipeSuffix).toMatch(/^[a-f0-9]{64}$/);
    expect(endpoint).toBe(`\\\\.\\pipe\\lody-control-${pipeSuffix}`);
    expect(endpoint).not.toContain(token);
    expect(makeWindowsLocalPipePath('lody-control', 'c'.repeat(64))).not.toBe(endpoint);
  });

  it('discovers the exact published Windows pipe names through daemon.json', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    vi.stubEnv('LODY_DATA_DIR', makeTempDir('lody-win-ipc-'));
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { token, pipeSuffix } = getLocalIpcServerCredentials();
      const run = {
        pid: 123,
        version: 'test',
        startedAt: '2026-11-12T00:00:00Z',
        token,
        socketPath: getLocalProbeSocketPath(undefined, pipeSuffix),
        controlSocketPath: getLocalControlSocketPath(undefined, pipeSuffix),
        dataPlaneSocketPath: getLocalLoroDataPlaneSocketPath(undefined, pipeSuffix),
      };
      writeLocalDaemonRunFile(run, getLocalDaemonRunFilePath());
      expect(getLocalProbeSocketPath()).toBe(run.socketPath);
      expect(getLocalControlSocketPath()).toBe(run.controlSocketPath);
      expect(getLocalLoroDataPlaneSocketPath()).toBe(run.dataPlaneSocketPath);
      expect(readLocalDaemonRunFile()).toEqual(run);
    } finally {
      if (descriptor) Object.defineProperty(process, 'platform', descriptor);
      vi.unstubAllEnvs();
    }
  });

  it('refreshes address and token together after a cached token is rejected', async () => {
    const socketPath = makeSocketPath('rotate');
    let token = 'a'.repeat(64);
    const presented: unknown[] = [];
    await listenSocket(socketPath, (req, res) => {
      presented.push(req.headers[LOCAL_IPC_TOKEN_HEADER]);
      const authenticated = matchesLocalIpcToken(token, req.headers[LOCAL_IPC_TOKEN_HEADER]);
      res.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          authenticated
            ? { ok: true, responses: [] }
            : { ok: false, error: 'local_ipc_unauthorized' }
        )
      );
    });
    const runFilePath = path.join(makeTempDir('lody-rotation-'), 'daemon.json');
    const publish = () =>
      writeLocalDaemonRunFile(
        {
          pid: 123,
          socketPath,
          controlSocketPath: socketPath,
          version: 'test',
          startedAt: 'test',
          token,
        },
        runFilePath
      );
    publish();
    const client = makeLocalControlClientSocket({ runFilePath });
    expect(await Effect.runPromise(client.sessionControl(createSessionRequest()))).toEqual([]);
    token = 'b'.repeat(64);
    publish();
    expect(await Effect.runPromise(client.sessionControl(createSessionRequest()))).toEqual([]);
    token = 'c'.repeat(64);
    expect(
      await Effect.runPromise(Effect.flip(client.sessionControl(createSessionRequest())))
    ).toMatchObject({ status: 401 });
    expect(presented).toEqual(['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), 'b'.repeat(64)]);
  });

  it.each([true, false])(
    'handles JSON POST authentication after restart (metadata rotated=%s)',
    async (rotated) => {
      const socketPath = makeSocketPath('schedule-token');
      const runFilePath = path.join(makeTempDir('lody-schedule-token-'), 'daemon.json');
      let token = 'a'.repeat(64);
      const presented: unknown[] = [];
      const appliedQueries: string[] = [];
      await listenSocket(socketPath, async (req, res) => {
        const body = JSON.parse(await readBody(req));
        presented.push(req.headers[LOCAL_IPC_TOKEN_HEADER]);
        const authenticated = matchesLocalIpcToken(token, req.headers[LOCAL_IPC_TOKEN_HEADER]);
        if (authenticated) appliedQueries.push(body.command.query);
        res.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            authenticated
              ? { ok: true, result: { schedules: [] } }
              : { ok: false, error: 'local_ipc_unauthorized' }
          )
        );
      });
      const publish = () =>
        writeLocalDaemonRunFile(
          {
            pid: 123,
            socketPath,
            controlSocketPath: socketPath,
            version: 'test',
            startedAt: 'test',
            token,
          },
          runFilePath
        );
      publish();
      const client = makeLocalControlClientSocket({ runFilePath });
      const request = (query: string) =>
        client.scheduleControl({
          machineId: 'synthetic-machine',
          workspaceId: 'synthetic-workspace',
          command: { action: 'list', query, limit: 30 },
        });
      const success = { ok: true, result: { schedules: [] } };
      expect(await Effect.runPromise(request('initial'))).toEqual(success);
      token = 'b'.repeat(64);
      if (rotated) publish();
      if (rotated) {
        expect(await Effect.runPromise(request('after-restart'))).toEqual(success);
        expect(presented).toEqual(['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)]);
        expect(appliedQueries).toEqual(['initial', 'after-restart']);
      } else {
        const error = await Effect.runPromise(Effect.flip(request('after-restart')));
        expect(error).toBeInstanceOf(IpcProtocolError);
        expect(error).toMatchObject({ status: 401, errorCode: 'local_ipc_unauthorized' });
        expect(presented).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
        expect(appliedQueries).toEqual(['initial']);
      }
    }
  );

  it('follows a new daemon address after an explicitly supplied discovered socket closes', async () => {
    const firstPath = makeSocketPath('first');
    const secondPath = makeSocketPath('second');
    const serve: http.RequestListener = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, responses: [] }));
    };
    const first = await listenSocket(firstPath, serve);
    await listenSocket(secondPath, serve);
    const runFilePath = path.join(makeTempDir('lody-address-rotation-'), 'daemon.json');
    const publish = (socketPath: string) =>
      writeLocalDaemonRunFile(
        {
          pid: 123,
          socketPath,
          controlSocketPath: socketPath,
          version: 'test',
          startedAt: 'test',
          token: 'a'.repeat(64),
        },
        runFilePath
      );
    publish(firstPath);
    const client = makeLocalControlClientSocket({ socketPath: firstPath, runFilePath });
    expect(await Effect.runPromise(client.sessionControl(createSessionRequest()))).toEqual([]);
    await new Promise<void>((resolve) => first.close(() => resolve()));
    publish(secondPath);
    expect(await Effect.runPromise(client.sessionControl(createSessionRequest()))).toEqual([]);
  });

  it('keeps a long-lived daemon health probe successful across token rotation', async () => {
    const socketPath = makeSocketPath('probe-rotation');
    const runFilePath = path.join(makeTempDir('lody-probe-rotation-'), 'daemon.json');
    let token = 'a'.repeat(64);
    await listenSocket(socketPath, (req, res) => {
      const authenticated = matchesLocalIpcToken(token, req.headers[LOCAL_IPC_TOKEN_HEADER]);
      res.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          authenticated
            ? {
                ok: true,
                machineId: 'synthetic-machine',
                pid: 123,
                cliVersion: 'test',
                homeDir: '/synthetic',
              }
            : { error: 'local_ipc_unauthorized' }
        )
      );
    });
    const publish = () =>
      writeLocalDaemonRunFile(
        {
          pid: 123,
          socketPath,
          controlSocketPath: socketPath,
          version: 'test',
          startedAt: 'test',
          token,
        },
        runFilePath
      );
    publish();
    const client = makeLocalProbeClientSocket({ runFilePath });
    expect(await Effect.runPromise(client.health())).toMatchObject({ ok: true });
    token = 'b'.repeat(64);
    publish();
    expect(await Effect.runPromise(client.health())).toMatchObject({ ok: true });
  });

  it('preserves an explicit endpoint when optional default metadata is corrupt', async () => {
    const socketPath = makeSocketPath('explicit');
    await listenSocket(socketPath, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          responses: req.headers[LOCAL_IPC_TOKEN_HEADER] ? ['unexpected-token'] : [],
        })
      );
    });
    vi.stubEnv('LODY_DATA_DIR', makeTempDir('lody-corrupt-default-'));
    try {
      const file = getLocalDaemonRunFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'not json');
      expect(
        await Effect.runPromise(
          makeLocalControlClientSocket({ socketPath }).sessionControl(createSessionRequest())
        )
      ).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops after one refresh when the newly published credential is also rejected', async () => {
    const socketPath = makeSocketPath('invalid-refresh');
    let published = 'a'.repeat(64);
    let reject = false;
    const accepted: string[] = [];
    const runFilePath = path.join(makeTempDir('lody-refresh-limit-'), 'daemon.json');
    const publish = () =>
      writeLocalDaemonRunFile(
        {
          pid: 123,
          socketPath,
          controlSocketPath: socketPath,
          version: 'test',
          startedAt: 'test',
          token: published,
        },
        runFilePath
      );
    await listenSocket(socketPath, async (req, res) => {
      await readBody(req);
      if (reject) {
        // Further rotation during the retry must not start another attempt.
        if (req.headers[LOCAL_IPC_TOKEN_HEADER] === published) {
          published = 'c'.repeat(64);
          publish();
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'local_ipc_unauthorized' }));
      } else {
        accepted.push('created');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, responses: [] }));
      }
    });
    publish();
    const client = makeLocalControlClientSocket({ runFilePath });
    await Effect.runPromise(client.sessionControl(createSessionRequest()));
    published = 'b'.repeat(64);
    publish();
    reject = true;
    expect(
      await Effect.runPromise(Effect.flip(client.sessionControl(createSessionRequest())))
    ).toMatchObject({ status: 401 });
    expect(accepted).toEqual(['created']);
  });

  it.each(['disconnect', 'timeout', 'business-401'] as const)(
    'does not replay a dispatched request after %s even if metadata rotates',
    async (failure) => {
      const socketPath = makeSocketPath('no-replay');
      const runFilePath = path.join(makeTempDir('lody-no-replay-'), 'daemon.json');
      const publish = (token: string) =>
        writeLocalDaemonRunFile(
          {
            pid: 123,
            socketPath,
            controlSocketPath: socketPath,
            version: 'test',
            startedAt: 'test',
            token,
          },
          runFilePath
        );
      const applied: string[] = [];
      let handled!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        handled = resolve;
      });
      await listenSocket(socketPath, async (req, res) => {
        await readBody(req);
        applied.push(applied.length === 0 ? 'initial' : 'write');
        if (applied.length === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, responses: [] }));
          return;
        }
        publish('b'.repeat(64));
        handled();
        if (failure === 'disconnect') req.socket.destroy();
        if (failure === 'business-401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'business_unauthorized' }));
        }
      });
      publish('a'.repeat(64));
      const client = makeLocalControlClientSocket({ runFilePath });
      await Effect.runPromise(client.sessionControl(createSessionRequest()));
      const originalRequest = http.request;
      let outgoing: http.ClientRequest | undefined;
      const requestSpy = vi.spyOn(http, 'request').mockImplementation((...args) => {
        outgoing = Reflect.apply(originalRequest, http, args) as http.ClientRequest;
        return outgoing;
      });
      const result = Effect.runPromise(Effect.flip(client.sessionControl(createSessionRequest())));
      await dispatched;
      if (failure === 'timeout') outgoing?.emit('timeout');
      requestSpy.mockRestore();
      expect(await result).toMatchObject({
        _tag:
          failure === 'business-401'
            ? 'IpcProtocolError'
            : failure === 'timeout'
              ? 'IpcTimeoutError'
              : 'IpcConnectError',
      });
      expect(applied).toEqual(['initial', 'write']);
    }
  );

  it('writes and reads the daemon run-file atomically with private permissions', () => {
    const runFilePath = path.join(makeTempDir('lody-run-parent-'), 'run', 'daemon.json');
    const runFile = {
      token: getLocalIpcServerCredentials().token,
      dataPlaneSocketPath: makeWindowsLocalPipePath(
        'data',
        getLocalIpcServerCredentials().pipeSuffix
      ),
      pid: 123,
      socketPath: '/tmp/lody-probe-test.sock',
      controlSocketPath: '/tmp/lody-control-test.sock',
      version: '0.0.0-test',
      startedAt: '2026-06-29T00:00:00.000Z',
    };

    writeLocalDaemonRunFile(runFile, runFilePath);

    expect(readLocalDaemonRunFile(runFilePath)).toEqual(runFile);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(runFilePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(runFilePath).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'places default socket paths inside the private daemon run dir, not tmpdir',
    () => {
      const runDir = getLocalDaemonRunDir();
      expect(path.dirname(getLocalControlSocketPath())).toBe(runDir);
      expect(path.dirname(getLocalProbeSocketPath())).toBe(runDir);
      expect(path.dirname(getLocalTerminalSocketPath())).toBe(runDir);
      expect(runDir.startsWith(os.tmpdir())).toBe(false);
    }
  );

  it('keeps the CommonJS terminal socket path in sync with the TypeScript module', () => {
    const require = createRequire(import.meta.url);
    const cjs = require('../src/node/local-terminal.cjs') as {
      getLocalTerminalSocketPath: () => string;
    };
    expect(cjs.getLocalTerminalSocketPath()).toBe(getLocalTerminalSocketPath());
  });
});
