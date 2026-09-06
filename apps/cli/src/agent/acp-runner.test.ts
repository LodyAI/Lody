import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childCleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/utils/windows-child-process', () => ({ terminateWindowsChildProcess: childCleanup }));
const nativePlatform = process.platform;

import { __test__, shutdownLocalAcpAgent, spawnAcpProcess } from './acp-runner';
import type { Logger } from '@/utils/logger';

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

function createFakeChildProcess(options?: {
  exitOnSigterm?: boolean;
  exitOnSigkill?: boolean;
  pid?: number;
}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.exitCode = null;
  child.pid = options?.pid;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM' && options?.exitOnSigterm !== false) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, signal));
    }
    if (signal === 'SIGKILL' && options?.exitOnSigkill !== false) {
      child.exitCode = 137;
      queueMicrotask(() => child.emit('exit', 137, signal));
    }
    return true;
  });
  return child;
}

describe('spawnAcpProcess', () => {
  it('spawns ACP agents in a detached process group on POSIX', () => {
    const child = createFakeChildProcess();
    const spawnImpl = vi.fn(() => child);

    const result = spawnAcpProcess({
      cliType: 'builtin',
      agentType: 'codex',
      workdir: '/tmp',
      env: process.env,
      command: 'test-command',
      args: ['--test'],
      spawnImpl: spawnImpl as never,
    });

    expect(result).toBe(child);
    expect(spawnImpl).toHaveBeenCalledWith('test-command', ['--test'], {
      cwd: '/tmp',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  });
});

describe('Codex title-agent environment', () => {
  it('isolates the title agent in the workdir Codex home', () => {
    const baseEnv = { LODY_TITLE_AGENT: '1', LODY_E2E: '1' };

    const prepared = __test__.prepareCodexHomeEnv(
      { cliType: 'builtin', agentType: 'codex', workdir: '/tmp/title-agent' },
      baseEnv
    );

    expect(prepared.isTitleAgentCodexRun).toBe(true);
    expect(prepared.shouldUseWorkdirCodexHome).toBe(true);
    expect(prepared.env.CODEX_HOME).toBe(path.join('/tmp/title-agent', '.codex'));
  });

  it('merges title isolation into existing Codex session config', () => {
    const env = __test__.withTitleAgentCodexConfig({
      CODEX_CONFIG: JSON.stringify({
        model_provider: 'gateway',
        model_providers: { gateway: { base_url: 'https://gateway.example/v1' } },
        skills: { include_instructions: true },
      }),
    });

    expect(JSON.parse(env.CODEX_CONFIG ?? '')).toEqual({
      model_provider: 'gateway',
      model_providers: { gateway: { base_url: 'https://gateway.example/v1' } },
      project_doc_max_bytes: 0,
      include_environment_context: false,
      skills: {
        include_instructions: false,
        bundled: { enabled: false },
      },
    });
  });

  it('copies custom provider config into the isolated Codex home', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-title-config-test-'));
    const sourcePath = path.join(tempDir, 'source.toml');
    const destinationPath = path.join(tempDir, 'isolated', 'config.toml');
    const config = `model_provider = "gateway"

[model_providers.gateway]
base_url = "https://gateway.example/v1"
`;
    fs.writeFileSync(sourcePath, config);
    fs.mkdirSync(path.dirname(destinationPath));

    try {
      __test__.copyTitleAgentCodexConfig(sourcePath, destinationPath);

      expect(fs.readFileSync(destinationPath, 'utf8')).toBe(config);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still isolates non-title Codex E2E runs in the workdir', () => {
    const prepared = __test__.prepareCodexHomeEnv(
      { cliType: 'builtin', agentType: 'codex', workdir: '/tmp/codex-e2e' },
      { LODY_E2E: '1' }
    );

    expect(prepared.isTitleAgentCodexRun).toBe(false);
    expect(prepared.shouldUseWorkdirCodexHome).toBe(true);
    expect(prepared.env.CODEX_HOME).toBe(path.join('/tmp/codex-e2e', '.codex'));
  });
});

describe('shutdownLocalAcpAgent', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    childCleanup.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: nativePlatform });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes the ACP session before terminating the local agent process', async () => {
    const calls: string[] = [];
    const child = createFakeChildProcess();
    const client = {
      closeSession: vi.fn(async () => {
        calls.push('close');
        return true;
      }),
    };
    vi.mocked(child.kill).mockImplementation((signal?: NodeJS.Signals) => {
      calls.push(`kill:${signal ?? 'default'}`);
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, signal));
      return true;
    });

    await shutdownLocalAcpAgent({
      agentProcess: child,
      client: client as never,
      acpSessionId: 'acp-1' as never,
      logger: createSilentLogger(),
      sessionLabel: 'test-local-agent',
    });

    expect(client.closeSession).toHaveBeenCalledWith('acp-1', 5000);
    expect(calls).toEqual(['close', 'kill:SIGTERM']);
  });

  it('escalates to SIGKILL when the local agent process ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const child = createFakeChildProcess({ exitOnSigterm: false, exitOnSigkill: true });

    const shutdownPromise = shutdownLocalAcpAgent({
      agentProcess: child,
      logger: createSilentLogger(),
      sessionLabel: 'test-local-agent',
      exitTimeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await shutdownPromise;

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  {
    it('terminates the ACP process group on POSIX when the child has a PID', async () => {
      const child = createFakeChildProcess({ pid: 1234 });
      const processKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        expect(pid).toBe(-1234);
        expect(signal).toBe('SIGTERM');
        child.exitCode = 0;
        queueMicrotask(() => child.emit('exit', 0, signal));
        return true;
      });

      await shutdownLocalAcpAgent({
        agentProcess: child,
        logger: createSilentLogger(),
        sessionLabel: 'test-local-agent',
      });

      expect(processKill).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('escalates the ACP process group to SIGKILL on POSIX when SIGTERM is ignored', async () => {
      vi.useFakeTimers();
      const child = createFakeChildProcess({ pid: 1234 });
      const processKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        expect(pid).toBe(-1234);
        if (signal === 'SIGKILL') {
          child.exitCode = 137;
          queueMicrotask(() => child.emit('exit', 137, signal));
        }
        return true;
      });

      const shutdownPromise = shutdownLocalAcpAgent({
        agentProcess: child,
        logger: createSilentLogger(),
        sessionLabel: 'test-local-agent',
        exitTimeoutMs: 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      await shutdownPromise;

      expect(processKill).toHaveBeenNthCalledWith(1, -1234, 'SIGTERM');
      expect(processKill).toHaveBeenNthCalledWith(2, -1234, 'SIGKILL');
      expect(child.kill).not.toHaveBeenCalled();
    });
  }

  it('recognizes a child that already exited from a signal', async () => {
    const child = createFakeChildProcess();
    child.signalCode = 'SIGTERM';
    await shutdownLocalAcpAgent({
      agentProcess: child,
      logger: createSilentLogger(),
      sessionLabel: 'signal',
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rejects when force termination never produces an exit', async () => {
    vi.useFakeTimers();
    const child = createFakeChildProcess({ exitOnSigterm: false, exitOnSigkill: false });
    const result = shutdownLocalAcpAgent({
      agentProcess: child,
      logger: createSilentLogger(),
      sessionLabel: 'stuck',
      exitTimeoutMs: 10,
    });
    const assertion = expect(result).rejects.toThrow('did not exit after SIGKILL');
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('reports a signaling failure and allows a later cleanup attempt', async () => {
    const child = createFakeChildProcess();
    vi.mocked(child.kill).mockImplementationOnce(() => {
      throw new Error('permission denied');
    });
    const options = { agentProcess: child, logger: createSilentLogger(), sessionLabel: 'retry' };
    await expect(shutdownLocalAcpAgent(options)).rejects.toThrow('permission denied');
    await shutdownLocalAcpAgent(options);
    expect(child.exitCode).toBe(0);
  });

  it('waits for shared Windows child cleanup despite protocol close failure', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = createFakeChildProcess({ pid: 1234 });
    let finish: (() => void) | undefined;
    childCleanup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const options = {
      agentProcess: child,
      logger: createSilentLogger(),
      sessionLabel: 'tree',
      client: {
        closeSession: async () => {
          throw new Error('closed');
        },
      } as never,
      acpSessionId: 'acp' as never,
    };
    let settled = false;
    const first = shutdownLocalAcpAgent(options).then(() => {
      settled = true;
    });
    const second = shutdownLocalAcpAgent(options);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(childCleanup).toHaveBeenCalledTimes(1);
    child.signalCode = 'SIGKILL';
    finish?.();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports Windows child failure and permits retry', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = createFakeChildProcess({ pid: 1234 });
    childCleanup
      .mockRejectedValueOnce(new Error('tree failed'))
      .mockImplementationOnce(async () => {
        child.signalCode = 'SIGKILL';
      });
    const options = {
      agentProcess: child,
      logger: createSilentLogger(),
      sessionLabel: 'tree-retry',
    };
    await expect(shutdownLocalAcpAgent(options)).rejects.toThrow('tree failed');
    await shutdownLocalAcpAgent(options);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('does not equate Windows cleanup return with wrapper exit', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    childCleanup.mockResolvedValue(undefined);
    const result = shutdownLocalAcpAgent({
      agentProcess: createFakeChildProcess({ pid: 1234 }),
      logger: createSilentLogger(),
      sessionLabel: 'tree-timeout',
      exitTimeoutMs: 10,
    });
    const assertion = expect(result).rejects.toThrow(
      'did not exit after Windows child termination'
    );
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});
