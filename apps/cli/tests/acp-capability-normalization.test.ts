import { describe, expect, it } from 'vitest';

import {
  normalizeAcpSessionCapabilities,
  readLegacySessionModelState,
} from '@/agent/acp-capability-normalization';

/**
 * Shape of a Codex `NewSessionResponse`: `configOptions` describe only the model
 * that is current right now, while the legacy `models.availableModels` list
 * carries every `model[effort]` combination the agent supports.
 */
const codexSessionResponse = {
  modes: { availableModes: [{ id: 'agent', name: 'Agent' }] },
  models: {
    currentModelId: 'gpt-5.6-sol[xhigh]',
    availableModels: [
      { modelId: 'gpt-5.6-sol[low]', name: 'GPT-5.6-Sol (low)' },
      { modelId: 'gpt-5.6-sol[xhigh]', name: 'GPT-5.6-Sol (xhigh)' },
      { modelId: 'gpt-5.4-mini[low]', name: 'GPT-5.4-Mini (low)' },
    ],
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: 'gpt-5.6-sol',
      options: [
        { value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
        { value: 'gpt-5.4-mini', name: 'GPT-5.4-Mini' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: 'low',
      // Only the current model's efforts.
      options: [
        { value: 'low', name: 'Low' },
        { value: 'xhigh', name: 'XHigh' },
      ],
    },
  ],
};

describe('ACP capability normalization', () => {
  it('reads the complete legacy model state used for model switching', () => {
    expect(readLegacySessionModelState(codexSessionResponse)).toEqual({
      currentModelId: 'gpt-5.6-sol[xhigh]',
      availableModels: [
        {
          modelId: 'gpt-5.6-sol[low]',
          name: 'GPT-5.6-Sol (low)',
          description: undefined,
        },
        {
          modelId: 'gpt-5.6-sol[xhigh]',
          name: 'GPT-5.6-Sol (xhigh)',
          description: undefined,
        },
        {
          modelId: 'gpt-5.4-mini[low]',
          name: 'GPT-5.4-Mini (low)',
          description: undefined,
        },
      ],
    });
  });

  it('recovers per-model reasoning efforts the config options cannot express', () => {
    const capabilities = normalizeAcpSessionCapabilities(codexSessionResponse);

    // configOptions still win for the model list itself (clean model ids).
    expect(capabilities.models.map((model) => model.modelId)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.4-mini',
    ]);
    // ...and the legacy combination list becomes the model-independent view,
    // so a caller selecting gpt-5.4-mini can be told it has no `xhigh`.
    expect(capabilities.modelReasoningEfforts).toEqual({
      'gpt-5.6-sol': ['low', 'xhigh'],
      'gpt-5.4-mini': ['low'],
    });
  });

  it('omits the breakdown for agents that do not publish model/effort combinations', () => {
    const capabilities = normalizeAcpSessionCapabilities({
      modes: { availableModes: [] },
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

    expect(capabilities.modelReasoningEfforts).toBeUndefined();
    expect(capabilities.models.map((model) => model.modelId)).toEqual(['opus', 'sonnet']);
  });

  it('preserves acknowledged steering support discovered from the live client', () => {
    const capabilities = normalizeAcpSessionCapabilities(
      { modes: { availableModes: [] } },
      { acknowledgedSteer: true }
    );

    expect(capabilities.acknowledgedSteer).toBe(true);
  });
});
