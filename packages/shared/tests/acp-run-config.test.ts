import { describe, expect, it } from 'vitest';

import {
  deriveModelReasoningEffortsFromLegacyModelIds,
  resolveAgentRunConfigSelection,
  resolvePerModelConfigOptionSelection,
  summarizeAgentRunConfigCapabilities,
  type AcpCapabilityCacheEntry,
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
      // away from the probed model, so effort/fast cannot be checked offline:
      // both are dispatched as requested and excluded from the snapshot check.
      validatedConfigIds: ['reasoning_effort', 'fast-mode'],
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
});

describe('per-model config options carried as concrete ids', () => {
  /** Codex probed under a model without a fast speed tier: no `fast-mode` at all. */
  const withoutFastMode = (): AcpCapabilityCacheEntry => {
    const capability = codexCapability();
    return {
      ...capability,
      configOptions: (capability.configOptions ?? []).filter((option) => option.id !== 'fast-mode'),
    };
  };

  it('keeps a stored fast toggle dispatchable when the turn runs another model', () => {
    // An Agent Role's stored run config: concrete ids, no semantic selection.
    expect(
      resolvePerModelConfigOptionSelection({
        configOptionValues: { 'fast-mode': true, mode: 'agent' },
        modelId: 'gpt-5.4-mini',
        capability: codexCapability(),
      })
    ).toEqual({ validatedConfigIds: ['fast-mode'], unverifiedSelections: ['fast-mode=true'] });

    // The probe never saw the option because its model had no fast tier. That
    // says nothing about the model this turn selects.
    expect(
      resolvePerModelConfigOptionSelection({
        configOptionValues: { 'fast-mode': true },
        modelId: 'gpt-5.4-mini',
        capability: withoutFastMode(),
      })
    ).toEqual({ validatedConfigIds: ['fast-mode'], unverifiedSelections: ['fast-mode=true'] });
  });

  it('leaves the snapshot authoritative for the model it was probed under', () => {
    for (const modelId of ['gpt-5.6-sol', undefined]) {
      expect(
        resolvePerModelConfigOptionSelection({
          configOptionValues: { 'fast-mode': true },
          modelId,
          capability: withoutFastMode(),
        })
      ).toEqual({ validatedConfigIds: [], unverifiedSelections: [] });
    }
  });

  it('still validates a stored effort against the target model breakdown', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...codexCapability(),
      modelReasoningEfforts: {
        'gpt-5.6-sol': ['low', 'medium', 'high'],
        'gpt-5.4-mini': ['low', 'medium'],
      },
    };

    expect(
      resolvePerModelConfigOptionSelection({
        configOptionValues: { reasoning_effort: 'medium' },
        modelId: 'gpt-5.4-mini',
        capability,
      })
    ).toEqual({ validatedConfigIds: ['reasoning_effort'], unverifiedSelections: [] });

    expect(() =>
      resolvePerModelConfigOptionSelection({
        configOptionValues: { reasoning_effort: 'high' },
        modelId: 'gpt-5.4-mini',
        capability,
      })
    ).toThrow(/Invalid reasoning effort for model gpt-5\.4-mini.*Allowed values: low, medium/s);
  });

  it('recognizes an agent that publishes effort under its own id', () => {
    // Claude: `effort` by category, `fast` as the toggle id.
    expect(
      resolvePerModelConfigOptionSelection({
        configOptionValues: { effort: 'high', fast: 'on', mode: 'auto' },
        modelId: 'opus',
        capability: claudeCapability(),
      })
    ).toEqual({
      validatedConfigIds: ['effort', 'fast'],
      unverifiedSelections: ['effort=high', 'fast=on'],
    });
  });
});
