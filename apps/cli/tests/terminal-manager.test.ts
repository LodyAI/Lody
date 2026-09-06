import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

import { ShellTerminalManager } from '../src/session/terminal-manager';
import type { SessionProcessHandle, SessionSandbox } from '../src/session/session-sandbox';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createProcessHandle(terminate: SessionProcessHandle['terminate']): SessionProcessHandle {
  const child = new EventEmitter() as ChildProcess;
  child.pid = 4321;
  child.killed = false;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);

  const subscribe = (stream: NodeJS.ReadableStream) => (listener: (chunk: Buffer) => void) => {
    stream.on('data', listener);
    return () => {
      stream.off('data', listener);
    };
  };

  return {
    child,
    inspectExit: async () => null,
    terminate,
    onExit: () => () => {},
    onClose: () => () => {},
    onError: () => () => {},
    onStdout: subscribe(child.stdout as NodeJS.ReadableStream),
    onStderr: subscribe(child.stderr as NodeJS.ReadableStream),
  };
}

describe('ShellTerminalManager', () => {
  it('preserves a Windows executable path and structured arguments', async () => {
    const processHandle = createProcessHandle(async () => {});
    const sandbox: SessionSandbox = {
      enabled: false,
      description: 'noop',
      applyLimits: async () => {},
      spawn: vi.fn(async () => processHandle),
      terminate: async () => {},
      cleanup: async () => {},
    };
    const manager = new ShellTerminalManager({
      logger: createSilentLogger(),
      sessionLabel: 'test-session',
      getActiveAcpSessionId: () => 'acp-1',
      resolveWorkdir: (cwd) => cwd ?? process.cwd(),
      buildEnv: () => process.env,
      sandbox,
    });
    const bashPath = 'C:\\Users\\test\\scoop\\apps\\git\\current\\bin\\bash.exe';
    const shellCommand = "cd '/c/workspace' && printf 'hello'";

    await manager.createTerminal('acp-1', bashPath, ['-c', shellCommand], 'C:\\workspace');

    expect(sandbox.spawn).toHaveBeenCalledWith(
      bashPath,
      ['-c', shellCommand],
      expect.objectContaining({ cwd: 'C:\\workspace', captureOutput: true })
    );
  });

  it('uses process handle termination instead of child.kill when stopping terminals', async () => {
    const terminate = vi.fn(async () => {});
    const processHandle = createProcessHandle(terminate);
    const sandbox: SessionSandbox = {
      enabled: false,
      description: 'noop',
      applyLimits: async () => {},
      spawn: vi.fn(async () => processHandle),
      terminate: async () => {},
      cleanup: async () => {},
    };
    const manager = new ShellTerminalManager({
      logger: createSilentLogger(),
      sessionLabel: 'test-session',
      getActiveAcpSessionId: () => 'acp-1',
      resolveWorkdir: (cwd) => cwd ?? process.cwd(),
      buildEnv: () => process.env,
      sandbox,
    });

    const terminalId = await manager.createTerminal('acp-1', 'node', ['-v']);
    await manager.killTerminal('acp-1', terminalId);

    expect(terminate).toHaveBeenCalledWith(false);
    expect(processHandle.child.kill).not.toHaveBeenCalled();
  });
});

function releaseFixture(handles: SessionProcessHandle[]) {
  const sandbox: SessionSandbox = {
    enabled: false,
    description: 'test',
    applyLimits: async () => {},
    spawn: vi.fn(async () => {
      const handle = handles.shift();
      if (!handle) throw new Error('no handle');
      return handle;
    }),
    terminate: async () => {},
    cleanup: async () => {},
  };
  return new ShellTerminalManager({
    logger: createSilentLogger(),
    sessionLabel: 'test',
    getActiveAcpSessionId: () => 'acp-1',
    resolveWorkdir: () => process.cwd(),
    buildEnv: () => ({}),
    sandbox,
  });
}

function observedHandle() {
  const handle = createProcessHandle(vi.fn(async () => {}));
  let close: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
  const unsubscribe = vi.fn();
  handle.onClose = (listener) => {
    close = listener;
    return unsubscribe;
  };
  return {
    handle,
    unsubscribe,
    exit: (code = 7) => {
      handle.child.exitCode = code;
      close(code, null);
    },
  };
}

it('gates release and existing waiters on the actual exit and coalesces release requests', async () => {
  const owned = observedHandle();
  const manager = releaseFixture([owned.handle]);
  const id = await manager.createTerminal('acp-1', 'test');
  const observed = vi.fn();
  const waiter = manager.waitForTerminalExit('acp-1', id).then(observed);
  const release = manager.releaseTerminal('acp-1', id);
  const second = manager.releaseTerminal('acp-1', id);
  expect((await manager.terminalOutput('acp-1', id)).exitStatus).toBeNull();
  expect(observed).not.toHaveBeenCalled();
  expect(owned.unsubscribe).not.toHaveBeenCalled();
  owned.exit(23);
  await Promise.all([release, second, waiter]);
  expect(observed).toHaveBeenCalledWith({ exitCode: 23, signal: undefined });
  expect(owned.unsubscribe).toHaveBeenCalledTimes(1);
  expect(owned.handle.terminate).toHaveBeenCalledTimes(1);
});

it('preserves failed release state and waiters for retry', async () => {
  const owned = observedHandle();
  owned.handle.terminate = vi.fn(async () => {
    throw new Error('refused');
  });
  const manager = releaseFixture([owned.handle]);
  const id = await manager.createTerminal('acp-1', 'test');
  const observed = vi.fn();
  const waiter = manager.waitForTerminalExit('acp-1', id).then(observed);
  await expect(manager.releaseTerminal('acp-1', id)).rejects.toThrow('refused');
  expect((await manager.terminalOutput('acp-1', id)).exitStatus).toBeNull();
  expect(observed).not.toHaveBeenCalled();
  expect(owned.unsubscribe).not.toHaveBeenCalled();
  owned.exit(17);
  await waiter;
  await manager.releaseTerminal('acp-1', id);
  expect(observed).toHaveBeenCalledWith({ exitCode: 17, signal: undefined });
});

it('bounds an unexited process through graceful and forced attempts without synthetic exit', async () => {
  vi.useFakeTimers();
  try {
    const owned = observedHandle();
    const manager = releaseFixture([owned.handle]);
    const id = await manager.createTerminal('acp-1', 'test');
    const release = manager.releaseTerminal('acp-1', id);
    const rejected = expect(release).rejects.toThrow('did not report exit');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(owned.handle.terminate).toHaveBeenNthCalledWith(1, false);
    expect(owned.handle.terminate).toHaveBeenNthCalledWith(2, true);
    expect((await manager.terminalOutput('acp-1', id)).exitStatus).toBeNull();
    expect(owned.unsubscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('aggregates disposal failure after attempting every terminal', async () => {
  const failed = observedHandle();
  failed.handle.terminate = vi.fn(async () => {
    throw new Error('refused');
  });
  const successful = observedHandle();
  successful.handle.terminate = vi.fn(async () => successful.exit(0));
  const manager = releaseFixture([failed.handle, successful.handle]);
  const first = await manager.createTerminal('acp-1', 'first');
  const second = await manager.createTerminal('acp-1', 'second');
  await expect(manager.disposeAll('acp-1')).rejects.toThrow('Terminal disposal failed');
  expect((await manager.terminalOutput('acp-1', first)).exitStatus).toBeNull();
  await expect(manager.terminalOutput('acp-1', second)).rejects.toThrow('already released');
});

it('retains exit observed before the terminal is inserted in the map', async () => {
  const owned = observedHandle();
  owned.handle.onClose = (listener) => {
    listener(31, null);
    return owned.unsubscribe;
  };
  const manager = releaseFixture([owned.handle]);
  const id = await manager.createTerminal('acp-1', 'test');
  await expect(manager.waitForTerminalExit('acp-1', id)).resolves.toEqual({
    exitCode: 31,
    signal: undefined,
  });
  await manager.releaseTerminal('acp-1', id);
  expect(owned.handle.terminate).not.toHaveBeenCalled();
});

it('forces a refused graceful release while the root is still live', async () => {
  const owned = observedHandle();
  owned.handle.terminate = vi.fn(async (force) => {
    if (!force) throw new Error('graceful refusal');
    owned.exit(29);
  });
  const manager = releaseFixture([owned.handle]);
  const id = await manager.createTerminal('acp-1', 'test');
  const waiter = manager.waitForTerminalExit('acp-1', id);
  await manager.releaseTerminal('acp-1', id);
  expect(owned.handle.terminate).toHaveBeenNthCalledWith(1, false);
  expect(owned.handle.terminate).toHaveBeenNthCalledWith(2, true);
  await expect(waiter).resolves.toEqual({ exitCode: 29, signal: undefined });
});

it('does not hide tree termination failure when the root exits during the request', async () => {
  const owned = observedHandle();
  owned.handle.terminate = vi.fn(async () => {
    owned.exit(19);
    throw new Error('tree failure');
  });
  const manager = releaseFixture([owned.handle]);
  const id = await manager.createTerminal('acp-1', 'test');
  await expect(manager.releaseTerminal('acp-1', id)).rejects.toThrow('tree failure');
  expect(owned.handle.terminate).toHaveBeenCalledTimes(1);
  expect(owned.unsubscribe).not.toHaveBeenCalled();
  await expect(manager.waitForTerminalExit('acp-1', id)).resolves.toEqual({
    exitCode: 19,
    signal: undefined,
  });
});

it('publishes actual close without waiting for hung resource inspection', async () => {
  const owned = observedHandle();
  owned.handle.inspectExit = () => new Promise(() => {});
  const manager = releaseFixture([owned.handle]);
  const id = await manager.createTerminal('acp-1', 'test');
  const waiter = manager.waitForTerminalExit('acp-1', id);
  owned.exit(37);
  await expect(waiter).resolves.toEqual({ exitCode: 37, signal: undefined });
  await manager.releaseTerminal('acp-1', id);
  expect(owned.unsubscribe).toHaveBeenCalledTimes(1);
  expect(owned.handle.terminate).not.toHaveBeenCalled();
});
