import { EventEmitter } from 'events';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';

import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { ACPSessionId, SessionId } from '@lody/shared';

import { AgentClient } from '../src/agent/agent-client';
import { createNoopSessionSandbox } from '../src/session/session-sandbox';
import {
  ShellTerminalManager,
  TerminalSpawnError,
  type TerminalManager,
} from '../src/session/terminal-manager';
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
  child.kill = vi.fn(() => true);

  const subscribe = (stream: NodeJS.ReadableStream) => (listener: (chunk: Buffer) => void) => {
    stream.on('data', listener);
    return () => {
      stream.off('data', listener);
    };
  };

  const subscribeEvent =
    (event: 'exit' | 'close' | 'error') =>
    (listener: (...args: never[]) => void) => {
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

function createManager(sandbox: SessionSandbox, platform?: NodeJS.Platform, workdir?: string) {
  return new ShellTerminalManager({
    logger: createSilentLogger(),
    sessionLabel: 'test-session',
    getActiveAcpSessionId: () => 'acp-1',
    resolveWorkdir: (cwd) => cwd ?? workdir ?? process.cwd(),
    buildEnv: () => process.env,
    sandbox,
    platform,
  });
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

  it('runs an unsplit command line through a non-login shell', async () => {
    const spawn = vi.fn(async () => createProcessHandle(async () => {}));
    const manager = createManager(createSandbox(spawn), 'darwin');

    await manager.createTerminal('acp-1', 'ls -al', [], tmpdir());

    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'ls -al'],
      expect.objectContaining({ cwd: tmpdir(), captureOutput: true })
    );
  });

  it('runs an unsplit command line through cmd.exe on Windows', async () => {
    const spawn = vi.fn(async () => createProcessHandle(async () => {}));
    const manager = createManager(createSandbox(spawn), 'win32');

    await manager.createTerminal('acp-1', 'dir /b', [], tmpdir());

    expect(spawn).toHaveBeenCalledWith('cmd.exe', ['/c', 'dir /b'], expect.anything());
  });

  it('spawns a split executable and argv unchanged', async () => {
    const spawn = vi.fn(async () => createProcessHandle(async () => {}));
    const manager = createManager(createSandbox(spawn), 'darwin');

    await manager.createTerminal('acp-1', 'git', ['status', '--short'], tmpdir());

    expect(spawn).toHaveBeenCalledWith('git', ['status', '--short'], expect.anything());
  });

  it('spawns an executable path containing spaces directly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-terminal-'));
    const executable = join(dir, 'my tool');
    writeFileSync(executable, '#!/bin/sh\necho hi\n');
    chmodSync(executable, 0o755);
    const spawn = vi.fn(async () => createProcessHandle(async () => {}));
    const manager = createManager(createSandbox(spawn), 'darwin');

    await manager.createTerminal('acp-1', executable, [], dir);
    await manager.createTerminal('acp-1', 'my tool', [], dir);

    expect(spawn).toHaveBeenNthCalledWith(1, executable, [], expect.anything());
    expect(spawn).toHaveBeenNthCalledWith(2, 'my tool', [], expect.anything());
  });

  it('never rebuilds a command line that already carries arguments', async () => {
    const spawn = vi.fn(async () => createProcessHandle(async () => {}));
    const manager = createManager(createSandbox(spawn), 'darwin');

    await manager.createTerminal('acp-1', 'my tool', ['--version'], tmpdir());

    expect(spawn).toHaveBeenCalledWith('my tool', ['--version'], expect.anything());
  });

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
    const manager = createManager(createSandbox(async () => processHandle), 'darwin');

    const terminalId = await manager.createTerminal('acp-1', 'node', ['-v']);
    const exitStatus = manager.waitForTerminalExit('acp-1', terminalId);
    processHandle.child.emit('error', new Error('stream closed unexpectedly'));

    await expect(exitStatus).resolves.toEqual({ exitCode: null, signal: undefined });
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
