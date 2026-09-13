import { describe, expect, it } from 'vitest';
import {
  computeTitleGenerationDefaults,
  getBuiltinTitleGenerationDefaults,
  acpOwnsSessionTitleGeneration,
  trustsUntaggedAcpSessionTitle,
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

describe('acpOwnsSessionTitleGeneration', () => {
  it('lets the builtin Claude, Codex and Grok adapters generate their own titles', () => {
    expect(acpOwnsSessionTitleGeneration('builtin', 'claude')).toBe(true);
    expect(acpOwnsSessionTitleGeneration('builtin', 'codex')).toBe(true);
    expect(acpOwnsSessionTitleGeneration('builtin', 'grok')).toBe(true);
  });

  it('keeps isolated title generation for adapters without ACP title support', () => {
    expect(acpOwnsSessionTitleGeneration('builtin', 'kimi')).toBe(false);
    expect(acpOwnsSessionTitleGeneration('builtin', 'deepseek')).toBe(false);
    expect(acpOwnsSessionTitleGeneration('builtin', 'bub')).toBe(false);
  });

  // The table describes each agent's managed runtime. An override can aim the
  // same agentType at an older executable with no title behaviour, and such a
  // session would otherwise get no title at all -- generator skipped, nothing
  // pushed, and the setting that would fix it hidden.
  it('gives ownership back to the local generator when a runtime is overridden', () => {
    expect(acpOwnsSessionTitleGeneration('builtin', 'codex', { codexPath: '/opt/old-codex' })).toBe(
      false
    );
    expect(acpOwnsSessionTitleGeneration('builtin', 'grok', { grokPath: '/opt/old-grok' })).toBe(
      false
    );
    expect(
      acpOwnsSessionTitleGeneration('builtin', 'claude', { claudeCodeExecutable: '/opt/old' })
    ).toBe(false);
  });

  it('ignores an override object with no usable value', () => {
    expect(acpOwnsSessionTitleGeneration('builtin', 'codex', {})).toBe(true);
    expect(acpOwnsSessionTitleGeneration('builtin', 'codex', { codexPath: '  ' })).toBe(true);
  });

  it('never applies to registry, custom, or unknown agents', () => {
    expect(acpOwnsSessionTitleGeneration('registry', 'codex')).toBe(false);
    expect(acpOwnsSessionTitleGeneration('custom', 'claude')).toBe(false);
    expect(acpOwnsSessionTitleGeneration('builtin', 'not-an-agent')).toBe(false);
  });
});

describe('trustsUntaggedAcpSessionTitle', () => {
  // Claude and Grok both publish a bare session_info_update with no _meta.
  it('trusts the builtin adapters that publish titles without a titleSource tag', () => {
    expect(trustsUntaggedAcpSessionTitle('builtin', 'claude')).toBe(true);
    expect(trustsUntaggedAcpSessionTitle('builtin', 'grok')).toBe(true);
  });

  // Codex tags every title and emits a first-prompt `fallback` preview before its
  // generated `explicit` one. Trusting untagged titles here would promote that
  // preview to the session title, so it must stay outside this set even though it
  // does own its title generation.
  it('does not trust Codex titles that lack an explicit titleSource', () => {
    expect(acpOwnsSessionTitleGeneration('builtin', 'codex')).toBe(true);
    expect(trustsUntaggedAcpSessionTitle('builtin', 'codex')).toBe(false);
  });

  // The trusted set is a subset of the owning set by construction, not by two
  // lists kept in sync; assert the relation rather than restating the members.
  it('never trusts an agent that does not own its title generation', () => {
    for (const agentType of ['claude', 'codex', 'grok', 'kimi', 'deepseek', 'nope']) {
      if (trustsUntaggedAcpSessionTitle('builtin', agentType)) {
        expect(acpOwnsSessionTitleGeneration('builtin', agentType)).toBe(true);
      }
    }
  });

  it('never applies to registry or custom providers', () => {
    expect(trustsUntaggedAcpSessionTitle('registry', 'claude')).toBe(false);
    expect(trustsUntaggedAcpSessionTitle('custom', 'claude')).toBe(false);
  });
});
