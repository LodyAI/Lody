import { describe, expect, it } from 'vitest';
import { DECLARED_MODEL_CAPABILITIES_TTL_MS, resolveAcpModelControls } from '../src/acp-run-config';
import type { AcpCapabilityCacheEntry } from '../src/ai';

const now = 100_000_000;
const source = {
  agentType: 'codex',
  sourceVersion: 'runtime-a',
  modes: [],
  models: [],
  measuredForModelId: 'astra',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: 'astra',
      options: [{ value: 'terra', name: 'Terra' }],
    },
  ],
  modelReasoningEfforts: { terra: ['low', 'high'] },
  declaredModelCapabilities: {
    version: 1 as const,
    receivedAt: now,
    sourceVersion: 'runtime-a',
    models: { astra: { effortValues: ['medium', 'ultra'], fastMode: true } },
  },
} satisfies Partial<AcpCapabilityCacheEntry>;

describe('per-model menu evidence', () => {
  it('uses declarations independently of the snapshot control set', () => {
    expect(resolveAcpModelControls(source, 'astra', now)).toMatchObject({
      effort: { configId: 'reasoning_effort', values: ['medium', 'ultra'] },
      fast: { configId: 'fast-mode', supported: true },
    });
    expect(resolveAcpModelControls(source, 'terra', now)).toMatchObject({
      effort: { values: ['low', 'high'] },
      fast: { supported: undefined },
    });
  });
  it('does not confuse an absent model with an explicit empty supported set', () => {
    expect(resolveAcpModelControls(source, 'future', now).effort?.values).toBeUndefined();
    expect(
      resolveAcpModelControls(
        {
          ...source,
          declaredModelCapabilities: {
            ...source.declaredModelCapabilities,
            models: { astra: { effortValues: [], fastMode: false } },
          },
        },
        'astra',
        now
      )
    ).toMatchObject({ effort: { values: [] }, fast: { supported: false } });
  });
  it('ignores expired and source-mismatched declarations', () => {
    expect(
      resolveAcpModelControls(source, 'astra', now + DECLARED_MODEL_CAPABILITIES_TTL_MS + 1).effort
        ?.values
    ).toBeUndefined();
    expect(
      resolveAcpModelControls({ ...source, sourceVersion: 'runtime-b' }, 'astra', now).fast
        ?.supported
    ).toBeUndefined();
  });
  it('uses each agent wire binding, without guessing for custom agents', () => {
    expect(resolveAcpModelControls({ ...source, agentType: 'claude' }, 'astra', now)).toMatchObject(
      {
        effort: { configId: 'effort' },
        fast: { configId: 'fast' },
      }
    );
    expect(resolveAcpModelControls({ ...source, agentType: 'custom-agent' }, 'astra', now)).toEqual(
      { effort: undefined, fast: undefined }
    );
  });
});
