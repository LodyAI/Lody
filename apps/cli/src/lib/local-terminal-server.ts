import fs from 'node:fs';
import net from 'node:net';
import { getLocalTerminalSocketPath } from '@lody/shared/node/local-terminal';
import { ensureLocalDaemonRunDir } from '@lody/shared/node/local-ipc';
import {
  createUtf8StreamDecoder,
  TerminalClientMessageSchema,
  type TerminalClientMessage,
  type TerminalServerEvent,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { TerminalPtyServiceApi } from '@/lib/terminal-pty-service';
import { removeStaleUnixSocket } from '@/lib/stale-unix-socket';

const MAX_BUFFER_BYTES = 1024 * 1024;

export interface LocalTerminalServerConfig {
  logger: Logger;
  terminalPtyService: TerminalPtyServiceApi;
}

type TerminalSocketState = {
  subscribedTerminalIds: Set<string>;
  replayingTerminalIds: Set<string>;
  replayBuffers: Map<string, TerminalServerEvent[]>;
};

let terminalServer: net.Server | null = null;
let activeSocketPath: string | null = null;
let terminalServerStart: Promise<void> | null = null;
let terminalServerStop: Promise<void> | null = null;
let acceptingMessages = false;
const pendingMessages = new Set<Promise<void>>();
// Tracks live client connections so shutdown can destroy them immediately.
// `net.Server.close()` only stops accepting new connections and otherwise waits
// for every open connection to end on its own; the Electron terminal relay holds
// a persistent (auto-reconnecting) connection, so without forcibly destroying
// these the listening socket would linger past process exit and block the next
// launch with `local_terminal_socket_in_use`.
const activeClientSockets = new Set<net.Socket>();

// Outbound events are built by trusted internal code (each `send()` call site is
// typed against TerminalServerEvent), so we skip a per-chunk schema re-validation
// here — it would run a full discriminated-union parse on every PTY output chunk
// on the CPU-sensitive CLI main thread. Inbound client messages are still
// validated at the trust boundary in the socket 'data' handler below.
function encodeEvent(event: TerminalServerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function send(socket: net.Socket, event: TerminalServerEvent): void {
  if (socket.destroyed) return;
  socket.write(encodeEvent(event));
}

function getEventTerminalId(event: TerminalServerEvent): string | null {
  return 'terminalId' in event && typeof event.terminalId === 'string' ? event.terminalId : null;
}

function createTerminalSocketState(): TerminalSocketState {
  return {
    subscribedTerminalIds: new Set<string>(),
    replayingTerminalIds: new Set<string>(),
    replayBuffers: new Map<string, TerminalServerEvent[]>(),
  };
}

function publishTerminalEvent(
  socket: net.Socket,
  state: TerminalSocketState,
  event: TerminalServerEvent
): void {
  const terminalId = getEventTerminalId(event);
  if (!terminalId) {
    send(socket, event);
    return;
  }
  if (!state.subscribedTerminalIds.has(terminalId)) {
    return;
  }
  if (state.replayingTerminalIds.has(terminalId)) {
    const buffer = state.replayBuffers.get(terminalId) ?? [];
    buffer.push(event);
    state.replayBuffers.set(terminalId, buffer);
    return;
  }
  send(socket, event);
  if (event.type === 'exit') {
    state.subscribedTerminalIds.delete(terminalId);
  }
}

function startTerminalReplay(state: TerminalSocketState, terminalId: string): void {
  state.subscribedTerminalIds.add(terminalId);
  state.replayingTerminalIds.add(terminalId);
  state.replayBuffers.set(terminalId, []);
}

function finishTerminalReplay(
  socket: net.Socket,
  state: TerminalSocketState,
  terminalId: string
): void {
  state.replayingTerminalIds.delete(terminalId);
  const bufferedEvents = state.replayBuffers.get(terminalId) ?? [];
  state.replayBuffers.delete(terminalId);
  for (const event of bufferedEvents) {
    send(socket, event);
    if (event.type === 'exit') {
      state.subscribedTerminalIds.delete(terminalId);
    }
  }
}

function cancelTerminalReplay(state: TerminalSocketState, terminalId: string): void {
  state.replayingTerminalIds.delete(terminalId);
  state.replayBuffers.delete(terminalId);
  state.subscribedTerminalIds.delete(terminalId);
}

function classifyTerminalError(error: unknown): { code: string; message: string } {
  const message = formatErrorMessage(error);
  if (message.startsWith('session_not_found:')) {
    return { code: 'session_not_found', message };
  }
  if (message.startsWith('session_archived:')) {
    return { code: 'session_archived', message };
  }
  if (message.startsWith('session_deleted:')) {
    return { code: 'session_deleted', message };
  }
  if (message.startsWith('session_machine_mismatch:')) {
    return { code: 'session_machine_mismatch', message };
  }
  if (message.startsWith('session_parent_cycle:')) {
    return { code: 'session_parent_cycle', message };
  }
  if (message.startsWith('session_ambiguous:')) {
    return { code: 'session_ambiguous', message };
  }
  if (message.startsWith('terminal_not_found:')) {
    return { code: 'terminal_not_found', message };
  }
  if (message.startsWith('terminal_limit_exceeded:')) {
    return { code: 'terminal_limit_exceeded', message };
  }
  if (message.includes('workdir') || message.includes('directory') || message.includes('ENOENT')) {
    return { code: 'workdir_unavailable', message };
  }
  return { code: 'terminal_error', message };
}

async function handleMessage(
  config: LocalTerminalServerConfig,
  socket: net.Socket,
  state: TerminalSocketState,
  message: TerminalClientMessage
): Promise<void> {
  try {
    switch (message.type) {
      case 'list': {
        send(socket, {
          type: 'terminals',
          requestId: message.requestId,
          sessionId: message.sessionId,
          terminals: config.terminalPtyService.list(message.sessionId),
        });
        return;
      }
      case 'open': {
        const result = await config.terminalPtyService.open(message);
        send(socket, {
          type: 'opened',
          requestId: message.requestId,
          terminalId: result.terminalId,
          ...(result.cwd ? { cwd: result.cwd } : {}),
        });
        return;
      }
      case 'attach': {
        startTerminalReplay(state, message.terminalId);
        try {
          const replay = config.terminalPtyService.attach(
            message.terminalId,
            message.cols,
            message.rows
          );
          send(socket, {
            terminalId: message.terminalId,
            type: 'title',
            title: replay.title,
          });
          if (replay.scrollback) {
            send(socket, {
              type: 'data',
              terminalId: message.terminalId,
              data: replay.scrollback,
              replay: true,
            });
          }
          finishTerminalReplay(socket, state, message.terminalId);
        } catch (error) {
          cancelTerminalReplay(state, message.terminalId);
          throw error;
        }
        return;
      }
      case 'input': {
        config.terminalPtyService.input(message.terminalId, message.data);
        return;
      }
      case 'resize': {
        config.terminalPtyService.resize(message.terminalId, message.cols, message.rows);
        return;
      }
      case 'close': {
        config.terminalPtyService.close(message.terminalId);
        return;
      }
      case 'close_session': {
        config.terminalPtyService.closeSession(message.sessionId);
        return;
      }
      default: {
        throw new Error(`unsupported_terminal_message:${JSON.stringify(message)}`);
      }
    }
  } catch (error) {
    const terminalError = classifyTerminalError(error);
    send(socket, {
      type: 'error',
      requestId: message.requestId,
      ...('terminalId' in message ? { terminalId: message.terminalId } : {}),
      code: terminalError.code,
      message: terminalError.message,
    });
  }
}

export async function startLocalTerminalServer(config: LocalTerminalServerConfig): Promise<void> {
  if (terminalServerStop) await terminalServerStop;
  if (terminalServer) {
    return;
  }
  if (terminalServerStart) {
    return await terminalServerStart;
  }

  acceptingMessages = true;
  terminalServerStart = startLocalTerminalServerInner(config).finally(() => {
    terminalServerStart = null;
  });
  return await terminalServerStart;
}

async function startLocalTerminalServerInner(config: LocalTerminalServerConfig): Promise<void> {
  // The terminal socket lives in the 0700 daemon run dir (S1); make sure the
  // dir exists even when this server starts before the IPC socket servers.
  ensureLocalDaemonRunDir();
  const socketPath = getLocalTerminalSocketPath();
  await removeStaleUnixSocket(socketPath, 'local_terminal_socket_in_use');

  const server = net.createServer((socket) => {
    if (!acceptingMessages) {
      socket.destroy();
      return;
    }
    let buffer = '';
    // One decoder per connection: a pasted multi-byte character can land on a
    // socket chunk boundary, and per-chunk `toString('utf8')` would turn it into
    // U+FFFD on both sides of the split.
    const decodeChunk = createUtf8StreamDecoder();
    const state = createTerminalSocketState();
    activeClientSockets.add(socket);
    const unsubscribe = config.terminalPtyService.onEvent((event) => {
      publishTerminalEvent(socket, state, event);
    });

    socket.on('data', (chunk) => {
      if (!acceptingMessages) return;
      buffer += decodeChunk(chunk);
      // Compare char length (O(1)) rather than re-scanning the whole buffer with
      // Buffer.byteLength on every chunk (O(n²) across a large multi-chunk paste).
      // This is a safety cap against an unbounded line, so an approximate bound is fine.
      if (buffer.length > MAX_BUFFER_BYTES) {
        send(socket, {
          type: 'error',
          code: 'payload_too_large',
          message: 'Terminal socket payload exceeded buffer limit',
        });
        socket.destroy();
        return;
      }

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch (error) {
            send(socket, {
              type: 'error',
              code: 'invalid_json',
              message: formatErrorMessage(error),
            });
            newlineIndex = buffer.indexOf('\n');
            continue;
          }

          const parsed = TerminalClientMessageSchema.safeParse(raw);
          if (!parsed.success) {
            send(socket, {
              type: 'error',
              code: 'invalid_request',
              message: parsed.error.message,
            });
            newlineIndex = buffer.indexOf('\n');
            continue;
          }

          const pending = handleMessage(config, socket, state, parsed.data);
          pendingMessages.add(pending);
          void pending.then(
            () => pendingMessages.delete(pending),
            () => pendingMessages.delete(pending)
          );
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      activeClientSockets.delete(socket);
      unsubscribe();
    });
    socket.on('error', (error) => {
      config.logger.debug(`[terminal] socket error: ${error.message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      terminalServer = server;
      activeSocketPath = socketPath;
      if (process.platform !== 'win32') {
        fs.chmodSync(socketPath, 0o600);
      }
      config.logger.debug(`[terminal] local terminal socket listening at ${socketPath}`);
      resolve();
    });
  });

  server.on('error', (error) => {
    config.logger.warn(`[terminal] local terminal server error: ${error.message}`);
    if (terminalServer === server) {
      terminalServer = null;
      activeSocketPath = null;
    }
    try {
      server.close();
    } catch {
      // already closed
    }
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });
}

export function stopLocalTerminalServer(): Promise<void> {
  acceptingMessages = false;
  if (terminalServerStop) return terminalServerStop;
  const stop = stopLocalTerminalServerInner();
  terminalServerStop = stop;
  void stop.then(
    () => {
      if (terminalServerStop === stop) terminalServerStop = null;
    },
    () => {
      if (terminalServerStop === stop) terminalServerStop = null;
    }
  );
  return stop;
}

async function stopLocalTerminalServerInner(): Promise<void> {
  // A shutdown that races listen must also close that newly created listener.
  await terminalServerStart?.catch(() => undefined);

  const server = terminalServer;
  const socketPath = activeSocketPath;
  terminalServer = null;
  activeSocketPath = null;

  // Force-close live client connections first. `server.close()` otherwise waits
  // for each one to end on its own, and the Electron relay keeps a persistent
  // connection — so without this the listening socket would linger past shutdown
  // and block the next launch with `local_terminal_socket_in_use`.
  for (const socket of activeClientSockets) {
    socket.destroy();
  }
  activeClientSockets.clear();

  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  // Destroying a socket does not cancel an already admitted open awaiting its
  // workdir. Drain those handlers before the fleet snapshots and closes PTYs.
  await Promise.allSettled(pendingMessages);
  if (socketPath && process.platform !== 'win32' && fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
}
