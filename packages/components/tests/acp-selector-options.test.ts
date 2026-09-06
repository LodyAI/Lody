import { describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  type AcpConfigOptionSummary,
  type AgentConfigId,
  type MachineViewMeta,
} from '@lody/shared';
import {
  buildAcpSelectorOptions,
  buildAllConfigOptionSelectors,
  normalizeCodexReasoningEffortSelectors,
  resolvePlanModeSelectorEnabled,
  togglePlanModeSelectorValue,
  type AcpConfigOptionSelector,
} from '../src/components/shared/acp-selector-options';

const agentConfigId = 'config-1' as AgentConfigId;

const machineWithCapabilities = (acpCapabilities: MachineViewMeta['acpCapabilities']) =>
  ({ acpCapabilities }) as Pick<MachineViewMeta, 'acpCapabilities'>;

const codexMachineWithConfigOptions = (configOptions: AcpConfigOptionSummary[]) =>
  machineWithCapabilities({
    [agentConfigId]: {
      cliType: 'builtin',
      agentType: 'codex',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime',
      modes: [],
      models: [],
      configOptions,
      fetchedAt: 1,
    },
  });

const codexModelAndReasoningOptions = (
  currentValue: string,
  reasoningOptions: Array<{ value: string; name: string; description?: string }>
): AcpConfigOptionSummary[] => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-5.6-sol',
    options: [
      { value: 'gpt-6-astra', name: 'GPT-6 Astra' },
      { value: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { value: 'gpt-5.6-other', name: 'GPT-5.6 Other' },
    ],
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: reasoningOptions,
  },
];

describe('buildAcpSelectorOptions', () => {
  it('synthesizes registry model selectors when a stale cache stores empty config options', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'registry',
      agentType: 'grok',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'registry',
          agentType: 'grok',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          provenance: 'runtime',
          modes: [],
          models: [
            { modelId: 'grok-4.5', name: 'Grok 4.5' },
            { modelId: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
          ],
          configOptions: [],
          fetchedAt: 1,
        },
      }),
    });

    const modelSelector = options.configOptionSelectors.find(
      (selector) => selector.category === 'model'
    );
    expect(modelSelector).toMatchObject({ configId: 'model' });
    expect(modelSelector?.options.map((option) => option.value)).toEqual([
      'grok-4.5',
      'grok-code-fast-1',
    ]);
  });

  it('does not inject Lody-owned registry mode config selectors', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'registry',
      agentType: 'custom-agent',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'registry',
          agentType: 'custom-agent',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default' },
                { value: 'planning', name: 'Planning' },
              ],
            },
          ],
          fetchedAt: 1,
        },
      }),
    });

    expect(options.modeOptions).toEqual([]);
    const modeSelector = options.configOptionSelectors.find(
      (selector) => selector.category === 'mode'
    );
    expect(modeSelector?.currentValue).toBe('default');
    expect(modeSelector?.options.map((option) => option.value)).toEqual(['default', 'planning']);
  });

  it('renders agent modes with their agent-provided names (no remapping)', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'claude',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'builtin',
          agentType: 'claude',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              currentValue: 'default',
              options: [
                { value: 'auto', name: 'Auto' },
                { value: 'default', name: 'Default' },
              ],
            },
          ],
          fetchedAt: 1,
        },
      }),
    });

    const byValue = new Map(options.modeOptions.map((option) => [option.value, option]));
    // Agent modes are passed through verbatim: no i18n remapping, so `auto` keeps
    // its own "Auto" label instead of collapsing onto a second "Default" entry.
    expect(byValue.get('auto')?.label).toBe('Auto');
    expect(byValue.get('default')?.label).toBe('Default');
    expect(options.defaultModeId).toBe('auto');
  });

  it('uses auto as the static builtin Kimi default mode', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'kimi',
      machine: machineWithCapabilities({}),
    });

    expect(options.defaultModeId).toBe('auto');
  });

  it('does not relabel Codex auto mode', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'builtin',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              currentValue: 'auto',
              options: [{ value: 'auto', name: 'Auto' }],
            },
          ],
          fetchedAt: 1,
        },
      }),
    });

    const autoOption = options.modeOptions.find((option) => option.value === 'auto');
    expect(autoOption?.label).toBe('Auto');
  });

  it('normalizes the Codex full access label from runtime capabilities', () => {
    const target = {
      configId: agentConfigId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      machine: codexMachineWithConfigOptions([
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent-full-access',
          options: [{ value: 'agent-full-access', name: 'Agent (full access)' }],
        },
      ]),
    };

    expect(buildAcpSelectorOptions(target).modeOptions).toMatchObject([
      { value: 'agent-full-access', label: 'Full access' },
    ]);
    expect(buildAllConfigOptionSelectors(target)[0]?.options).toMatchObject([
      { value: 'agent-full-access', label: 'Full access' },
    ]);
  });

  it('keeps latest Codex fast and plan config options', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'builtin',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
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
                { value: 'read-only', name: 'Read-only' },
                { value: 'agent', name: 'Agent' },
              ],
            },
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gpt-5.5',
              options: [{ value: 'gpt-5.5', name: 'GPT-5.5' }],
            },
            {
              id: 'reasoning_effort',
              name: 'Reasoning effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'xhigh',
              options: [{ value: 'xhigh', name: 'Extra high' }],
            },
            {
              id: 'fast-mode',
              name: 'Fast mode',
              category: 'fast-mode',
              type: 'select',
              currentValue: 'off',
              options: [
                { value: 'off', name: 'Off' },
                { value: 'on', name: 'On' },
              ],
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
        },
      }),
    });

    expect(options.modeOptions.map((option) => option.value)).toEqual(['read-only', 'agent']);
    expect(options.modelOptions.map((option) => option.value)).toEqual(['gpt-5.5']);
    expect(options.configOptionSelectors.map((selector) => selector.configId)).toEqual([
      'reasoning_effort',
      'fast-mode',
      'collaboration_mode',
    ]);
    expect(options.capabilityAuthority).toBe('provisional');
    expect(options.defaultModelId).toBe('gpt-5.5');
  });

  it('distinguishes runtime probes from legacy provisional cache entries', () => {
    const configOptions: AcpConfigOptionSummary[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-5.6-sol',
        options: [{ value: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      },
    ];
    const runtime = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: codexMachineWithConfigOptions(configOptions),
    });
    const legacy = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'builtin',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          modes: [],
          models: [],
          configOptions,
          fetchedAt: 1,
        },
      }),
    });

    expect(runtime.capabilityAuthority).toBe('authoritative');
    expect(legacy.capabilityAuthority).toBe('provisional');
  });

  it('keeps a provisional persisted value visible until runtime validation', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      selectedModelId: 'gpt-5.6-sol',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'builtin',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gpt-5.5',
              options: [{ value: 'gpt-5.5', name: 'GPT-5.5' }],
            },
          ],
          fetchedAt: 1,
        },
      }),
    });

    expect(options.capabilityAuthority).toBe('provisional');
    expect(options.modelOptions.map((option) => option.value)).toEqual(['gpt-5.5', 'gpt-5.6-sol']);
  });

  it('keeps boolean config options as toggle selectors', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'builtin',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'reasoning_effort',
              name: 'Think level',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [{ value: 'medium', name: 'Medium' }],
            },
            {
              id: 'safe_mode',
              name: 'Safe Mode',
              description: 'Require extra confirmation before future turns',
              type: 'boolean',
              currentValue: false,
              options: [],
            },
          ],
          fetchedAt: 1,
        },
      }),
    });

    expect(options.configOptionSelectors.map((selector) => selector.configId)).toEqual([
      'reasoning_effort',
      'safe_mode',
    ]);
    expect(
      options.configOptionSelectors.find((selector) => selector.configId === 'safe_mode')
    ).toEqual({
      configId: 'safe_mode',
      label: 'Safe Mode',
      description: 'Require extra confirmation before future turns',
      category: undefined,
      type: 'boolean',
      currentValue: false,
      options: [],
    });
  });

  it('ignores stale registry capability cache entries', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'registry',
      agentType: 'codex',
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'registry',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION - 1,
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'safe_mode',
              name: 'Safe Mode',
              type: 'boolean',
              currentValue: false,
              options: [],
            },
          ],
          fetchedAt: 1,
        },
      }),
    });

    expect(options.configOptionSelectors).toEqual([]);
  });

  it('provides no mode options before registry capabilities have loaded', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'registry',
      agentType: 'custom-agent',
      machine: machineWithCapabilities({}),
    });

    expect(options.modeOptions).toEqual([]);
  });

  it('uses static builtin capabilities when machine cache is missing', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: machineWithCapabilities({}),
    });

    expect(options.modeOptions.map((option) => option.value)).toEqual([
      'read-only',
      'agent',
      'agent-auto-review',
      'agent-full-access',
    ]);
    expect(options.modeOptions.find((option) => option.value === 'agent-full-access')?.label).toBe(
      'Full access'
    );
    expect(options.modeOptions.find((option) => option.value === 'agent-auto-review')?.label).toBe(
      'Auto review'
    );
    expect(options.defaultModeId).toBe('agent-auto-review');
    expect(options.modelOptions.map((option) => option.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    expect(options.configOptionSelectors.map((selector) => selector.configId)).toEqual([
      'reasoning_effort',
      'fast-mode',
      'collaboration_mode',
    ]);
    expect(options.capabilityAuthority).toBe('provisional');
    expect(options.defaultModelId).toBe('gpt-5.6-sol');
  });

  it('prefers auto review as the default mode over the probed adapter default', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: codexMachineWithConfigOptions([
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'read-only', name: 'Read-only' },
            { value: 'agent', name: 'Agent' },
            { value: 'agent-auto-review', name: 'Agent (auto review)' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ]),
    });

    expect(options.capabilityAuthority).toBe('authoritative');
    expect(options.defaultModeId).toBe('agent-auto-review');
  });

  it('falls back to the probed default mode when the adapter has no auto review mode', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      machine: codexMachineWithConfigOptions([
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'read-only', name: 'Read-only' },
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ]),
    });

    expect(options.capabilityAuthority).toBe('authoritative');
    expect(options.defaultModeId).toBe('agent');
  });

  it('keeps static builtin capabilities when a legacy session has no config id', () => {
    const options = buildAcpSelectorOptions({
      cliType: 'builtin',
      agentType: 'codex',
      machine: machineWithCapabilities({}),
    });

    expect(options.capabilityAuthority).toBe('provisional');
    expect(options.modeOptions.length).toBeGreaterThan(0);
  });

  it('keeps builtin Grok interaction mode in the run-config selectors', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'grok',
      machine: machineWithCapabilities({}),
    });

    expect(options.capabilityAuthority).toBe('provisional');
    expect(options.modeOptions).toEqual([]);
    expect(options.defaultModeId).toBeNull();
    expect(
      options.configOptionSelectors.find((selector) => selector.configId === 'interaction_mode')
    ).toMatchObject({
      label: 'Interaction Mode',
      currentValue: 'agent',
      options: [{ value: 'agent' }, { value: 'plan' }],
    });
  });

  it('does not use static or default cached builtin capabilities when a runtime override is set', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      runtimeOverrides: { codexPath: '/tmp/codex' },
      machine: machineWithCapabilities({
        [agentConfigId]: {
          cliType: 'builtin',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          sourceVersion: 'builtin-codex-default',
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              currentValue: 'agent',
              options: [{ value: 'agent', name: 'Agent' }],
            },
          ],
          fetchedAt: 1,
        },
      }),
    });

    expect(options.modeOptions).toEqual([]);
    expect(options.modelOptions).toEqual([]);
    expect(options.configOptionSelectors).toEqual([]);
  });

  it('exposes static builtin selectors for title-generation settings', () => {
    const selectors = buildAllConfigOptionSelectors({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'claude',
      machine: machineWithCapabilities({}),
    });

    expect(selectors.map((selector) => selector.configId)).toEqual([
      'mode',
      'model',
      'effort',
      'fast',
    ]);
  });

  it('does not invent Astra tiers from another model snapshot', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      selectedModelId: 'gpt-6-astra',
      configOptionValues: { reasoning_effort: 'high' },
      machine: codexMachineWithConfigOptions(
        codexModelAndReasoningOptions('medium', [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
        ])
      ),
    });
    expect(
      options.configOptionSelectors.find((s) => s.configId === 'reasoning_effort')
    ).toMatchObject({
      availability: 'unknown',
      currentValue: 'high',
      options: [],
      hasDefault: false,
    });
  });

  it('uses the selected model declaration even when the snapshot has no effort control', () => {
    const machine = codexMachineWithConfigOptions([
      codexModelAndReasoningOptions('medium', [])[0]!,
    ]);
    const capability = machine.acpCapabilities![agentConfigId]!;
    capability.declaredModelCapabilities = {
      version: 1,
      receivedAt: Date.now(),
      models: {
        'gpt-6-astra': { effortValues: ['low', 'high', 'ultra'], fastMode: true },
        'gpt-5.6-terra': { effortValues: ['medium', 'max'], fastMode: false },
      },
    };
    const target = {
      configId: agentConfigId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      machine,
    };
    const astra = buildAcpSelectorOptions({ ...target, selectedModelId: 'gpt-6-astra' });
    expect(
      astra.configOptionSelectors
        .find((s) => s.configId === 'reasoning_effort')
        ?.options.map((o) => o.value)
    ).toEqual(['low', 'high', 'ultra']);
    expect(astra.configOptionSelectors.find((s) => s.configId === 'fast-mode')).toMatchObject({
      type: 'boolean',
      hasDefault: false,
    });
    const terra = buildAcpSelectorOptions({ ...target, selectedModelId: 'gpt-5.6-terra' });
    expect(
      terra.configOptionSelectors
        .find((s) => s.configId === 'reasoning_effort')
        ?.options.map((o) => o.value)
    ).toEqual(['medium', 'max']);
    expect(terra.configOptionSelectors.some((s) => s.configId === 'fast-mode')).toBe(false);
    expect(
      buildAllConfigOptionSelectors({ ...target, selectedModelId: 'gpt-6-astra' }).find(
        (s) => s.configId === 'reasoning_effort'
      )
    ).toEqual(astra.configOptionSelectors.find((s) => s.configId === 'reasoning_effort'));
  });

  it('recovers legacy Terra efforts while Astra metadata remains unknown', () => {
    const machine = codexMachineWithConfigOptions([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-6-astra',
        options: [{ value: 'gpt-5.6-terra', name: 'Terra' }],
      },
    ]);
    machine.acpCapabilities![agentConfigId]!.modelReasoningEfforts = {
      'gpt-5.6-terra': ['low', 'high'],
    };
    const target = {
      configId: agentConfigId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      machine,
    };
    const astra = buildAcpSelectorOptions(target);
    expect(astra.modelOptions.map((o) => o.value)).toContain('gpt-6-astra');
    expect(
      astra.configOptionSelectors.find((s) => s.configId === 'reasoning_effort')?.availability
    ).toBe('unknown');
    const terra = buildAcpSelectorOptions({ ...target, selectedModelId: 'gpt-5.6-terra' });
    expect(
      terra.configOptionSelectors
        .find((s) => s.configId === 'reasoning_effort')
        ?.options.map((o) => o.value)
    ).toEqual(['low', 'high']);
  });

  it('retains same-model snapshot labels without extending their advertised values', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      selectedModelId: 'gpt-5.6-sol',
      machine: codexMachineWithConfigOptions(
        codexModelAndReasoningOptions('medium', [
          { value: 'medium', name: 'Balanced' },
          { value: 'high', name: 'Deep' },
        ])
      ),
    });
    expect(
      options.configOptionSelectors.find((s) => s.configId === 'reasoning_effort')
    ).toMatchObject({
      currentValue: 'medium',
      options: [
        { value: 'medium', label: 'Balanced' },
        { value: 'high', label: 'Deep' },
      ],
    });
  });

  it('marks an unlisted static model unknown instead of borrowing static efforts', () => {
    const options = buildAcpSelectorOptions({
      cliType: 'builtin',
      agentType: 'codex',
      selectedModelId: 'future-model',
    });
    expect(options.modelOptions.find((o) => o.value === 'future-model')).toMatchObject({
      disabled: true,
    });
    expect(
      options.configOptionSelectors.find((s) => s.configId === 'reasoning_effort')
    ).toMatchObject({ availability: 'unknown', options: [] });
  });

  it('does not offer expired declarations or turn an empty declaration into unknown', () => {
    const machine = codexMachineWithConfigOptions([
      codexModelAndReasoningOptions('medium', [])[0]!,
    ]);
    const capability = machine.acpCapabilities![agentConfigId]!;
    capability.declaredModelCapabilities = {
      version: 1,
      receivedAt: 0,
      models: { 'gpt-6-astra': { effortValues: ['ultra'] } },
    };
    const target = {
      configId: agentConfigId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      selectedModelId: 'gpt-6-astra',
      machine,
    };
    expect(
      buildAcpSelectorOptions(target).configOptionSelectors.find(
        (s) => s.configId === 'reasoning_effort'
      )
    ).toMatchObject({ availability: 'unknown', options: [] });
    capability.declaredModelCapabilities = {
      version: 1,
      receivedAt: Date.now(),
      models: { 'gpt-6-astra': { effortValues: [] } },
    };
    expect(
      buildAcpSelectorOptions(target).configOptionSelectors.find(
        (s) => s.configId === 'reasoning_effort'
      )
    ).toMatchObject({ availability: 'unsupported', options: [] });
  });

  it('keeps a requested Fast mode visible when support is unknown', () => {
    const options = buildAcpSelectorOptions({
      configId: agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      selectedModelId: 'gpt-6-astra',
      configOptionValues: { 'fast-mode': true },
      machine: codexMachineWithConfigOptions([codexModelAndReasoningOptions('medium', [])[0]!]),
    });
    expect(options.configOptionSelectors.find((s) => s.configId === 'fast-mode')).toMatchObject({
      availability: 'unknown',
      type: 'boolean',
      hasDefault: false,
    });
  });

  it('leaves non-Codex and non-reasoning selectors unchanged', () => {
    const reasoningSelector: AcpConfigOptionSelector = {
      configId: 'reasoning_effort',
      label: 'Reasoning effort',
      type: 'select',
      currentValue: 'medium',
      options: [{ value: 'medium', label: 'medium' }],
    };
    const customSelector: AcpConfigOptionSelector = {
      ...reasoningSelector,
      configId: 'custom_effort',
    };

    expect(
      normalizeCodexReasoningEffortSelectors([reasoningSelector], {
        cliType: 'builtin',
        agentType: 'claude',
        selectedModelId: 'gpt-5.6-sol',
      })
    ).toEqual([reasoningSelector]);
    expect(
      normalizeCodexReasoningEffortSelectors([customSelector], {
        cliType: 'builtin',
        agentType: 'codex',
        selectedModelId: 'gpt-5.6-sol',
      })
    ).toEqual([customSelector]);
  });
});

describe('plan mode selector value semantics', () => {
  /* Codex is the only agent that carries plan mode as a config option, and it
     publishes exactly one shape: a `collaboration_mode` select over
     `default` / `plan` — never the `on` / `off` pair the fast toggle uses. */
  const collaborationModeSelector: AcpConfigOptionSelector = {
    configId: 'collaboration_mode',
    label: 'Collaboration mode',
    category: 'collaboration_mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'plan', label: 'Plan' },
    ],
  };

  it('reads plan state from default/plan, not on/off', () => {
    expect(resolvePlanModeSelectorEnabled(collaborationModeSelector, undefined)).toBe(false);
    expect(resolvePlanModeSelectorEnabled(collaborationModeSelector, 'plan')).toBe(true);
    expect(resolvePlanModeSelectorEnabled(collaborationModeSelector, 'default')).toBe(false);
  });

  it('toggles to a value the selector accepts', () => {
    /* Regression: writing 'on' here is invalid for the selector, so the value
       fell back to `currentValue` and the toggle never flipped. */
    const enabled = togglePlanModeSelectorValue(collaborationModeSelector, undefined);
    expect(enabled).toBe('plan');
    expect(resolvePlanModeSelectorEnabled(collaborationModeSelector, enabled)).toBe(true);

    const disabled = togglePlanModeSelectorValue(collaborationModeSelector, enabled);
    expect(disabled).toBe('default');
    expect(resolvePlanModeSelectorEnabled(collaborationModeSelector, disabled)).toBe(false);
  });

  it('resolves an unrecognized stored value through the selector currentValue', () => {
    const planCurrent: AcpConfigOptionSelector = {
      ...collaborationModeSelector,
      currentValue: 'plan',
    };
    expect(resolvePlanModeSelectorEnabled(planCurrent, 'bogus')).toBe(true);
    expect(togglePlanModeSelectorValue(planCurrent, 'bogus')).toBe('default');
  });
});
