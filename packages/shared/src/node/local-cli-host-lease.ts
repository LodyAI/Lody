import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { getInstallationProfile } from './installation-profile';
import type { PlatformKind } from '../platform-kind';

const HOST_TCP_ADDRESS = '127.0.0.1';
const HOST_REQUEST_TIMEOUT_MS = 800;
const E2E_HOST_PORT_ENV = 'LODY_E2E_LOCAL_CLI_HOST_PORT';
const E2E_HOST_PIPE_ENV = 'LODY_E2E_LOCAL_CLI_HOST_PIPE';
const E2E_HOST_PIPE_PATTERN = /^\\\\\.\\pipe\\lody-e2e-[A-Za-z0-9-]{1,80}$/u;

export type LocalCliHostMode = 'daemon' | 'electron' | 'foreground';

export type LocalCliHostRecord = {
  version: 1;
  instanceId: string;
  pid: number;
  mode: LocalCliHostMode;
  startedAtMs: number;
};

export type LocalCliHostEndpoint =
  | { kind: 'pipe'; path: string }
  | { kind: 'tcp'; host: string; port: number };

export type LocalCliHostLease = {
  record: LocalCliHostRecord;
  close: () => Promise<void>;
};

export type LocalCliHostLeaseResult =
  | { status: 'acquired'; lease: LocalCliHostLease }
  | { status: 'occupied'; record: LocalCliHostRecord | null };

type AcquireLocalCliHostLeaseOptions = {
  instanceId: string;
  mode: LocalCliHostMode;
  signal?: AbortSignal;
  endpoint?: LocalCliHostEndpoint;
  shutdownControl?: {
    token: string;
    onRequest: () => void;
  };
};

type ListeningHost = {
  server: net.Server;
  sockets: Set<net.Socket>;
};

function getUserPipeSuffix(): string {
  if (typeof process.getuid === 'function') return String(process.getuid());
  const userInfo = os.userInfo();
  return crypto
    .createHash('sha256')
    .update(`${userInfo.uid}:${userInfo.username}:${os.homedir()}`)
    .digest('hex')
    .slice(0, 16);
}

function getE2eHostPort(): number | null {
  if (process.env.LODY_E2E !== '1') return null;
  const rawPort = process.env[E2E_HOST_PORT_ENV]?.trim();
  if (!rawPort) return null;
  if (!/^\d+$/u.test(rawPort)) {
    throw new Error(`${E2E_HOST_PORT_ENV} must be an integer between 1024 and 65535`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${E2E_HOST_PORT_ENV} must be an integer between 1024 and 65535`);
  }
  return port;
}

export function getE2eHostPipe(nodePlatform = process.platform): string | null {
  if (nodePlatform !== 'win32' || process.env.LODY_E2E !== '1') return null;
  const pipe = process.env[E2E_HOST_PIPE_ENV]?.trim();
  if (!pipe) return null;
  if (!E2E_HOST_PIPE_PATTERN.test(pipe)) {
    throw new Error(`${E2E_HOST_PIPE_ENV} must use the \\\\.\\pipe\\lody-e2e-<id> namespace`);
  }
  return pipe;
}

export function getLocalCliHostEndpoint(platform?: PlatformKind): LocalCliHostEndpoint {
  const profile = getInstallationProfile(platform);
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path:
        getE2eHostPipe() ?? `\\\\.\\pipe\\${profile.namespace}-agent-host-${getUserPipeSuffix()}`,
    };
  }
  return {
    kind: 'tcp',
    host: HOST_TCP_ADDRESS,
    port: getE2eHostPort() ?? profile.localCliHostPort,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Local CLI host acquisition canceled', 'AbortError');
}

function parseRecord(value: unknown): LocalCliHostRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<LocalCliHostRecord>;
  if (
    record.version !== 1 ||
    typeof record.instanceId !== 'string' ||
    !record.instanceId ||
    typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    (record.mode !== 'daemon' && record.mode !== 'electron' && record.mode !== 'foreground') ||
    typeof record.startedAtMs !== 'number' ||
    !Number.isFinite(record.startedAtMs)
  ) {
    return null;
  }
  return record as LocalCliHostRecord;
}

function connect(endpoint: LocalCliHostEndpoint): net.Socket {
  return endpoint.kind === 'pipe'
    ? net.createConnection(endpoint.path)
    : net.createConnection({ host: endpoint.host, port: endpoint.port });
}

function listen(server: net.Server, endpoint: LocalCliHostEndpoint): void {
  if (endpoint.kind === 'pipe') {
    server.listen(endpoint.path);
  } else {
    server.listen(endpoint.port, endpoint.host);
  }
}

export async function inspectLocalCliHost(
  endpoint: LocalCliHostEndpoint = getLocalCliHostEndpoint(),
  timeoutMs = HOST_REQUEST_TIMEOUT_MS
): Promise<LocalCliHostRecord | null> {
  return await new Promise((resolve) => {
    const socket = connect(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (record: LocalCliHostRecord | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(record);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8 * 1024) {
        finish(null);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(parseRecord(JSON.parse(buffer.slice(0, newline))));
      } catch {
        finish(null);
      }
    });
    socket.once('error', () => finish(null));
    socket.once('end', () => finish(null));
  });
}

function isShutdownRequest(
  value: unknown
): value is { type: 'lody/host-shutdown'; instanceId: string; token: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'lody/host-shutdown' &&
    typeof record.instanceId === 'string' &&
    typeof record.token === 'string'
  );
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}

async function createListeningHost(
  endpoint: LocalCliHostEndpoint,
  record: LocalCliHostRecord,
  shutdownControl: AcquireLocalCliHostLeaseOptions['shutdownControl']
): Promise<ListeningHost | null> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // Electron probes this endpoint with a short timeout. If the CLI event loop
    // is temporarily busy, the probe can reset its socket before this callback
    // gets to write the host record. A reset on an accepted socket is a normal
    // peer disconnect, not a host-fatal error; without a listener Node promotes
    // it to an uncaught exception and terminates the CLI.
    socket.on('error', () => socket.destroy());
    socket.write(`${JSON.stringify(record)}\n`);

    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 8 * 1024) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: 'invalid_request' })}\n`);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'invalid_request' })}\n`);
        return;
      }
      if (
        !shutdownControl ||
        !isShutdownRequest(value) ||
        value.instanceId !== record.instanceId ||
        !tokensEqual(value.token, shutdownControl.token)
      ) {
        socket.end(`${JSON.stringify({ ok: false, error: 'unauthorized' })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: true })}\n`, () => {
        queueMicrotask(() => {
          try {
            shutdownControl.onRequest();
          } catch {
            // The authenticated request was accepted; host shutdown owns its own logging.
          }
        });
      });
    });
  });

  return await new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(null);
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve({ server, sockets });
    });
    listen(server, endpoint);
  });
}

async function closeListeningHost(host: ListeningHost): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    host.server.close((error) => (error ? reject(error) : resolve()));
    for (const socket of host.sockets) socket.destroy();
  });
}

export async function acquireLocalCliHostLease(
  options: AcquireLocalCliHostLeaseOptions
): Promise<LocalCliHostLeaseResult> {
  const endpoint = options.endpoint ?? getLocalCliHostEndpoint();
  throwIfAborted(options.signal);

  const observed = await inspectLocalCliHost(endpoint);
  throwIfAborted(options.signal);
  if (observed) return { status: 'occupied', record: observed };

  const record: LocalCliHostRecord = {
    version: 1,
    instanceId: options.instanceId,
    pid: process.pid,
    mode: options.mode,
    startedAtMs: Date.now(),
  };
  const listening = await createListeningHost(endpoint, record, options.shutdownControl);
  if (!listening) {
    return { status: 'occupied', record: await inspectLocalCliHost(endpoint) };
  }
  if (options.signal?.aborted) {
    await closeListeningHost(listening);
    throwIfAborted(options.signal);
  }

  let closed = false;
  return {
    status: 'acquired',
    lease: {
      record,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeListeningHost(listening);
      },
    },
  };
}

export async function requestLocalCliHostShutdown(options: {
  instanceId: string;
  token: string;
  expectedPid?: number;
  expectedMode?: LocalCliHostMode;
  endpoint?: LocalCliHostEndpoint;
  timeoutMs?: number;
}): Promise<{ ok: true; record: LocalCliHostRecord } | { ok: false; error: string }> {
  const endpoint = options.endpoint ?? getLocalCliHostEndpoint();
  const timeoutMs = options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
  return await new Promise((resolve) => {
    const socket = connect(endpoint);
    let buffer = '';
    let hostRecord: LocalCliHostRecord | null = null;
    let settled = false;
    const finish = (
      result: { ok: true; record: LocalCliHostRecord } | { ok: false; error: string }
    ) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8 * 1024) {
        finish({ ok: false, error: 'invalid_response' });
        return;
      }
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          finish({ ok: false, error: 'invalid_response' });
          return;
        }
        if (!hostRecord) {
          hostRecord = parseRecord(value);
          if (
            !hostRecord ||
            hostRecord.instanceId !== options.instanceId ||
            (options.expectedPid !== undefined && hostRecord.pid !== options.expectedPid) ||
            (options.expectedMode !== undefined && hostRecord.mode !== options.expectedMode)
          ) {
            finish({ ok: false, error: 'owner_mismatch' });
            return;
          }
          socket.write(
            `${JSON.stringify({
              type: 'lody/host-shutdown',
              instanceId: options.instanceId,
              token: options.token,
            })}\n`
          );
          continue;
        }
        const response = value as { ok?: unknown; error?: unknown };
        if (response.ok === true) {
          finish({ ok: true, record: hostRecord });
        } else {
          finish({
            ok: false,
            error: typeof response.error === 'string' ? response.error : 'rejected',
          });
        }
        return;
      }
    });
    socket.once('error', (error) => finish({ ok: false, error: error.message }));
    socket.once('end', () => finish({ ok: false, error: 'connection_closed' }));
  });
}
