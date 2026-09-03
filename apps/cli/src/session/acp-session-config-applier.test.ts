import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, AcpConfigOptionValue, SessionId } from '@lody/shared';
import type { AgentClient } from '@/agent/agent-client';
import type { Logger } from '@/utils/logger';
import { applyAcpSessionRunConfig } from './acp-session-config-applier';

type SessionConfigCall = {
  method: 'unstable_setSessionModel' | 'setSessionConfigOption';
  configId?: string;
  value: AcpConfigOptionValue;
};

const CURSOR_STYLE_PARAMETER_OPTIONS = [
  {
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: 'model-a',
    options: [
      { name: 'Model A', value: 'model-a' },
      { name: 'Model B', value: 'model-b' },
    ],
  },
  {
    id: 'thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'false',
    options: [
      { name: 'On', value: 'true' },
      { name: 'Off', value: 'false' },
    ],
  },
  {
    id: 'fast',
    type: 'select',
    currentValue: 'false',
    options: [
      { name: 'On', value: 'true' },
      { name: 'Off', value: 'false' },
    ],
  },
] as const;

function createOrderedAgentClient(args?: {
  setSessionModel?: (sessionId: ACPSessionId, modelId: string) => Promise<void>;
}): { agentClient: AgentClient; calls: SessionConfigCall[] } {
  const calls: SessionConfigCall[] = [];
  const agentClient = {
    isCreated: () => true,
    getConfigOptions: () => [...CURSOR_STYLE_PARAMETER_OPTIONS],
    unstable_setSessionModel: async (sessionId: ACPSessionId, modelId: string) => {
      calls.push({ method: 'unstable_setSessionModel', value: modelId });
      await args?.setSessionModel?.(sessionId, modelId);
    },
    setSessionConfigOption: async (
      _sessionId: ACPSessionId,
      configId: string,
      value: AcpConfigOptionValue
    ) => {
      calls.push({ method: 'setSessionConfigOption', configId, value });
    },
  } as unknown as AgentClient;
  return { agentClient, calls };
}

function createLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as Logger;
  vi.mocked(logger.child).mockReturnValue(logger);
  return logger;
}

describe('applyAcpSessionRunConfig', () => {
  it('applies mode, model, and remaining options to an established ACP session', async () => {
    const setSessionMode = vi.fn(async () => undefined);
    const setSessionModel = vi.fn(async () => undefined);
    const setSessionConfigOption = vi.fn(async () => undefined);
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [
        { id: 'permission-mode', category: 'mode', type: 'select', currentValue: 'default' },
        { id: 'engine', category: 'model', type: 'select', currentValue: 'model-a' },
        { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high' },
      ],
      setSessionMode,
      unstable_setSessionModel: setSessionModel,
      setSessionConfigOption,
    } as unknown as AgentClient;

    await expect(
      applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-1' as SessionId,
          acpSessionId: 'acp-1' as ACPSessionId,
          agentClient,
        },
        config: {
          modeId: 'agent',
          modelId: 'model-a',
          configOptionValues: {
            'permission-mode': 'ignored-duplicate',
            engine: 'ignored-duplicate',
            effort: 'high',
          },
        },
        logger: createLogger(),
      })
    ).resolves.toEqual({
      rejectedSelections: [],
      warningSelections: [],
      runtimeConfigPatch: {
        acpSessionId: 'acp-1',
        modeId: 'agent',
        modelId: 'model-a',
        configOptionValues: {
          'permission-mode': 'agent',
          engine: 'model-a',
          effort: 'high',
        },
      },
    });

    expect(setSessionMode).toHaveBeenCalledWith('acp-1', 'agent');
    expect(setSessionModel).toHaveBeenCalledWith('acp-1', 'model-a');
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(setSessionConfigOption).toHaveBeenCalledWith('acp-1', 'effort', 'high');
  });

  it('redacts sensitive values in logs and preserves rejected selections', async () => {
    const logger = createLogger();
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [],
      setSessionConfigOption: vi.fn(async () => {
        throw new Error('rejected');
      }),
    } as unknown as AgentClient;

    await expect(
      applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-2' as SessionId,
          acpSessionId: 'acp-2' as ACPSessionId,
          agentClient,
        },
        config: {
          configOptionValues: {
            api_token: 'private-value',
          },
        },
        logger,
      })
    ).resolves.toEqual({
      rejectedSelections: ['api_token=<redacted>'],
      warningSelections: ['api_token=<redacted>'],
      runtimeConfigPatch: { acpSessionId: 'acp-2', configOptionValues: {} },
    });

    expect(vi.mocked(logger.debug).mock.calls.flat().join('\n')).not.toContain('private-value');
  });

  it.each(['codex', 'claude'])(
    'suppresses known %s run-config mismatch warnings while retaining rejection diagnostics',
    async (agentType) => {
      const reject = vi.fn(async () => {
        throw new Error('rejected');
      });
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'effort', category: 'thought_level' },
          { id: 'fast', category: 'fast-mode' },
          { id: 'collaboration_mode', category: 'collaboration_mode' },
          { id: 'custom-option', category: 'custom' },
        ],
        setSessionMode: reject,
        unstable_setSessionModel: reject,
        setSessionConfigOption: reject,
      } as unknown as AgentClient;

      await expect(
        applyAcpSessionRunConfig({
          session: {
            sessionId: 'session-3' as SessionId,
            acpSessionId: 'acp-3' as ACPSessionId,
            agentClient,
          },
          config: {
            cliType: 'builtin',
            agentType,
            modeId: 'plan',
            modelId: 'model-a',
            configOptionValues: {
              effort: 'high',
              fast: false,
              collaboration_mode: 'plan',
              'custom-option': 'enabled',
            },
          },
          logger: createLogger(),
        })
      ).resolves.toEqual({
        rejectedSelections: [
          'mode="plan"',
          'model="model-a"',
          'effort="high"',
          'fast=false',
          'collaboration_mode="plan"',
          'custom-option="enabled"',
        ],
        warningSelections: ['custom-option="enabled"'],
        runtimeConfigPatch: { acpSessionId: 'acp-3', configOptionValues: {} },
      });
    }
  );

  it('keeps known run-config rejection warnings for other agents', async () => {
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [{ id: 'reasoning_effort', category: 'thought_level' }],
      unstable_setSessionModel: vi.fn(async () => {
        throw new Error('rejected');
      }),
      setSessionConfigOption: vi.fn(async () => {
        throw new Error('rejected');
      }),
    } as unknown as AgentClient;

    await expect(
      applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-4' as SessionId,
          acpSessionId: 'acp-4' as ACPSessionId,
          agentClient,
        },
        config: {
          cliType: 'registry',
          agentType: 'other-agent',
          modelId: 'model-a',
          configOptionValues: { reasoning_effort: 'high' },
        },
        logger: createLogger(),
      })
    ).resolves.toEqual({
      rejectedSelections: ['model="model-a"', 'reasoning_effort="high"'],
      warningSelections: ['model="model-a"', 'reasoning_effort="high"'],
      runtimeConfigPatch: { acpSessionId: 'acp-4', configOptionValues: {} },
    });
  });

  it('keeps non-plan mode rejection warnings for Codex and Claude', async () => {
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [],
      setSessionMode: vi.fn(async () => {
        throw new Error('rejected');
      }),
    } as unknown as AgentClient;

    await expect(
      applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-5' as SessionId,
          acpSessionId: 'acp-5' as ACPSessionId,
          agentClient,
        },
        config: {
          cliType: 'builtin',
          agentType: 'codex',
          modeId: 'agent-full-access',
        },
        logger: createLogger(),
      })
    ).resolves.toEqual({
      rejectedSelections: ['mode="agent-full-access"'],
      warningSelections: ['mode="agent-full-access"'],
      runtimeConfigPatch: { acpSessionId: 'acp-5', configOptionValues: {} },
    });
  });

  it('applies a config-option model before per-model options even when the model key is last', async () => {
    const { agentClient, calls } = createOrderedAgentClient();

    await applyAcpSessionRunConfig({
      session: {
        sessionId: 'session-6' as SessionId,
        acpSessionId: 'acp-6' as ACPSessionId,
        agentClient,
      },
      config: {
        configOptionValues: {
          thinking: 'true',
          fast: 'true',
          model: 'model-b',
        },
      },
      logger: createLogger(),
    });

    const firstCall = calls[0];
    expect(firstCall).toEqual({ method: 'unstable_setSessionModel', value: 'model-b' });
    const optionCalls = calls.filter((call) => call.method === 'setSessionConfigOption');
    const modelCallIndex = calls.findIndex((call) => call.method === 'unstable_setSessionModel');
    expect(
      optionCalls.every((call) => {
        const callIndex = calls.indexOf(call);
        return callIndex > modelCallIndex && call.configId !== 'model';
      })
    ).toBe(true);
    expect(optionCalls.filter((call) => call.configId === 'thinking')).toEqual([
      { method: 'setSessionConfigOption', configId: 'thinking', value: 'true' },
    ]);
    expect(optionCalls.filter((call) => call.configId === 'fast')).toEqual([
      { method: 'setSessionConfigOption', configId: 'fast', value: 'true' },
    ]);
  });

  it('applies an explicit modelId once before per-model options and does not resend the model option', async () => {
    const { agentClient, calls } = createOrderedAgentClient();

    await applyAcpSessionRunConfig({
      session: {
        sessionId: 'session-7' as SessionId,
        acpSessionId: 'acp-7' as ACPSessionId,
        agentClient,
      },
      config: {
        modelId: 'model-b',
        configOptionValues: {
          model: 'model-b',
          thinking: 'true',
        },
      },
      logger: createLogger(),
    });

    expect(calls.filter((call) => call.method === 'unstable_setSessionModel')).toEqual([
      { method: 'unstable_setSessionModel', value: 'model-b' },
    ]);
    expect(calls[0]).toEqual({ method: 'unstable_setSessionModel', value: 'model-b' });
    const thinkingCallIndex = calls.findIndex(
      (call) => call.method === 'setSessionConfigOption' && call.configId === 'thinking'
    );
    expect(thinkingCallIndex).toBeGreaterThan(0);
    expect(calls[thinkingCallIndex]).toEqual({
      method: 'setSessionConfigOption',
      configId: 'thinking',
      value: 'true',
    });
    expect(
      calls.some((call) => call.method === 'setSessionConfigOption' && call.configId === 'model')
    ).toBe(false);
  });

  it('keeps a failed config-option model switch debug-only and still applies remaining options', async () => {
    const { agentClient, calls } = createOrderedAgentClient({
      setSessionModel: async () => {
        throw new Error('model switch rejected');
      },
    });

    await expect(
      applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-8' as SessionId,
          acpSessionId: 'acp-8' as ACPSessionId,
          agentClient,
        },
        config: {
          configOptionValues: {
            thinking: 'true',
            fast: 'true',
            model: 'model-b',
          },
        },
        logger: createLogger(),
      })
    ).resolves.toMatchObject({
      rejectedSelections: [],
      warningSelections: [],
    });

    expect(calls.filter((call) => call.method === 'unstable_setSessionModel')).toEqual([
      { method: 'unstable_setSessionModel', value: 'model-b' },
    ]);
    expect(calls.filter((call) => call.method === 'setSessionConfigOption')).toEqual([
      { method: 'setSessionConfigOption', configId: 'thinking', value: 'true' },
      { method: 'setSessionConfigOption', configId: 'fast', value: 'true' },
    ]);
  });
});
