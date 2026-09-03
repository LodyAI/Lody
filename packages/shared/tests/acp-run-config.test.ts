import { describe, expect, it } from 'vitest';

import {
  deriveModelReasoningEffortsFromLegacyModelIds,
  resolveAgentRunConfigSelection,
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
      // away from the probed model, so neither effort nor fast can be checked
      // offline: both are dispatched as requested and reported as unverified.
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

  it('dispatches controls the snapshot does not carry instead of rejecting them', () => {
    // A snapshot captured under a model with no fast tier and no effort list
    // looks exactly like this. It cannot decide anything for another model.
    const capability: AcpCapabilityCacheEntry = {
      ...codexCapability(),
      configOptions: [],
    };

    expect(resolveAgentRunConfigSelection({ reasoningEffort: 'high' }, capability)).toEqual({
      configOptionValues: { reasoning_effort: 'high' },
      unverifiedSelections: ['reasoningEffort=high'],
    });
    expect(resolveAgentRunConfigSelection({ fastMode: true }, capability)).toEqual({
      configOptionValues: { 'fast-mode': true },
      unverifiedSelections: ['fastMode=true'],
    });

    // Plan mode is the exception, and for a binding reason rather than a
    // capability one: with neither a collaboration_mode option nor a plan
    // permission mode there is no way to express the request at all.
    expect(() => resolveAgentRunConfigSelection({ planMode: true }, capability)).toThrow(
      /does not offer a plan mode/
    );
  });

  it('spells a snapshot-less control the way the target agent spells it', () => {
    // Probed under a model with neither control, for each builtin agent.
    const bare = (agentType: string): AcpCapabilityCacheEntry => ({
      ...codexCapability(),
      agentType,
      configOptions: [],
    });

    expect(
      resolveAgentRunConfigSelection({ reasoningEffort: 'high', fastMode: true }, bare('codex'))
        .configOptionValues
    ).toEqual({ reasoning_effort: 'high', 'fast-mode': true });

    // Claude spells both differently; Codex's ids would be a silent no-op there.
    expect(
      resolveAgentRunConfigSelection({ reasoningEffort: 'high', fastMode: true }, bare('claude'))
        .configOptionValues
    ).toEqual({ effort: 'high', fast: true });
  });

  it('reports a missing wire binding as such, not as an unsupported control', () => {
    // A third-party agent Lody has no fast-mode convention for.
    const capability: AcpCapabilityCacheEntry = {
      ...codexCapability(),
      agentType: 'some-registry-agent',
      configOptions: [],
    };
    expect(() => resolveAgentRunConfigSelection({ fastMode: true }, capability)).toThrow(
      /cannot be encoded/
    );
    expect(() => resolveAgentRunConfigSelection({ reasoningEffort: 'high' }, capability)).toThrow(
      /cannot be encoded/
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

    // `xhigh` is absent from the probed model's snapshot options but the agent
    // published a breakdown saying the selected model takes it: confirmed, so
    // nothing is reported as unverified.
    expect(
      resolveAgentRunConfigSelection(
        { modelId: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
        capability
      )
    ).toEqual({
      modelId: 'gpt-5.6-sol',
      configOptionValues: { reasoning_effort: 'xhigh' },
    });

    // Outside the target model's published list. That is real evidence, but it
    // can be stale (the breakdown is per account and per catalog revision), so
    // it dispatches and is reported rather than rejected.
    expect(
      resolveAgentRunConfigSelection(
        { modelId: 'gpt-5.4-mini', reasoningEffort: 'high' },
        capability
      )
    ).toEqual({
      modelId: 'gpt-5.4-mini',
      configOptionValues: { reasoning_effort: 'high' },
      unverifiedSelections: ['reasoningEffort=high'],
    });
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
