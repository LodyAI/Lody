import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, AcpConfigOptionValue, SessionId } from '@lody/shared';
import type { AcpModeSetEvidence, AgentClient } from '@/agent/agent-client';
import type { Logger } from '@/utils/logger';
import {
  AcpRunConfigSafetyError,
  applyAcpSessionRunConfig,
  type AcpSessionRunConfig,
} from './acp-session-config-applier';

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

type FakeOption = {
  id: string;
  category?: string;
  type: string;
  currentValue: AcpConfigOptionValue;
};

/**
 * A stateful stand-in for an ACP agent seen through AgentClient: options carry
 * current values, every agent report bumps the report generation, and hooks
 * reproduce agent behaviour such as rebuilding permission modes on a model switch.
 */
class FakeAgent {
  readonly calls: string[] = [];
  generation = 0;
  lastReportedModeId: string | undefined;
  /** How `setSessionMode` answers: a full option list, a bare set_mode ack, or nothing. */
  modeAnswer: 'config-response' | 'set-mode-ack' | 'empty' = 'config-response';
  /** Mode ids the agent refuses to switch to (it keeps its current mode). */
  refusedModes = new Set<string>();
  onModelSwitch: (agent: FakeAgent, modelId: string) => void = () => undefined;
  onModeSet: (agent: FakeAgent) => void = () => undefined;

  constructor(public options: FakeOption[]) {}

  value(id: string): AcpConfigOptionValue | undefined {
    return this.options.find((option) => option.id === id)?.currentValue;
  }

  /** The agent reports new state on its own, as a notification would. */
  report(id: string, value: AcpConfigOptionValue): void {
    this.options = this.options.map((option) =>
      option.id === id ? { ...option, currentValue: value } : option
    );
    this.generation += 1;
  }

  client(): AgentClient {
    return {
      isCreated: () => true,
      getConfigOptions: () => this.options,
      getAgentStateReportGeneration: () => this.generation,
      getLastReportedModeId: () => this.lastReportedModeId,
      unstable_setSessionModel: async (_: ACPSessionId, modelId: string) => {
        this.calls.push(`model=${modelId}`);
        this.report(this.options.find((o) => o.category === 'model')?.id ?? 'model', modelId);
        this.onModelSwitch(this, modelId);
      },
      setSessionConfigOption: async (_: ACPSessionId, id: string, value: AcpConfigOptionValue) => {
        this.calls.push(`${id}=${String(value)}`);
        if (!this.options.some((option) => option.id === id)) throw new Error('unknown option');
        this.report(id, value);
        return this.options.map((option) => ({ ...option }));
      },
      setSessionMode: async (_: ACPSessionId, modeId: string): Promise<AcpModeSetEvidence> => {
        this.calls.push(`mode=${modeId}`);
        const modeOption = this.options.find((option) => option.category === 'mode');
        if (!this.refusedModes.has(modeId)) {
          if (modeOption) this.report(modeOption.id, modeId);
          else this.lastReportedModeId = modeId;
        }
        this.onModeSet(this);
        if (this.modeAnswer === 'set-mode-ack') return { kind: 'set-mode-ack' };
        if (this.modeAnswer === 'empty') return { kind: 'none' };
        return {
          kind: 'config-response',
          modeId: this.options.find((option) => option.category === 'mode')?.currentValue,
        };
      },
    } as unknown as AgentClient;
  }
}

const claudeOptions = (): FakeOption[] => [
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'default' },
  { id: 'model', category: 'model', type: 'select', currentValue: 'opus' },
  { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high' },
];

const apply = (agent: FakeAgent, config: AcpSessionRunConfig) =>
  applyAcpSessionRunConfig({
    session: {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient: agent.client(),
    },
    config: { cliType: 'builtin', agentType: 'claude', ...config },
    logger: createLogger(),
  });

describe('applyAcpSessionRunConfig ordering and safety', () => {
  it('sets permission after the model, so a model switch cannot silently widen it', async () => {
    const agent = new FakeAgent(claudeOptions());
    // Claude downgrades a mode the new model lacks to `default` on a switch.
    agent.onModelSwitch = (fake) => fake.report('mode', 'default');

    const result = await apply(agent, {
      modeId: 'plan',
      modelId: 'sonnet',
      configOptionValues: { effort: 'medium' },
    });

    expect(agent.calls).toEqual(['model=sonnet', 'effort=medium', 'mode=plan']);
    expect(agent.value('mode')).toBe('plan');
    expect(result.runtimeConfigPatch).toMatchObject({ modeId: 'plan', modelId: 'sonnet' });
    expect(result.warningSelections).toEqual([]);
  });

  it('stops the turn when the agent reports a wider mode than the one requested', async () => {
    const agent = new FakeAgent(claudeOptions());
    agent.refusedModes.add('plan');

    await expect(apply(agent, { modeId: 'plan' })).rejects.toThrow(AcpRunConfigSafetyError);
    await expect(apply(agent, { modeId: 'plan' })).rejects.toThrow(
      /mode requested plan, agent reports default/
    );
  });

  it('stops the turn when a non-restrictive request lands on a wider mode', async () => {
    const agent = new FakeAgent(claudeOptions());
    agent.report('mode', 'bypassPermissions');
    agent.refusedModes.add('default');

    await expect(apply(agent, { modeId: 'default' })).rejects.toThrow(
      /mode requested default, agent reports bypassPermissions/
    );
  });

  it('does not take an empty acknowledgement as confirmation of a restrictive mode', async () => {
    // The agent's list already says `plan` (a stale value) but the setting
    // itself returned nothing to confirm it.
    const agent = new FakeAgent(claudeOptions());
    agent.report('mode', 'plan');
    agent.modeAnswer = 'empty';

    await expect(apply(agent, { modeId: 'plan' })).rejects.toThrow(/no confirmed state/);
  });

  it('lets a report after the setting contradict a confirmed Plan', async () => {
    const agent = new FakeAgent([
      ...claudeOptions(),
      { id: 'plan_mode', type: 'boolean', currentValue: false },
    ]);
    // Plan is confirmed first; a report arriving while the mode is set turns it off.
    agent.onModeSet = (fake) => fake.report('plan_mode', false);

    await expect(
      apply(agent, { modeId: 'default', configOptionValues: { plan_mode: true } })
    ).rejects.toThrow(/plan_mode requested true, agent reports false/);
  });

  it('accepts a set_mode acknowledgement from an agent that reports no mode state', async () => {
    const agent = new FakeAgent([
      { id: 'model', category: 'model', type: 'select', currentValue: 'gpt-6' },
    ]);
    agent.modeAnswer = 'set-mode-ack';

    const result = await apply(agent, { agentType: 'codex', modeId: 'read-only' });

    expect(result.runtimeConfigPatch?.modeId).toBe('read-only');
  });

  it('re-sends an inherited permission after this turn switched model', async () => {
    const agent = new FakeAgent(claudeOptions());
    agent.report('mode', 'plan');
    agent.onModelSwitch = (fake) => fake.report('mode', 'default');

    await apply(agent, { modelId: 'sonnet', inheritedSafetyIntent: { modeId: 'plan' } });

    expect(agent.calls).toEqual(['model=sonnet', 'mode=plan']);
    expect(agent.value('mode')).toBe('plan');
  });

  it('leaves an inherited permission alone when the agent already reports it', async () => {
    const agent = new FakeAgent(claudeOptions());
    agent.report('mode', 'plan');

    await apply(agent, {
      configOptionValues: { effort: 'low' },
      inheritedSafetyIntent: { modeId: 'plan' },
    });

    expect(agent.calls).toEqual(['effort=low']);
  });

  it('warns instead of failing when a non-restrictive mode lands on an incomparable one', async () => {
    const agent = new FakeAgent(claudeOptions());
    agent.refusedModes.add('acceptEdits');
    agent.report('mode', 'auto');

    const result = await apply(agent, { modeId: 'acceptEdits' });

    expect(result.warningSelections).toEqual(['mode requested acceptEdits, agent reports auto']);
  });
});

describe('applyAcpSessionRunConfig rejections', () => {
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
    'suppresses known %s model, effort and Fast mismatch warnings while retaining diagnostics',
    async (agentType) => {
      const reject = vi.fn(async () => {
        throw new Error('rejected');
      });
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'effort', category: 'thought_level' },
          { id: 'fast', category: 'fast-mode' },
          { id: 'custom-option', category: 'custom' },
        ],
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
            modelId: 'model-a',
            configOptionValues: {
              effort: 'high',
              fast: false,
              'custom-option': 'enabled',
            },
          },
          logger: createLogger(),
        })
      ).resolves.toEqual({
        rejectedSelections: [
          'model="model-a"',
          'effort="high"',
          'fast=false',
          'custom-option="enabled"',
        ],
        warningSelections: ['custom-option="enabled"'],
        runtimeConfigPatch: { acpSessionId: 'acp-3', configOptionValues: {} },
      });
    }
  );

  it('fails closed when a requested Plan cannot be set', async () => {
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
          sessionId: 'session-6' as SessionId,
          acpSessionId: 'acp-6' as ACPSessionId,
          agentClient,
        },
        config: {
          cliType: 'builtin',
          agentType: 'codex',
          configOptionValues: { collaboration_mode: 'plan' },
        },
        logger: createLogger(),
      })
    ).rejects.toThrow(AcpRunConfigSafetyError);
  });

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

  it('warns when a non-restrictive mode cannot be set', async () => {
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [],
      setSessionMode: vi.fn(async () => {
        throw new Error('rejected');
      }),
    } as unknown as AgentClient;

    const result = await applyAcpSessionRunConfig({
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
    });

    expect(result.warningSelections).toEqual([
      'mode requested agent-full-access, agent reports no confirmed state',
    ]);
  });
});
