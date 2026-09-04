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

    await expect(session.terminate(false)).resolves.toBeUndefined();
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(session.acpSessionId).toBeNull();
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

  it('shares resource teardown between concurrent forced termination calls', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminateProcess = vi.fn(() => blocked);
    const session = createSession();
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = createProcessHandle(terminateProcess);

    const first = session.terminate(true);
    const second = session.terminate(true);

    expect(terminateProcess).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
  });
});
