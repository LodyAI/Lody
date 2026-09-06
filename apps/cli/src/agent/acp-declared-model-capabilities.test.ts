import { describe, expect, it } from 'vitest';
import {
  findDeclaredEffortValues,
  findDeclaredFastModeSupport,
  summarizeAgentRunConfigCapabilities,
  DECLARED_MODEL_CAPABILITIES_TTL_MS,
  type AcpCapabilityCacheEntry,
} from '@lody/shared';

import { normalizeAcpSessionCapabilities } from './acp-capability-normalization';

/** A `session/new` response shaped like Codex's, carrying the Lody declaration. */
const sessionResponse = (models: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: 'gpt-5.2',
      options: [
        { value: 'gpt-5.2', name: 'GPT-5.2' },
        { value: 'gpt-5.6-luna', name: 'Luna' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
      ],
    },
  ],
  _meta: { lody: { modelCapabilities: { version: 1, models, ...extra } } },
});

const entryOf = (
  response: ReturnType<typeof sessionResponse>,
  receivedAt = 1_000
): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'codex',
  modes: [],
  models: [],
  fetchedAt: receivedAt,
  ...normalizeAcpSessionCapabilities(response, { receivedAt }),
});

describe('declared model capabilities', () => {
  const declared = {
    'gpt-5.2': { effortValues: ['low', 'medium'], fastMode: false },
    'gpt-5.6-luna': { effortValues: ['low', 'medium', 'high', 'xhigh'], fastMode: true },
  };

  it('answers for a model the snapshot never described', () => {
    // The probe ran on gpt-5.2, which has no fast tier, so `configOptions`
    // carries no fast toggle at all. That is the exact case where the snapshot
    // knows nothing and the declaration does.
    const entry = entryOf(sessionResponse(declared));

    expect(entry.measuredForModelId).toBe('gpt-5.2');
    expect(findDeclaredFastModeSupport(entry, 'gpt-5.6-luna', 1_000)).toBe(true);
    expect(findDeclaredFastModeSupport(entry, 'gpt-5.2', 1_000)).toBe(false);
    expect(findDeclaredEffortValues(entry, 'gpt-5.6-luna', 1_000)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('says nothing about a model the agent did not name', () => {
    const entry = entryOf(sessionResponse(declared));
    // Unknown, not unsupported: a declaration answers only for what it lists.
    expect(findDeclaredFastModeSupport(entry, 'gpt-6-unreleased', 1_000)).toBeUndefined();
  });

  it('stops speaking once stale or heard under another adapter version', () => {
    const entry = entryOf(sessionResponse(declared));
    const stale = 1_000 + DECLARED_MODEL_CAPABILITIES_TTL_MS + 1;
    expect(findDeclaredFastModeSupport(entry, 'gpt-5.6-luna', stale)).toBeUndefined();

    // Same data, but the declaration was heard under a different adapter build.
    const moved: AcpCapabilityCacheEntry = {
      ...entry,
      sourceVersion: 'codex@2',
      declaredModelCapabilities: entry.declaredModelCapabilities
        ? { ...entry.declaredModelCapabilities, sourceVersion: 'codex@1' }
        : undefined,
    };
    expect(findDeclaredFastModeSupport(moved, 'gpt-5.6-luna', 1_000)).toBeUndefined();
  });

  it('reports fast mode for the agent once any model declares it', () => {
    // The MCP create-options summary used to answer from the probed model's
    // snapshot alone, so an agent whose default model lacks fast published
    // `fastMode: false` for every model it has.
    const entry = entryOf(sessionResponse(declared));
    const summary = summarizeAgentRunConfigCapabilities(entry, 1_000);

    expect(summary.fastMode).toBe(true);
    expect(summary.measuredForModelId).toBe('gpt-5.2');
    expect(
      summary.models.find((model) => model.id === 'gpt-5.6-luna')?.reasoningEffortValues
    ).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('ignores a declaration it cannot trust, whole rather than in part', () => {
    // Unknown version, and a catalog past the bound. Half a catalog would answer
    // "no fast mode" for models the agent simply could not fit.
    const wrongVersion = {
      ...sessionResponse(declared),
      _meta: { lody: { modelCapabilities: { version: 2, models: declared } } },
    };
    expect(entryOf(wrongVersion).declaredModelCapabilities).toBeUndefined();

    const oversized = Object.fromEntries(
      Array.from({ length: 65 }, (_unused, index) => [`model-${index}`, { fastMode: true }])
    );
    expect(entryOf(sessionResponse(oversized)).declaredModelCapabilities).toBeUndefined();

    const noMeta = { ...sessionResponse(declared), _meta: undefined };
    expect(entryOf(noMeta).declaredModelCapabilities).toBeUndefined();
  });
});
