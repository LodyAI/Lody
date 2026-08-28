import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { fetchAcpCapabilities } from './acp-capabilities';
import { AcpAuthenticationRequiredError } from './agent-client';

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

function createSuccessfulStartupResult(sessionResponse?: Record<string, unknown>) {
  return {
    agentProcess: {} as never,
    client: {
      supportsAcknowledgedSteer: () => false,
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
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('uses the current working directory for capability probing', async () => {
    const result = await fetchAcpCapabilities('registry', 'probe-agent', createSilentLogger());

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'registry',
        agentType: 'probe-agent',
        workdir: process.cwd(),
      })
    );
    expect(result.availableCommands).toEqual([{ name: '/help', description: 'Help' }]);
  });

  it('preserves acknowledged steering support discovered from the live client', async () => {
    const startupResult = createSuccessfulStartupResult();
    startupResult.client = {
      supportsAcknowledgedSteer: () => true,
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
