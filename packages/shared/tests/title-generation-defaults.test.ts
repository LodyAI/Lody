import { describe, expect, it } from 'vitest';
import {
  computeTitleGenerationDefaults,
  getBuiltinTitleGenerationDefaults,
  usesAcpProvidedSessionTitle,
  type AcpConfigOptionSummary,
} from '../src/ai';

const makeOption = (
  id: string,
  category: string | undefined,
  currentValue: string,
  options: Array<{ value: string; name: string }>
): AcpConfigOptionSummary => ({
  id,
  name: id,
  category,
  type: 'select',
  currentValue,
  options: options.map((o) => ({ value: o.value, name: o.name })),
});

describe('computeTitleGenerationDefaults', () => {
  const claudeOptions: AcpConfigOptionSummary[] = [
    makeOption('model', 'model', 'claude-sonnet-4-5-20250514', [
      { value: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5' },
      { value: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { value: 'claude-opus-4-0-20250514', name: 'Claude Opus 4' },
    ]),
    makeOption('mode', 'mode', 'default', [
      { value: 'default', name: 'Default' },
      { value: 'write', name: 'Write' },
      { value: 'plan', name: 'Plan' },
    ]),
  ];

  const codexOptions: AcpConfigOptionSummary[] = [
    makeOption('model', 'model', 'gpt-5.3-codex', [
      { value: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
      { value: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
      { value: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      { value: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
    ]),
    makeOption('mode', 'mode', 'auto', [
      { value: 'auto', name: 'Auto' },
      { value: 'read-only', name: 'Read Only' },
      { value: 'write', name: 'Write' },
    ]),
    makeOption('reasoning_effort', 'thought_level', 'medium', [
      { value: 'high', name: 'High' },
      { value: 'medium', name: 'Medium' },
      { value: 'low', name: 'Low' },
    ]),
  ];

  it('leaves the Claude model at the provider default', () => {
    const result = computeTitleGenerationDefaults('builtin', 'claude', claudeOptions);
    expect(result).not.toHaveProperty('model');
  });

  it('selects the least-privileged mode for claude', () => {
    const result = computeTitleGenerationDefaults('builtin', 'claude', claudeOptions);
    expect(result['mode']).toBe('plan');
  });

  it('leaves the Codex model at the provider default', () => {
    const result = computeTitleGenerationDefaults('builtin', 'codex', codexOptions);
    expect(result).not.toHaveProperty('model');
  });

  it('selects read-only mode for codex when available', () => {
    const result = computeTitleGenerationDefaults('builtin', 'codex', codexOptions);
    expect(result['mode']).toBe('read-only');
  });

  it('selects low reasoning_effort for codex', () => {
    const result = computeTitleGenerationDefaults('builtin', 'codex', codexOptions);
    expect(result['reasoning_effort']).toBe('low');
  });

  it('does not infer model preference from option order for registry agents', () => {
    const options: AcpConfigOptionSummary[] = [
      makeOption('amp-mode', 'model', 'medium', [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'ultra', name: 'Ultra' },
      ]),
    ];
    const result = computeTitleGenerationDefaults('registry', 'custom-agent', options);
    expect(result).not.toHaveProperty('amp-mode');

    options[0] = makeOption('amp-mode', 'model', 'medium', [
      { value: 'ultra', name: 'Ultra' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
      { value: 'medium', name: 'Medium' },
    ]);
    expect(computeTitleGenerationDefaults('registry', 'custom-agent', options)).not.toHaveProperty(
      'amp-mode'
    );
  });

  it('treats Interactive Claude as a registry provider, not a builtin default source', () => {
    const result = computeTitleGenerationDefaults('registry', 'claude-p', claudeOptions);
    expect(result).not.toHaveProperty('model');
    expect(result['mode']).toBe('plan');
  });

  it('leaves unknown mode and reasoning vocabularies unchanged', () => {
    const options: AcpConfigOptionSummary[] = [
      makeOption('permission', 'mode', 'balanced', [
        { value: 'balanced', name: 'Balanced' },
        { value: 'trusted', name: 'Trusted' },
      ]),
      makeOption('depth', 'thought_level', 'standard', [
        { value: 'standard', name: 'Standard' },
        { value: 'deep', name: 'Deep' },
      ]),
    ];

    expect(computeTitleGenerationDefaults('registry', 'custom-agent', options)).toEqual({});
  });

  it('does not recognize known words embedded inside unknown values', () => {
    const options: AcpConfigOptionSummary[] = [
      makeOption('permission', 'mode', 'balanced', [
        { value: 'autonomous', name: 'Autonomous' },
        { value: 'planner', name: 'Planner' },
      ]),
      makeOption('depth', 'thought_level', 'standard', [
        { value: 'shallow', name: 'Shallow' },
        { value: 'highlighted', name: 'Highlighted' },
      ]),
    ];

    expect(computeTitleGenerationDefaults('registry', 'custom-agent', options)).toEqual({});
  });

  it('returns empty object for empty configOptions', () => {
    const result = computeTitleGenerationDefaults('builtin', 'claude', []);
    expect(result).toEqual({});
  });
});

describe('getBuiltinTitleGenerationDefaults', () => {
  it('does not provide static defaults to compatibility callers', () => {
    expect(getBuiltinTitleGenerationDefaults('claude')).toBeUndefined();
  });
});

describe('usesAcpProvidedSessionTitle', () => {
  it('uses the builtin Claude ACP title', () => {
    expect(usesAcpProvidedSessionTitle('builtin', 'claude')).toBe(true);
  });

  it('keeps isolated title generation for other providers', () => {
    expect(usesAcpProvidedSessionTitle('builtin', 'codex')).toBe(false);
    expect(usesAcpProvidedSessionTitle('builtin', 'kimi')).toBe(false);
    expect(usesAcpProvidedSessionTitle('registry', 'codex')).toBe(false);
    expect(usesAcpProvidedSessionTitle('custom', 'claude')).toBe(false);
  });
});
