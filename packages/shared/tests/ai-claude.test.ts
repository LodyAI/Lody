import { describe, expect, it } from 'vitest';

import { getStaticBuiltinAcpCapabilities } from '../src/ai';

describe('builtin Claude shared contract', () => {
  it('exposes version-agnostic Claude models for first render', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'claude');

    expect(capabilities?.modes.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'default', name: 'Manual' },
      { id: 'acceptEdits', name: 'Accept Edits' },
      { id: 'plan', name: 'Plan Mode' },
      { id: 'dontAsk', name: "Don't Ask" },
      { id: 'bypassPermissions', name: 'Bypass Permissions' },
    ]);
    expect(capabilities?.models).toEqual([
      {
        modelId: 'default',
        name: 'Default (recommended)',
        description: 'Opus (1M context)',
      },
      {
        modelId: 'opus[1m]',
        name: 'Opus (1M context)',
        description: 'Opus with 1M context · Best for everyday, complex tasks',
      },
      {
        modelId: 'claude-fable-5-1[1m]',
        name: 'Fable',
        description: 'Fable · Most capable for your hardest and longest-running tasks',
      },
      {
        modelId: 'sonnet',
        name: 'Sonnet',
        description: 'Sonnet · Efficient for routine tasks',
      },
      {
        modelId: 'haiku',
        name: 'Haiku',
        description: 'Haiku · Fastest for quick answers',
      },
    ]);
  });

  it('keeps static Claude model labels free of hardcoded versions', () => {
    // Static labels are provisional first-render copy; exact versions arrive
    // from the runtime probe. A hardcoded version here goes stale on every
    // runtime bump that skips the static sync.
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'claude');
    const texts = (capabilities?.models ?? []).flatMap((model) => [
      model.name ?? '',
      model.description ?? '',
    ]);
    expect(texts.filter((text) => /\d+\.\d+/.test(text))).toEqual([]);
  });

  it('matches the default model config options exposed to boolean-capable clients', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'claude');
    const options = capabilities?.configOptions ?? [];

    expect(options.map((option) => option.id)).toEqual(['mode', 'model', 'effort', 'fast']);
    expect(
      options.find((option) => option.id === 'effort')?.options.map(({ value }) => value)
    ).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(options.find((option) => option.id === 'fast')).toEqual({
      id: 'fast',
      name: 'Fast mode',
      description: 'Faster responses on supported models',
      category: 'model_config',
      type: 'boolean',
      currentValue: false,
      options: [],
    });
  });
});
