import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flock } from '@loro-dev/flock-wasm';
import {
  getMachineFlockAgentConfigs,
  getMachineFlockProviderSetups,
  readMachineFlockRowsFromFlock,
  writeMachineFlockRowToFlock,
  machineFlockKeys,
} from '@lody/shared';
import { importMagpieProviders, resolveMagpieImport } from './magpie-import';
import { toAgentConfigOutput } from './agent-config-output';
import type { AgentConfigMeta, MachineMeta } from '@lody/shared';
import {
  applyEnvUpdates,
  inferAgentConfigCliType,
  parseEnvAssignments,
  parseEnvFileText,
  resolveMachineOrThrow,
  resolveAgentConfigSelector,
  sortAgentConfigs,
} from './agent-config';

const state = vi.hoisted(() => ({
  config: undefined as AgentConfigMeta | undefined,
  saved: undefined as AgentConfigMeta | undefined,
  flock: undefined as Flock | undefined,
  flushed: undefined as ReturnType<typeof readMachineFlockRowsFromFlock> | undefined,
  syncResults: [true, true],
  online: true,
}));

vi.mock('@/utils/file-lock', () => ({
  fileLocksLegacy: { withLock: async (_key: string, action: () => Promise<unknown>) => action() },
}));

vi.mock('@/lib/command-runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/command-runtime')>();
  return {
    ...original,
    getAuthContextOrThrow: () => ({ machineId: 'machine-id' }),
    resolveWorkspaceOrThrow: async () => ({ id: 'workspace-id' }),
    withWorkspaceManager: async (
      _auth: unknown,
      _workspace: unknown,
      _name: string,
      action: (manager: object) => Promise<void>
    ) =>
      action({
        repo: {
          openFlockDoc: async () => ({ flock: state.flock }),
          flush: async () => {
            state.flushed = state.flock
              ? structuredClone(readMachineFlockRowsFromFlock(state.flock))
              : undefined;
          },
        },
        getOnlineMachineIds: async () => new Set(state.online ? ['machine-id'] : []),
        markMachineFlockDocDirty: () => {},
        syncMachineFlockDoc: async () => state.syncResults.shift() ?? true,
      }),
    listAliveDocMetas: async () => [
      {
        meta: {
          id: 'machine-id',
          name: 'Machine',
          protocolCapabilities: { magpieImport: 1, providerSetup: 1, builtinPi: 1 },
        },
      },
    ],
    runOneShotCommand: async (_name: string, _options: unknown, action: () => Promise<void>) =>
      action(),
    ensureWorkspaceMetaSynced: async () => {},
  };
});
vi.mock('@/lib/agent-config-machine-flock', () => ({
  listMergedAgentConfigs: async () => (state.config ? [state.config] : []),
  upsertMachineAgentConfig: async (
    _repo: unknown,
    _workspace: unknown,
    config: AgentConfigMeta
  ) => {
    state.saved = structuredClone(config);
  },
  deleteMachineAgentConfig: async () => {},
}));

const createAgentConfig = (overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta => ({
  id: 'agent-config-id',
  machineId: 'machine-id',
  name: 'Codex Default',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  description: undefined,
  ...overrides,
});

const createMachine = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
  id: 'machine-id',
  name: 'Machine',
  cliVersion: '0.0.0',
  os: 'linux',
  sessions: [],
  ...overrides,
});

describe('agent-config command helpers', () => {
  it('sorts agent configs by name then id', () => {
    const configs = [
      createAgentConfig({ id: 'b', name: 'Beta' }),
      createAgentConfig({ id: 'c', name: 'Alpha' }),
      createAgentConfig({ id: 'a', name: 'Alpha' }),
    ];

    expect(sortAgentConfigs(configs).map((config) => config.id)).toEqual(['a', 'c', 'b']);
  });

  it('resolves agent config selectors from id, name, or env fallback', () => {
    const configs = [
      createAgentConfig({ id: 'cfg-1', name: 'Codex Default' }),
      createAgentConfig({ id: 'cfg-2', name: 'Claude' }),
    ];

    expect(resolveAgentConfigSelector(configs, { selector: 'cfg-2' }).id).toBe('cfg-2');
    expect(resolveAgentConfigSelector(configs, { selector: 'Claude' }).id).toBe('cfg-2');
    expect(resolveAgentConfigSelector([configs[0]!], { envSelector: 'cfg-1' }).id).toBe('cfg-1');
  });

  it('rejects ambiguous agent config names', () => {
    expect(() =>
      resolveAgentConfigSelector(
        [
          createAgentConfig({ id: 'cfg-1', name: 'Shared' }),
          createAgentConfig({ id: 'cfg-2', name: 'Shared' }),
        ],
        { selector: 'Shared' }
      )
    ).toThrow(/ambiguous/i);
  });

  it('rejects ambiguous machine names', () => {
    expect(() =>
      resolveMachineOrThrow(
        [
          createMachine({ id: 'machine-1', name: 'Shared' }),
          createMachine({ id: 'machine-2', name: 'Shared' }),
        ],
        {
          selector: 'Shared',
          authMachineId: 'machine-1',
        }
      )
    ).toThrow(/ambiguous/i);
  });

  it('parses inline and file env entries and applies updates in the correct order', () => {
    expect(parseEnvAssignments(['OPENAI_API_KEY=abc', 'FOO=bar'])).toEqual({
      OPENAI_API_KEY: 'abc',
      FOO: 'bar',
    });

    expect(
      parseEnvFileText(`
# comment
OPENAI_API_KEY=from-file
FOO=from-file
`)
    ).toEqual({
      OPENAI_API_KEY: 'from-file',
      FOO: 'from-file',
    });

    expect(
      applyEnvUpdates(
        { BASE: '1', FOO: 'old' },
        { FOO: 'from-file', BAR: 'from-file' },
        { FOO: 'from-flag', BAZ: 'from-flag' },
        ['BASE']
      )
    ).toEqual({
      FOO: 'from-flag',
      BAR: 'from-file',
      BAZ: 'from-flag',
    });
  });

  it('infers cli type from agent type', () => {
    expect(inferAgentConfigCliType('codex')).toBe('builtin');
    expect(inferAgentConfigCliType('claude')).toBe('builtin');
    expect(inferAgentConfigCliType('grok')).toBe('builtin');
    expect(inferAgentConfigCliType('bub')).toBe('builtin');
    expect(inferAgentConfigCliType('dimcode')).toBe('builtin');
    expect(inferAgentConfigCliType('claude-p')).toBe('registry');
    expect(inferAgentConfigCliType('opencode')).toBe('registry');
    expect(inferAgentConfigCliType('kimi')).toBe('registry');
    expect(inferAgentConfigCliType('kimi-code')).toBe('registry');
  });
});

describe('Magpie provider imports', () => {
  const machine = createMachine({
    protocolCapabilities: { magpieImport: 1, providerSetup: 1, builtinPi: 1 },
  });
  function harness() {
    const flock = new Flock();
    let id = 0;
    const run = (targets?: string, targetMachine = machine) =>
      importMagpieProviders({
        flock,
        machine: targetMachine,
        request: resolveMagpieImport({ targets }),
        existing: [],
        newId: () => `magpie-${++id}` as AgentConfigMeta['id'],
        now: 1000,
      });
    const read = () => {
      const rows = readMachineFlockRowsFromFlock(flock);
      return {
        configs: Object.values(getMachineFlockAgentConfigs(rows)),
        setups: Object.values(getMachineFlockProviderSetups(rows)),
      };
    };
    return { flock, run, read };
  }

  it('persists all seven native mappings and preserves identities across retries', () => {
    const { run, read } = harness();
    const result = run();
    expect(result.map((p) => p.target)).toEqual([
      'claude',
      'codex',
      'pi',
      'dsh',
      'kimi',
      'grok',
      'bub',
    ]);
    expect(read().configs.map((c) => c.agentType)).toEqual(['deepseek']);
    expect(read().setups).toHaveLength(6);
    const configs = [...read().configs, ...read().setups.map((s) => s.config)];
    expect(
      configs.every(
        (c) =>
          c.magpieGatewayUrl === 'http://127.0.0.1:3425' &&
          c.cliType === 'builtin' &&
          c.machineId === machine.id
      )
    ).toBe(true);
    expect(configs.find((c) => c.agentType === 'pi')?.env).toEqual({});
    expect(configs.find((c) => c.agentType === 'deepseek')?.env).toEqual({
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:3425/v1',
      DEEPSEEK_API_KEY: 'magpie-lody',
    });
    const before = read();
    expect(run().map((p) => p.agentConfigId)).toEqual(result.map((p) => p.agentConfigId));
    expect(read()).toEqual(before);
  });

  it('retries failed setup without replacing its configuration or other providers', () => {
    const { flock, run, read } = harness();
    run('pi');
    const original = read().setups[0]!;
    const failed = {
      ...original,
      config: { ...original.config, name: 'My Pi' },
      status: 'failed' as const,
      failureCode: 'verification-failed' as const,
    };
    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.providerSetup(failed.id),
      value: failed,
    });
    run('pi,codex');
    expect(read().setups.find((s) => s.id === original.id)).toEqual({
      ...original,
      config: failed.config,
      status: 'queued',
      attempt: 2,
    });
    expect(read().setups).toHaveLength(2);
  });

  it('rejects unsupported Pi before writing any selected provider', () => {
    const { run, read } = harness();
    expect(() =>
      run(
        'claude,pi',
        createMachine({ protocolCapabilities: { magpieImport: 1, providerSetup: 1 } })
      )
    ).toThrow('builtin Pi');
    expect(read()).toEqual({ configs: [], setups: [] });
    expect(() => run('codex', createMachine())).toThrow('daemon');
    expect(read()).toEqual({ configs: [], setups: [] });
  });

  it('completes a partial import without overwriting a published provider', () => {
    const { flock, run, read } = harness();
    run('pi');
    const config = {
      ...read().setups[0]!.config,
      name: 'Preserve my Pi',
      env: { CUSTOM: 'synthetic' },
    };
    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.agentConfig(config.id),
      value: config,
    });
    expect(run('pi,codex')[0]?.status).toBe('existing');
    expect(read().configs).toEqual([config]);
    expect(read().setups).toHaveLength(2);
  });

  it('creates a fresh setup rather than reviving a cancelled one', () => {
    const { flock, run, read } = harness();
    run('pi');
    const cancelled = read().setups[0]!;
    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.providerSetupCancellation(cancelled.id),
      value: { v: 1, id: cancelled.id, machineId: machine.id, cancelledAt: 1001 },
    });
    const result = run('pi');
    expect(result[0]?.agentConfigId).not.toBe(cancelled.id);
    expect(read().setups.find((s) => s.id === cancelled.id)).toEqual(cancelled);
    expect(read().setups).toHaveLength(2);
  });

  it('validates gateway, link selection and duplicate targets before import', () => {
    expect(() => resolveMagpieImport({ gateway: 'https://example.com' })).toThrow();
    expect(() => resolveMagpieImport({ link: '' })).toThrow();
    expect(() => resolveMagpieImport({ targets: 'pi,pi' })).toThrow('Invalid --targets');
    expect(() => resolveMagpieImport({ targets: '' })).toThrow('Invalid --targets');
    const data = Buffer.from(
      JSON.stringify({
        kind: 'custom',
        id: 'magpie',
        name: 'Magpie',
        auth: { method: 'apiKey', apiKey: 'magpie-lody' },
        endpoints: [
          {
            protocol: 'openai-chat',
            baseUrl: 'http://127.0.0.1:3425/v1',
            targets: ['pi'],
            modelsUrl: 'http://127.0.0.1:3425/v1/models',
          },
        ],
      })
    ).toString('base64url');
    const link = `lody://provider/import?v=1&data=${data}`;
    expect(resolveMagpieImport({ link }).targets).toEqual(['pi']);
    expect(() => resolveMagpieImport({ link, targets: 'codex' })).toThrow('Invalid --targets');
    expect(() => resolveMagpieImport({ link, gateway: 'http://127.0.0.1:3425' })).toThrow('either');
  });
});

const syntheticEnv = {
  OPENAI_API_KEY: 'synthetic-key-never-valid',
  ORDINARY_NAME: 'synthetic-arbitrary-value',
  MULTILINE: 'synthetic-first-line\nsynthetic-second-line',
  EMPTY: '',
};

describe('agent-config output boundary', () => {
  let lines: string[];
  let directory: string;

  beforeEach(async () => {
    vi.resetModules(); // Each parse gets fresh Commander option state.
    state.config = createAgentConfig({ env: { ...syntheticEnv } });
    state.saved = undefined;
    lines = [];
    directory = await mkdtemp(join(tmpdir(), 'lody-config-output-'));
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    const { agentConfigCommand } = await import('./agent-config');
    await agentConfigCommand.parseAsync(args, { from: 'user' });
    return lines.join('\n');
  }
  function expectNoValues(output: string) {
    for (const value of Object.values(syntheticEnv).filter(Boolean)) {
      expect(output).not.toContain(value);
      expect(output).not.toContain(JSON.stringify(value).slice(1, -1));
    }
  }

  it('imports through the CLI on the invoking machine and reports durable rows when upload fails', async () => {
    state.flock = new Flock();
    state.flushed = undefined;
    state.syncResults = [true, false];
    state.online = true;
    vi.stubEnv('LODY_MACHINE_ID', 'unrelated-remote-machine');
    try {
      const output = JSON.parse(await run(['import-magpie', '--targets', 'pi,dsh', '--json']));
      expect(output).toMatchObject({ ok: true, machineId: 'machine-id', synced: false });
      expect(output.providers.map((p: { target: string }) => p.target)).toEqual(['pi', 'dsh']);
      expect(Object.values(getMachineFlockProviderSetups(state.flushed!))[0]?.config).toMatchObject(
        { agentType: 'pi', magpieGatewayUrl: 'http://127.0.0.1:3425', machineId: 'machine-id' }
      );
      expect(Object.values(getMachineFlockAgentConfigs(state.flushed!))[0]?.agentType).toBe(
        'deepseek'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['offline', 'sync'])('does not write when preflight fails: %s', async (failure) => {
    state.flock = new Flock();
    state.flushed = undefined;
    state.online = failure !== 'offline';
    state.syncResults = [false];
    await expect(run(['import-magpie', '--targets', 'pi', '--json'])).rejects.toThrow();
    expect(readMachineFlockRowsFromFlock(state.flock)).toEqual({});
    expect(state.flushed).toBeUndefined();
  });

  it.each([false, true])(
    'show hides every env value (json=%s) without changing stored values',
    async (json) => {
      const output = await run(['show', 'agent-config-id', ...(json ? ['--json'] : [])]);
      expectNoValues(output);
      for (const key of Object.keys(syntheticEnv)) expect(output).toContain(key);
      if (json) {
        expect(JSON.parse(output).agentConfig).not.toHaveProperty('env');
        expect(JSON.parse(output).agentConfig.envKeys).toEqual(Object.keys(syntheticEnv).sort());
      } else expect(output).toContain('EMPTY=[configured]');
      expect(state.config?.env).toEqual(syntheticEnv);
    }
  );

  it.each([false, true])(
    'show requires an explicit opt-in to include raw values (json=%s)',
    async (json) => {
      const output = await run([
        'show',
        'agent-config-id',
        '--show-secrets',
        ...(json ? ['--json'] : []),
      ]);
      if (json) expect(JSON.parse(output).agentConfig.env).toEqual(syntheticEnv);
      else
        for (const [key, value] of Object.entries(syntheticEnv))
          expect(output).toContain(`${key}=${value}`);
    }
  );

  it('uses an allowlist even when persisted configs gain fields', () => {
    const config = {
      ...createAgentConfig({ env: syntheticEnv }),
      futureCredential: 'synthetic-future-secret',
      customAcp: { command: 'synthetic-command-secret', args: [] },
    };
    for (const reveal of [false, true]) {
      const output = JSON.stringify(toAgentConfigOutput(config, reveal));
      expect(output).not.toContain('synthetic-future-secret');
      expect(output).not.toContain('synthetic-command-secret');
    }
  });

  it('create returns a receipt while preserving inline and file values for launch', async () => {
    const envFile = join(directory, 'config.env');
    await writeFile(envFile, `OPENAI_API_KEY=${syntheticEnv.OPENAI_API_KEY}\nEMPTY=\n`);
    const output = await run([
      'create',
      '--agent-type',
      'codex',
      '--env-file',
      envFile,
      '--env',
      `ORDINARY_NAME=${syntheticEnv.ORDINARY_NAME}`,
      '--json',
    ]);
    expectNoValues(output);
    expect(JSON.parse(output)).toEqual({
      ok: true,
      workspaceId: 'workspace-id',
      agentConfigId: state.saved?.id,
      changedFields: ['name', 'agentType', 'machineId', 'env'],
    });
    expect(state.saved?.env).toEqual({
      OPENAI_API_KEY: syntheticEnv.OPENAI_API_KEY,
      ORDINARY_NAME: syntheticEnv.ORDINARY_NAME,
      EMPTY: '',
    });
  });

  it('a name-only update cannot echo existing credentials', async () => {
    const output = await run(['update', 'agent-config-id', '--name', 'Renamed', '--json']);
    expect(JSON.parse(output)).toEqual({
      ok: true,
      workspaceId: 'workspace-id',
      agentConfigId: 'agent-config-id',
      changedFields: ['name'],
    });
    expectNoValues(output);
    expect(state.saved).toMatchObject({ name: 'Renamed', env: syntheticEnv });
  });

  it('env updates and removals persist real values without echoing them', async () => {
    const output = await run([
      'update',
      'agent-config-id',
      '--env',
      'ORDINARY_NAME=synthetic-new-value',
      '--unset-env',
      'OPENAI_API_KEY',
      '--json',
    ]);
    expectNoValues(output);
    expect(output).not.toContain('synthetic-new-value');
    expect(JSON.parse(output).changedFields).toEqual(['env']);
    expect(state.saved?.env).toEqual({
      ORDINARY_NAME: 'synthetic-new-value',
      MULTILINE: syntheticEnv.MULTILINE,
      EMPTY: '',
    });
  });

  it.each(['create', 'update'])(
    'invalid inline input in %s reports position, not contents',
    async (command) => {
      const args =
        command === 'create' ? ['create', '--agent-type', 'codex'] : ['update', 'agent-config-id'];
      await expect(
        run([...args, '--env', 'VALID=value', '--env', syntheticEnv.OPENAI_API_KEY, '--json'])
      ).rejects.toEqual(new Error('Invalid assignment at entry 2. Expected KEY=VALUE.'));
      expect(lines).toEqual([]);
      expect(state.saved).toBeUndefined();
    }
  );

  it('invalid env file input reports only the physical line number', async () => {
    const envFile = join(directory, 'invalid.env');
    await writeFile(envFile, `# comment\n\n=${syntheticEnv.OPENAI_API_KEY}\n`);
    await expect(
      run(['create', '--agent-type', 'codex', '--env-file', envFile, '--json'])
    ).rejects.toEqual(new Error('Invalid env file entry at line 3. Expected KEY=VALUE.'));
    expect(lines).toEqual([]);
    expect(state.saved).toBeUndefined();
  });
});
