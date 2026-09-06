import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, SessionId, WorkspaceId } from '@lody/shared';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

import { Session } from '../src/session/session';
import type { TerminalManager } from '../src/session/terminal-manager';
import type { SessionProcessHandle } from '../src/session/session-sandbox';
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

const createTerminalManager = (overrides: Partial<TerminalManager> = {}): TerminalManager => ({
  createTerminal: async () => 'terminal-id',
  terminalOutput: async () => ({ output: '', truncated: false, exitStatus: null }),
  releaseTerminal: async () => {},
  waitForTerminalExit: async () => ({ exitCode: 0 }),
  killTerminal: async () => {},
  ...overrides,
});

const createSession = (): Session => {
  return new Session(
    {
      workspaceId: 'workspace-1' as WorkspaceId,
      userId: 'user-1',
      machineId: 'machine-1',
      agentCliType: 'builtin',
      agentType: 'codex',
      sessionId: 'session-1' as SessionId,
      userName: 'test-user',
      userEmail: 'test@example.com',
    },
    createSilentLogger(),
    process.cwd()
  );
};

function createProcessHandle(terminate: SessionProcessHandle['terminate']): SessionProcessHandle {
  const child = new EventEmitter() as ChildProcess;
  child.pid = 4321;
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => true);
  let exitListener: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | null =
    null;

  return {
    child,
    inspectExit: async () => null,
    terminate: async (force) => {
      await terminate(force);
      child.exitCode = force ? 137 : 0;
      exitListener?.(child.exitCode, force ? 'SIGKILL' : 'SIGTERM');
    },
    onExit: (listener) => {
      exitListener = listener;
      return () => {
        if (exitListener === listener) {
          exitListener = null;
        }
      };
    },
    onClose: () => () => {},
    onError: () => () => {},
  };
}

describe('Session terminate cleanup', () => {
  it('reports failed cleanup and a new retry attempt without inferring success from status', async () => {
    const session = createSession();
    session.acpSessionId = 'acp-session-1' as ACPSessionId;
    session.terminalManager = createTerminalManager({
      disposeAll: vi
        .fn()
        .mockRejectedValueOnce(new Error('synthetic disposal failure'))
        .mockResolvedValue(undefined),
    });
    expect((await session.getMonitorRuntimeInfo()).cleanup).toBeNull();
    const failed = session.terminate(true);
    expect((await session.getMonitorRuntimeInfo()).cleanup?.state).toBe('running');
    await expect(failed).rejects.toThrow('Session process termination failed');
    const receipt = (await session.getMonitorRuntimeInfo()).cleanup;
    expect(receipt?.state).toBe('failed');
    await session.terminate(true);
    expect((await session.getMonitorRuntimeInfo()).cleanup?.state).toBe('completed');
    expect(receipt?.state).toBe('failed');
  });

  it('shares pending termination and upgrades force without waiting for terminal disposal', async () => {
    const session = createSession();
    let finishDisposal = () => {};
    let startedDisposal = () => {};
    const started = new Promise<void>((resolve) => {
      startedDisposal = resolve;
    });
    session.acpSessionId = 'acp-session-1' as ACPSessionId;
    session.terminalManager = createTerminalManager({
      disposeAll: () => {
        startedDisposal();
        return new Promise<void>((resolve) => {
          finishDisposal = resolve;
        });
      },
    });
    let processKilled = () => {};
    const killed = new Promise<void>((resolve) => {
      processKilled = resolve;
    });
    const handle = createProcessHandle(async (force) => {
      expect(force).toBe(true);
      handle.child.exitCode = 0;
      processKilled();
    });
    (session as unknown as { agentProcess: SessionProcessHandle }).agentProcess = handle;
    const first = session.terminate(false);
    await started;
    const second = session.terminate(true);
    expect(second).toBe(first);
    await killed;
    finishDisposal();
    await first;
    expect(session.acpSessionId).toBeNull();
  });
  it('disposes ACP terminals before closing the ACP session on graceful terminate', async () => {
    const disposeAll = vi.fn(async () => {});
    const closeSession = vi.fn(async () => true);
    const session = createSession();
    session.terminalManager = createTerminalManager({ disposeAll });
    session.acpSessionId = 'acp-session-1' as ACPSessionId;
    session.agentClient = {
      isCreated: vi.fn(() => true),
      closeSession,
    } as never;

    await session.terminate(false);

    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(disposeAll).toHaveBeenCalledWith('acp-session-1');
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('acp-session-1');
    expect(disposeAll.mock.invocationCallOrder[0]).toBeLessThan(
      closeSession.mock.invocationCallOrder[0]
    );
    expect(session.acpSessionId).toBeNull();
    expect(session.agentClient).toBeNull();
  });

  it('continues graceful termination when terminal cleanup fails', async () => {
    const disposeAll = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const closeSession = vi.fn(async () => true);
    const session = createSession();
    session.terminalManager = createTerminalManager({ disposeAll });
    session.acpSessionId = 'acp-session-1' as ACPSessionId;
    session.agentClient = {
      isCreated: vi.fn(() => true),
      closeSession,
    } as never;

    await expect(session.terminate(false)).rejects.toThrow('Session process termination failed');
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(session.acpSessionId).toBe('acp-session-1');
  });

  it('bounds stalled terminal disposal, still kills processes, and retries without duplicate disposal', async () => {
    vi.useFakeTimers();
    try {
      const session = createSession();
      let finishDisposal = () => {};
      const pending = new Promise<void>((resolve) => {
        finishDisposal = resolve;
      });
      const disposeAll = vi.fn(() => pending);
      session.terminalManager = createTerminalManager({ disposeAll });
      session.acpSessionId = 'acp-session-1' as ACPSessionId;
      const terminateProcess = vi.fn(async () => {});
      // @ts-expect-error - exercising private process ownership
      session.agentProcess = createProcessHandle(terminateProcess);
      // @ts-expect-error - observing private sandbox lifecycle
      const terminateSandbox = vi.spyOn(session.sandbox, 'terminate');
      const terminated = vi.fn();
      session.on('terminated', terminated);
      const first = expect(session.terminate(true)).rejects.toThrow(
        'Session process termination failed'
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      expect(terminateProcess).toHaveBeenCalledWith(true);
      expect(terminateSandbox).toHaveBeenCalledWith(true);
      expect(terminated).not.toHaveBeenCalled();
      const retry = session.terminate(true);
      await Promise.resolve();
      expect(disposeAll).toHaveBeenCalledTimes(1);
      finishDisposal();
      await retry;
      expect(terminated).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips ACP closeSession during forced terminate', async () => {
    const disposeAll = vi.fn(async () => {});
    const closeSession = vi.fn(async () => true);
    const session = createSession();
    session.terminalManager = createTerminalManager({ disposeAll });
    session.acpSessionId = 'acp-session-1' as ACPSessionId;
    session.agentClient = {
      isCreated: vi.fn(() => true),
      closeSession,
    } as never;

    await session.terminate(true);

    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(closeSession).not.toHaveBeenCalled();
    expect(session.acpSessionId).toBeNull();
  });

  it('uses process handle termination for tracked processes', async () => {
    const terminateProcess = vi.fn(async () => {});
    const session = createSession();
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = createProcessHandle(terminateProcess);

    await session.terminate(false);

    expect(terminateProcess).toHaveBeenCalledWith(false);
    // @ts-expect-error - exercising private process handle wiring
    expect(session.agentProcess).toBeNull();
  });
});

describe('Session bounded process exit', () => {
  it('recognizes signal-only exits without sending another termination', async () => {
    const session = createSession();
    const handle = createProcessHandle(vi.fn());
    handle.child.signalCode = 'SIGTERM';
    handle.terminate = vi.fn();
    // @ts-expect-error - exercising private bounded process lifecycle
    await session.killAndWait(handle, true);
    expect(handle.terminate).not.toHaveBeenCalled();
  });

  it('rejects when a forced process never exits and removes its subscription', async () => {
    vi.useFakeTimers();
    try {
      const session = createSession();
      const handle = createProcessHandle(vi.fn());
      handle.terminate = vi.fn(async () => {});
      const unsubscribe = vi.fn();
      handle.onExit = vi.fn(() => unsubscribe);
      // @ts-expect-error - exercising private bounded process lifecycle
      const result = session.killAndWait(handle, true);
      const rejected = expect(result).rejects.toThrow('after forced termination');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds graceful waiting, escalates, and clears the expired subscription', async () => {
    vi.useFakeTimers();
    try {
      const session = createSession();
      const handle = createProcessHandle(vi.fn());
      handle.terminate = vi.fn(async (force) => {
        if (force) handle.child.signalCode = 'SIGKILL';
      });
      const unsubscribe = vi.fn();
      handle.onExit = vi.fn(() => unsubscribe);
      // @ts-expect-error - exercising private bounded process lifecycle
      const result = session.killAndWait(handle, false);
      await vi.advanceTimersByTimeAsync(5_000);
      await result;
      expect(handle.terminate).toHaveBeenNthCalledWith(1, false);
      expect(handle.terminate).toHaveBeenNthCalledWith(2, true);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans its deadline and subscription after synchronous exit replay', async () => {
    vi.useFakeTimers();
    try {
      const session = createSession();
      const handle = createProcessHandle(vi.fn());
      handle.terminate = vi.fn(async () => {});
      const unsubscribe = vi.fn();
      handle.onExit = vi.fn((listener) => {
        listener(null, 'SIGTERM');
        return unsubscribe;
      });
      // @ts-expect-error - exercising private bounded process lifecycle
      await session.killAndWait(handle, false);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Session termination failures', () => {
  it('preserves stopping ownership after sandbox failure and allows retry', async () => {
    const session = createSession();
    const terminated = vi.fn();
    session.on('terminated', terminated);
    // @ts-expect-error - observing private sandbox lifecycle
    const sandbox = session.sandbox;
    const terminate = vi
      .spyOn(sandbox, 'terminate')
      .mockRejectedValueOnce(new Error('kill failed'))
      .mockResolvedValue(undefined);
    const cleanup = vi.spyOn(sandbox, 'cleanup').mockResolvedValue(undefined);
    await expect(session.terminate(true)).rejects.toThrow('Session process termination failed');
    expect(cleanup).not.toHaveBeenCalled();
    expect(terminated).not.toHaveBeenCalled();
    // @ts-expect-error - observing retained lifecycle state
    expect(session.status).toBe('stopping');
    await session.terminate(true);
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(terminated).toHaveBeenCalledTimes(1);
  });

  it('attempts the other process and sandbox when one process termination fails', async () => {
    const session = createSession();
    const failing = createProcessHandle(async () => {
      throw new Error('process failure');
    });
    const terminateOther = vi.fn(async () => {});
    // @ts-expect-error - exercising private process ownership
    session.activeProcess = failing;
    // @ts-expect-error - exercising private process ownership
    session.agentProcess = createProcessHandle(terminateOther);
    // @ts-expect-error - observing private sandbox lifecycle
    const sandbox = session.sandbox;
    const terminateSandbox = vi.spyOn(sandbox, 'terminate').mockResolvedValue(undefined);
    const cleanup = vi.spyOn(sandbox, 'cleanup').mockResolvedValue(undefined);
    await expect(session.terminate(true)).rejects.toThrow('Session process termination failed');
    expect(terminateOther).toHaveBeenCalledWith(true);
    expect(terminateSandbox).toHaveBeenCalledWith(true);
    expect(cleanup).not.toHaveBeenCalled();
    // @ts-expect-error - observing retained ownership for retry
    expect(session.activeProcess).toBe(failing);
  });
});

it('does not hide failed graceful termination when the root exits during the attempt', async () => {
  const session = createSession();
  const handle = createProcessHandle(vi.fn());
  handle.terminate = vi.fn(async () => {
    handle.child.signalCode = 'SIGTERM';
    throw new Error('tree termination failed');
  });
  // @ts-expect-error - exercising private bounded process lifecycle
  await expect(session.killAndWait(handle, false)).rejects.toThrow('tree termination failed');
  expect(handle.terminate).toHaveBeenCalledTimes(1);
});

it('retries a refused graceful request forcibly while the root remains live', async () => {
  const session = createSession();
  const handle = createProcessHandle(vi.fn());
  handle.terminate = vi.fn(async (force) => {
    if (!force) throw new Error('graceful refusal');
    handle.child.signalCode = 'SIGKILL';
  });
  // @ts-expect-error - exercising private bounded process lifecycle
  await session.killAndWait(handle, false);
  expect(handle.terminate).toHaveBeenNthCalledWith(1, false);
  expect(handle.terminate).toHaveBeenNthCalledWith(2, true);
});

it('rejects a refused forced retry without claiming completion', async () => {
  const session = createSession();
  const handle = createProcessHandle(vi.fn());
  handle.terminate = vi.fn(async (force) => {
    throw new Error(force ? 'force refusal' : 'graceful refusal');
  });
  // @ts-expect-error - exercising private bounded process lifecycle
  await expect(session.killAndWait(handle, false)).rejects.toThrow('force refusal');
  expect(handle.terminate).toHaveBeenCalledTimes(2);
});

it('propagates failed startup cleanup and retains ownership for shutdown', async () => {
  const session = createSession();
  const cleanupError = new Error('startup cleanup refused');
  const handle = createProcessHandle(async () => {
    throw cleanupError;
  });
  // No stdin causes startup to fail after the session takes ownership.
  // @ts-expect-error - injecting the owned sandbox boundary
  const spawn = vi.spyOn(session.sandbox, 'spawn').mockResolvedValue(handle);
  await expect(
    session.createAgent({
      cliType: 'registry',
      agentType: 'opencode',
      command: 'opencode',
      args: ['acp'],
    } as Parameters<Session['createAgent']>[0])
  ).rejects.toBe(cleanupError);
  expect(spawn).toHaveBeenCalledTimes(1);
  // @ts-expect-error - verifying retained ownership after failure
  expect(session.agentProcess).toBe(handle);
  await expect(
    session.createAgent({
      cliType: 'registry',
      agentType: 'opencode',
      command: 'opencode',
      args: ['acp'],
    } as Parameters<Session['createAgent']>[0])
  ).rejects.toThrow('Previous agent ownership');
  expect(spawn).toHaveBeenCalledTimes(1);
  // @ts-expect-error - the failed retry cannot replace the original live owner
  expect(session.agentProcess).toBe(handle);
  handle.terminate = vi.fn(async () => {
    handle.child.exitCode = 0;
  });
  await session.terminate(true);
  expect(handle.terminate).toHaveBeenCalledWith(true);
});

it('serializes agent launch admission before the sandbox publishes a handle', async () => {
  const session = createSession();
  let entered = () => {};
  const spawning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = (_handle: SessionProcessHandle) => {};
  // @ts-expect-error - injecting the async owned spawn boundary
  const spawn = vi.spyOn(session.sandbox, 'spawn').mockImplementation(() => {
    entered();
    return new Promise<SessionProcessHandle>((resolve) => {
      release = resolve;
    });
  });
  const callbacks = {
    cliType: 'registry',
    agentType: 'opencode',
    command: 'opencode',
    args: ['acp'],
  } as Parameters<Session['createAgent']>[0];
  const first = session.createAgent(callbacks);
  const rejected = expect(first).rejects.toThrow();
  await spawning;
  await expect(session.createAgent(callbacks)).rejects.toThrow('Previous agent ownership');
  expect(spawn).toHaveBeenCalledOnce();
  release(createProcessHandle(async () => {}));
  await rejected;
  await session.terminate(true);
});
