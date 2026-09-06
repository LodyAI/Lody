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

function releaseFixture(handles: SessionProcessHandle[], spawn?: SessionSandbox['spawn']) {
  const sandbox: SessionSandbox = {
    enabled: false,
    description: 'test',
    applyLimits: async () => {},
    spawn:
      spawn ??
      vi.fn(async () => {
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

it('closes admission and drains pending terminal starts before disposal returns', async () => {
  const owned = observedHandle();
  owned.handle.terminate = vi.fn(async () => owned.exit(0));
  let finishSpawn: (handle: SessionProcessHandle) => void = () => {};
  const pending = new Promise<SessionProcessHandle>((resolve) => {
    finishSpawn = resolve;
  });
  const sandbox: SessionSandbox = {
    enabled: false,
    description: 'test',
    applyLimits: async () => {},
    spawn: vi.fn(() => pending),
    terminate: async () => {},
    cleanup: async () => {},
  };
  const manager = new ShellTerminalManager({
    logger: createSilentLogger(),
    sessionLabel: 'test',
    getActiveAcpSessionId: () => 'acp-1',
    resolveWorkdir: () => process.cwd(),
    buildEnv: () => ({}),
    sandbox,
  });
  const start = expect(manager.createTerminal('acp-1', 'test')).rejects.toThrow(
    'cancelled by shutdown'
  );
  const disposed = vi.fn();
  const disposal = manager.disposeAll('acp-1').then(disposed);
  await expect(manager.createTerminal('acp-1', 'late')).rejects.toThrow('shutting down');
  await Promise.resolve();
  expect(disposed).not.toHaveBeenCalled();
  finishSpawn(owned.handle);
  await Promise.all([start, disposal]);
  expect(owned.handle.terminate).toHaveBeenCalledTimes(1);
  expect(owned.unsubscribe).toHaveBeenCalledTimes(1);
  expect(sandbox.spawn).toHaveBeenCalledTimes(1);
});

it('finishes disposal when a pending terminal launch rejects', async () => {
  let failSpawn: (error: Error) => void = () => {};
  const pending = new Promise<SessionProcessHandle>((_resolve, reject) => {
    failSpawn = reject;
  });
  const sandbox: SessionSandbox = {
    enabled: false,
    description: 'test',
    applyLimits: async () => {},
    spawn: () => pending,
    terminate: async () => {},
    cleanup: async () => {},
  };
  const manager = new ShellTerminalManager({
    logger: createSilentLogger(),
    sessionLabel: 'test',
    getActiveAcpSessionId: () => 'acp-1',
    resolveWorkdir: () => process.cwd(),
    buildEnv: () => ({}),
    sandbox,
  });
  const start = expect(manager.createTerminal('acp-1', 'test')).rejects.toThrow('launch failed');
  const disposal = manager.disposeAll('acp-1');
  failSpawn(new Error('launch failed'));
  await Promise.all([start, disposal]);
});

it('protects a pending terminal start and live watch until its observed exit', async () => {
  const owned = observedHandle();
  let finishStart: (handle: SessionProcessHandle) => void = () => {
    throw new Error('Start promise not initialized');
  };
  const starting = new Promise<SessionProcessHandle>((resolve) => {
    finishStart = resolve;
  });
  const manager = releaseFixture([], () => starting);
  expect(manager.hasRunningTerminals()).toBe(false);

  const creation = manager.createTerminal('acp-1', 'node', ['--watch', 'server.js']);
  expect(manager.hasRunningTerminals()).toBe(true);
  finishStart(owned.handle);
  const id = await creation;
  expect(manager.hasRunningTerminals()).toBe(true);
  expect((await manager.terminalOutput('acp-1', id)).exitStatus).toBeNull();

  owned.exit(0);
  expect(manager.hasRunningTerminals()).toBe(false);
  // The terminal remains addressable for output. Its mere presence cannot pin GC.
  expect((await manager.terminalOutput('acp-1', id)).exitStatus).toEqual({
    exitCode: 0,
    signal: undefined,
  });
  expect(owned.unsubscribe).not.toHaveBeenCalled();
});

it('clears the background guard when terminal startup rejects', async () => {
  let rejectStart: (error: Error) => void = () => {
    throw new Error('Start promise not initialized');
  };
  const starting = new Promise<SessionProcessHandle>((_, reject) => {
    rejectStart = reject;
  });
  const manager = releaseFixture([], () => starting);
  const creation = manager.createTerminal('acp-1', 'watch');
  const rejected = expect(creation).rejects.toThrow('spawn rejected');
  expect(manager.hasRunningTerminals()).toBe(true);
  rejectStart(new Error('spawn rejected'));
  await rejected;
  expect(manager.hasRunningTerminals()).toBe(false);
});

it('keeps another pending start protected when one terminal startup fails', async () => {
  const owned = observedHandle();
  let finishStart: (handle: SessionProcessHandle) => void = () => {
    throw new Error('Start promise not initialized');
  };
  const starting = new Promise<SessionProcessHandle>((resolve) => {
    finishStart = resolve;
  });
  const manager = releaseFixture([], async (command) => {
    if (command === 'bad-watch') throw new Error('spawn rejected');
    return starting;
  });
  const creation = manager.createTerminal('acp-1', 'good-watch');
  await expect(manager.createTerminal('acp-1', 'bad-watch')).rejects.toThrow('spawn rejected');
  expect(manager.hasRunningTerminals()).toBe(true);
  finishStart(owned.handle);
  await creation;
  expect(manager.hasRunningTerminals()).toBe(true);
  owned.exit(0);
  expect(manager.hasRunningTerminals()).toBe(false);
});

it('protects live terminal work through MessageHandler before consulting empty history', async () => {
  const { MessageHandler } = await import('../src/lib/message-handler');
  const { SessionIdSchema } = await import('@lody/shared');
  const owned = observedHandle();
  const terminalManager = releaseFixture([owned.handle]);
  const id = await terminalManager.createTerminal('acp-1', 'watch');
  const getHistory = vi.fn(async () => []);
  const receiver = {
    sessionManager: { getSession: () => ({ terminalManager }) },
    workspaceDocument: { getOrCreateSessionDoc: async () => ({ getHistory }) },
  };
  const sessionId = SessionIdSchema.parse('watch-session');
  await expect(MessageHandler.prototype.hasBackgroundWork.call(receiver, sessionId)).resolves.toBe(
    true
  );
  expect(getHistory).not.toHaveBeenCalled();
  owned.exit(0);
  await expect(MessageHandler.prototype.hasBackgroundWork.call(receiver, sessionId)).resolves.toBe(
    false
  );
  expect(getHistory).toHaveBeenCalledOnce();
  expect((await terminalManager.terminalOutput('acp-1', id)).exitStatus?.exitCode).toBe(0);
});
