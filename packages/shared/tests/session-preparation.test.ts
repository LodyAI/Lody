import { describe, expect, it } from 'vitest';
import {
  buildSessionPreparationClaimKey,
  buildSessionPreparationRequestKey,
  buildSessionPreparationRunConfig,
  normalizeSessionPreparationRunConfigForDedup,
} from '../src/session-preparation';
import type { AgentConfigId } from '../src/ids';

describe('session preparation run config', () => {
  it('keeps current non-sensitive selections and omits secret-shaped option ids', () => {
    expect(
      buildSessionPreparationRunConfig({
        modeId: ' agent ',
        modelId: ' model-a ',
        configOptionValues: {
          effort: 'high',
          fast: true,
          API_KEY: 'private',
          bearerToken: 'private',
        },
      })
    ).toEqual({
      modeId: 'agent',
      modelId: 'model-a',
      configOptionValues: {
        effort: 'high',
        fast: true,
      },
    });
  });

  it('normalizes option order for preparation identity', () => {
    expect(
      normalizeSessionPreparationRunConfigForDedup({
        modelId: 'model-a',
        configOptionValues: { zeta: true, alpha: 'high' },
      })
    ).toEqual([
      null,
      'model-a',
      [
        ['alpha', 'high'],
        ['zeta', true],
      ],
    ]);
  });

  it('keeps the Task tool gate in preparation and dedup identity', () => {
    const enabled = buildSessionPreparationRunConfig({ taskToolsEnabled: true });

    expect(enabled).toEqual({ taskToolsEnabled: true });
    expect(normalizeSessionPreparationRunConfigForDedup(enabled)).toEqual([null, null, null, true]);
    expect(buildSessionPreparationRunConfig({ taskToolsEnabled: false })).toBeUndefined();
  });

  it('separates Schedule-enabled preparation from both plain and Task-only Agent instances', () => {
    const enabled = buildSessionPreparationRunConfig({ scheduleToolsEnabled: true });
    expect(enabled).toEqual({ scheduleToolsEnabled: true });
    expect(normalizeSessionPreparationRunConfigForDedup(enabled)).not.toEqual(
      normalizeSessionPreparationRunConfigForDedup({})
    );
    expect(normalizeSessionPreparationRunConfigForDedup(enabled)).not.toEqual(
      normalizeSessionPreparationRunConfigForDedup({ taskToolsEnabled: true })
    );
    expect(buildSessionPreparationRunConfig({ scheduleToolsEnabled: false })).toBeUndefined();
  });

  it('omits an empty selection', () => {
    expect(
      buildSessionPreparationRunConfig({
        modeId: ' ',
        modelId: null,
        configOptionValues: { auth_token: 'private' },
      })
    ).toBeUndefined();
  });

  it('includes run configuration in request dedup but not durable claim identity', () => {
    const identity = {
      requestedByUserId: 'user-1',
      agentConfigId: 'agent-1' as AgentConfigId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      project: {
        kind: 'github' as const,
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      },
    };
    const first = {
      ...identity,
      runConfig: {
        modelId: 'model-a',
        configOptionValues: { effort: 'high', fast: true },
      },
    };
    const reordered = {
      ...identity,
      runConfig: {
        modelId: 'model-a',
        configOptionValues: { fast: true, effort: 'high' },
      },
    };
    const changed = {
      ...identity,
      runConfig: {
        modelId: 'model-b',
        configOptionValues: { effort: 'high', fast: true },
      },
    };

    expect(buildSessionPreparationRequestKey(first)).toBe(
      buildSessionPreparationRequestKey(reordered)
    );
    expect(buildSessionPreparationRequestKey(first)).not.toBe(
      buildSessionPreparationRequestKey(changed)
    );
    expect(buildSessionPreparationClaimKey(first)).toBe(buildSessionPreparationClaimKey(changed));
  });
});
