// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AcpCapabilityCacheEntry } from '@lody/shared';

import { capabilityModels } from '../src/components/harness/device-capabilities';

/**
 * The Models page's pool is the machine's ACP capability entry, folded into
 * plain rows. What these cases pin: a model select's options beat the flat
 * `models` list (the select is the newer, richer answer), option groups become
 * the page's provider groups, and model `_meta`/`description` is what the row
 * may show — no tiers or windows are invented for it.
 */
const entry = (overrides: Partial<AcpCapabilityCacheEntry>): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'sorbet',
  modes: [],
  models: [],
  fetchedAt: 0,
  ...overrides,
});

describe('capabilityModels', () => {
  it('lists the probe models with their own names and meta', () => {
    const models = capabilityModels(
      entry({
        models: [
          {
            modelId: 'anthropic/claude-opus-4-5',
            name: 'Claude Opus 4.5',
            description: 'Most capable',
            _meta: { contextWindow: 200000 },
          },
          { modelId: 'openai/gpt-5-mini', name: 'GPT-5 mini' },
        ],
      })
    );

    expect(models).toEqual([
      {
        id: 'anthropic/claude-opus-4-5',
        name: 'Claude Opus 4.5',
        group: undefined,
        meta: '200K',
      },
      { id: 'openai/gpt-5-mini', name: 'GPT-5 mini', group: undefined, meta: undefined },
    ]);
  });

  it('prefers the model configOption, carrying its groups through', () => {
    const models = capabilityModels(
      entry({
        models: [{ modelId: 'legacy/flat', name: 'Flat' }],
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'kimi-k2',
            options: [
              { value: 'kimi-k2', name: 'Kimi K2', group: 'Moonshot' },
              { value: 'deepseek-chat', name: 'DeepSeek Chat', group: 'DeepSeek' },
            ],
          },
        ],
      })
    );

    expect(models.map((model) => model.id)).toEqual(['kimi-k2', 'deepseek-chat']);
    expect(models[0]?.group).toBe('Moonshot');
  });

  it('is empty when the entry advertises nothing', () => {
    expect(capabilityModels(undefined)).toEqual([]);
    expect(capabilityModels(entry({}))).toEqual([]);
  });
});
