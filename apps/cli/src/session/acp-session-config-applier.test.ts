import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, SessionId } from '@lody/shared';
import type { AgentClient } from '@/agent/agent-client';
import type { Logger } from '@/utils/logger';
import { applyAcpSessionRunConfig } from './acp-session-config-applier';

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
    // A real agent reports back what it accepted, so the fake does too: the
    // applier reads that state rather than echoing the request.
    let currentMode = 'default';
    const setSessionMode = vi.fn(async (_sessionId: string, mode: string) => {
      currentMode = mode;
    });
    const setSessionModel = vi.fn(async () => undefined);
    const setSessionConfigOption = vi.fn(async () => undefined);
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [
        { id: 'permission-mode', category: 'mode', type: 'select', currentValue: currentMode },
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

  it('keeps the requested permission mode when the model switch would reset it', async () => {
    // Claude rebuilds the available permission modes on a model switch and
    // downgrades the current one to `default` when the new model does not
    // support it. Applying the mode before the model therefore loses it — and
    // loses it toward WIDER permissions than the turn asked for.
    let currentMode = 'default';
    let currentModel = 'model-a';
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [
        { id: 'permission-mode', category: 'mode', type: 'select', currentValue: currentMode },
        { id: 'engine', category: 'model', type: 'select', currentValue: currentModel },
      ],
      setSessionMode: vi.fn(async (_sessionId: string, mode: string) => {
        currentMode = mode;
      }),
      unstable_setSessionModel: vi.fn(async (_sessionId: string, model: string) => {
        currentModel = model;
        currentMode = 'default';
      }),
      setSessionConfigOption: vi.fn(async () => undefined),
    } as unknown as AgentClient;

    const result = await applyAcpSessionRunConfig({
      session: {
        sessionId: 'session-8' as SessionId,
        acpSessionId: 'acp-8' as ACPSessionId,
        agentClient,
      },
      config: {
        cliType: 'builtin',
        agentType: 'claude',
        modeId: 'plan',
        modelId: 'model-b',
      },
      logger: createLogger(),
    });

    expect(result.runtimeConfigPatch?.modelId).toBe('model-b');
    expect(result.runtimeConfigPatch?.modeId).toBe('plan');
    expect(result.warningSelections).toEqual([]);
  });

  describe('permission not applied', () => {
    /** An agent whose model switch resets the permission mode to `auto`. */
    const wideningAgent = () => {
      let currentMode = 'auto';
      let currentModel = 'model-a';
      return {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'permission-mode', category: 'mode', type: 'select', currentValue: currentMode },
          { id: 'engine', category: 'model', type: 'select', currentValue: currentModel },
        ],
        setSessionMode: vi.fn(async (_sessionId: string, mode: string) => {
          currentMode = mode;
        }),
        unstable_setSessionModel: vi.fn(async (_sessionId: string, model: string) => {
          currentModel = model;
          currentMode = 'auto';
        }),
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;
    };

    const apply = async (
      config: Parameters<typeof applyAcpSessionRunConfig>[0]['config'],
      agentClient: AgentClient
    ) =>
      await applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-9' as SessionId,
          acpSessionId: 'acp-9' as ACPSessionId,
          agentClient,
        },
        config,
        logger: createLogger(),
      });

    it('reports the escalation when the agent ends up wider than requested', async () => {
      // The agent refuses to stay in plan: `setSessionMode` "succeeds" but its
      // own state says `auto`, which approves without asking a human.
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'permission-mode', category: 'mode', type: 'select', currentValue: 'auto' },
        ],
        setSessionMode: vi.fn(async () => undefined),
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        { cliType: 'builtin', agentType: 'claude', modeId: 'plan' },
        agentClient
      );

      expect(result.permissionEscalation).toEqual({
        controlId: 'permission-mode',
        requestedModeId: 'plan',
        effectiveModeId: 'auto',
      });
    });

    it('does not report one when the agent honors the request', async () => {
      // Same widening agent, but the ordering fix means plan is applied after
      // the model that would have reset it.
      const result = await apply(
        { cliType: 'builtin', agentType: 'claude', modeId: 'plan', modelId: 'model-b' },
        wideningAgent()
      );

      expect(result.runtimeConfigPatch?.modeId).toBe('plan');
      expect(result.permissionEscalation).toBeUndefined();
    });

    it('does not report one on an unconfirmed, narrower, or unranked outcome', async () => {
      // Nothing to compare against: the agent publishes no mode of its own, so
      // the patch carries only our own acknowledgement.
      const silent = {
        isCreated: () => true,
        getConfigOptions: () => [],
        setSessionMode: vi.fn(async () => undefined),
      } as unknown as AgentClient;
      expect(
        (await apply({ cliType: 'builtin', agentType: 'claude', modeId: 'plan' }, silent))
          .permissionEscalation
      ).toBeUndefined();

      // Narrower than requested is a functional mismatch, not an escalation.
      const narrower = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'permission-mode', category: 'mode', type: 'select', currentValue: 'plan' },
        ],
        setSessionMode: vi.fn(async () => undefined),
      } as unknown as AgentClient;
      expect(
        (await apply({ cliType: 'builtin', agentType: 'claude', modeId: 'auto' }, narrower))
          .permissionEscalation
      ).toBeUndefined();

      // A third-party mode Lody does not rank can never be judged wider.
      const unranked = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'permission-mode', category: 'mode', type: 'select', currentValue: 'vendor-mode' },
        ],
        setSessionMode: vi.fn(async () => undefined),
      } as unknown as AgentClient;
      expect(
        (await apply({ cliType: 'registry', agentType: 'other', modeId: 'plan' }, unranked))
          .permissionEscalation
      ).toBeUndefined();
    });

    it('catches a widened explicit _permission selector, not just the mode', async () => {
      // Grok's real permission control is a `_permission` config option, not a
      // mode: `ask` requested, `always-approve` reported.
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          {
            id: 'permission_mode',
            category: '_permission',
            type: 'select',
            currentValue: 'always-approve',
          },
        ],
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'grok',
          configOptionValues: { permission_mode: 'ask' },
        },
        agentClient
      );

      expect(result.permissionEscalation).toEqual({
        controlId: 'permission_mode',
        requestedModeId: 'ask',
        effectiveModeId: 'always-approve',
      });
    });

    it('ranks the remaining builtin permission values', async () => {
      const permissionAgent = (currentValue: string) =>
        ({
          isCreated: () => true,
          getConfigOptions: () => [
            { id: 'permission_mode', category: '_permission', type: 'select', currentValue },
          ],
          setSessionConfigOption: vi.fn(async () => undefined),
        }) as unknown as AgentClient;

      // Grok `ask` → `auto`: approval moves from a human to the model.
      expect(
        (
          await apply(
            {
              cliType: 'builtin',
              agentType: 'grok',
              configOptionValues: { permission_mode: 'ask' },
            },
            permissionAgent('auto')
          )
        ).permissionEscalation
      ).toEqual({ controlId: 'permission_mode', requestedModeId: 'ask', effectiveModeId: 'auto' });

      // DeepSeek Harness `read-only` → `workspace-write`.
      expect(
        (
          await apply(
            {
              cliType: 'builtin',
              agentType: 'deepseek',
              configOptionValues: { permission_mode: 'read-only' },
            },
            permissionAgent('workspace-write')
          )
        ).permissionEscalation
      ).toEqual({
        controlId: 'permission_mode',
        requestedModeId: 'read-only',
        effectiveModeId: 'workspace-write',
      });

      // The other direction is a functional mismatch, not an escalation.
      expect(
        (
          await apply(
            {
              cliType: 'builtin',
              agentType: 'grok',
              configOptionValues: { permission_mode: 'always-approve' },
            },
            permissionAgent('ask')
          )
        ).permissionEscalation
      ).toBeUndefined();
    });

    it('applies an explicit _permission selector after the model', async () => {
      // Same reset hazard as the mode: a model switch must not be able to
      // overwrite the permission the turn asked for.
      let currentPermission = 'always-approve';
      let currentModel = 'model-a';
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          {
            id: 'permission_mode',
            category: '_permission',
            type: 'select',
            currentValue: currentPermission,
          },
          { id: 'engine', category: 'model', type: 'select', currentValue: currentModel },
        ],
        unstable_setSessionModel: vi.fn(async (_sessionId: string, model: string) => {
          currentModel = model;
          currentPermission = 'always-approve';
        }),
        setSessionConfigOption: vi.fn(
          async (_sessionId: string, configId: string, value: unknown) => {
            if (configId === 'permission_mode' && typeof value === 'string') {
              currentPermission = value;
            }
          }
        ),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'grok',
          modelId: 'model-b',
          configOptionValues: { permission_mode: 'ask' },
        },
        agentClient
      );

      expect(result.permissionEscalation).toBeUndefined();
      expect(result.runtimeConfigPatch?.configOptionValues?.['permission_mode']).toBe('ask');
    });

    it('stands down for a _permission escalation the turn accepted', async () => {
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          {
            id: 'permission_mode',
            category: '_permission',
            type: 'select',
            currentValue: 'always-approve',
          },
        ],
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'grok',
          configOptionValues: { permission_mode: 'ask' },
          acceptWiderPermission: {
            controlId: 'permission_mode',
            requestedModeId: 'ask',
            effectiveModeId: 'always-approve',
          },
        },
        agentClient
      );

      expect(result.permissionEscalation).toBeUndefined();
      expect(result.warningSelections).toEqual(['permission_mode="ask"']);
    });

    it('still stops when the agent moved further than what was accepted', async () => {
      // Accepted `plan → auto` after the first stop; by the time the turn
      // re-runs the agent reports `always-approve`. That is a difference the
      // user was never shown, so the acceptance does not cover it.
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          {
            id: 'permission-mode',
            category: 'mode',
            type: 'select',
            currentValue: 'always-approve',
          },
        ],
        setSessionMode: vi.fn(async () => undefined),
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'claude',
          modeId: 'plan',
          acceptWiderPermission: {
            controlId: 'permission-mode',
            requestedModeId: 'plan',
            effectiveModeId: 'auto',
          },
        },
        agentClient
      );

      expect(result.permissionEscalation).toEqual({
        controlId: 'permission-mode',
        requestedModeId: 'plan',
        effectiveModeId: 'always-approve',
      });
    });

    it('still stops on a second permission control the user never saw', async () => {
      // Grok carries both a mode selector and an explicit `_permission` one.
      // Accepting the disclosed one must not wave the other one through.
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'interaction_mode', category: 'mode', type: 'select', currentValue: 'auto' },
          {
            id: 'permission_mode',
            category: '_permission',
            type: 'select',
            currentValue: 'always-approve',
          },
        ],
        setSessionMode: vi.fn(async () => undefined),
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'grok',
          modeId: 'plan',
          configOptionValues: { permission_mode: 'ask' },
          acceptWiderPermission: {
            controlId: 'interaction_mode',
            requestedModeId: 'plan',
            effectiveModeId: 'auto',
          },
        },
        agentClient
      );

      expect(result.permissionEscalation).toEqual({
        controlId: 'permission_mode',
        requestedModeId: 'ask',
        effectiveModeId: 'always-approve',
      });
    });

    it('keeps scanning past the accepted item to the one still undisclosed', async () => {
      // The accepted control is reached FIRST in the apply order, so a skip that
      // ended the scan would let the later mode escalation through.
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'interaction_mode', category: 'mode', type: 'select', currentValue: 'auto' },
          {
            id: 'permission_mode',
            category: '_permission',
            type: 'select',
            currentValue: 'always-approve',
          },
        ],
        setSessionMode: vi.fn(async () => undefined),
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'grok',
          modeId: 'plan',
          configOptionValues: { permission_mode: 'ask' },
          acceptWiderPermission: {
            controlId: 'permission_mode',
            requestedModeId: 'ask',
            effectiveModeId: 'always-approve',
          },
        },
        agentClient
      );

      expect(result.permissionEscalation).toEqual({
        controlId: 'interaction_mode',
        requestedModeId: 'plan',
        effectiveModeId: 'auto',
      });
    });

    it('does not let an acceptance for one control cover the same values on another', async () => {
      // Same `plan → auto` values, different control. Matching on the values
      // alone would silently transfer consent between permission dimensions.
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          {
            id: 'permission_mode',
            category: '_permission',
            type: 'select',
            currentValue: 'auto',
          },
        ],
        setSessionConfigOption: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'grok',
          configOptionValues: { permission_mode: 'plan' },
          acceptWiderPermission: {
            controlId: 'interaction_mode',
            requestedModeId: 'plan',
            effectiveModeId: 'auto',
          },
        },
        agentClient
      );

      expect(result.permissionEscalation).toEqual({
        controlId: 'permission_mode',
        requestedModeId: 'plan',
        effectiveModeId: 'auto',
      });
    });

    it('stands down for a turn that carries the informed acceptance', async () => {
      const agentClient = {
        isCreated: () => true,
        getConfigOptions: () => [
          { id: 'permission-mode', category: 'mode', type: 'select', currentValue: 'auto' },
        ],
        setSessionMode: vi.fn(async () => undefined),
      } as unknown as AgentClient;

      const result = await apply(
        {
          cliType: 'builtin',
          agentType: 'claude',
          modeId: 'plan',
          acceptWiderPermission: {
            controlId: 'permission-mode',
            requestedModeId: 'plan',
            effectiveModeId: 'auto',
          },
        },
        agentClient
      );

      expect(result.permissionEscalation).toBeUndefined();
      // Still reported: accepting the run does not make the mismatch invisible.
      expect(result.warningSelections).toEqual(['mode="plan"']);
    });
  });

  it('reports a selection the agent accepted but dropped from its own state', async () => {
    // The codex shape: `fast-mode` is accepted without error on a model with no
    // fast speed tier, and simply does not come back in the published state, so
    // the turn runs at normal speed with nothing thrown.
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [
        { id: 'model', category: 'model', type: 'select', currentValue: 'gpt-5.2' },
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
        },
      ],
      unstable_setSessionModel: vi.fn(async () => undefined),
      setSessionConfigOption: vi.fn(async () => undefined),
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
          agentType: 'codex',
          modelId: 'gpt-5.2',
          configOptionValues: { reasoning_effort: 'high', 'fast-mode': true },
        },
        logger: createLogger(),
      })
    ).resolves.toEqual({
      // Nothing was rejected, so diagnostics stay empty: the published state is
      // the only evidence Fast is not running.
      rejectedSelections: [],
      warningSelections: ['fast-mode=true'],
      runtimeConfigPatch: {
        acpSessionId: 'acp-3',
        modelId: 'gpt-5.2',
        configOptionValues: { model: 'gpt-5.2', reasoning_effort: 'high' },
      },
    });
  });

  it('stays quiet when a rejected selection was already effective', async () => {
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [
        { id: 'fast', category: 'model_config', type: 'boolean', currentValue: false },
        {
          id: 'effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
        },
      ],
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
          agentType: 'claude',
          configOptionValues: { fast: false, effort: 'low' },
        },
        logger: createLogger(),
      })
    ).resolves.toEqual({
      rejectedSelections: ['fast=false', 'effort="low"'],
      // `fast` already held the requested value, so the rejection changed
      // nothing; `effort` did not, so it is worth saying.
      warningSelections: ['effort="low"'],
      runtimeConfigPatch: {
        acpSessionId: 'acp-6',
        configOptionValues: { fast: false, effort: 'high' },
      },
    });
  });

  it('treats an on/off select and a boolean toggle as the same choice', async () => {
    const agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [
        { id: 'fast', category: 'model_config', type: 'select', currentValue: 'on' },
      ],
      setSessionConfigOption: vi.fn(async () => undefined),
    } as unknown as AgentClient;

    await expect(
      applyAcpSessionRunConfig({
        session: {
          sessionId: 'session-7' as SessionId,
          acpSessionId: 'acp-7' as ACPSessionId,
          agentClient,
        },
        config: { cliType: 'builtin', agentType: 'claude', configOptionValues: { fast: true } },
        logger: createLogger(),
      })
    ).resolves.toEqual({
      rejectedSelections: [],
      warningSelections: [],
      runtimeConfigPatch: { acpSessionId: 'acp-7', configOptionValues: { fast: 'on' } },
    });
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
