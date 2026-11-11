import { AgentSideConnection, PROTOCOL_VERSION, type Stream } from '@agentclientprotocol/sdk';
import {
  initializeAndReadAcpRateLimits,
  initializeAndRunSorbetCredentials,
  queryLocalAcpRateLimits,
  runLocalSorbetCredentials,
} from './acp-runner';
import { spawn } from 'node:child_process';
import * as loginShell from './login-shell-env';
import * as setting from './setting';
import { getLodyNpmCacheDir } from './npx-cache';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __test__,
  prepareAcpProcessEnvironmentLegacy,
  shutdownLocalAcpAgent,
  spawnAcpProcess,
} from './acp-runner';
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

describe('read-only quota ACP handshake', () => {
  it.each([true, false])(
    'queries only when advertised (query=%s), without creating a session',
    async (query) => {
      const outbound = new TransformStream();
      const inbound = new TransformStream();
      const limits = {
        rateLimits: [
          {
            limitId: 'account',
            scope: { providerId: 'example' },
            windows: [
              { usedPercent: 37, windowDurationSeconds: 18000, resetsAtEpochSeconds: null },
            ],
          },
        ],
        fetchedAtEpochSeconds: 123,
      };
      let sessions = 0;
      let initialization: unknown;
      const _server = new AgentSideConnection(
        () => ({
          initialize: async (params) => {
            initialization = params.clientCapabilities;
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: {
                _meta: { lody: { rateLimits: { version: 1, ...(query ? { query: true } : {}) } } },
              },
            };
          },
          newSession: async () => {
            sessions++;
            throw new Error('Unexpected session');
          },
          authenticate: async () => {
            throw new Error('Unexpected login');
          },
          prompt: async () => {
            throw new Error('Unexpected prompt');
          },
          cancel: async () => {},
          extMethod: async (method) => {
            if (method !== '_lody/rate_limits/get' && method !== 'lody/rate_limits/get')
              throw new Error(method);
            return limits;
          },
        }),
        { readable: outbound.readable, writable: inbound.writable } as Stream
      );
      const result = initializeAndReadAcpRateLimits({
        readable: inbound.readable,
        writable: outbound.writable,
      } as Stream);
      if (query) await expect(result).resolves.toEqual(limits);
      else await expect(result).rejects.toThrow('unsupported');
      expect(sessions).toBe(0);
      expect(initialization).toMatchObject({
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
      });
    }
  );
});

describe('Antigravity quota ACP compatibility', () => {
  // Synthetic data matching the official 1.4.5 /usage layout, not a user transcript.
  const usage = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini Flash, Gemini Pro)*
  - **Weekly Limit Remaining:** 25% remaining (resets Jan 8, 2030, 16:11 UTC)
  - **Five Hour Limit Remaining:** 0% remaining (resets Jan 2, 2030, 21:11 UTC)
- **Claude and GPT models**
  - **Weekly Limit Remaining:** 100% remaining (resets Jan 8, 2030, 16:46 UTC)
  - **Five Hour Limit Remaining:** 81.5% remaining (resets Jan 2, 2030, 21:46 UTC)`;

  async function query(
    options: {
      text?: string;
      commands?: string[];
      cliType?: 'registry' | 'custom';
      serverName?: string;
      stopReason?: 'end_turn' | 'cancelled';
      beforeNewResponse?: boolean;
    } = {}
  ) {
    const outbound = new TransformStream();
    const inbound = new TransformStream();
    const prompts: unknown[] = [];
    const sessions: unknown[] = [];
    const advertise = async () =>
      server.sessionUpdate({
        sessionId: 'quota-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: (options.commands ?? ['usage']).map((name) => ({
            name,
            description: name,
          })),
        },
      });
    const server = new AgentSideConnection(
      () => ({
        initialize: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: options.serverName ?? 'antigravity-acp', version: '1.4.5' },
        }),
        newSession: async (params) => {
          sessions.push(params);
          if (options.beforeNewResponse) await advertise();
          else
            queueMicrotask(() => {
              void advertise();
            });
          return { sessionId: 'quota-session' };
        },
        authenticate: async () => {
          throw new Error('Must not log in');
        },
        prompt: async (params) => {
          prompts.push(params);
          // Other sessions and token-usage notifications must not enter quota parsing.
          await server.sessionUpdate({
            sessionId: 'other',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'unrelated' },
            },
          });
          const text = options.text ?? usage;
          for (const part of [text.slice(0, 77), text.slice(77)]) {
            await server.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: part },
              },
            });
          }
          return { stopReason: options.stopReason ?? 'end_turn' };
        },
        cancel: async () => {},
      }),
      { readable: outbound.readable, writable: inbound.writable } as Stream
    );
    const outcome = initializeAndReadAcpRateLimits(
      {
        readable: inbound.readable,
        writable: outbound.writable,
      } as Stream,
      {
        cliType: options.cliType ?? 'registry',
        agentType: 'antigravity-acp',
        workdir: '/quota-scratch',
      }
    );
    return { outcome, prompts, sessions };
  }

  it.each([false, true])(
    'reads separate weekly and 5h windows (early commands: %s)',
    async (beforeNewResponse) => {
      const { outcome, prompts, sessions } = await query({ beforeNewResponse });
      const snapshot = await outcome;
      expect(snapshot.rateLimits).toEqual([
        {
          limitId: 'antigravity-acp',
          scope: { providerId: 'antigravity' },
          windows: [
            {
              label: 'Gemini Models',
              usedPercent: 75,
              windowDurationSeconds: 604800,
              resetsAtEpochSeconds: Date.parse('2030-01-08T16:11:00Z') / 1000,
            },
            {
              label: 'Gemini Models',
              usedPercent: 100,
              windowDurationSeconds: 18000,
              resetsAtEpochSeconds: Date.parse('2030-01-02T21:11:00Z') / 1000,
            },
            {
              label: 'Claude and GPT models',
              usedPercent: 0,
              windowDurationSeconds: 604800,
              resetsAtEpochSeconds: Date.parse('2030-01-08T16:46:00Z') / 1000,
            },
            {
              label: 'Claude and GPT models',
              usedPercent: 18.5,
              windowDurationSeconds: 18000,
              resetsAtEpochSeconds: Date.parse('2030-01-02T21:46:00Z') / 1000,
            },
          ],
        },
      ]);
      expect(sessions).toEqual([{ cwd: '/quota-scratch', mcpServers: [] }]);
      expect(prompts).toEqual([
        { sessionId: 'quota-session', prompt: [{ type: 'text', text: '/usage' }] },
      ]);
    }
  );

  it.each([
    { cliType: 'custom' as const },
    { serverName: 'another-agent' },
    { commands: [] },
    { text: 'Quota is unavailable' },
    { text: usage.replace('25%', '125%') },
    { text: 'x'.repeat(65537) },
    { stopReason: 'cancelled' as const },
  ])(
    'rejects unsupported or invalid quota without manufacturing values: case %#',
    async (options) => {
      const { outcome, prompts } = await query(options);
      await expect(outcome).rejects.toThrow();
      if (options.cliType || options.serverName || options.commands) expect(prompts).toEqual([]);
    }
  );

  it('keeps missing and unzoned resets unknown without inventing weekly quota', async () => {
    const { outcome } = await query({
      text: `### Quota Limits
- **Gemini Models**
  - **Five Hour Limit Remaining:** 10% remaining (resets Jan 2, 2030, 21:11)
- **Claude and GPT models**
  - **Five Hour Limit Remaining:** 20% remaining`,
    });
    expect((await outcome).rateLimits[0]?.windows).toEqual([
      {
        label: 'Gemini Models',
        usedPercent: 90,
        windowDurationSeconds: 18000,
        resetsAtEpochSeconds: null,
      },
      {
        label: 'Claude and GPT models',
        usedPercent: 80,
        windowDurationSeconds: 18000,
        resetsAtEpochSeconds: null,
      },
    ]);
  });

  it.each(['commands', 'reply'] as const)(
    'cancels while waiting for %s and removes scratch after the child exits',
    async (phase) => {
      vi.spyOn(loginShell, 'getLoginShellEnvLegacy').mockResolvedValue({});
      vi.spyOn(setting, 'resolveACPProcessLaunchAsync').mockResolvedValue({
        command: 'synthetic-antigravity',
        args: [],
      });
      const controller = new AbortController();
      let ready = () => {};
      const waiting = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let child: ChildProcess | undefined;
      let scratch = '';
      const script = `
      const readline = require('node:readline');
      const send = value => console.log(JSON.stringify(value));
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const r = JSON.parse(line);
        if (r.method === 'initialize') send({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.5' } } });
        if (r.method === 'session/new') {
          send({ jsonrpc: '2.0', id: r.id, result: { sessionId: 'quota' } });
          if (${JSON.stringify(phase)} === 'commands') console.error('waiting');
          else send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'quota', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'usage', description: 'Quota' }] } } });
        }
        if (r.method === 'session/prompt') console.error('waiting');
      });`;
      try {
        const outcome = queryLocalAcpRateLimits({
          cliType: 'registry',
          agentType: 'antigravity-acp',
          workdir: process.cwd(),
          env: {},
          logger: createSilentLogger(),
          signal: controller.signal,
          terminalManager: {} as never,
          onUpdateMessage: () => {},
          onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          spawnImpl: ((_command, _args, options) => {
            scratch = String(options.cwd);
            child = spawn(process.execPath, ['-e', script], options);
            child.stderr?.on('data', (data) => {
              if (String(data).includes('waiting')) ready();
            });
            return child;
          }) as NonNullable<Parameters<typeof queryLocalAcpRateLimits>[0]['spawnImpl']>,
        });
        const rejected = expect(outcome).rejects.toThrow('cancelled');
        await waiting;
        expect(fs.existsSync(scratch)).toBe(true);
        expect(scratch).not.toBe(process.cwd());
        controller.abort();
        await rejected;
        expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
        expect(fs.existsSync(scratch)).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    }
  );
});

describe('Sorbet credentials ACP handshake', () => {
  it('recovers a failed npm startup before running logout exactly once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-sorbet-credentials-offline-'));
    vi.stubEnv('LODY_DATA_DIR', root);
    vi.spyOn(loginShell, 'getLoginShellEnvLegacy').mockResolvedValue({});
    const install = path.join(getLodyNpmCacheDir(), '_npx', 'aa11');
    const pkg = path.join(install, 'node_modules', '@sorbetai', 'acp');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(install, 'package.json'),
      JSON.stringify({ _npx: { packages: ['@sorbetai/acp@alpha'] } })
    );
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ version: '0.1.0', bin: 'index.js' })
    );
    fs.writeFileSync(path.join(pkg, 'index.js'), '');
    const marker = path.join(root, 'logout');
    const attempts: string[][] = [];
    const script = `
      const readline = require('node:readline');
      const fs = require('node:fs');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { 'sorbet.dev': { credentials: { version: 1 } } } } } }) + '\\n');
        } else if (request.method === '_sorbet/auth/credentials/logout') {
          fs.appendFileSync(process.env.TEST_MARKER, 'logout\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
        }
      });`;
    try {
      const result = await runLocalSorbetCredentials(
        createSilentLogger(),
        { type: 'logout', providerId: 'example' },
        undefined,
        {
          spawnImpl: ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
            attempts.push([...args]);
            const code =
              attempts.length === 1
                ? "console.error('npm error code ENOTFOUND'); process.exit(1)"
                : script;
            return spawn(process.execPath, ['-e', code], {
              ...options,
              env: { ...options.env, TEST_MARKER: marker },
            });
          }) as never,
        }
      );
      expect(result).toEqual({ kind: 'credentials', credentials: [] });
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toContain('--offline');
      expect(fs.readFileSync(marker, 'utf8')).toBe('logout\n');
      attempts.length = 0;
      const failingScript = script.replace(
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })",
        "console.error('npm error code ENOTFOUND'); process.exit(1); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })"
      );
      await expect(
        runLocalSorbetCredentials(
          createSilentLogger(),
          { type: 'logout', providerId: 'example' },
          undefined,
          {
            spawnImpl: ((
              _command: string,
              args: string[],
              options: { env?: NodeJS.ProcessEnv }
            ) => {
              attempts.push([...args]);
              return spawn(process.execPath, ['-e', failingScript], {
                ...options,
                env: { ...options.env, TEST_MARKER: marker },
              });
            }) as never,
          }
        )
      ).rejects.toThrow();
      expect(attempts).toHaveLength(1);
      expect(fs.readFileSync(marker, 'utf8')).toBe('logout\nlogout\n');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['list', 'logout'] as const)(
    'initializes without session capabilities and executes %s',
    async (operation) => {
      const outbound = new TransformStream();
      const inbound = new TransformStream();
      let initialization: unknown;
      const received: Array<{ method: string; params: unknown }> = [];
      const server = new AgentSideConnection(
        () => ({
          initialize: async (params) => {
            initialization = params.clientCapabilities;
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { _meta: { 'sorbet.dev': { credentials: { version: 1 } } } },
            };
          },
          newSession: async () => {
            throw new Error('Unexpected session');
          },
          authenticate: async () => {
            throw new Error('Unexpected authentication');
          },
          prompt: async () => {
            throw new Error('Unexpected prompt');
          },
          cancel: async () => {},
          extMethod: async (method, params) => {
            received.push({ method, params });
            return method.endsWith('/list')
              ? { credentials: [{ providerId: 'example', type: 'oauth' }] }
              : {};
          },
        }),
        { readable: outbound.readable, writable: inbound.writable } as Stream
      );
      void server;
      const result = await initializeAndRunSorbetCredentials(
        { readable: inbound.readable, writable: outbound.writable } as Stream,
        new AbortController().signal,
        operation === 'list' ? { type: 'list' } : { type: 'logout', providerId: 'example' }
      );
      expect(initialization).toMatchObject({
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
      });
      expect(received).toEqual([
        {
          method: `_sorbet/auth/credentials/${operation}`,
          params: operation === 'list' ? {} : { providerId: 'example' },
        },
      ]);
      expect(result).toEqual(
        operation === 'list' ? [{ providerId: 'example', type: 'oauth' }] : []
      );
    }
  );
});

describe('ACP system Node prerequisites', () => {
  it('leaves other launch environments unchanged even if inherited fields resemble DSH', async () => {
    const env = { PATH: '', ELECTRON_RUN_AS_NODE: '1', LODY_DSH_NODE_ARGS: 'inherited' };
    expect(
      await prepareAcpProcessEnvironmentLegacy({ command: 'other-agent', args: [] }, env)
    ).toBe(env);
  });

  it('reports Node missing before starting a builtin DSH process', async () => {
    const launch = { command: 'npx', args: [], env: { LODY_DSH_NODE_ARGS: 'synthetic' } };
    await expect(prepareAcpProcessEnvironmentLegacy(launch, { PATH: '' })).rejects.toThrow(
      '[DSH_NODE_NOT_FOUND]'
    );
  });
});
