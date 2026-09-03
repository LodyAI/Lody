import { describe, expect, it } from 'vitest';

import {
  deriveModelReasoningEffortsFromLegacyModelIds,
  isAcpOnOffSelectValues,
  isAcpToggleSelectEnabledValue,
  isAcpTrueFalseSelectValues,
  resolveAcpConfigOptionsForModel,
  resolveAcpTargetModelId,
  resolveAgentRunConfigSelection,
  summarizeAgentRunConfigCapabilities,
  toggleAcpSelectOptionValue,
  type AcpCapabilityCacheEntry,
  type AcpConfigOptionSummary,
} from '../src';

/** Codex-shaped agent: reasoning effort, a boolean fast toggle, and collaboration mode. */
const codexCapability = (): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'codex',
  modes: [],
  models: [],
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'agent',
      options: [
        { value: 'agent', name: 'Agent' },
        { value: 'read-only', name: 'Read-only' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
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
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'fast-mode',
      name: 'Fast mode',
      category: 'model_config',
      type: 'boolean',
      currentValue: false,
      options: [],
    },
    {
      id: 'collaboration_mode',
      name: 'Collaboration mode',
      category: 'collaboration_mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ],
  fetchedAt: 1,
});

/** Claude-shaped agent: `effort` by category, `fast` toggle, planning as a permission mode. */
const claudeCapability = (): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'claude',
  modes: [],
  models: [],
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'auto',
      options: [
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan Mode' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'opus', name: 'Opus' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'fast',
      name: 'Fast',
      category: 'model_config',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
  ],
  fetchedAt: 1,
});

describe('agent run config selection', () => {
  it('maps the semantic selection onto Codex option ids', () => {
    expect(
      resolveAgentRunConfigSelection(
        {
          modelId: 'gpt-5.4-mini',
          reasoningEffort: 'high',
          fastMode: true,
          planMode: true,
        },
        codexCapability()
      )
    ).toEqual({
      modelId: 'gpt-5.4-mini',
      configOptionValues: {
        reasoning_effort: 'high',
        'fast-mode': true,
        collaboration_mode: 'plan',
      },
      // This agent published no per-model breakdown, and the selection switches
      // away from the probed model, so effort/fast cannot be checked offline.
      validatedConfigIds: ['reasoning_effort'],
      unverifiedSelections: ['reasoningEffort=high', 'fastMode=true'],
    });
  });

  it('turns toggles off with the value shape the option declares', () => {
    expect(
      resolveAgentRunConfigSelection({ fastMode: false, planMode: false }, codexCapability())
    ).toEqual({
      configOptionValues: { 'fast-mode': false, collaboration_mode: 'default' },
    });
  });

  it('rejects a plan-mode option that is not the collaboration_mode select', () => {
    /* Codex publishes exactly one plan shape. An on/off option under some other
       id is not plan mode, so the request must fail loudly rather than run with
       planning silently off. */
    const other = codexCapability();
    other.configOptions = other.configOptions?.map((option) =>
      option.id === 'collaboration_mode'
        ? {
            ...option,
            id: 'plan-mode',
            category: 'plan-mode',
            currentValue: 'off',
            options: [
              { value: 'off', name: 'Off' },
              { value: 'on', name: 'On' },
            ],
          }
        : option
    );
    expect(() => resolveAgentRunConfigSelection({ planMode: true }, other)).toThrow(
      'does not offer a plan mode'
    );
  });

  it('selects the plan permission mode for agents without a plan toggle', () => {
    expect(
      resolveAgentRunConfigSelection(
        { reasoningEffort: 'high', fastMode: true, planMode: true },
        claudeCapability()
      )
    ).toEqual({
      modeId: 'plan',
      configOptionValues: { effort: 'high', fast: 'on' },
    });
  });

  it('leaves the mode alone when a mode-based plan agent is asked not to plan', () => {
    expect(resolveAgentRunConfigSelection({ planMode: false }, claudeCapability())).toEqual({});
  });

  it('rejects controls the agent does not offer instead of running with other settings', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...codexCapability(),
      configOptions: [],
    };
    expect(() => resolveAgentRunConfigSelection({ reasoningEffort: 'high' }, capability)).toThrow(
      /does not offer a reasoning effort option/
    );
    expect(() => resolveAgentRunConfigSelection({ fastMode: true }, capability)).toThrow(
      /does not offer a fast mode option/
    );
    expect(() => resolveAgentRunConfigSelection({ planMode: true }, capability)).toThrow(
      /does not offer a plan mode/
    );
  });

  it('refuses to select anything when the agent has reported no capabilities', () => {
    expect(() => resolveAgentRunConfigSelection({ modelId: 'gpt-5.4-mini' }, undefined)).toThrow(
      /ACP capabilities are unavailable/
    );
    expect(resolveAgentRunConfigSelection({}, undefined)).toEqual({});
    expect(resolveAgentRunConfigSelection(undefined, codexCapability())).toEqual({});
  });

  it('summarizes what a caller may choose per agent', () => {
    expect(summarizeAgentRunConfigCapabilities(codexCapability())).toEqual({
      models: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini' },
      ],
      reasoningEffortValues: ['low', 'medium', 'high'],
      measuredForModelId: 'gpt-5.6-sol',
      fastMode: true,
      planMode: true,
    });
    expect(summarizeAgentRunConfigCapabilities(claudeCapability()).planMode).toBe(true);
    expect(summarizeAgentRunConfigCapabilities(undefined)).toEqual({
      models: [],
      reasoningEffortValues: [],
      fastMode: false,
      planMode: false,
    });
  });

  it('reports effort per model when the agent published the breakdown', () => {
    const summary = summarizeAgentRunConfigCapabilities({
      ...codexCapability(),
      modelReasoningEfforts: {
        'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh'],
        'gpt-5.4-mini': ['low', 'medium'],
      },
    });

    expect(summary.models).toEqual([
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        reasoningEffortValues: ['low', 'medium', 'high', 'xhigh'],
      },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini', reasoningEffortValues: ['low', 'medium'] },
    ]);
    // The flat list still describes only the probed model.
    expect(summary.measuredForModelId).toBe('gpt-5.6-sol');
  });

  it('validates effort against the model being selected, not the probed one', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...codexCapability(),
      modelReasoningEfforts: {
        'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh'],
        'gpt-5.4-mini': ['low', 'medium'],
      },
    };

    // `xhigh` is absent from the probed model's snapshot options but valid for
    // the model being selected: it must be accepted and marked pre-validated so
    // the caller's snapshot check does not reject it.
    expect(
      resolveAgentRunConfigSelection(
        { modelId: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
        capability
      )
    ).toEqual({
      modelId: 'gpt-5.6-sol',
      configOptionValues: { reasoning_effort: 'xhigh' },
      validatedConfigIds: ['reasoning_effort'],
    });

    // Valid for the probed model, unsupported by the target model.
    expect(() =>
      resolveAgentRunConfigSelection(
        { modelId: 'gpt-5.4-mini', reasoningEffort: 'high' },
        capability
      )
    ).toThrow(/Invalid reasoning effort for model gpt-5\.4-mini.*Allowed values: low, medium/s);
  });

  it('flags selections it cannot verify offline instead of pretending they hold', () => {
    // No per-model breakdown: a model switch makes effort and fast unverifiable.
    const resolved = resolveAgentRunConfigSelection(
      { modelId: 'gpt-5.4-mini', reasoningEffort: 'high', fastMode: true },
      codexCapability()
    );

    expect(resolved.unverifiedSelections).toEqual(['reasoningEffort=high', 'fastMode=true']);
    expect(resolved.configOptionValues).toEqual({
      reasoning_effort: 'high',
      'fast-mode': true,
    });

    // Staying on the probed model keeps the snapshot authoritative.
    expect(
      resolveAgentRunConfigSelection({ reasoningEffort: 'high', fastMode: true }, codexCapability())
        .unverifiedSelections
    ).toBeUndefined();
  });

  it('recovers the per-model effort breakdown from a legacy model[effort] list', () => {
    expect(
      deriveModelReasoningEffortsFromLegacyModelIds([
        'gpt-5.6-sol[low]',
        'gpt-5.6-sol[high]',
        'gpt-5.6-sol[high]',
        'gpt-5.4-mini[low]',
      ])
    ).toEqual({
      'gpt-5.6-sol': ['low', 'high'],
      'gpt-5.4-mini': ['low'],
    });
    expect(deriveModelReasoningEffortsFromLegacyModelIds(['opus', 'sonnet'])).toBeUndefined();
    expect(deriveModelReasoningEffortsFromLegacyModelIds([])).toBeUndefined();
  });

  it('falls back to legacy modes/models when the agent reports no config options', () => {
    const legacy: AcpCapabilityCacheEntry = {
      cliType: 'builtin',
      agentType: 'kimi',
      modes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
      models: [{ modelId: 'k2', name: 'Kimi K2' }],
      fetchedAt: 1,
    };
    expect(summarizeAgentRunConfigCapabilities(legacy)).toEqual({
      models: [{ id: 'k2', name: 'Kimi K2' }],
      reasoningEffortValues: [],
      fastMode: false,
      planMode: true,
    });
    expect(resolveAgentRunConfigSelection({ planMode: true }, legacy)).toEqual({ modeId: 'plan' });
  });

  it('recognises a true/false fast select and writes those advertised values', () => {
    const capability: AcpCapabilityCacheEntry = {
      cliType: 'custom',
      agentType: 'cursor',
      modes: [],
      models: [],
      configOptions: [
        {
          id: 'fast',
          name: 'Fast',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'true', name: 'On' },
            { value: 'false', name: 'Off' },
          ],
        },
      ],
      fetchedAt: 1,
    };

    expect(summarizeAgentRunConfigCapabilities(capability).fastMode).toBe(true);
    expect(resolveAgentRunConfigSelection({ fastMode: true }, capability)).toEqual({
      configOptionValues: { fast: 'true' },
    });
    expect(resolveAgentRunConfigSelection({ fastMode: false }, capability)).toEqual({
      configOptionValues: { fast: 'false' },
    });
  });
});

const modelSelect = (currentValue = 'a'): AcpConfigOptionSummary => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue,
  options: [
    { value: 'a', name: 'A' },
    { value: 'b', name: 'B' },
    { value: 'c', name: 'C' },
  ],
});

const modeSelect = (): AcpConfigOptionSummary => ({
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'agent',
  options: [{ value: 'agent', name: 'Agent' }],
});

const thinkingSelect = (): AcpConfigOptionSummary => ({
  id: 'thinking',
  name: 'Thinking',
  category: 'thought_level',
  type: 'select',
  currentValue: 'false',
  options: [
    { value: 'true', name: 'On' },
    { value: 'false', name: 'Off' },
  ],
});

const effortSelect = (): AcpConfigOptionSummary => ({
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
});

const fastSelect = (): AcpConfigOptionSummary => ({
  id: 'fast',
  name: 'Fast',
  category: 'model_config',
  type: 'select',
  currentValue: 'false',
  options: [
    { value: 'true', name: 'On' },
    { value: 'false', name: 'Off' },
  ],
});

const reasoningSelect = (): AcpConfigOptionSummary => ({
  id: 'reasoning',
  name: 'Reasoning',
  category: 'thought_level',
  type: 'select',
  currentValue: 'minimal',
  options: [
    { value: 'minimal', name: 'Minimal' },
    { value: 'full', name: 'Full' },
  ],
});

const contextSelect = (): AcpConfigOptionSummary => ({
  id: 'context',
  name: 'Context',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Default' }],
});

const catalogCompositionEntry = (): Pick<
  AcpCapabilityCacheEntry,
  'configOptions' | 'configOptionsByModel'
> => ({
  configOptions: [modelSelect(), modeSelect(), thinkingSelect(), effortSelect(), fastSelect()],
  configOptionsByModel: {
    a: [thinkingSelect(), effortSelect(), fastSelect()],
    b: [reasoningSelect(), contextSelect()],
    c: [],
  },
});

describe('resolveAcpConfigOptionsForModel', () => {
  it('composes shared snapshot options with model a catalog entries', () => {
    const entry = catalogCompositionEntry();
    expect(resolveAcpConfigOptionsForModel(entry, 'a')?.map((option) => option.id)).toEqual([
      'model',
      'mode',
      'thinking',
      'effort',
      'fast',
    ]);
  });

  it('does not leak probe-time per-model options into model b', () => {
    const entry = catalogCompositionEntry();
    expect(resolveAcpConfigOptionsForModel(entry, 'b')?.map((option) => option.id)).toEqual([
      'model',
      'mode',
      'reasoning',
      'context',
    ]);
  });

  it('keeps only shared snapshot options for a known model with an empty catalog entry', () => {
    const entry = catalogCompositionEntry();
    expect(resolveAcpConfigOptionsForModel(entry, 'c')?.map((option) => option.id)).toEqual([
      'model',
      'mode',
    ]);
  });

  it('returns the snapshot unchanged for a model the catalog does not know', () => {
    const entry = catalogCompositionEntry();
    expect(resolveAcpConfigOptionsForModel(entry, 'z')).toBe(entry.configOptions);
  });

  it('returns the snapshot when the catalog is absent or the model id is not a string', () => {
    const entry = catalogCompositionEntry();
    const snapshot = entry.configOptions;
    expect(resolveAcpConfigOptionsForModel({ configOptions: snapshot }, 'a')).toBe(snapshot);
    expect(resolveAcpConfigOptionsForModel(entry, undefined)).toBe(snapshot);
    expect(resolveAcpConfigOptionsForModel(entry, null)).toBe(snapshot);
  });

  it('ignores model and mode options that a catalog entry tries to replace', () => {
    const snapshotModel = modelSelect();
    const snapshotMode = modeSelect();
    const entry = {
      configOptions: [snapshotModel, snapshotMode, thinkingSelect(), effortSelect(), fastSelect()],
      configOptionsByModel: {
        a: [
          {
            ...modelSelect('a'),
            options: [{ value: 'a', name: 'A' }],
          },
          {
            ...modeSelect(),
            currentValue: 'catalog-mode',
            options: [{ value: 'catalog-mode', name: 'Catalog mode' }],
          },
          thinkingSelect(),
          effortSelect(),
          fastSelect(),
        ],
        b: [reasoningSelect(), contextSelect()],
        c: [],
      },
    };

    const resolved = resolveAcpConfigOptionsForModel(entry, 'a');
    expect(resolved?.[0]).toBe(snapshotModel);
    expect(resolved?.[1]).toBe(snapshotMode);
    expect(resolved?.[0]?.options.map((option) => option.value)).toEqual(['a', 'b', 'c']);
    expect(resolved?.[1]?.currentValue).toBe('agent');
    expect(resolved?.map((option) => option.id)).toEqual([
      'model',
      'mode',
      'thinking',
      'effort',
      'fast',
    ]);
  });
});

describe('resolveAcpTargetModelId', () => {
  it('prefers an explicit model id over config values and the current value', () => {
    expect(
      resolveAcpTargetModelId({
        modelId: 'explicit',
        configOptionValues: { model: 'from-values' },
        configOptions: [modelSelect('from-current')],
      })
    ).toBe('explicit');
  });

  it('reads the model-category select from config option values before currentValue', () => {
    expect(
      resolveAcpTargetModelId({
        configOptionValues: { model: 'from-values' },
        configOptions: [modelSelect('from-current')],
      })
    ).toBe('from-values');
    expect(resolveAcpTargetModelId({ configOptions: [modelSelect('from-current')] })).toBe(
      'from-current'
    );
  });

  it('treats an empty-string modelId as not explicit', () => {
    expect(
      resolveAcpTargetModelId({
        modelId: '',
        configOptionValues: { model: 'from-values' },
        configOptions: [modelSelect('from-current')],
      })
    ).toBe('from-values');
  });

  it('ignores a non-string model option value', () => {
    expect(
      resolveAcpTargetModelId({
        configOptionValues: { model: true },
        configOptions: [modelSelect('from-current')],
      })
    ).toBe('from-current');
  });

  it('treats an empty-string model option value as not selected', () => {
    expect(
      resolveAcpTargetModelId({
        configOptionValues: { model: '' },
        configOptions: [modelSelect('from-current')],
      })
    ).toBe('from-current');
  });
});

describe('ACP toggle select predicates', () => {
  it('recognises on/off selects that include extra values', () => {
    expect(isAcpOnOffSelectValues(['off', 'on', 'auto'])).toBe(true);
  });

  it('recognises exactly the true/false select set', () => {
    expect(isAcpTrueFalseSelectValues(['true', 'false'])).toBe(true);
    expect(isAcpTrueFalseSelectValues(['false', 'true'])).toBe(true);
    expect(isAcpTrueFalseSelectValues(['true', 'false', 'auto'])).toBe(false);
    expect(isAcpTrueFalseSelectValues(['true', 'true'])).toBe(false);
    expect(isAcpTrueFalseSelectValues(['True', 'False'])).toBe(false);
  });

  it('writes the advertised toggle representation', () => {
    expect(toggleAcpSelectOptionValue(['true', 'false'], true)).toBe('true');
    expect(toggleAcpSelectOptionValue(['on', 'off'], false)).toBe('off');
  });

  it('treats only the advertised enabled strings as on', () => {
    expect(isAcpToggleSelectEnabledValue('true')).toBe(true);
    expect(isAcpToggleSelectEnabledValue('on')).toBe(true);
    expect(isAcpToggleSelectEnabledValue('false')).toBe(false);
    expect(isAcpToggleSelectEnabledValue(true)).toBe(false);
  });
});
