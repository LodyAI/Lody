import net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import {
  startLocalTerminalServer,
  stopLocalTerminalServer,
} from '../src/lib/local-terminal-server';
import type { TerminalPtyServiceApi } from '../src/lib/terminal-pty-service';
import type { Logger } from '../src/utils/logger';

const socketPath = vi.hoisted(() =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\lody-terminal-shutdown-test-${process.pid}-${Date.now()}`
    : `/tmp/lody-terminal-shutdown-test-${process.pid}-${Date.now()}.sock`
);
vi.mock('@lody/shared/node/local-terminal', () => ({
  getLocalTerminalSocketPath: () => socketPath,
}));
vi.mock('@lody/shared/node/local-ipc', () => ({ ensureLocalDaemonRunDir() {} }));
const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  setLevel() {},
  child: () => logger,
  close: async () => {},
};
afterEach(async () => {
  await stopLocalTerminalServer();
});

it.each(['resolve', 'reject'] as const)(
  'drains an admitted open that later %ss after its real socket closes',
  async (outcome) => {
    let completeOpen = () => {};
    let failOpen: (error: Error) => void = () => {};
    const opening = new Promise<void>((resolve, reject) => {
      completeOpen = resolve;
      failOpen = reject;
    });
    const liveTerminals = new Set<string>();
    const open = vi.fn(async () => {
      await opening;
      liveTerminals.add('terminal-1');
      return { terminalId: 'terminal-1' };
    });
    const closeAll = vi.fn(() => liveTerminals.clear());
    const service: TerminalPtyServiceApi = {
      open,
      closeAll,
      stopAdmission() {},
      list: () => [],
      attach: () => ({ title: '', scrollback: '' }),
      input() {},
      resize() {},
      close() {},
      closeSession() {},
      onEvent: () => () => {},
    };
    await startLocalTerminalServer({ logger, terminalPtyService: service });
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(
      `${JSON.stringify({ type: 'open', requestId: 'open-1', sessionId: 'session-1', cols: 80, rows: 24 })}\n`
    );
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const stopped = vi.fn();
    const stopping = stopLocalTerminalServer();
    const shutdown = stopping.then(stopped);
    try {
      expect(stopLocalTerminalServer()).toBe(stopping);
      await closed;
      expect(stopped).not.toHaveBeenCalled();
      if (outcome === 'resolve') completeOpen();
      else failOpen(new Error('workdir unavailable'));
      await shutdown;
      expect(liveTerminals.size).toBe(outcome === 'resolve' ? 1 : 0);
      closeAll();
      expect(liveTerminals.size).toBe(0);
      expect(open).toHaveBeenCalledOnce();
    } finally {
      completeOpen();
      socket.destroy();
      await stopping;
    }
  }
);
