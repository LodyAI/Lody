import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __test__, shutdownLocalAcpAgent, spawnAcpProcess } from './acp-runner';
import type { Logger } from '@/utils/logger';
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
  afterEach(() => {
    vi.useRealTimers();
  });

  const spawnAgent = (table: FakeProcessTable): ChildProcess =>
    table.api.spawn('agent', [], { detached: true });

  it('closes the ACP session before terminating the agent process group', async () => {
    const table = new FakeProcessTable('linux');
    const child = spawnAgent(table);
    const leader = child.pid ?? -1;
    const descendant = table.addDescendant(leader);
    const signalsAtClose: unknown[] = [];
    const client = {
      closeSession: vi.fn(async () => {
        signalsAtClose.push(...table.delivered);
        return true;
      }),
    };

    await shutdownLocalAcpAgent({
      agentProcess: child,
      client: client as never,
      acpSessionId: 'acp-1' as never,
      logger: createSilentLogger(),
      sessionLabel: 'test-local-agent',
      nodeProcess: table.api,
    });

    expect(client.closeSession).toHaveBeenCalledWith('acp-1', 5000);
    expect(signalsAtClose).toEqual([]);
    expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGTERM' }]);
    expect(table.isAlive(descendant)).toBe(false);
  });

  it('escalates to SIGKILL when the agent ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    const child = spawnAgent(table);
    const leader = child.pid ?? -1;

    const shutdown = shutdownLocalAcpAgent({
      agentProcess: child,
      logger: createSilentLogger(),
      sessionLabel: 'test-local-agent',
      exitTimeoutMs: 10,
      nodeProcess: table.api,
    });
    await vi.advanceTimersByTimeAsync(20);
    await shutdown;

    expect(table.delivered).toEqual([
      { target: -leader, signal: 'SIGTERM' },
      { target: -leader, signal: 'SIGKILL' },
    ]);
    expect(table.isAlive(leader)).toBe(false);
  });

  // Probe, title, and login agents are never reused, so a survivor is logged
  // as a leak instead of failing a caller whose real work already finished.
  it('reports an agent that survives termination without rejecting', async () => {
    vi.useFakeTimers();
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
    const warnings: string[] = [];
    const logger = {
      ...createSilentLogger(),
      warn: (message: unknown) => warnings.push(String(message)),
    };

    const shutdown = shutdownLocalAcpAgent({
      agentProcess: spawnAgent(table),
      logger,
      sessionLabel: 'test-local-agent',
      exitTimeoutMs: 10,
      nodeProcess: table.api,
    });
    await vi.advanceTimersByTimeAsync(30);

    await expect(shutdown).resolves.toBeUndefined();
    expect(warnings.join('\n')).toContain(
      '[test-local-agent] ACP agent process could not be terminated'
    );
  });
});
