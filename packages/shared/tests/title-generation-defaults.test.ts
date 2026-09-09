import { describe, expect, it } from 'vitest';
import {
  computeTitleGenerationDefaults,
  getBuiltinTitleGenerationDefaults,
  resolveSessionAgentIdentity,
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

  it('selects the last-listed model for claude', () => {
    const result = computeTitleGenerationDefaults('builtin', 'claude', claudeOptions);
    expect(result['model']).toBe('claude-opus-4-0-20250514');
  });

  it('selects the least-privileged mode for claude', () => {
    const result = computeTitleGenerationDefaults('builtin', 'claude', claudeOptions);
    expect(result['mode']).toBe('plan');
  });

  it('selects the last-listed codex model', () => {
    const result = computeTitleGenerationDefaults('builtin', 'codex', codexOptions);
    expect(result['model']).toBe('gpt-5.3-codex-spark');
  });

  it('selects read-only mode for codex when available', () => {
    const result = computeTitleGenerationDefaults('builtin', 'codex', codexOptions);
    expect(result['mode']).toBe('read-only');
  });

  it('selects low reasoning_effort for codex', () => {
    const result = computeTitleGenerationDefaults('builtin', 'codex', codexOptions);
    expect(result['reasoning_effort']).toBe('low');
  });

  it('uses the last-listed model when no static preferred option exists', () => {
    const noHaikuOptions: AcpConfigOptionSummary[] = [
      makeOption('model', 'model', 'claude-sonnet-4-5-20250514', [
        { value: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5' },
        { value: 'claude-opus-4-0-20250514', name: 'Claude Opus 4' },
      ]),
    ];
    const result = computeTitleGenerationDefaults('builtin', 'claude', noHaikuOptions);
    expect(result['model']).toBe('claude-opus-4-0-20250514');
  });

  it('uses the same runtime selection for other ACP agents', () => {
    const options: AcpConfigOptionSummary[] = [
      makeOption('model', 'model', 'some-model', [
        { value: 'some-model', name: 'Some Model' },
        { value: 'other-model', name: 'Other Model' },
      ]),
    ];
    const result = computeTitleGenerationDefaults('registry', 'custom-agent', options);
    expect(result['model']).toBe('other-model');
  });

  it('treats Interactive Claude as a registry provider, not a builtin default source', () => {
    const result = computeTitleGenerationDefaults('registry', 'claude-p', claudeOptions);
    expect(result['model']).toBe('claude-opus-4-0-20250514');
    expect(result['mode']).toBe('plan');
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

describe('resolveSessionAgentIdentity', () => {
  it('keeps current builtin/registry/custom encodings', () => {
    expect(resolveSessionAgentIdentity('builtin', 'claude')).toEqual({
      cliType: 'builtin',
      agentType: 'claude',
    });
    expect(resolveSessionAgentIdentity('registry', 'codex')).toEqual({
      cliType: 'registry',
      agentType: 'codex',
    });
  });

  it('maps pre-#1221 agentType-only Claude/Codex to builtin', () => {
    expect(resolveSessionAgentIdentity(undefined, 'claude')).toEqual({
      cliType: 'builtin',
      agentType: 'claude',
    });
    expect(resolveSessionAgentIdentity('', 'codex')).toEqual({
      cliType: 'builtin',
      agentType: 'codex',
    });
  });

  it('maps transitional cliType=claude|codex with no agentType to builtin', () => {
    expect(resolveSessionAgentIdentity('claude', undefined)).toEqual({
      cliType: 'builtin',
      agentType: 'claude',
    });
    expect(resolveSessionAgentIdentity('codex', '')).toEqual({
      cliType: 'builtin',
      agentType: 'codex',
    });
  });

  it('maps both-legacy encodings to builtin using agentType', () => {
    expect(resolveSessionAgentIdentity('claude', 'codex')).toEqual({
      cliType: 'builtin',
      agentType: 'codex',
    });
  });

  it('returns null for unknown or incomplete identities', () => {
    expect(resolveSessionAgentIdentity(undefined, undefined)).toBeNull();
    expect(resolveSessionAgentIdentity('builtin', '')).toBeNull();
    expect(resolveSessionAgentIdentity('kimi', undefined)).toBeNull();
  });
});
