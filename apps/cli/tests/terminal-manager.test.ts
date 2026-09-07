import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

  it('runs an unsplit shell command line through a shell (command has spaces, no args)', async () => {
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

    await manager.createTerminal('acp-1', 'ls -la /foo', []);

    const expectedShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const expectedFlag = process.platform === 'win32' ? '/c' : '-c';
    expect(sandbox.spawn).toHaveBeenCalledWith(
      expectedShell,
      [expectedFlag, 'ls -la /foo'],
      expect.objectContaining({ captureOutput: true })
    );
  });

  it('leaves a spec-conformant split command (executable + args) untouched', async () => {
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

    await manager.createTerminal('acp-1', 'git', ['status', '--short']);

    expect(sandbox.spawn).toHaveBeenCalledWith(
      'git',
      ['status', '--short'],
      expect.objectContaining({ captureOutput: true })
    );
  });

  it('spawns a zero-argument executable path containing spaces directly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-term-'));
    const toolPath = join(dir, 'my tool');
    writeFileSync(toolPath, '#!/bin/sh\necho hi\n');
    chmodSync(toolPath, 0o755);

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
      resolveWorkdir: (cwd) => cwd ?? dir,
      buildEnv: () => process.env,
      sandbox,
    });

    await manager.createTerminal('acp-1', 'my tool', [], dir);

    expect(sandbox.spawn).toHaveBeenCalledWith(
      'my tool',
      [],
      expect.objectContaining({ cwd: dir, captureOutput: true })
    );
  });
});
