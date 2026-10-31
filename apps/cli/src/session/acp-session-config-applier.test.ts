import { describe, expect, it } from 'vitest';
import { Deferred, Effect, Fiber } from 'effect';
import type { ACPSessionId, AcpConfigOptionValue } from '@lody/shared';
import { AcpConfiguration, AcpConfigurationError } from '@/agent/acp-configuration';
import { getAcpRuntimeConfigPatchFromOptions } from '@/lib/acp/runtime-config';
import { applyAcpSessionRunConfig, type AcpSessionRunConfig } from './acp-session-config-applier';

const createAgent = (
  behavior: { reject?: string; ignore?: string; resetEffort?: boolean } = {}
) => {
  const state: Record<string, AcpConfigOptionValue> = {
    mode: 'default',
    model: 'old',
    effort: 'low',
    plan_mode: true,
  };
  const options = () =>
    Object.entries(state).map(([id, value]) => ({
      id,
      name: id,
      category: id === 'mode' || id === 'model' ? id : undefined,
      ...(typeof value === 'boolean'
        ? { type: 'boolean' as const, currentValue: value }
        : { type: 'select' as const, currentValue: value, options: [] }),
    }));
  const select = (id: string, value: AcpConfigOptionValue) =>
    Effect.suspend(() => {
      if (behavior.reject === id) return Effect.fail(new AcpConfigurationError(id, 'rejected'));
      if (behavior.ignore !== id) state[id] = value;
      if (behavior.resetEffort && (id === 'mode' || id === 'model')) state.effort = 'low';
      if (behavior.resetEffort && id === 'mode') state.model = 'old';
      return Effect.void;
    });
  const service = AcpConfiguration.of({
    options: options(),
    read: Effect.sync(() => ({
      ...getAcpRuntimeConfigPatchFromOptions('agent' as ACPSessionId, options()),
      generation: 'connection',
      state: 'ready' as const,
    })),
    setMode: (value) => select('mode', value),
    setModel: (value) => select('model', value),
    setOption: select,
  });
  const run = (config: AcpSessionRunConfig) =>
    Effect.runPromise(
      applyAcpSessionRunConfig(config).pipe(Effect.provideService(AcpConfiguration, service))
    );
  return { state, service, run };
};

describe('applyAcpSessionRunConfig', () => {
  it.each<AcpSessionRunConfig>([
    { configOptionValues: { effort: 'max', model: 'new', mode: 'worker' } },
    { configOptionValues: { mode: 'worker', effort: 'max', model: 'new' } },
    { configOptionValues: { model: 'new', mode: 'worker', effort: 'max' } },
    { modelId: 'new', configOptionValues: { effort: 'max', mode: 'worker' } },
    { modeId: 'worker', configOptionValues: { effort: 'max', model: 'new' } },
  ])(
    'applies mode/model before dependent choices regardless of dictionary order: %j',
    async (config) => {
      const agent = createAgent({ resetEffort: true });
      const confirmed = await agent.run(config);
      expect(agent.state).toEqual({ mode: 'worker', model: 'new', effort: 'max', plan_mode: true });
      expect(confirmed.configOptionValues).toEqual(agent.state);
    }
  );

  it('uses the scalar mode/model requirements once when the input contains both representations', async () => {
    const agent = createAgent();
    expect(
      await agent.run({
        modeId: 'agent',
        modelId: 'new',
        configOptionValues: {
          mode: 'ignored',
          model: 'ignored',
          effort: 'high',
        },
      })
    ).toMatchObject({ modeId: 'agent', modelId: 'new', configOptionValues: { effort: 'high' } });
  });

  it.each(['codex', 'claude', 'custom'])(
    'fails rejected Plan for %s and retains confirmed partial state',
    async (agentType) => {
      const agent = createAgent({ reject: 'plan_mode' });
      await expect(
        agent.run({
          agentType,
          modelId: 'new',
          configOptionValues: {
            plan_mode: false,
            effort: 'max',
          },
        })
      ).rejects.toMatchObject({ field: 'plan_mode', reason: 'rejected' });
      expect(agent.state).toEqual({
        mode: 'default',
        model: 'new',
        effort: 'low',
        plan_mode: true,
      });
    }
  );

  it.each(['mode', 'model', 'effort'])(
    'fails when %s is acknowledged but the final snapshot contradicts it',
    async (field) => {
      const agent = createAgent({ ignore: field });
      await expect(
        agent.run({ configOptionValues: { [field]: 'requested' } })
      ).rejects.toMatchObject({
        field,
        reason: 'unconfirmed',
      });
      expect(agent.state[field]).not.toBe('requested');
    }
  );

  it('does not expose requested secret values or provider payloads in the public error', async () => {
    const agent = createAgent({ reject: 'api_token' });
    const failure = await agent
      .run({ configOptionValues: { api_token: 'private-value' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpConfigurationError);
    expect(String(failure)).toContain('api_token');
    expect(String(failure)).not.toContain('private-value');
  });

  it('preserves explicit false and an omitted field without filling defaults', async () => {
    const agent = createAgent();
    expect(await agent.run({ configOptionValues: { plan_mode: false } })).toMatchObject({
      configOptionValues: { plan_mode: false, model: 'old', effort: 'low' },
    });
  });

  it('interruption during model application prevents subsequent options', async () => {
    const agent = createAgent();
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const wait = yield* Deferred.make<void>();
        const service = {
          ...agent.service,
          setModel: () =>
            Effect.gen(function* () {
              agent.state.model = 'new';
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(wait);
            }),
        };
        const fiber = yield* applyAcpSessionRunConfig({
          modelId: 'new',
          configOptionValues: { effort: 'max' },
        }).pipe(Effect.provideService(AcpConfiguration, service), Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(agent.state).toMatchObject({ model: 'new', effort: 'low' });
      })
    );
  });
});
