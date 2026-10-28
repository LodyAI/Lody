import { EventEmitter } from 'events';
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { ACPSessionId, SessionId } from '@lody/shared';

import { AgentClient } from '../src/agent/agent-client';
import { createNoopSessionSandbox } from '../src/session/session-sandbox';
import {
  ShellTerminalManager,
  TerminalSpawnError,
  type TerminalManager,
  type ShellTerminalManagerOptions,
} from '../src/session/terminal-manager';
import type { SessionProcessHandle, SessionSandbox } from '../src/session/session-sandbox';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createProcessHandle(
  terminate: SessionProcessHandle['terminate'],
  options: { pid?: number | null } = {}
): SessionProcessHandle {
  const child = new EventEmitter() as ChildProcess;
  // `null` models a child that never started: node leaves `pid` unset there.
  child.pid = options.pid === null ? undefined : (options.pid ?? 4321);
  child.killed = false;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const subscribe = (stream: NodeJS.ReadableStream) => (listener: (chunk: Buffer) => void) => {
    stream.on('data', listener);
    return () => {
      stream.off('data', listener);
    };
  };

  const subscribeEvent =
    (event: 'exit' | 'close' | 'error') => (listener: (...args: never[]) => void) => {
      child.on(event, listener as (...args: unknown[]) => void);
      return () => {
        child.off(event, listener as (...args: unknown[]) => void);
      };
    };

  return {
    child,
    inspectExit: async () => null,
    terminate,
    onExit: subscribeEvent('exit') as SessionProcessHandle['onExit'],
    onClose: subscribeEvent('close') as SessionProcessHandle['onClose'],
    onError: subscribeEvent('error') as SessionProcessHandle['onError'],
    onStdout: subscribe(child.stdout as NodeJS.ReadableStream),
    onStderr: subscribe(child.stderr as NodeJS.ReadableStream),
  };
}

function createSandbox(spawn: SessionSandbox['spawn']): SessionSandbox {
  return {
    enabled: false,
    description: 'noop',
    applyLimits: async () => {},
    readResourceAccounting: async () => ({
      kind: 'process-tree',
      rootPids: [],
      memoryLimitBytes: null,
      cpuLimitCores: null,
      pidsLimit: null,
    }),
    spawn,
    terminate: async () => {},
    cleanup: async () => {},
  };
}

function createManager(
  sandbox: SessionSandbox,
  platform?: NodeJS.Platform,
  workdir?: string,
  onResourceLimitExceeded?: ShellTerminalManagerOptions['onResourceLimitExceeded']
) {
  return new ShellTerminalManager({
    logger: createSilentLogger(),
    sessionLabel: 'test-session',
    getActiveAcpSessionId: () => 'acp-1',
    resolveWorkdir: (cwd) => cwd ?? workdir ?? process.cwd(),
    buildEnv: () => process.env,
    sandbox,
    platform,
    onResourceLimitExceeded,
  });
}

describe('ShellTerminalManager', () => {
  it('rejects with a spawn error when the sandbox reports ENOENT', async () => {
    const enoent = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
    const manager = createManager(
      createSandbox(async () => {
        throw enoent;
      }),
      'darwin'
    );

    const failure = await manager.createTerminal('acp-1', 'nope', ['--version']).catch((e) => e);

    expect(failure).toBeInstanceOf(TerminalSpawnError);
    expect((failure as TerminalSpawnError).spawnCode).toBe('ENOENT');
    expect((failure as TerminalSpawnError).cause).toBe(enoent);
  });

  it('rejects instead of handing out a terminal whose child never started', async () => {
    // A sandbox that does not await the child's pid resolves the handle first
    // and only then surfaces the failure on the process error channel.
    const processHandle = createProcessHandle(async () => {}, { pid: null });
    const manager = createManager(
      createSandbox(async () => {
        setImmediate(() => {
          processHandle.child.emit(
            'error',
            Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' })
          );
        });
        return processHandle;
      }),
      'darwin'
    );

    const failure = await manager.createTerminal('acp-1', 'nope', ['--version']).catch((e) => e);

    expect(failure).toBeInstanceOf(TerminalSpawnError);
    expect((failure as TerminalSpawnError).spawnCode).toBe('ENOENT');
  });

  it('completes a pending wait when the process errors after it started', async () => {
    const processHandle = createProcessHandle(async () => {});
    const manager = createManager(
      createSandbox(async () => processHandle),
      'darwin'
    );

    const terminalId = await manager.createTerminal('acp-1', 'node', ['-v']);
    const exitStatus = manager.waitForTerminalExit('acp-1', terminalId);
    processHandle.child.emit('error', new Error('stream closed unexpectedly'));

    await expect(exitStatus).resolves.toEqual({ exitCode: null, signal: undefined });
  });
});

describe('ACP terminal exit drain', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function fixture(
    onResourceLimitExceeded?: ShellTerminalManagerOptions['onResourceLimitExceeded']
  ) {
    const tree = { alive: true };
    const handle = createProcessHandle(async () => {
      tree.alive = false;
    });
    const manager = createManager(
      createSandbox(async () => handle),
      undefined,
      undefined,
      onResourceLimitExceeded
    );
    const id = await manager.createTerminal('acp-1', 'synthetic-command', []);
    const results: unknown[] = [];
    const wait = manager.waitForTerminalExit('acp-1', id).then((status) => {
      results.push(status);
      return status;
    });
    return { manager, handle, id, results, wait, tree };
  }

  it('returns after 100 ms when a descendant holds stdio, retaining the tail and direct status', async () => {
    const f = await fixture();
    f.handle.child.stdout?.emit('data', Buffer.from('before exit\n'));
    f.handle.child.emit('exit', 7, null);
    await vi.advanceTimersByTimeAsync(99);
    f.handle.child.stderr?.emit('data', Buffer.from('stderr tail\n'));
    f.handle.child.stdout?.emit('data', Buffer.from('stdout tail\n'));
    expect(f.results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.results).toEqual([{ exitCode: 7, signal: undefined }]);
    await expect(f.wait).resolves.toEqual({ exitCode: 7, signal: undefined });
    expect(await f.manager.terminalOutput('acp-1', f.id)).toEqual({
      output: 'before exit\nstderr tail\nstdout tail\n',
      truncated: false,
      exitStatus: { exitCode: 7, signal: undefined },
    });
    f.handle.child.emit('close', 0, null);
    await vi.runAllTimersAsync();
    await expect(f.manager.waitForTerminalExit('acp-1', f.id)).resolves.toEqual({
      exitCode: 7,
      signal: undefined,
    });
    await f.manager.killTerminal('acp-1', f.id);
    await f.manager.releaseTerminal('acp-1', f.id);
    expect(f.tree.alive).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes on close before the deadline with both output tails and the original signal', async () => {
    const notifications: string[] = [];
    const f = await fixture((violation) => {
      notifications.push(violation.message);
    });
    f.handle.inspectExit = async (_code, signal) =>
      signal === 'SIGINT' ? { kind: 'pids', message: 'synthetic process limit' } : null;
    f.handle.child.emit('exit', null, 'SIGINT');
    f.handle.child.stdout?.emit('data', Buffer.from('stdout tail'));
    f.handle.child.stderr?.emit('data', Buffer.from('stderr tail'));
    f.handle.child.emit('close', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.results).toEqual([{ exitCode: null, signal: 'SIGINT' }]);
    expect((await f.manager.terminalOutput('acp-1', f.id)).output).toBe('stdout tailstderr tail');
    expect(notifications).toEqual(['synthetic process limit']);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.releaseTerminal('acp-1', f.id);
  });

  it('keeps new waiters pending during drain and releases without killing an exited tree', async () => {
    const f = await fixture();
    f.handle.child.emit('exit', 23, null);
    const second: unknown[] = [];
    const secondWait = f.manager
      .waitForTerminalExit('acp-1', f.id)
      .then((status) => second.push(status));
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual([]);
    await f.manager.killTerminal('acp-1', f.id);
    await f.manager.releaseTerminal('acp-1', f.id);
    await Promise.all([f.wait, secondWait]);
    expect(second).toEqual([{ exitCode: 23, signal: undefined }]);
    expect(f.results).toEqual(second);
    expect(f.tree.alive).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    f.handle.child.emit('exit', 0, null);
    f.handle.child.emit('close', 0, null);
    await vi.runAllTimersAsync();
    await expect(f.manager.terminalOutput('acp-1', f.id)).rejects.toThrow('already released');
  });

  it('stops an active command on release and settles waiters while detaching its events', async () => {
    const f = await fixture();
    await f.manager.releaseTerminal('acp-1', f.id);
    await expect(f.wait).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
    expect(f.tree.alive).toBe(false);
    f.handle.child.emit('exit', 0, null);
    f.handle.child.emit('close', 0, null);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.results).toEqual([{ exitCode: null, signal: 'SIGTERM' }]);
    await f.manager.disposeAll('acp-1');
    expect(f.tree.alive).toBe(false);
  });

  it('preserves direct exit status when resource inspection fails', async () => {
    const f = await fixture();
    f.handle.inspectExit = async () => {
      throw new Error('accounting unavailable');
    };
    f.handle.child.emit('exit', 9, null);
    f.handle.child.emit('close', 9, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.results).toEqual([{ exitCode: 9, signal: undefined }]);
    await f.manager.releaseTerminal('acp-1', f.id);
  });

  it('reports a resource violation once when close follows the drain deadline', async () => {
    const notifications: string[] = [];
    const f = await fixture((violation) => {
      notifications.push(violation.message);
    });
    f.handle.inspectExit = async () => ({ kind: 'memory', message: 'synthetic memory limit' });
    f.handle.child.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.results).toEqual([{ exitCode: null, signal: 'SIGKILL' }]);
    expect(notifications).toEqual(['synthetic memory limit']);
    f.handle.child.emit('close', null, 'SIGKILL');
    await vi.runAllTimersAsync();
    expect(notifications).toEqual(['synthetic memory limit']);
    await f.manager.releaseTerminal('acp-1', f.id);
  });

  it('uses close as a fallback when no exit was delivered', async () => {
    const f = await fixture();
    f.handle.child.stdout?.emit('data', Buffer.from('complete output'));
    f.handle.child.emit('close', 3, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.results).toEqual([{ exitCode: 3, signal: undefined }]);
    expect((await f.manager.terminalOutput('acp-1', f.id)).output).toBe('complete output');
    await f.manager.releaseTerminal('acp-1', f.id);
  });
});

describe.skipIf(process.platform === 'win32')('ShellTerminalManager against a real process', () => {
  it('runs an unsplit command line and returns its output', async () => {
    const manager = createManager(createNoopSessionSandbox());

    const terminalId = await manager.createTerminal(
      'acp-1',
      "printf 'hello from %s' sh",
      [],
      tmpdir()
    );
    const exitStatus = await manager.waitForTerminalExit('acp-1', terminalId);
    const result = await manager.terminalOutput('acp-1', terminalId);
    await manager.releaseTerminal('acp-1', terminalId);

    expect(exitStatus).toEqual({ exitCode: 0, signal: undefined });
    expect(result.output).toBe('hello from sh');
  });

  it('returns while a real background descendant still holds stdout/stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-terminal-drain-'));
    const fifo = join(dir, 'finish');
    const sandbox = createNoopSessionSandbox();
    const setup = createManager(sandbox);
    const setupId = await setup.createTerminal('acp-1', 'mkfifo', [fifo]);
    expect((await setup.waitForTerminalExit('acp-1', setupId)).exitCode).toBe(0);
    await setup.releaseTerminal('acp-1', setupId);

    const control = openSync(fifo, constants.O_RDWR);
    let observedHandle: SessionProcessHandle | undefined;
    let outputReady: () => void = () => {};
    const output = new Promise<void>((resolve) => {
      outputReady = resolve;
    });
    let commandOutput = '';
    let commandExited: () => void = () => {};
    let pipesClosed: () => void = () => {};
    const exit = new Promise<void>((resolve) => {
      commandExited = resolve;
    });
    const close = new Promise<void>((resolve) => {
      pipesClosed = resolve;
    });
    let closed = false;
    const manager = createManager({
      ...sandbox,
      spawn: async (...args) => {
        const handle = await sandbox.spawn(...args);
        observedHandle = handle;
        handle.onExit(commandExited);
        handle.onClose(() => {
          closed = true;
          pipesClosed();
        });
        return {
          ...handle,
          onStdout: (listener) =>
            handle.onStdout((chunk) => {
              listener(chunk);
              commandOutput += chunk.toString();
              if (commandOutput.includes('root output\n')) outputReady();
            }),
        };
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const id = await manager.createTerminal('acp-1', '/bin/sh', [
      '-c',
      'printf "root output\\n"; (read token < "$1"; printf "background survived\\n") &',
      'fixture',
      fifo,
    ]);
    let backgroundOutput = '';
    const unsubscribeBackground = observedHandle?.onStdout((chunk) => {
      backgroundOutput += chunk.toString();
    });
    const results: unknown[] = [];
    const wait = manager.waitForTerminalExit('acp-1', id).then((status) => results.push(status));
    try {
      // The FIFO holds the descendant until this test explicitly releases it.
      // Only the drain clock advances; process readiness uses actual exit events.
      await Promise.all([exit, output]);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(results).toEqual([{ exitCode: 0, signal: undefined }]);
      expect((await manager.terminalOutput('acp-1', id)).output).toBe('root output\n');
      expect(closed).toBe(false);
      await manager.killTerminal('acp-1', id);
      await manager.releaseTerminal('acp-1', id);
    } finally {
      vi.useRealTimers();
      // O_RDWR keeps cleanup nonblocking even if a regression killed the reader.
      writeSync(control, 'finish\n');
      await close;
      closeSync(control);
      unsubscribeBackground?.();
      await wait;
      await manager.disposeAll('acp-1');
      await sandbox.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(backgroundOutput).toContain('background survived\n');
  });

  it('preserves structured argv and executable paths containing spaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-terminal-argv-'));
    const executable = join(dir, 'my tool');
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(executable, 0o755);
    const sandbox = createNoopSessionSandbox();
    const manager = createManager(sandbox);
    try {
      for (const command of [executable, './my tool']) {
        const id = await manager.createTerminal('acp-1', command, ['one two', '$literal'], dir);
        expect((await manager.waitForTerminalExit('acp-1', id)).exitCode).toBe(0);
        expect((await manager.terminalOutput('acp-1', id)).output).toBe('one two\n$literal\n');
        await manager.releaseTerminal('acp-1', id);
      }
    } finally {
      await sandbox.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unresolvable executable instead of leaving a hung terminal', async () => {
    const manager = createManager(createNoopSessionSandbox());

    const failure = await manager
      .createTerminal('acp-1', 'lody-no-such-command', ['--version'], tmpdir())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TerminalSpawnError);
    expect((failure as TerminalSpawnError).spawnCode).toBe('ENOENT');
  });
});

describe('AgentClient terminal/create', () => {
  it('answers an unspawnable command with a numeric JSON-RPC error code', async () => {
    const terminalManager = {
      createTerminal: async () => {
        throw new TerminalSpawnError('ENOENT', 'nope', new Error('spawn nope ENOENT'));
      },
    } as unknown as TerminalManager;
    const client = new AgentClient({
      sessionId: 'test-session' as SessionId,
      logger: createSilentLogger(),
      terminalManager,
      onUpdateMessage: () => {},
      onRequestPermission: async () => ({
        outcome: { outcome: 'selected' as const, optionId: 'opt-1' },
      }),
    });
    // Simulate session startup by setting the internal field directly.
    // @ts-expect-error - accessing a private field for test setup
    client.acpSessionId = 'acp-1' as ACPSessionId;

    const failure = await client
      .createTerminal?.({ sessionId: 'acp-1', command: 'nope' })
      .catch((error: unknown) => error);

    expect(typeof (failure as { code?: unknown }).code).toBe('number');
    expect(failure).toMatchObject({ code: -32602 });
    expect((failure as Error).message).toContain('nope');
  });
});
