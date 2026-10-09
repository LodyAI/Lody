import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  ensureLocalDaemonRunDir,
  getLocalControlSocketPath,
  getLocalDaemonLockFilePath,
  getLocalDaemonRunFilePath,
  getLocalProbeSocketPath,
  removeLocalDaemonRunFile,
  writeLocalDaemonRunFile,
  type LocalDaemonRunFile,
} from '@lody/shared/node/local-ipc';
import { getServerNow } from '@lody/shared';
import { createLocalProbeRequestHandler, type LocalProbeConfig } from '@/lib/local-probe';
import {
  createLocalSessionControlRequestHandler,
  type LocalSessionControlConfig,
} from '@/lib/local-session-control';
import { removeStaleUnixSocket } from '@/lib/stale-unix-socket';
import { isPidAliveSync } from '@/platform/promise-facade';

type LocalIpcSocketServerPaths = {
  probeSocketPath?: string;
  controlSocketPath?: string;
  runFilePath?: string;
  lockFilePath?: string;
};

export type LocalIpcSocketServerConfig = {
  probe: LocalProbeConfig;
  control: LocalSessionControlConfig;
  version: string;
  paths?: LocalIpcSocketServerPaths;
};

type SocketServerState = {
  probeServer: http.Server;
  controlServer: http.Server;
  probeSocketPath: string;
  controlSocketPath: string;
  runFilePath: string;
  activeConnections: Set<net.Socket>;
};

let socketServerState: SocketServerState | null = null;
let socketServerStart: Promise<LocalDaemonRunFile> | null = null;

function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function readLockOwnerPid(lockFilePath: string): number | null {
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function createStartupLock(lockFilePath: string): number {
  const fd = fs.openSync(lockFilePath, 'wx', 0o600);
  fs.writeSync(fd, `${process.pid}\n`);
  if (process.platform !== 'win32') {
    fs.chmodSync(lockFilePath, 0o600);
  }
  return fd;
}

function acquireStartupLock(lockFilePath: string): number {
  try {
    return createStartupLock(lockFilePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw error;
    }

    const ownerPid = readLockOwnerPid(lockFilePath);
    if (ownerPid !== null && isPidAliveSync(ownerPid)) {
      throw new Error(`local_ipc_lock_in_use:${lockFilePath}`, { cause: error });
    }

    unlinkIfExists(lockFilePath);
    try {
      return createStartupLock(lockFilePath);
    } catch (retryError) {
      throw new Error(`local_ipc_lock_in_use:${lockFilePath}`, { cause: retryError });
    }
  }
}

async function withStartupLock<T>(lockFilePath: string, fn: () => Promise<T>): Promise<T> {
  ensureLocalDaemonRunDir(path.dirname(lockFilePath));
  const fd = acquireStartupLock(lockFilePath);
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
    unlinkIfExists(lockFilePath);
  }
}

// `http.Server.close()` only stops accepting new connections and otherwise
// waits for every open connection to end on its own; long-lived keep-alive
// clients (Electron main polls these sockets continuously) would stall
// shutdown, so track live connections and destroy them when stopping — same
// hazard local-terminal-server.ts documents for its persistent relay client.
function trackConnections(server: http.Server, connections: Set<net.Socket>): void {
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => {
      connections.delete(socket);
    });
  });
}

async function listenOnSocket(
  server: http.Server,
  socketPath: string,
  label: string,
  config: LocalProbeConfig
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      if (process.platform !== 'win32') {
        fs.chmodSync(socketPath, 0o600);
      }
      config.logger.debug(`[local-ipc] ${label} socket listening at ${socketPath}`);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function closeServerAndUnlink(server: http.Server, socketPath: string): Promise<void> {
  await closeServer(server);
  if (process.platform !== 'win32') {
    unlinkIfExists(socketPath);
  }
}

async function shutdownSocketServerState(state: SocketServerState): Promise<void> {
  for (const socket of state.activeConnections) {
    socket.destroy();
  }
  state.activeConnections.clear();
  await Promise.all([
    closeServerAndUnlink(state.probeServer, state.probeSocketPath),
    closeServerAndUnlink(state.controlServer, state.controlSocketPath),
  ]);
  removeLocalDaemonRunFile(state.runFilePath);
}

async function startLocalIpcSocketServersInner(
  config: LocalIpcSocketServerConfig
): Promise<LocalDaemonRunFile> {
  const probeSocketPath = config.paths?.probeSocketPath ?? getLocalProbeSocketPath();
  const controlSocketPath = config.paths?.controlSocketPath ?? getLocalControlSocketPath();
  const runFilePath = config.paths?.runFilePath ?? getLocalDaemonRunFilePath();
  const lockFilePath = config.paths?.lockFilePath ?? getLocalDaemonLockFilePath();

  return await withStartupLock(lockFilePath, async () => {
    await removeStaleUnixSocket(probeSocketPath, 'local_ipc_socket_in_use');
    await removeStaleUnixSocket(controlSocketPath, 'local_ipc_socket_in_use');

    const probeServer = http.createServer(createLocalProbeRequestHandler(config.probe));
    const controlServer = http.createServer(
      createLocalSessionControlRequestHandler(config.control)
    );
    const activeConnections = new Set<net.Socket>();
    trackConnections(probeServer, activeConnections);
    trackConnections(controlServer, activeConnections);
    const state: SocketServerState = {
      probeServer,
      controlServer,
      probeSocketPath,
      controlSocketPath,
      runFilePath,
      activeConnections,
    };
    // A post-listen server error leaves the server dead; clear the singleton
    // and clean up so a later start actually restarts instead of returning a
    // fake "running" state, and log with the failing channel label.
    const handleFatalServerError = (label: string) => (error: Error) => {
      config.probe.logger.warn(`[local-ipc] ${label} socket server error: ${error.message}`);
      if (socketServerState !== state) {
        return;
      }
      socketServerState = null;
      void shutdownSocketServerState(state).catch((cleanupError: unknown) => {
        config.probe.logger.debug(
          `[local-ipc] cleanup after ${label} socket server error failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`
        );
      });
    };
    probeServer.on('error', handleFatalServerError('probe'));
    controlServer.on('error', handleFatalServerError('control'));

    try {
      await listenOnSocket(probeServer, probeSocketPath, 'probe', config.probe);
      await listenOnSocket(controlServer, controlSocketPath, 'control', config.probe);

      const runFile: LocalDaemonRunFile = {
        pid: process.pid,
        socketPath: probeSocketPath,
        controlSocketPath,
        version: config.version,
        startedAt: new Date(getServerNow()).toISOString(),
      };
      writeLocalDaemonRunFile(runFile, runFilePath);
      socketServerState = state;
      return runFile;
    } catch (error) {
      for (const socket of activeConnections) {
        socket.destroy();
      }
      activeConnections.clear();
      await closeServer(probeServer).catch(() => {});
      await closeServer(controlServer).catch(() => {});
      if (process.platform !== 'win32') {
        unlinkIfExists(probeSocketPath);
        unlinkIfExists(controlSocketPath);
      }
      throw error;
    }
  });
}

export async function startLocalIpcSocketServers(
  config: LocalIpcSocketServerConfig
): Promise<LocalDaemonRunFile> {
  if (socketServerState) {
    return {
      pid: process.pid,
      socketPath: socketServerState.probeSocketPath,
      controlSocketPath: socketServerState.controlSocketPath,
      version: config.version,
      startedAt: new Date(getServerNow()).toISOString(),
    };
  }
  if (socketServerStart) {
    return await socketServerStart;
  }

  socketServerStart = startLocalIpcSocketServersInner(config).finally(() => {
    socketServerStart = null;
  });
  return await socketServerStart;
}

export async function stopLocalIpcSocketServers(): Promise<void> {
  if (!socketServerState) {
    return;
  }

  const state = socketServerState;
  socketServerState = null;
  await shutdownSocketServerState(state);
}

// Test-only: exposes the live server handles so tests can simulate post-listen
// fatal errors without reaching into module internals.
export function getLocalIpcSocketServersForTest(): {
  probeServer: http.Server;
  controlServer: http.Server;
} | null {
  if (!socketServerState) {
    return null;
  }
  return {
    probeServer: socketServerState.probeServer,
    controlServer: socketServerState.controlServer,
  };
}
