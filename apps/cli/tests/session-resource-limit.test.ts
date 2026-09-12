import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { SessionId, WorkspaceId } from '@lody/shared';

import { Session } from '../src/session/session';
import {
  type SessionSandboxLimits,
  SessionResourceLimitError,
  type SessionProcessHandle,
  type SessionSandbox,
} from '../src/session/session-sandbox';
import type { Logger } from '../src/utils/logger';
import {
  captureGitWorkingTreeDiffBaseline,
  getCurrentCommitHash,
  type GitRunner,
} from '../src/lib/git/git-diff-stats';

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

class FakeCommandChild extends EventEmitter {
  pid: number;
  killed = false;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough() as unknown as ChildProcess['stdin'];
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

const createProcessHandle = (
  child: FakeCommandChild,
  inspectExit: SessionProcessHandle['inspectExit']
): SessionProcessHandle => {
  let exitEvent: [number | null, NodeJS.Signals | null] | null = null;
  let closeEvent: [number | null, NodeJS.Signals | null] | null = null;
  let errorEvent: [Error] | null = null;

  const exitListeners = new Set<(exitCode: number | null, signal: NodeJS.Signals | null) => void>();
  const closeListeners = new Set<
    (exitCode: number | null, signal: NodeJS.Signals | null) => void
  >();
  const errorListeners = new Set<(error: Error) => void>();

  child.once('exit', (exitCode, signal) => {
    exitEvent = [exitCode, signal];
    for (const listener of Array.from(exitListeners)) {
      listener(exitCode, signal);
    }
  });

  child.once('close', (exitCode, signal) => {
    closeEvent = [exitCode, signal];
    for (const listener of Array.from(closeListeners)) {
      listener(exitCode, signal);
    }
  });

  child.once('error', (error) => {
    errorEvent = [error];
    for (const listener of Array.from(errorListeners)) {
      listener(error);
    }
  });

  const subscribe = <TArgs extends unknown[]>(
    listeners: Set<(...args: TArgs) => void>,
    listener: (...args: TArgs) => void,
    bufferedArgs: TArgs | null
  ): (() => void) => {
    if (bufferedArgs) {
      let active = true;
      setImmediate(() => {
        if (active) {
          listener(...bufferedArgs);
        }
      });
      return () => {
        active = false;
      };
    }

    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // Mirrors the real handle's `captureOutput` channel: read from creation,
  // replay on subscribe, so output produced before the caller holds the handle
  // is not lost.
  const captureOutput = (stream: PassThrough) => {
    let buffered: Buffer[] | null = [];
    const listeners = new Set<(chunk: Buffer) => void>();
    stream.on('data', (chunk: Buffer) => {
      if (buffered) {
        buffered.push(chunk);
        return;
      }
      for (const listener of Array.from(listeners)) {
        listener(chunk);
      }
    });
    return (listener: (chunk: Buffer) => void) => {
      listeners.add(listener);
      const replay = buffered;
      buffered = null;
      if (replay) {
        for (const chunk of replay) {
          listener(chunk);
        }
      }
      return () => {
        listeners.delete(listener);
      };
    };
  };

  return {
    child: child as unknown as ChildProcess,
    inspectExit,
    terminate: async (force) => {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    },
    onExit: (listener) => subscribe(exitListeners, listener, exitEvent),
    onClose: (listener) => subscribe(closeListeners, listener, closeEvent),
    onError: (listener) => subscribe(errorListeners, listener, errorEvent),
    onStdout: captureOutput(child.stdout),
    onStderr: captureOutput(child.stderr),
  };
};

const createSandbox = (
  handles: SessionProcessHandle[]
): SessionSandbox & {
  spawn: Mock<SessionSandbox['spawn']>;
  terminate: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
} => ({
  enabled: true,
  description: 'test-sandbox',
  applyLimits: vi.fn(async (_limits: SessionSandboxLimits) => {}),
  spawn: vi.fn(async () => {
    const next = handles.shift();
    if (!next) {
      throw new Error('No sandbox process handle available');
    }
    return next;
  }),
  terminate: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
});

const createSession = (sessionId: string, sandbox: SessionSandbox): Session =>
  new Session(
    {
      workspaceId: 'workspace-1' as WorkspaceId,
      userId: 'user-1',
      machineId: 'machine-1',
      agentCliType: 'builtin',
      agentType: 'codex',
      sessionId: sessionId as SessionId,
      userName: 'test-user',
      userEmail: 'test@example.com',
    },
    createSilentLogger(),
    process.cwd(),
    sandbox
  );

describe('Session resource limits', () => {
  it('replays a close event that happens before sandbox.spawn resolves', async () => {
    const child = new FakeCommandChild(1000);
    const delayedHandle = createProcessHandle(child, async () => null);
    const sandbox = createSandbox([]);
    sandbox.spawn.mockImplementation(async () => {
      child.stdout.write(Buffer.from('late-close'));
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      child.emit('close', 0, null);
      return delayedHandle;
    });
    const session = createSession('session-late-close', sandbox);

    await expect(session.exec('echo', ['late-close'], process.cwd(), false)).resolves.toBe(
      'late-close'
    );
  });

  it('fails only the over-limit session and leaves other sessions usable', async () => {
    const killedChild = new FakeCommandChild(1001);
    const limitedSandbox = createSandbox([
      createProcessHandle(killedChild, async () => ({
        kind: 'memory',
        message: 'Session exceeded memory.max (256 MiB) and was killed by the kernel',
      })),
    ]);
    const limitedSession = createSession('session-over-limit', limitedSandbox);

    const sessionError = new Promise<Error>((resolve) => {
      limitedSession.once('error', (event) => resolve(event.error));
    });
    const terminated = new Promise<void>((resolve) => {
      limitedSession.once('terminated', () => resolve());
    });

    const failingExec = limitedSession.exec('echo', ['hello'], process.cwd(), false);
    await Promise.resolve();
    killedChild.stdout.end();
    killedChild.stderr.end();
    killedChild.emit('close', null, 'SIGKILL');

    await expect(failingExec).rejects.toBeInstanceOf(SessionResourceLimitError);
    await expect(sessionError).resolves.toBeInstanceOf(SessionResourceLimitError);
    await terminated;

    expect(limitedSandbox.terminate).toHaveBeenCalledWith(true);
    expect(limitedSandbox.cleanup).toHaveBeenCalledTimes(1);
    await expect(limitedSession.exec('echo', ['again'], process.cwd(), false)).rejects.toThrow(
      'Session session-over-limit is not running'
    );

    const healthyChild = new FakeCommandChild(1002);
    const healthySandbox = createSandbox([createProcessHandle(healthyChild, async () => null)]);
    const healthySession = createSession('session-healthy', healthySandbox);

    const healthyExec = healthySession.exec('echo', ['ok'], process.cwd(), false);
    await Promise.resolve();
    healthyChild.stdout.write(Buffer.from('ok'));
    healthyChild.stdout.end();
    healthyChild.stderr.end();
    healthyChild.exitCode = 0;
    healthyChild.emit('close', 0, null);

    await expect(healthyExec).resolves.toBe('ok');
  });
});

describe('Session command execution', () => {
  it('spawns structured commands directly without a shell', async () => {
    const child = new FakeCommandChild(1003);
    const sandbox = createSandbox([createProcessHandle(child, async () => null)]);
    const session = createSession('session-direct-command', sandbox);
    const args = ['rev-parse', '--verify', "topic's branch^{commit}"];

    const result = session.exec('git', args, process.cwd(), false);
    await Promise.resolve();
    child.stdout.write(Buffer.from('deadbeef\n'));
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit('close', 0, null);

    await expect(result).resolves.toBe('deadbeef\n');
    expect(sandbox.spawn).toHaveBeenCalledWith(
      'git',
      args,
      expect.objectContaining({ cwd: process.cwd() })
    );
  });

  it('keeps command spawn failures local to the caller', async () => {
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const sandbox = createSandbox([]);
    sandbox.spawn.mockRejectedValue(spawnError);
    const session = createSession('session-command-spawn-error', sandbox);
    const onSessionError = vi.fn();
    session.on('error', onSessionError);

    await expect(
      session.exec('git', ['rev-parse', '--is-inside-work-tree'], process.cwd(), false)
    ).rejects.toBe(spawnError);
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it('lets best-effort Git baselines fall back without a session error', async () => {
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const sandbox = createSandbox([]);
    sandbox.spawn.mockRejectedValue(spawnError);
    const session = createSession('session-git-baseline-error', sandbox);
    const onSessionError = vi.fn();
    session.on('error', onSessionError);
    const runGit: GitRunner = (args) => session.exec('git', args, process.cwd(), false);

    await expect(getCurrentCommitHash(runGit)).resolves.toBeNull();
    await expect(captureGitWorkingTreeDiffBaseline(runGit)).resolves.toBeNull();
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it('keeps command process errors local to the caller', async () => {
    const child = new FakeCommandChild(1004);
    const sandbox = createSandbox([createProcessHandle(child, async () => null)]);
    const session = createSession('session-command-process-error', sandbox);
    const onSessionError = vi.fn();
    session.on('error', onSessionError);

    const result = session.exec(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      process.cwd(),
      false
    );
    await Promise.resolve();
    const processError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    child.emit('error', processError);

    await expect(result).rejects.toBe(processError);
    expect(onSessionError).not.toHaveBeenCalled();
  });
});
