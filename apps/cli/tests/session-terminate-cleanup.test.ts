import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, SessionId, WorkspaceId } from '@lody/shared';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

import type realSpawn from 'cross-spawn';

import { TerminationFailed } from '@lody/shared/node/process';
import { Session } from '../src/session/session';
import type { TerminalManager } from '../src/session/terminal-manager';
import {
  createSessionSandboxFactory,
  type SessionProcessHandle,
  type SessionSandbox,
} from '../src/session/session-sandbox';
import type { Logger } from '../src/utils/logger';
import { FakeProcessTable } from '@lody/shared/node/process-testing';

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

const createTerminalManager = (overrides: Partial<TerminalManager> = {}): TerminalManager => ({
  createTerminal: async () => 'terminal-id',
  terminalOutput: async () => ({ output: '', truncated: false, exitStatus: null }),
  releaseTerminal: async () => {},
  waitForTerminalExit: async () => ({ exitCode: 0 }),
  killTerminal: async () => {},
  ...overrides,
});

const createSession = (sandbox?: SessionSandbox): Session => {
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
    process.cwd(),
    sandbox
  );
};

const createProcessTableSandbox = async (table: FakeProcessTable): Promise<SessionSandbox> =>
  await createSessionSandboxFactory({
    logger: createSilentLogger(),
    deps: {
      platform: table.platform,
      spawnProcess: table.api.spawn as unknown as typeof realSpawn,
      configureExecutionProcess: vi.fn(async () => {}),
      killPid: table.api.kill,
    },
  })('session-1' as SessionId);

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

  it('shares one termination between concurrent callers and emits terminated once', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createProcessTableSandbox(table);
    const session = createSession(sandbox);
    const agent = await sandbox.spawn('agent', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const descendant = table.addDescendant(agent.child.pid ?? -1);
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = agent;
    const terminated: unknown[] = [];
    session.on('terminated', (event) => terminated.push(event));

    await Promise.all([session.terminate(false), session.terminate(false)]);

    expect(terminated).toHaveLength(1);
    expect(table.isAlive(descendant)).toBe(false);
    expect(table.delivered).toEqual([{ target: -(agent.child.pid ?? -1), signal: 'SIGTERM' }]);
  });

  // Quitting the desktop forces teardown while a graceful stop may be running;
  // waiting on it outlasts the desktop's own kill deadline.
  it('escalates an in-flight graceful termination when a forced call joins', async () => {
    const table = new FakeProcessTable('darwin');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    const sandbox = await createProcessTableSandbox(table);
    const session = createSession(sandbox);
    const agent = await sandbox.spawn('agent', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const leader = agent.child.pid ?? -1;
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = agent;
    // A wedged agent never answers the graceful session/close.
    const closeRequested = Promise.withResolvers<void>();
    session.acpSessionId = 'acp-session-1' as ACPSessionId;
    session.agentClient = {
      isCreated: () => true,
      closeSession: async () => {
        closeRequested.resolve();
        return await new Promise<boolean>(() => {});
      },
    } as never;
    const terminated: unknown[] = [];
    session.on('terminated', (event) => terminated.push(event));

    const graceful = session.terminate(false);
    await closeRequested.promise;
    await session.terminate(true);
    await graceful;

    expect(table.isAlive(leader)).toBe(false);
    expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGKILL' }]);
    expect(terminated).toHaveLength(1);
  });

  it('kills the agent under a forced terminate without waiting for terminal disposal', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createProcessTableSandbox(table);
    const session = createSession(sandbox);
    const agent = await sandbox.spawn('agent', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const agentExited = new Promise<void>((resolve) => agent.onExit(() => resolve()));
    // A terminal command slow to stop: disposal completes only once the agent is gone.
    session.terminalManager = createTerminalManager({ disposeAll: async () => await agentExited });
    session.acpSessionId = 'acp-session-1' as ACPSessionId;
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = agent;

    await session.terminate(true);

    expect(table.isAlive(agent.child.pid ?? -1)).toBe(false);
  });

  it('terminates an agent started after an earlier termination finished', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createProcessTableSandbox(table);
    const session = createSession(sandbox);
    await session.terminate(true);
    const lateAgent = await sandbox.spawn('agent', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = lateAgent;

    await session.terminate(true);

    expect(table.isAlive(lateAgent.child.pid ?? -1)).toBe(false);
  });

  // A reused Session's agent can exit on its own (clearing agentProcess) and
  // leave its children in the sandbox; a later terminate must still end them.
  it('ends what a later agent left in the sandbox after an earlier termination', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createProcessTableSandbox(table);
    const session = createSession(sandbox);
    await session.terminate(true);
    const lateAgent = await sandbox.spawn('agent', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const orphan = table.addDescendant(lateAgent.child.pid ?? -1);
    table.exitOnItsOwn(lateAgent.child.pid ?? -1);

    await session.terminate(true);

    expect(table.isAlive(orphan)).toBe(false);
  });

  it('reports the agent exit code, not a finished command, in terminated', async () => {
    const session = createSession();
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = createProcessHandle(async () => {});
    const terminated: Array<{ exitCode: number }> = [];
    session.on('terminated', (event) => terminated.push(event));

    await session.terminate(true);

    expect(terminated).toEqual([{ sessionId: 'session-1', exitCode: 137 }]);
  });

  // A survivor may still hold the ACP prompt; reuse would feed it a new turn.
  it('rejects when a process tree survives, after finishing its bookkeeping', async () => {
    const survivor = new TerminationFailed({
      target: 'process group 4321',
      reason: 'still-alive',
      message: 'process group 4321 was still running 5000ms after SIGKILL',
    });
    const session = createSession();
    session.agentClient = { isCreated: vi.fn(() => false) } as never;
    // @ts-expect-error - exercising private process handle wiring
    session.agentProcess = createProcessHandle(async () => {
      throw survivor;
    });
    const terminated: unknown[] = [];
    session.on('terminated', (event) => terminated.push(event));

    await expect(session.terminate(true)).rejects.toBe(survivor);
    expect(terminated).toHaveLength(1);
    expect(session.agentClient).toBeNull();
  });
});
