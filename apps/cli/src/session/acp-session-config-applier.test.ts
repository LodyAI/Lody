import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, SessionId } from '@lody/shared';
import type { AgentClient } from '@/agent/agent-client';
import type { Logger } from '@/utils/logger';
import { applyAcpSessionRunConfig } from './acp-session-config-applier';

function createLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    trace: vi.fn(),
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
    const options = [
      { id: 'permission-mode', category: 'mode', type: 'select', currentValue: 'default' },
      { id: 'engine', category: 'model', type: 'select', currentValue: 'model-b' },
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low' },
    ];
    const select = async (configId: string, value: string) => {
      const option = options.find((candidate) => candidate.id === configId);
      if (!option || value === 'ignored-duplicate') throw new Error('Invalid selection');
      option.currentValue = value;
    };
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => options,
      setSessionMode: async (_sessionId: string, value: string) => select('permission-mode', value),
      unstable_setSessionModel: async (_sessionId: string, value: string) =>
        select('engine', value),
      setSessionConfigOption: async (_sessionId: string, configId: string, value: string) =>
        select(configId, value),
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
    'exposes %s model rejection while suppressing effort, Fast, and Plan warnings',
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
        warningSelections: ['model="model-a"', 'custom-option="enabled"'],
        runtimeConfigPatch: { acpSessionId: 'acp-3', configOptionValues: {} },
      });
    }
  );

  it.each(
    ['codex', 'claude', 'other-agent'].flatMap((agentType) =>
      ['modelId', 'configOptionValues'].map((source) => ({ agentType, source }))
    )
  )(
    'reports $agentType model rejection from $source and retains the active model',
    async ({ agentType, source }) => {
      const options = [
        { id: 'engine', category: 'model', type: 'select', currentValue: 'active-model' },
      ];
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => options,
        unstable_setSessionModel: async () => {
          throw new Error('Requested model is unavailable');
        },
      } as unknown as AgentClient;

      const result = await applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-model-rejection' as SessionId,
          acpSessionId: 'acp-model-rejection' as ACPSessionId,
          agentClient,
        },
        config: {
          agentType,
          ...(source === 'modelId'
            ? { modelId: 'requested-model', configOptionValues: { engine: 'duplicate-model' } }
            : { configOptionValues: { engine: 'requested-model' } }),
        },
        logger: createLogger(),
      });

      expect(result).toEqual({
        rejectedSelections: ['model="requested-model"'],
        warningSelections: ['model="requested-model"'],
        runtimeConfigPatch: {
          acpSessionId: 'acp-model-rejection',
          modelId: 'active-model',
          configOptionValues: { engine: 'active-model' },
        },
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
});
