import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    ) => action({ repo: {} }),
    listAliveDocMetas: async () => [{ meta: { id: 'machine-id', name: 'Machine' } }],
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
