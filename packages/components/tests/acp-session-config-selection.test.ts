import { describe, expect, it } from 'vitest';
import {
  EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  buildAcpSessionConfigCandidates,
  fenceAcpSessionUserEdits,
  filterAcpSessionConfigOptionValues,
  resolveAcpSessionConfigSelection,
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
  it('retains an unrecognized preference until authoritative capabilities arrive', () => {
    const inputs = { edits: emptyEdits, preferences: { modelId: 'gpt-5.6-sol' } };
    expect(resolveAcpSessionConfigSelection(inputs, baseOptions).selectedModelId).toBe(
      'gpt-5.6-sol'
    );
    expect(
      resolveAcpSessionConfigSelection(inputs, {
        ...baseOptions,
        capabilityAuthority: 'authoritative',
        modelOptions: [
          { value: 'gpt-5.6-sol', label: '5.6 Sol' },
          { value: 'gpt-5.5', label: '5.5' },
        ],
        defaultModelId: 'gpt-5.6-sol',
      }).selectedModelId
    ).toBe('gpt-5.6-sol');
  });

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

  it('is stable for a preference key missing from the runtime snapshot (#185 regression)', () => {
    /* The shape of session 51e236e0…, which crashed 0.89.x on open: the last
       turn's preferences carry `fast`, the agent's runtime snapshot does not.
       The old reconcile/apply reducer pair alternated between re-seeding and
       deleting `fast` forever; derivation settles it once — the runtime
       snapshot owns the whole non-user KEY SET, so `fast` is OMITTED (not
       back-filled from the selector fallback, and never resurrected from the
       stale preference, set to true here so a resurrection would be visible)
       — and, being a pure function, returns the identical result on every
       evaluation. */
    const preferences = {
      modeId: 'auto',
      modelId: 'claude-fable-5[1m]',
      configOptionValues: { effort: 'high', fast: true },
    };
    const runtimePreferences = {
      modeId: 'auto',
      modelId: 'claude-fable-5',
      configOptionValues: { effort: 'high', mode: 'auto', model: 'claude-fable-5' },
    };
    const selectors = [
      {
        configId: 'effort',
        label: 'Effort',
        type: 'select' as const,
        currentValue: 'default',
        options: [
          { value: 'default', label: 'D' },
          { value: 'high', label: 'H' },
        ],
      },
      {
        configId: 'fast',
        label: 'Fast',
        type: 'boolean' as const,
        currentValue: false,
        options: [],
      },
    ];
    for (const authority of ['provisional', 'authoritative'] as const) {
      const options: AcpSessionSelectorOptionsInput = {
        capabilityAuthority: authority,
        modeOptions: [{ value: 'auto', label: 'Auto' }],
        modelOptions: [
          { value: 'claude-fable-5', label: 'F5' },
          { value: 'claude-fable-5[1m]', label: 'F5 1M' },
        ],
        defaultModeId: 'auto',
        defaultModelId: 'claude-fable-5',
        configOptionSelectors: selectors,
      };
      const inputs = { edits: emptyEdits, preferences, runtimePreferences };
      const first = resolveAcpSessionConfigSelection(inputs, options);
      const second = resolveAcpSessionConfigSelection(inputs, options);
      expect(second).toEqual(first);
      expect(first.selectedModeId).toBe('auto');
      expect(first.selectedModelId).toBe('claude-fable-5');
      // The runtime snapshot owns the key set: `fast` is omitted, never
      // resurrected from the stale preference or a selector fallback.
      expect(first.configOptionValues).toEqual(
        authority === 'provisional'
          ? { effort: 'high', mode: 'auto', model: 'claude-fable-5' }
          : { effort: 'high' }
      );
    }
  });

  it('builds unvalidated candidates from the same chain', () => {
    expect(
      buildAcpSessionConfigCandidates({
        edits: { model: { value: 'edited' }, configOptions: { effort: 'low' } },
        preferences: { modeId: 'plan', modelId: 'pref', configOptionValues: { effort: 'high' } },
        runtimePreferences: { modelId: 'runtime', configOptionValues: { effort: 'mid' } },
      })
    ).toEqual({
      modeId: 'plan',
      modelId: 'edited',
      configOptionValues: { effort: 'low' },
    });
  });

  it('filters values against the current selector schema', () => {
    const selectors = [
      {
        configId: 'collaboration_mode',
        label: 'Collaboration mode',
        type: 'select' as const,
        currentValue: 'default',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'plan', label: 'Plan' },
        ],
      },
    ];
    expect(
      filterAcpSessionConfigOptionValues(
        { 'plan-mode': 'on', collaboration_mode: 'plan', future_option: 'enabled' },
        selectors
      )
    ).toEqual({ collaboration_mode: 'plan' });
    expect(
      filterAcpSessionConfigOptionValues(
        { 'plan-mode': 'on', collaboration_mode: 'invalid' },
        selectors
      )
    ).toEqual({});
  });
});

describe('fenceAcpSessionUserEdits', () => {
  const edits: AcpSessionUserConfigEdits = {
    model: { value: 'gpt-5.5' },
    configOptions: { reasoning_effort: 'high' },
  };

  it('clears everything on a target change or when edits are not preserved', () => {
    expect(
      fenceAcpSessionUserEdits(edits, {
        targetChanged: true,
        preserveUnsentUserEdits: true,
        preferences: {},
      })
    ).toBe(EMPTY_ACP_SESSION_USER_CONFIG_EDITS);
    expect(
      fenceAcpSessionUserEdits(edits, {
        targetChanged: false,
        preserveUnsentUserEdits: false,
        preferences: {},
      })
    ).toBe(EMPTY_ACP_SESSION_USER_CONFIG_EDITS);
  });

  it('acknowledges only values captured by the accepted turn', () => {
    // The accepted turn did NOT capture the edit: it stays a user edit.
    expect(
      fenceAcpSessionUserEdits(edits, {
        targetChanged: false,
        preserveUnsentUserEdits: true,
        preferences: { configOptionValues: { reasoning_effort: 'low' } },
      })
    ).toEqual({ model: { value: 'gpt-5.5' }, configOptions: { reasoning_effort: 'high' } });
    // The accepted turn captured both values: nothing is a user edit anymore,
    // so a later runtime baseline may move those fields again.
    expect(
      fenceAcpSessionUserEdits(edits, {
        targetChanged: false,
        preserveUnsentUserEdits: true,
        preferences: { modelId: 'gpt-5.5', configOptionValues: { reasoning_effort: 'high' } },
      })
    ).toBe(EMPTY_ACP_SESSION_USER_CONFIG_EDITS);
  });
});
