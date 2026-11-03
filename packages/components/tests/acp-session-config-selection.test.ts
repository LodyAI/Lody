import { describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  type AcpCapabilityCacheEntry,
  type AgentConfigId,
} from '@lody/shared';
import { buildAcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  buildAcpSessionConfigCandidates,
  filterAcpSessionConfigOptionValues,
  resolveAcpSessionConfigSelection,
  type AcpSessionConfigSelectionInputs,
  type AcpSessionSelectorOptionsInput,
  type AcpSessionUserConfigEdits,
} from '../src/lib/acp-session-config-selection';

const emptyEdits = EMPTY_ACP_SESSION_USER_CONFIG_EDITS;

const baseOptions: AcpSessionSelectorOptionsInput = {
  capabilityAuthority: 'provisional',
  modeOptions: [],
  modelOptions: [{ value: 'gpt-5.5', label: '5.5' }],
  defaultModeId: null,
  defaultModelId: 'gpt-5.5',
  configOptionSelectors: [],
};

describe('ACP session config derivation', () => {
  it('replaces an invalid preference only after authoritative validation', () => {
    const inputs = { edits: emptyEdits, preferences: { modelId: 'removed-model' } };
    expect(resolveAcpSessionConfigSelection(inputs, baseOptions).selectedModelId).toBe(
      'removed-model'
    );
    expect(
      resolveAcpSessionConfigSelection(inputs, {
        ...baseOptions,
        capabilityAuthority: 'authoritative',
      }).selectedModelId
    ).toBe('gpt-5.5');
  });

  it('derives fresh defaults but preserves explicit user selections', () => {
    const authoritative: AcpSessionSelectorOptionsInput = {
      ...baseOptions,
      capabilityAuthority: 'authoritative',
      modelOptions: [
        { value: 'gpt-5.6-sol', label: '5.6 Sol' },
        { value: 'gpt-5.5', label: '5.5' },
      ],
      defaultModelId: 'gpt-5.6-sol',
    };
    // No edit: the default follows the capability catalog.
    expect(
      resolveAcpSessionConfigSelection({ edits: emptyEdits, preferences: {} }, authoritative)
        .selectedModelId
    ).toBe('gpt-5.6-sol');
    // A user edit outranks the default and survives an authority change.
    const edited: AcpSessionUserConfigEdits = { model: { value: 'gpt-5.5' }, configOptions: {} };
    expect(
      resolveAcpSessionConfigSelection({ edits: edited, preferences: {} }, authoritative)
        .selectedModelId
    ).toBe('gpt-5.5');
    // An INVALID user edit falls through the chain under authoritative caps.
    const invalidEdit: AcpSessionUserConfigEdits = { model: { value: 'gone' }, configOptions: {} };
    expect(
      resolveAcpSessionConfigSelection({ edits: invalidEdit, preferences: {} }, authoritative)
        .selectedModelId
    ).toBe('gpt-5.6-sol');
  });

  it('keeps unknown config keys provisionally and removes them authoritatively', () => {
    const selectors = [
      {
        configId: 'fast-mode',
        label: 'Fast mode',
        type: 'select' as const,
        currentValue: 'off',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
      },
    ];
    const inputs = {
      edits: emptyEdits,
      preferences: {
        configOptionValues: { future_option: 'enabled', 'fast-mode': 'future-value' },
      },
    };
    expect(
      resolveAcpSessionConfigSelection(inputs, {
        ...baseOptions,
        configOptionSelectors: selectors,
      }).configOptionValues
    ).toEqual({ future_option: 'enabled', 'fast-mode': 'future-value' });
    expect(
      resolveAcpSessionConfigSelection(inputs, {
        ...baseOptions,
        capabilityAuthority: 'authoritative',
        configOptionSelectors: selectors,
      }).configOptionValues
    ).toEqual({ 'fast-mode': 'off' });
  });

  it('applies the runtime baseline over non-user fields', () => {
    const selectors = [
      {
        configId: 'collaboration_mode',
        label: 'Collaboration mode',
        type: 'select' as const,
        currentValue: 'plan',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'plan', label: 'Plan' },
        ],
      },
      {
        configId: 'reasoning_effort',
        label: 'Reasoning effort',
        type: 'select' as const,
        currentValue: 'low',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
      },
    ];
    const options: AcpSessionSelectorOptionsInput = {
      ...baseOptions,
      capabilityAuthority: 'authoritative',
      configOptionSelectors: selectors,
    };
    // Deterministic across collaborators: same inputs, same result.
    const resolved = resolveAcpSessionConfigSelection(
      {
        edits: emptyEdits,
        preferences: { configOptionValues: { collaboration_mode: 'plan' } },
        runtimePreferences: { configOptionValues: { collaboration_mode: 'default' } },
      },
      options
    );
    expect(resolved.configOptionValues.collaboration_mode).toBe('default');
    // A local unsent edit outranks the runtime baseline for its own field only.
    expect(
      resolveAcpSessionConfigSelection(
        {
          edits: { configOptions: { reasoning_effort: 'high' } },
          preferences: {
            configOptionValues: { collaboration_mode: 'plan', reasoning_effort: 'low' },
          },
          runtimePreferences: {
            configOptionValues: { collaboration_mode: 'default', reasoning_effort: 'low' },
          },
        },
        options
      ).configOptionValues
    ).toEqual({ collaboration_mode: 'default', reasoning_effort: 'high' });
  });

  it('removes non-user options omitted from a full runtime snapshot', () => {
    expect(
      resolveAcpSessionConfigSelection(
        {
          edits: emptyEdits,
          preferences: { configOptionValues: { removed_option: 'enabled' } },
          runtimePreferences: { configOptionValues: {} },
        },
        baseOptions
      ).configOptionValues
    ).toEqual({});
  });

  it('normalizes model-dependent selectors against the RESOLVED model', () => {
    /* An authoritative capability refresh removed the persisted extended Codex
       model (`gpt-5.6-sol`). The selector catalog was built for that stale
       CANDIDATE, so the reasoning selector still carries the extended tiers —
       without re-normalization, `max` would stay valid and dispatchable after
       the model resolved to one that does not support it. */
    const staleNormalizedReasoningSelector = {
      configId: 'reasoning_effort',
      label: 'Reasoning effort',
      type: 'select' as const,
      currentValue: 'medium',
      options: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'max', label: 'Max' },
        { value: 'ultra', label: 'Ultra' },
      ],
    };
    const resolved = resolveAcpSessionConfigSelection(
      {
        edits: emptyEdits,
        preferences: {
          modelId: 'gpt-5.6-sol',
          configOptionValues: { reasoning_effort: 'max' },
        },
      },
      {
        capabilityAuthority: 'authoritative',
        modeOptions: [],
        modelOptions: [{ value: 'gpt-5.5', label: '5.5' }],
        defaultModeId: null,
        defaultModelId: 'gpt-5.5',
        configOptionSelectors: [staleNormalizedReasoningSelector],
      },
      { cliType: 'builtin', agentType: 'codex' }
    );
    expect(resolved.selectedModelId).toBe('gpt-5.5');
    // `max` is not a reasoning tier of the resolved model: the stale
    // preference falls through to the normalized selector's own value.
    expect(resolved.configOptionValues.reasoning_effort).toBe('medium');
  });

  it('returns the resolved-model selectors so dispatch filtering keeps resolved-valid values', () => {
    /* The resolver keeps `xhigh` for the resolved 4.6, but the caller's
       candidate-4.5 selector would drop it at dispatch. The resolved selectors
       must travel with the values so filtering follows the model the turn
       will actually run on. */
    const staleGrokReasoningSelector = {
      configId: 'reasoning_effort',
      label: 'Reasoning effort',
      type: 'select' as const,
      currentValue: 'high',
      options: [
        { value: 'high', label: 'High' },
        { value: 'medium', label: 'Medium' },
        { value: 'low', label: 'Low' },
      ],
    };
    const resolved = resolveAcpSessionConfigSelection(
      {
        edits: emptyEdits,
        preferences: {
          modelId: 'grok-4.5',
          configOptionValues: { reasoning_effort: 'xhigh' },
        },
      },
      {
        capabilityAuthority: 'authoritative',
        modeOptions: [],
        modelOptions: [{ value: 'grok-4.6', label: '4.6' }],
        defaultModeId: null,
        defaultModelId: 'grok-4.6',
        configOptionSelectors: [staleGrokReasoningSelector],
        modelReasoningEfforts: {
          'grok-4.6': ['xhigh', 'high', 'medium', 'low'],
        },
      },
      { cliType: 'builtin', agentType: 'grok' }
    );
    expect(resolved.selectedModelId).toBe('grok-4.6');
    expect(resolved.configOptionValues.reasoning_effort).toBe('xhigh');
    expect(
      resolved.configOptionSelectors
        ?.find((selector) => selector.configId === 'reasoning_effort')
        ?.options.map((option) => option.value)
    ).toEqual(['xhigh', 'high', 'medium', 'low']);
    expect(
      filterAcpSessionConfigOptionValues(
        resolved.configOptionValues,
        resolved.configOptionSelectors ?? []
      ).reasoning_effort
    ).toBe('xhigh');
    expect(
      filterAcpSessionConfigOptionValues(resolved.configOptionValues, [staleGrokReasoningSelector])
        .reasoning_effort
    ).toBeUndefined();
  });

  it('lets a pinned effort through when the same pick moves the model', () => {
    const selectors = [
      {
        configId: 'reasoning_effort',
        label: 'Reasoning',
        category: 'thought_level' as const,
        type: 'select' as const,
        currentValue: 'high',
        options: [
          { value: 'high', label: 'High' },
          { value: 'low', label: 'Low' },
        ],
      },
      {
        configId: 'collaboration_mode',
        label: 'Collaboration mode',
        type: 'select' as const,
        currentValue: 'default',
        options: [{ value: 'default', label: 'Default' }],
      },
    ];
    const pinned = { reasoning_effort: 'xhigh', collaboration_mode: 'invalid' };
    // These selectors belong to the model being left behind; only the effort is
    // model-dependent, so everything else is still validated against them.
    expect(filterAcpSessionConfigOptionValues(pinned, selectors, { switchesModel: true })).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(filterAcpSessionConfigOptionValues(pinned, selectors)).toEqual({});
  });
});

describe('ACP session config with declared per-model controls', () => {
  const configId = 'per-model-config' as AgentConfigId;
  const modelOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue: 'model-a',
    options: [
      { value: 'model-a', name: 'A' },
      { value: 'model-b', name: 'B' },
    ],
  };
  const entry = (
    agentType: string,
    configOptions: AcpCapabilityCacheEntry['configOptions']
  ): AcpCapabilityCacheEntry => ({
    cliType: 'builtin',
    agentType,
    cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
    provenance: 'runtime',
    modes: [],
    models: [],
    configOptions,
    declaredModelControls: {
      'model-a': { effortValues: [], fastMode: false },
      'model-b': { effortValues: ['low', 'medium', 'high'], fastMode: true },
    },
    fetchedAt: 1,
  });
  const selectorOptions = (capability: AcpCapabilityCacheEntry, selectedModelId: string) =>
    buildAcpSelectorOptions({
      configId,
      cliType: 'builtin',
      agentType: capability.agentType,
      selectedModelId,
      machine: { acpCapabilities: { [configId]: capability } },
    });

  it("keeps Claude's provider default instead of pinning medium", () => {
    // What Claude publishes for model-b to a client without AIR recommendedValue.
    const capability = entry('claude', [
      { ...modelOption, currentValue: 'model-b' },
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    ]);

    const resolved = resolveAcpSessionConfigSelection(
      {
        edits: emptyEdits,
        preferences: { modelId: 'model-b', configOptionValues: { effort: 'default' } },
      },
      selectorOptions(capability, 'model-b'),
      { cliType: 'builtin', agentType: 'claude' }
    );

    expect(resolved.configOptionValues.effort).toBe('default');
  });

  it("keeps a Role's Fast=true when it switches away from a model without Fast", () => {
    const capability = entry('codex', [
      modelOption,
      { id: 'fast-mode', name: 'Fast', type: 'boolean', currentValue: false, options: [] },
    ]);
    // The Role applies with the OUTGOING model's selectors, which have no Fast.
    const outgoing = selectorOptions(capability, 'model-a').configOptionSelectors;
    expect(outgoing.some((selector) => selector.configId === 'fast-mode')).toBe(false);
    const edits = filterAcpSessionConfigOptionValues({ 'fast-mode': true }, outgoing, {
      switchesModel: true,
    });

    const resolved = resolveAcpSessionConfigSelection(
      {
        edits: { model: { value: 'model-b' }, configOptions: edits },
        preferences: { modelId: 'model-a' },
      },
      selectorOptions(capability, 'model-b'),
      { cliType: 'builtin', agentType: 'codex' }
    );

    expect(resolved.selectedModelId).toBe('model-b');
    expect(resolved.configOptionValues['fast-mode']).toBe(true);
  });
});

describe.each(['custom', 'registry'] as const)('%s model-category effort selection', (cliType) => {
  const configId = 'generic-effort' as AgentConfigId;
  const target = { cliType, agentType: 'synthetic-agent' };
  const machine = {
    acpCapabilities: {
      [configId]: {
        ...target,
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        provenance: 'runtime' as const,
        fetchedAt: 1,
        modes: [],
        models: [],
        configOptions: [
          {
            id: 'provider_model',
            name: 'Model',
            category: 'model',
            type: 'select' as const,
            currentValue: 'a',
            options: ['a', 'b', 'adaptive'].map((value) => ({ value, name: value })),
          },
          {
            id: 'provider_effort',
            name: 'Effort',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: 'high',
            options: ['medium', 'high', 'max'].map((value) => ({ value, name: value })),
          },
        ],
        declaredModelControls: {
          a: { effortValues: ['medium', 'high', 'max'] },
          b: { effortValues: ['low', 'medium', 'high', 'xhigh', 'max'] },
          adaptive: { effortValues: [] },
        },
      },
    },
  };
  const build = (inputs: AcpSessionConfigSelectionInputs) => {
    const candidate = buildAcpSessionConfigCandidates(inputs);
    return buildAcpSelectorOptions({
      ...target,
      configId,
      machine,
      selectedModelId: candidate.modelId,
      configOptionValues: candidate.configOptionValues,
    });
  };
  const resolve = (inputs: AcpSessionConfigSelectionInputs) =>
    resolveAcpSessionConfigSelection(inputs, build(inputs), target);
  const efforts = (value: {
    configOptionSelectors: AcpSessionSelectorOptionsInput['configOptionSelectors'];
  }) =>
    value.configOptionSelectors
      .find((selector) => selector.configId === 'provider_effort')
      ?.options.map((option) => option.value);
  const inputsFor = (model: string): AcpSessionConfigSelectionInputs => ({
    edits: { configOptions: { provider_model: model } },
    preferences: {},
  });

  it('derives both stages from the real model config id and preserves config-option dispatch', () => {
    const inputs = {
      ...inputsFor('b'),
      runtimePreferences: { configOptionValues: { provider_model: 'a', provider_effort: 'high' } },
    };
    expect(efforts(build(inputs))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const resolved = resolve(inputs);
    expect(efforts(resolved)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolved.selectedModelId).toBeNull();
    expect(resolved.configOptionValues.provider_model).toBe('b');
    expect(
      filterAcpSessionConfigOptionValues(
        resolved.configOptionValues,
        resolved.configOptionSelectors
      )
    ).toEqual({ provider_model: 'b', provider_effort: 'high' });
  });

  it('hides empty effort declarations and restores the control on switching back', () => {
    const hidden = resolve(inputsFor('adaptive'));
    expect(efforts(hidden)).toBeUndefined();
    expect(hidden.configOptionValues).toEqual({ provider_model: 'adaptive' });
    const restored = resolve({
      edits: { configOptions: { provider_model: 'b' } },
      preferences: { configOptionValues: hidden.configOptionValues },
    });
    expect(efforts(restored)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(restored.configOptionValues.provider_effort).toBe('high');
  });

  it('validates the model before effort and falls back from an invalid edit to the runtime model', () => {
    const inputs: AcpSessionConfigSelectionInputs = {
      edits: { configOptions: { provider_model: 'removed', provider_effort: 'xhigh' } },
      runtimePreferences: {
        configOptionValues: { provider_model: 'b', provider_effort: 'medium' },
      },
      preferences: { configOptionValues: { provider_model: 'a' } },
    };
    const resolved = resolve(inputs);
    expect(resolved.configOptionValues).toEqual({ provider_model: 'b', provider_effort: 'xhigh' });
    expect(efforts(resolved)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('restores controls when an unsupported candidate is removed from the authoritative catalog', () => {
    const inputs: AcpSessionConfigSelectionInputs = {
      edits: { configOptions: { provider_model: 'adaptive' } },
      preferences: { configOptionValues: { provider_model: 'b' } },
    };
    const capability = machine.acpCapabilities[configId];
    const options = buildAcpSelectorOptions({
      ...target,
      configId,
      configOptionValues: { provider_model: 'adaptive' },
      machine: {
        acpCapabilities: {
          [configId]: {
            ...capability,
            configOptions: capability.configOptions.map((option) =>
              option.category === 'model'
                ? { ...option, options: option.options.filter((item) => item.value !== 'adaptive') }
                : option
            ),
          },
        },
      },
    });
    expect(efforts(options)).toBeUndefined();
    const resolved = resolveAcpSessionConfigSelection(inputs, options, target);
    expect(efforts(resolved)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolved.configOptionValues.provider_model).toBe('b');
  });

  it('uses the generic config value even if a stale dedicated model id exists', () => {
    const options = buildAcpSelectorOptions({
      ...target,
      configId,
      machine,
      selectedModelId: 'a',
      configOptionValues: { provider_model: 'b' },
    });
    expect(efforts(options)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('keeps runtime snapshots authoritative over missing keys and invalid values', () => {
    for (const runtimeValues of [{}, { provider_model: 'removed', provider_effort: 'removed' }]) {
      const resolved = resolve({
        edits: emptyEdits,
        runtimePreferences: { configOptionValues: runtimeValues },
        preferences: { configOptionValues: { provider_model: 'b', provider_effort: 'xhigh' } },
      });
      expect(resolved.configOptionValues).toEqual({});
      expect(efforts(resolved)).toEqual(['medium', 'high', 'max']);
    }
  });
});
