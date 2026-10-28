import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CodexProfileExecution } from './codex-profile-runtime';
import type { StartLocalAcpAgentOptions } from './acp-runner';

import type { Logger } from '@/utils/logger';

const mocks = vi.hoisted(() => ({
  startLocalAcpAgent: vi.fn(),
  shutdownLocalAcpAgent: vi.fn(async () => {}),
  probeBuiltinAuthentication: vi.fn(),
}));

vi.mock('./acp-runner', () => ({
  startLocalAcpAgent: mocks.startLocalAcpAgent,
  shutdownLocalAcpAgent: mocks.shutdownLocalAcpAgent,
}));

vi.mock('./acp-authentication', () => ({
  probeBuiltinAuthentication: mocks.probeBuiltinAuthentication,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), rm: vi.fn(actual.rm) };
});

import { fetchAcpCapabilities } from './acp-capabilities';
import { AcpAuthenticationRequiredError } from './agent-client';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createSuccessfulStartupResult(sessionResponse?: Record<string, unknown>) {
  return {
    agentProcess: {} as never,
    client: {
      supportsSessionTitleGeneration: () => false,
      getRateLimitsCapability: () => undefined,
      supportsAcknowledgedSteer: () => false,
      getGoalCapability: () => undefined,
    } as never,
    acpSessionId: 'acp-session-1' as never,
    sessionResponse: sessionResponse ?? {
      sessionId: 'acp-session-1',
      modes: {
        availableModes: [{ id: 'default', name: 'Default' }],
      },
      models: {
        availableModels: [{ modelId: 'claude-sonnet', name: 'Claude Sonnet' }],
        currentModelId: 'claude-sonnet',
      },
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select' as const,
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
      availableCommands: [{ name: '/help', description: 'Help' }],
    },
  };
}

function mockStartupWithSessionResponse(sessionResponse: Record<string, unknown>) {
  mocks.startLocalAcpAgent.mockImplementation(async () =>
    createSuccessfulStartupResult(sessionResponse)
  );
}

describe('fetchAcpCapabilities', () => {
  const probeDirectories = new Set<string>();
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of probeDirectories) {
      // A regression may pass cwd instead: never delete it from test teardown.
      if (/^lody-(acp-capabilities|test-profile)-/.test(path.basename(directory))) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    probeDirectories.clear();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.probeBuiltinAuthentication.mockResolvedValue({ status: 'unknown' });
    mocks.startLocalAcpAgent.mockImplementation(async () => createSuccessfulStartupResult());
  });

  it('defers builtin Codex authentication to ACP session creation', async () => {
    const result = await fetchAcpCapabilities('builtin', 'codex', createSilentLogger());

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.probeBuiltinAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'builtin',
        agentType: 'codex',
      })
    );
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: undefined,
      })
    );
    expect(result.models.map((model) => model.modelId)).toEqual(['claude-sonnet']);
  });

  it('reports missing builtin credentials before starting the ACP adapter', async () => {
    const authMethods = [
      {
        id: 'claude-ai-login',
        name: 'Claude subscription',
        type: 'terminal' as const,
        args: ['auth', 'login', '--claudeai'],
      },
    ];
    mocks.probeBuiltinAuthentication.mockResolvedValue({
      status: 'unauthenticated',
      authMethods,
    });

    const result = fetchAcpCapabilities('builtin', 'claude', createSilentLogger());

    await expect(result).rejects.toBeInstanceOf(AcpAuthenticationRequiredError);
    await expect(result).rejects.toMatchObject({ authMethods });
    expect(mocks.startLocalAcpAgent).not.toHaveBeenCalled();
  });

  it.each(['registry', 'custom', 'builtin'] as const)(
    'uses a writable isolated workspace for %s probes even when daemon cwd is root',
    async (cliType) => {
      const inheritedCwd = path.parse(process.cwd()).root;
      vi.spyOn(process, 'cwd').mockReturnValue(inheritedCwd);
      let workdir = '';
      mocks.startLocalAcpAgent.mockImplementation(async (options: StartLocalAcpAgentOptions) => {
        workdir = options.workdir;
        probeDirectories.add(workdir);
        expect(path.isAbsolute(workdir)).toBe(true);
        expect(workdir).not.toBe(inheritedCwd);
        await mkdir(path.join(workdir, '.gemini', 'skills'), { recursive: true });
        await writeFile(path.join(workdir, '.gemini', 'skills', 'probe'), 'workspace ready');
        return createSuccessfulStartupResult();
      });
      mocks.shutdownLocalAcpAgent.mockImplementation(async () => {
        expect(await readFile(path.join(workdir, '.gemini', 'skills', 'probe'), 'utf8')).toBe(
          'workspace ready'
        );
      });

      const result = await fetchAcpCapabilities(cliType, 'probe-agent', createSilentLogger());
      expect(result.models.map((model) => model.modelId)).toEqual(['claude-sonnet']);
      expect(result.availableCommands).toEqual([{ name: '/help', description: 'Help' }]);
      expect(existsSync(workdir)).toBe(false);
    }
  );

  it('keeps concurrent probe directories until each shutdown finishes', async () => {
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseShutdown = () => {};
    const shutdownReleased = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const directories: string[] = [];
    mocks.startLocalAcpAgent.mockImplementation(async ({ workdir }: StartLocalAcpAgentOptions) => {
      probeDirectories.add(workdir);
      directories.push(workdir);
      await writeFile(path.join(workdir, 'owner'), workdir);
      return createSuccessfulStartupResult();
    });
    mocks.shutdownLocalAcpAgent.mockImplementation(async () => {
      notifyStarted();
      await shutdownReleased;
    });
    const first = fetchAcpCapabilities('registry', 'probe-agent', createSilentLogger());
    await started;
    try {
      mocks.shutdownLocalAcpAgent.mockImplementation(async () => {});
      await fetchAcpCapabilities('registry', 'probe-agent', createSilentLogger());
      const [firstDir = '', secondDir = ''] = directories;
      expect(firstDir).not.toBe(secondDir);
      expect(await readFile(path.join(firstDir, 'owner'), 'utf8')).toBe(firstDir);
      expect(existsSync(secondDir)).toBe(false);
    } finally {
      releaseShutdown();
      await first;
    }
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
  });

  it.each(['startup', 'cancelled', 'normalization'] as const)(
    'removes the workspace after %s failure and preserves the original error',
    async (failure) => {
      const controller = new AbortController();
      const error = new Error(failure);
      let workdir = '';
      mocks.startLocalAcpAgent.mockImplementation(async (options: StartLocalAcpAgentOptions) => {
        workdir = options.workdir;
        probeDirectories.add(workdir);
        await mkdir(path.join(workdir, '.gemini', 'skills'), { recursive: true });
        if (failure === 'cancelled') {
          controller.abort(error);
          options.signal?.throwIfAborted();
        }
        if (failure === 'startup') throw error;
        const startup = createSuccessfulStartupResult();
        startup.client = {
          supportsSessionFork: () => {
            throw error;
          },
        } as never;
        return startup;
      });
      await expect(
        fetchAcpCapabilities(
          'registry',
          'probe-agent',
          createSilentLogger(),
          undefined,
          undefined,
          undefined,
          { signal: controller.signal }
        )
      ).rejects.toBe(error);
      expect(workdir).not.toBe('');
      expect(existsSync(workdir)).toBe(false);
    }
  );

  it('cleans a directory allocated while cancellation was arriving without starting an agent', async () => {
    const controller = new AbortController();
    const error = new Error('cancelled during allocation');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let workdir = '';
    vi.mocked(mkdtemp).mockImplementationOnce(async (prefix) => {
      workdir = await actual.mkdtemp(prefix);
      probeDirectories.add(workdir);
      controller.abort(error);
      return workdir;
    });
    let spawned = false;
    mocks.startLocalAcpAgent.mockImplementation(async () => {
      spawned = true;
      return createSuccessfulStartupResult();
    });
    await expect(
      fetchAcpCapabilities(
        'registry',
        'probe-agent',
        createSilentLogger(),
        undefined,
        undefined,
        undefined,
        { signal: controller.signal }
      )
    ).rejects.toBe(error);
    expect(spawned).toBe(false);
    expect(existsSync(workdir)).toBe(false);
  });

  it('does not fall back to inherited cwd when workspace allocation fails', async () => {
    const error = new Error('temporary directory unavailable');
    vi.mocked(mkdtemp).mockRejectedValueOnce(error);
    let spawned = false;
    mocks.startLocalAcpAgent.mockImplementation(async () => {
      spawned = true;
      return createSuccessfulStartupResult();
    });
    await expect(
      fetchAcpCapabilities('registry', 'probe-agent', createSilentLogger())
    ).rejects.toBe(error);
    expect(spawned).toBe(false);
  });

  it.each([false, true])(
    'preserves the probe outcome when removal fails (startup failure: %s)',
    async (failStartup) => {
      const startupError = new Error('provider authentication required');
      const warnings: string[] = [];
      const logger = createSilentLogger();
      logger.warn = (message) => {
        warnings.push(String(message));
        throw new Error('log sink unavailable');
      };
      const directories: string[] = [];
      mocks.startLocalAcpAgent.mockImplementation(
        async ({ workdir }: StartLocalAcpAgentOptions) => {
          probeDirectories.add(workdir);
          directories.push(workdir);
          if (failStartup) throw startupError;
          return createSuccessfulStartupResult();
        }
      );
      vi.mocked(rm).mockRejectedValueOnce(new Error('workspace busy'));
      const result = fetchAcpCapabilities('registry', 'probe-agent', logger);
      if (failStartup) await expect(result).rejects.toBe(startupError);
      else expect((await result).models.map((model) => model.modelId)).toEqual(['claude-sonnet']);
      expect(warnings).toEqual(['[acp-capabilities] Failed to remove temporary probe workspace']);
      expect(existsSync(directories[0] ?? '')).toBe(true);

      mocks.startLocalAcpAgent.mockImplementation(
        async ({ workdir }: StartLocalAcpAgentOptions) => {
          probeDirectories.add(workdir);
          directories.push(workdir);
          return createSuccessfulStartupResult();
        }
      );
      const retry = await fetchAcpCapabilities('registry', 'probe-agent', logger);
      expect(retry.models.map((model) => model.modelId)).toEqual(['claude-sonnet']);
      expect(directories[1]).not.toBe(directories[0]);
      expect(existsSync(directories[1] ?? '')).toBe(false);
    }
  );

  it('preserves the Codex profile home when credential verification fails', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lody-test-profile-'));
    probeDirectories.add(home);
    await writeFile(path.join(home, 'auth.json'), 'synthetic credentials');
    const codexProfile: CodexProfileExecution = {
      profile: {
        workspaceId: 'workspace',
        machineId: 'machine',
        configId: 'config',
        home,
        authStore: 'codex-default',
        profile: {
          mode: 'api-key',
          profileId: '00000000-0000-4000-8000-000000000001',
          baseUrl: 'https://example.invalid/v1',
        },
      },
    };
    let workdir = '';
    mocks.startLocalAcpAgent.mockImplementation(async (options: StartLocalAcpAgentOptions) => {
      workdir = options.workdir;
      probeDirectories.add(workdir);
      expect(options.codexProfile).toBe(codexProfile);
      expect(workdir).not.toBe(home);
      return createSuccessfulStartupResult();
    });
    await expect(
      fetchAcpCapabilities(
        'builtin',
        'codex',
        createSilentLogger(),
        undefined,
        undefined,
        undefined,
        { codexProfile, verifyCodexCredential: true }
      )
    ).rejects.toThrow('Codex credential verification requires a candidate key');
    expect(existsSync(workdir)).toBe(false);
    expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe('synthetic credentials');
  });

  it('still attempts workspace cleanup if shutdown unexpectedly rejects', async () => {
    let workdir = '';
    const error = new Error('shutdown failed');
    mocks.startLocalAcpAgent.mockImplementation(async (options: StartLocalAcpAgentOptions) => {
      workdir = options.workdir;
      probeDirectories.add(workdir);
      return createSuccessfulStartupResult();
    });
    mocks.shutdownLocalAcpAgent.mockRejectedValueOnce(error);
    await expect(
      fetchAcpCapabilities('registry', 'probe-agent', createSilentLogger())
    ).rejects.toBe(error);
    expect(existsSync(workdir)).toBe(false);
  });

  it('records provider title ownership from the live initialization', async () => {
    const startup = createSuccessfulStartupResult();
    Object.assign(startup.client, { supportsSessionTitleGeneration: () => true });
    mocks.startLocalAcpAgent.mockResolvedValue(startup);
    const result = await fetchAcpCapabilities('custom', 'title-agent', createSilentLogger());
    expect(result.sessionTitle).toBe(true);
  });

  it.each([undefined, { version: 1 }, { version: 1, query: true }])(
    'preserves the initialized quota capability %j',
    async (capability) => {
      const startup = createSuccessfulStartupResult();
      Object.assign(startup.client, { getRateLimitsCapability: () => capability });
      mocks.startLocalAcpAgent.mockResolvedValue(startup);
      const result = await fetchAcpCapabilities('custom', 'quota-agent', createSilentLogger());
      expect(result.rateLimits).toEqual(capability);
    }
  );

  it('records the goal actions the live client advertised', async () => {
    const startupResult = createSuccessfulStartupResult();
    startupResult.client = {
      supportsSessionTitleGeneration: () => false,
      getRateLimitsCapability: () => undefined,
      supportsAcknowledgedSteer: () => false,
      getGoalCapability: () => ({ version: 1, actions: ['pause', 'resume'] }),
    } as never;
    mocks.startLocalAcpAgent.mockResolvedValue(startupResult);

    const result = await fetchAcpCapabilities('registry', 'goal-agent', createSilentLogger());

    expect(result.goalActions).toEqual(['pause', 'resume']);
  });

  it('leaves goal actions absent for a runtime with no goal extension', async () => {
    mocks.startLocalAcpAgent.mockResolvedValue(createSuccessfulStartupResult());

    const result = await fetchAcpCapabilities('registry', 'plain-agent', createSilentLogger());

    expect(result.goalActions).toBeUndefined();
  });

  it('preserves acknowledged steering support discovered from the live client', async () => {
    const startupResult = createSuccessfulStartupResult();
    startupResult.client = {
      supportsSessionTitleGeneration: () => false,
      getRateLimitsCapability: () => undefined,
      supportsAcknowledgedSteer: () => true,
      getGoalCapability: () => undefined,
    } as never;
    mocks.startLocalAcpAgent.mockResolvedValue(startupResult);

    const result = await fetchAcpCapabilities('registry', 'steering-agent', createSilentLogger());

    expect(result.acknowledgedSteer).toBe(true);
  });

  it('uses commands from NewSessionResponse and ignores command update notifications', async () => {
    mocks.startLocalAcpAgent.mockImplementation(async (options) => {
      options.onUpdateMessage({
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: '/late', description: 'Late update' }],
        },
      } as never);
      return createSuccessfulStartupResult({
        sessionId: 'acp-session-1',
        availableCommands: [{ name: '/initial', description: 'Initial response' }],
      });
    });

    const result = await fetchAcpCapabilities('registry', 'response-agent', createSilentLogger());

    expect(result.availableCommands).toEqual([
      { name: '/initial', description: 'Initial response' },
    ]);
  });

  it('preserves an explicit empty command list from NewSessionResponse', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      availableCommands: [],
    });

    const result = await fetchAcpCapabilities('registry', 'response-agent', createSilentLogger());

    expect(result.availableCommands).toEqual([]);
  });

  it('ignores a malformed NewSessionResponse command extension', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      availableCommands: [{ name: 123, description: 'invalid' }],
    });

    const result = await fetchAcpCapabilities('registry', 'response-agent', createSilentLogger());

    expect(result.availableCommands).toBeUndefined();
  });

  it('probes registry agents even when their agent type matches a builtin name', async () => {
    const result = await fetchAcpCapabilities('registry', 'codex', createSilentLogger());

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'registry',
        agentType: 'codex',
      })
    );
    expect(result.models.map((model) => model.modelId)).toEqual(['claude-sonnet']);
  });

  it('probes builtin agents when runtime overrides are set', async () => {
    await fetchAcpCapabilities('builtin', 'codex', createSilentLogger(), undefined, undefined, {
      codexPath: '/tmp/lody-test-codex',
    });

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/tmp/lody-test-codex' },
      })
    );
  });

  it('merges provider env into the capability probe process env', async () => {
    await fetchAcpCapabilities('registry', 'env-agent', createSilentLogger(), {
      ACP_PROVIDER_TOKEN: 'secret-token',
    });

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'registry',
        agentType: 'env-agent',
        env: expect.objectContaining({
          PATH: process.env.PATH,
          ACP_PROVIDER_TOKEN: 'secret-token',
        }),
      })
    );
  });

  it('derives models from a model-category config option when present', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'opus',
          options: [
            { value: 'opus', name: 'Opus' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'config-agent', createSilentLogger());

    expect(result.models).toEqual([
      { modelId: 'opus', name: 'Opus', description: undefined },
      { modelId: 'sonnet', name: 'Sonnet', description: undefined },
    ]);
  });

  it('falls back to the legacy models field for agents without config options', async () => {
    // Agent predating config-option model selection: only the legacy
    // NewSessionResponse.models field, no `model`-category config option.
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }] },
      models: {
        availableModels: [
          { modelId: 'legacy-a', name: 'Legacy A', description: 'first' },
          { modelId: 'legacy-b', name: 'Legacy B' },
        ],
        currentModelId: 'legacy-a',
      },
    });

    const result = await fetchAcpCapabilities('custom', 'legacy-agent', createSilentLogger());

    expect(result.models).toEqual([
      { modelId: 'legacy-a', name: 'Legacy A', description: 'first' },
      { modelId: 'legacy-b', name: 'Legacy B', description: undefined },
    ]);
  });

  it('prefers config-option models over the legacy models field when both exist', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      models: {
        availableModels: [{ modelId: 'legacy-only', name: 'Legacy Only' }],
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'cfg',
          options: [{ value: 'cfg', name: 'Config Model' }],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'hybrid-agent', createSilentLogger());

    expect(result.models).toEqual([
      { modelId: 'cfg', name: 'Config Model', description: undefined },
    ]);
  });

  it('returns no models when neither config options nor the legacy field provide them', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }] },
    });

    const result = await fetchAcpCapabilities('registry', 'modeless-agent', createSilentLogger());

    expect(result.models).toEqual([]);
  });

  // BC-2026-06-24-ACP-CONFIG-OPTION-AGENT-FILTERED: the current version drops
  // the `agent`-id config option returned by acp-extension-claude.
  it('filters out the `agent` config option while keeping the rest', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
        {
          id: 'agent',
          name: 'Agent',
          type: 'select',
          currentValue: 'main',
          options: [{ value: 'main', name: 'Main' }],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'filter-agent', createSilentLogger());

    expect(result.configOptions?.map((opt) => opt.id)).toEqual(['mode']);
  });

  it('returns no config options when only the `agent` option is present', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      configOptions: [
        {
          id: 'agent',
          name: 'Agent',
          type: 'select',
          currentValue: 'main',
          options: [{ value: 'main', name: 'Main' }],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'filter-agent', createSilentLogger());

    expect(result.configOptions).toBeUndefined();
  });
});
