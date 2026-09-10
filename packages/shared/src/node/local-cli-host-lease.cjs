const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const { getInstallationProfile } = require('./installation-profile.cjs');

const HOST_TCP_ADDRESS = '127.0.0.1';
const HOST_REQUEST_TIMEOUT_MS = 800;
const E2E_HOST_PORT_ENV = 'LODY_E2E_LOCAL_CLI_HOST_PORT';
const E2E_HOST_PIPE_ENV = 'LODY_E2E_LOCAL_CLI_HOST_PIPE';
const E2E_HOST_PIPE_PATTERN = /^\\\\\.\\pipe\\lody-e2e-[A-Za-z0-9-]{1,80}$/u;

function getUserPipeSuffix() {
  if (typeof process.getuid === 'function') return String(process.getuid());
  const userInfo = os.userInfo();
  return crypto
    .createHash('sha256')
    .update(`${userInfo.uid}:${userInfo.username}:${os.homedir()}`)
    .digest('hex')
    .slice(0, 16);
}

function getE2eHostPort() {
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

function getE2eHostPipe(nodePlatform = process.platform) {
  if (nodePlatform !== 'win32' || process.env.LODY_E2E !== '1') return null;
  const pipe = process.env[E2E_HOST_PIPE_ENV]?.trim();
  if (!pipe) return null;
  if (!E2E_HOST_PIPE_PATTERN.test(pipe)) {
    throw new Error(`${E2E_HOST_PIPE_ENV} must use the \\\\.\\pipe\\lody-e2e-<id> namespace`);
  }
  return pipe;
}

function getLocalCliHostEndpoint(platform) {
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Local CLI host acquisition canceled', 'AbortError');
}

function parseRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    value.version !== 1 ||
    typeof value.instanceId !== 'string' ||
    !value.instanceId ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    (value.mode !== 'daemon' && value.mode !== 'electron' && value.mode !== 'foreground') ||
    typeof value.startedAtMs !== 'number' ||
    !Number.isFinite(value.startedAtMs)
  ) {
    return null;
  }
  return value;
}

function connect(endpoint) {
  return endpoint.kind === 'pipe'
    ? net.createConnection(endpoint.path)
    : net.createConnection({ host: endpoint.host, port: endpoint.port });
}

function listen(server, endpoint) {
  if (endpoint.kind === 'pipe') server.listen(endpoint.path);
  else server.listen(endpoint.port, endpoint.host);
}

async function inspectLocalCliHost(
  endpoint = getLocalCliHostEndpoint(),
  timeoutMs = HOST_REQUEST_TIMEOUT_MS
) {
  return await new Promise((resolve) => {
    const socket = connect(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (record) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(record);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8 * 1024) return finish(null);
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

function isShutdownRequest(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.type === 'lody/host-shutdown' &&
    typeof value.instanceId === 'string' &&
    typeof value.token === 'string'
  );
}

function tokensEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}

async function createListeningHost(endpoint, record, shutdownControl) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A timed-out health probe may reset this accepted socket before the host
    // record is written. Treat that peer disconnect as connection-local.
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
      let value;
      try {
        value = JSON.parse(buffer.slice(0, newline));
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
            // The shutdown owner is responsible for logging its own failures.
          }
        });
      });
    });
  });
  return await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve({ server, sockets });
    });
    listen(server, endpoint);
  });
}

async function closeListeningHost(host) {
  await new Promise((resolve, reject) => {
    host.server.close((error) => (error ? reject(error) : resolve()));
    for (const socket of host.sockets) socket.destroy();
  });
}

async function acquireLocalCliHostLease(options) {
  const endpoint = options.endpoint ?? getLocalCliHostEndpoint();
  throwIfAborted(options.signal);
  const observed = await inspectLocalCliHost(endpoint);
  throwIfAborted(options.signal);
  if (observed) return { status: 'occupied', record: observed };
  const record = {
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

async function requestLocalCliHostShutdown(options) {
  const endpoint = options.endpoint ?? getLocalCliHostEndpoint();
  const timeoutMs = options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
  return await new Promise((resolve) => {
    const socket = connect(endpoint);
    let buffer = '';
    let hostRecord = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8 * 1024) return finish({ ok: false, error: 'invalid_response' });
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          return finish({ ok: false, error: 'invalid_response' });
        }
        if (!hostRecord) {
          hostRecord = parseRecord(value);
          if (
            !hostRecord ||
            hostRecord.instanceId !== options.instanceId ||
            (options.expectedPid !== undefined && hostRecord.pid !== options.expectedPid) ||
            (options.expectedMode !== undefined && hostRecord.mode !== options.expectedMode)
          ) {
            return finish({ ok: false, error: 'owner_mismatch' });
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
        if (value?.ok === true) return finish({ ok: true, record: hostRecord });
        return finish({
          ok: false,
          error: typeof value?.error === 'string' ? value.error : 'rejected',
        });
      }
    });
    socket.once('error', (error) => finish({ ok: false, error: error.message }));
    socket.once('end', () => finish({ ok: false, error: 'connection_closed' }));
  });
}

module.exports = {
  acquireLocalCliHostLease,
  getE2eHostPipe,
  getLocalCliHostEndpoint,
  inspectLocalCliHost,
  requestLocalCliHostShutdown,
};
