import { describe, expect, it } from 'vitest';
import { reconcileAgentRoleSchema } from '../src/lib/agent-role-schema-reconciliation';
import {
  AGENT_ROLE_VERSION,
  bindAgentRoleTarget,
  type AcpCapabilityCacheEntry,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  applyAgentRoleRunConfigDefaults,
  carryAgentRoleOptionsToModel,
  buildAgentRoleFormValue,
  buildAgentRoleRunConfigSummary,
  buildAgentRoleFromForm,
  createAgentRoleTargetFormValue,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  findAgentRoleRunConfigIssues,
  selectAuthorableAgentRoleConfigOptions,
  suggestAgentRoleTarget,
  validateAgentRoleForm,
  type AgentRoleFormValue,
  type AgentRoleTargetFormValue,
} from '../src/lib/agent-role-form';

const role = (overrides: Partial<AgentRole> = {}): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Reviewer',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6' },
  revision: 1,
  createdAt: 10,
  updatedAt: 10,
  ...overrides,
});

const targetValue = (
  overrides: Partial<AgentRoleTargetFormValue> = {}
): AgentRoleTargetFormValue => ({
  ...createAgentRoleTargetFormValue('machine-1' as MachineId),
  agentConfigId: 'config-1' as AgentConfigId,
  modelId: 'gpt-5.6',
  ...overrides,
});

const TARGET_KEYS = new Set<string>([
  'machineId',
  'agentConfigId',
  'modeId',
  'modelId',
  'configOptionValues',
  'memory',
  'alias',
]);

/** A single-target form; target fields in `overrides` go to that one target. */
const formValue = (
  overrides: Partial<AgentRoleFormValue> & Partial<AgentRoleTargetFormValue> = {}
): AgentRoleFormValue => {
  const entries = Object.entries(overrides);
  const target = Object.fromEntries(entries.filter(([key]) => TARGET_KEYS.has(key)));
  const shared = Object.fromEntries(entries.filter(([key]) => !TARGET_KEYS.has(key)));
  return {
    ...EMPTY_AGENT_ROLE_FORM_VALUE,
    name: 'Reviewer',
    activeMachineId: 'machine-1' as MachineId,
    targets: [targetValue(target)],
    ...shared,
  };
};

const createId = () => 'new-role' as AgentRoleId;

describe('role description authoring', () => {
  it('preserves legacy no-op saves and round-trips edits and clearing', () => {
    const existing = role();
    const options = { existing, ownerUserId: 'user-1', now: 20, createId };
    const value = buildAgentRoleFormValue(existing);
    expect(value.description).toBe('');
    expect(buildAgentRoleFromForm(value, options)).toBe(existing);
    const edited = buildAgentRoleFromForm({ ...value, description: 'Review changes' }, options);
    expect(edited.description).toBe('Review changes');
    expect(edited.revision).toBe(2);
    expect(buildAgentRoleFormValue(edited).description).toBe('Review changes');
    const cleared = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(edited), description: '' },
      { ...options, existing: edited }
    );
    expect(cleared.description).toBe('');
    expect(cleared.revision).toBe(3);
  });

  it('caps newly saved descriptions at 140 Unicode code points', () => {
    const saved = buildAgentRoleFromForm(formValue({ description: '😀'.repeat(141) }), {
      ownerUserId: 'user-1',
      now: 20,
      createId,
    });
    expect(saved.description).toBe('😀'.repeat(140));
  });
});

describe('automatic role schema reconciliation', () => {
  const capability: AcpCapabilityCacheEntry = {
    cliType: 'builtin',
    agentType: 'codex',
    provenance: 'runtime',
    fetchedAt: 1,
    modes: [],
    models: [],
    configOptions: [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'retired-model',
        options: [],
      },
      { id: 'plan_mode', name: 'Plan', type: 'boolean', currentValue: false },
      {
        id: 'effort',
        name: 'Effort',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      },
    ],
  };

  it('removes retired fields, migrates Plan and preserves model, permissions and invalid values', () => {
    const before = role({
      runConfig: {
        modelId: 'retired-model',
        modeId: 'strict',
        configOptionValues: {
          interaction_mode: 'code',
          collaboration_mode: 'plan',
          effort: 'invalid',
          _permission: 'ask',
          sandbox: 'read-only',
          future_removed: false,
        },
      },
    });
    const after = reconcileAgentRoleSchema(before, capability);
    expect(after.runConfig).toEqual({
      modelId: 'retired-model',
      modeId: 'strict',
      configOptionValues: {
        effort: 'invalid',
        _permission: 'ask',
        sandbox: 'read-only',
        plan_mode: true,
      },
    });
    expect(before.runConfig.configOptionValues?.collaboration_mode).toBe('plan');
    expect(reconcileAgentRoleSchema(after, capability)).toBe(after);
  });

  it('keeps an explicit new Plan value and leaves advertised legacy fields intact', () => {
    const before = role({
      runConfig: { configOptionValues: { plan_mode: false, collaboration_mode: 'plan' } },
    });
    expect(reconcileAgentRoleSchema(before, capability).runConfig.configOptionValues).toEqual({
      plan_mode: false,
    });
    expect(
      reconcileAgentRoleSchema(before, {
        ...capability,
        configOptions: [
          ...capability.configOptions!,
          {
            id: 'collaboration_mode',
            name: 'Plan',
            type: 'select',
            currentValue: 'default',
            options: [],
          },
        ],
      })
    ).toBe(before);
  });

  it('does not infer removals from absent or provisional schemas', () => {
    const before = role({ runConfig: { configOptionValues: { unknown: 'keep' } } });
    expect(reconcileAgentRoleSchema(before, { ...capability, configOptions: undefined })).toBe(
      before
    );
    expect(reconcileAgentRoleSchema(before, { ...capability, provenance: undefined })).toBe(before);
    expect(
      reconcileAgentRoleSchema(before, { ...capability, configOptions: [] }).runConfig
        .configOptionValues
    ).toEqual({});
  });

  it('preserves model-dependent options when the probe describes another model', () => {
    const before = role({
      runConfig: {
        modelId: 'another-model',
        configOptionValues: {
          model_specific: true,
          collaboration_mode: 'plan',
        },
      },
    });
    expect(reconcileAgentRoleSchema(before, capability).runConfig).toEqual({
      modelId: 'another-model',
      configOptionValues: { model_specific: true, plan_mode: true },
    });
  });

  it.each([
    [{ interaction_mode: 'plan' }, true],
    [{ interaction_mode: 'plan', collaboration_mode: 'default' }, false],
    [{ interaction_mode: 'plan', plan_mode: false }, false],
  ] as const)(
    'preserves legacy interaction Plan with explicit newer choices taking precedence: %j',
    (values, enabled) => {
      const before = role({ runConfig: { configOptionValues: values } });
      expect(reconcileAgentRoleSchema(before, capability).runConfig.configOptionValues).toEqual({
        plan_mode: enabled,
      });
    }
  );
});

const selectorOptions = (overrides: Partial<AcpSelectorOptions> = {}): AcpSelectorOptions => ({
  capabilityAuthority: 'authoritative',
  defaultModeId: 'default',
  defaultModelId: 'gpt-5.6',
  modeOptions: [{ value: 'default', label: 'Default' }],
  modelOptions: [{ value: 'gpt-5.6', label: 'GPT-5.6' }],
  configOptionSelectors: [
    {
      type: 'select',
      configId: 'thought_level',
      label: 'Reasoning',
      currentValue: 'medium',
      options: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    },
    { type: 'boolean', configId: 'fast-mode', label: 'Fast', options: [], currentValue: false },
  ],
  modelReasoningEfforts: undefined,
  ...overrides,
});

describe('agent role form validation', () => {
  it('requires a name and an exact machine + agent config pair', () => {
    expect(validateAgentRoleForm(EMPTY_AGENT_ROLE_FORM_VALUE, { accessibleRoles: [] })).toEqual([
      'name_required',
      'machine_required',
    ]);
    expect(
      validateAgentRoleForm(formValue({ agentConfigId: null }), { accessibleRoles: [] })
    ).toEqual(['agent_config_required']);
    expect(validateAgentRoleForm(formValue(), { accessibleRoles: [] })).toEqual([]);
  });

  it('rejects a name with no mention token left in it', () => {
    expect(validateAgentRoleForm(formValue({ name: '  ---  ' }), { accessibleRoles: [] })).toEqual([
      'name_required',
    ]);
  });

  it('rejects a name that collides on the derived mention token, but not its own', () => {
    const existing = role({ id: 'other' as AgentRoleId, name: 'Reviewer' });
    // "Code Reviewer" and "Code-Reviewer" would both complete as one token.
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), { accessibleRoles: [existing] })
    ).toEqual(['name_taken']);
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), {
        accessibleRoles: [existing],
        editingRoleId: 'other' as AgentRoleId,
      })
    ).toEqual([]);
  });
});

describe('name check exemption', () => {
  it('ignores the row an in-flight create already wrote', () => {
    // The local write lands while the dialog is still open, so the catalog now
    // contains the very Role being created. The editor has carried that id
    // since the form opened, so the form does not report its own name as taken.
    const justWritten = role({ id: 'new-role' as AgentRoleId, name: 'Reviewer' });
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), {
        accessibleRoles: [justWritten],
        editingRoleId: justWritten.id,
      })
    ).toEqual([]);
  });

  it('still catches a real clash while a save is in flight', () => {
    const other = role({ id: 'other' as AgentRoleId, name: 'Reviewer' });
    expect(
      validateAgentRoleForm(formValue({ name: 'Reviewer' }), {
        accessibleRoles: [other],
        editingRoleId: 'new-role' as AgentRoleId,
      })
    ).toEqual(['name_taken']);
  });
});

describe('building a role from the form', () => {
  it('saves current options, removes retired thinking, and reopens without compatibility warnings', () => {
    const existing = role({
      runConfig: {
        modelId: 'gpt-5.6',
        modeId: 'default',
        memory: { providerId: 'nowledge', memoryId: 'reviewer' },
        configOptionValues: { thinking: 'high', thought_level: 'high', 'fast-mode': false },
      },
      promptPrefix: 'Review carefully.',
    });
    const value = buildAgentRoleFormValue(existing);
    const capabilities = selectorOptions();
    const options = {
      existing,
      ownerUserId: 'user-1',
      now: 20,
      createId,
      selectorOptions: capabilities,
    };
    const saved = buildAgentRoleFromForm(value, options);
    expect(saved.runConfig).toEqual({
      ...existing.runConfig,
      configOptionValues: { thought_level: 'high', 'fast-mode': false },
    });
    expect(saved.promptPrefix).toBe(existing.promptPrefix);
    expect(saved.revision).toBe(2);
    expect(saved.updatedAt).toBe(20);
    expect(findAgentRoleRunConfigIssues(saved.runConfig, capabilities)).toEqual([]);
    expect(value.targets[0]?.configOptionValues).toHaveProperty('thinking', 'high');
    expect(existing.runConfig.configOptionValues).toHaveProperty('thinking', 'high');
    expect(
      buildAgentRoleFromForm(buildAgentRoleFormValue(saved), { ...options, existing: saved })
    ).toBe(saved);
  });

  it('uses current option defaults for invalid values without replacing model or mode pins', () => {
    const saved = buildAgentRoleFromForm(
      formValue({
        modelId: 'retired-model',
        modeId: 'retired-mode',
        configOptionValues: { thought_level: 'ultra', 'fast-mode': 'true' },
      }),
      { ownerUserId: 'user-1', now: 20, createId, selectorOptions: selectorOptions() }
    );
    expect(saved.runConfig).toEqual({
      modelId: 'retired-model',
      modeId: 'retired-mode',
      configOptionValues: { thought_level: 'medium', 'fast-mode': false },
    });
  });

  it.each(['unavailable', 'provisional'] as const)(
    'preserves options when capabilities are %s',
    (capabilityAuthority) => {
      const existing = role({ runConfig: { configOptionValues: { thinking: 'high' } } });
      expect(
        buildAgentRoleFromForm(buildAgentRoleFormValue(existing), {
          existing,
          ownerUserId: 'user-1',
          now: 20,
          createId,
          selectorOptions: selectorOptions({ capabilityAuthority }),
        })
      ).toBe(existing);
    }
  );

  it('clears all retired options when the authoritative editor has no option controls', () => {
    const saved = buildAgentRoleFromForm(formValue({ configOptionValues: { thinking: 'high' } }), {
      ownerUserId: 'user-1',
      now: 20,
      createId,
      selectorOptions: selectorOptions({ configOptionSelectors: [] }),
    });
    expect(saved.runConfig.configOptionValues ?? {}).toEqual({});
  });

  it('creates a private role with revision 1', () => {
    const created = buildAgentRoleFromForm(formValue(), {
      ownerUserId: 'user-1',
      now: 100,
      createId,
    });
    expect(created).toMatchObject({
      id: 'new-role',
      ownerUserId: 'user-1',
      visibility: 'private',
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('keeps the authored emoji and drops one that is only whitespace', () => {
    expect(
      buildAgentRoleFromForm(formValue({ emoji: ' 🔍 ' }), {
        ownerUserId: 'user-1',
        now: 100,
        createId,
      }).emoji
    ).toBe('🔍');
    expect(
      buildAgentRoleFromForm(formValue({ emoji: '   ' }), {
        ownerUserId: 'user-1',
        now: 100,
        createId,
      }).emoji
    ).toBeUndefined();
  });

  it('refuses to store a secret-shaped option the surface somehow offered', () => {
    const created = buildAgentRoleFromForm(
      formValue({ configOptionValues: { thought_level: 'high', api_key: 'sk-live' } }),
      { ownerUserId: 'user-1', now: 100, createId }
    );
    expect(created.runConfig.configOptionValues).toEqual({ thought_level: 'high' });
  });

  it('leaves an unchanged edit untouched so its revision does not move', () => {
    const existing = role();
    const saved = buildAgentRoleFromForm(buildAgentRoleFormValue(existing), {
      existing,
      ownerUserId: 'user-1',
      now: 200,
      createId,
    });
    expect(saved).toBe(existing);
  });

  it('bumps the revision exactly once for a real edit', () => {
    const existing = role({ revision: 4 });
    const saved = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(existing), promptPrefix: 'Be strict.' },
      { existing, ownerUserId: 'user-1', now: 200, createId }
    );
    expect(saved).toMatchObject({
      id: existing.id,
      revision: 5,
      updatedAt: 200,
      createdAt: 10,
      promptPrefix: 'Be strict.',
    });
  });

  it('keeps the original owner when someone else saves a shared role', () => {
    const existing = role({ ownerUserId: 'user-2', visibility: 'workspace' });
    const saved = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(existing), name: 'Renamed' },
      { existing, ownerUserId: 'user-1', now: 200, createId }
    );
    expect(saved.ownerUserId).toBe('user-2');
  });

  it('shares and unshares through the same row', () => {
    const existing = role();
    const shared = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(existing), shareWithWorkspace: true },
      { existing, ownerUserId: 'user-1', now: 200, createId }
    );
    expect(shared).toMatchObject({ id: existing.id, visibility: 'workspace', revision: 2 });

    const unshared = buildAgentRoleFromForm(
      { ...buildAgentRoleFormValue(shared), shareWithWorkspace: false },
      { existing: shared, ownerUserId: 'user-1', now: 300, createId }
    );
    expect(unshared).toMatchObject({ id: existing.id, visibility: 'private', revision: 3 });
  });
});

describe('run config defaults', () => {
  it('writes the agent own defaults into the unset fields', () => {
    expect(
      applyAgentRoleRunConfigDefaults(targetValue({ modelId: null }), selectorOptions())
    ).toEqual(
      targetValue({
        modelId: 'gpt-5.6',
        modeId: 'default',
        configOptionValues: { thought_level: 'medium', 'fast-mode': false },
      })
    );
  });

  it('never overwrites a stored selection, so an incompatible one stays visible', () => {
    const stored = targetValue({
      modelId: 'retired-model',
      modeId: 'default',
      configOptionValues: { thought_level: 'ultra', 'fast-mode': true },
    });
    expect(applyAgentRoleRunConfigDefaults(stored, selectorOptions())).toBe(stored);
  });

  it('fills nothing while the agent capabilities are unknown', () => {
    const value = targetValue({ modelId: null });
    expect(
      applyAgentRoleRunConfigDefaults(
        value,
        selectorOptions({ capabilityAuthority: 'unavailable' })
      )
    ).toBe(value);
    expect(applyAgentRoleRunConfigDefaults(value, null)).toBe(value);
  });

  it('offers no default for a secret-shaped option, because it is never authorable', () => {
    const seeded = applyAgentRoleRunConfigDefaults(
      targetValue({ modelId: null }),
      selectorOptions({
        configOptionSelectors: [
          { type: 'select', configId: 'api_key', label: 'Key', currentValue: 'x', options: [] },
        ],
      })
    );
    expect(seeded.configOptionValues).toEqual({});
  });
});

describe('run config model switch', () => {
  it('keeps the values the new model still accepts and drops the rest', () => {
    const effort = (values: string[]) => ({
      type: 'select' as const,
      configId: 'effort',
      label: 'Effort',
      currentValue: values[0],
      options: values.map((value) => ({ value, label: value })),
    });
    const fast = { type: 'boolean' as const, configId: 'fast', label: 'Fast', options: [] };
    const outgoing = [effort(['high', 'xhigh']), fast];
    const incoming = [effort(['high'])];
    const values = { effort: 'high', permission_mode: 'acceptEdits', fast: true };

    expect(carryAgentRoleOptionsToModel(values, outgoing, incoming)).toEqual({
      effort: 'high',
      permission_mode: 'acceptEdits',
    });
    expect(
      carryAgentRoleOptionsToModel({ ...values, effort: 'xhigh' }, outgoing, incoming)
    ).not.toHaveProperty('effort');
  });
});

describe('run config compatibility', () => {
  it('reports every setting the agent no longer publishes', () => {
    expect(
      findAgentRoleRunConfigIssues(
        {
          modeId: 'retired-mode',
          modelId: 'retired-model',
          configOptionValues: { thought_level: 'ultra', legacy: 'x' },
        },
        selectorOptions()
      )
    ).toEqual([
      { kind: 'mode_unsupported', value: 'retired-mode' },
      { kind: 'model_unsupported', value: 'retired-model' },
      { kind: 'option_value_unsupported', configId: 'thought_level', value: 'ultra' },
      { kind: 'option_unsupported', configId: 'legacy' },
    ]);
  });

  it('accepts a run config the agent still publishes', () => {
    expect(
      findAgentRoleRunConfigIssues(
        { modeId: 'default', modelId: 'gpt-5.6', configOptionValues: { 'fast-mode': true } },
        selectorOptions()
      )
    ).toEqual([]);
  });

  it('will not call a stored selection compatible while capabilities are unknown', () => {
    const unavailable = selectorOptions({ capabilityAuthority: 'unavailable' });
    expect(findAgentRoleRunConfigIssues({ modelId: 'gpt-5.6' }, unavailable)).toEqual([
      { kind: 'capabilities_unknown' },
    ]);
    // Nothing pinned means nothing to be wrong about.
    expect(findAgentRoleRunConfigIssues({}, unavailable)).toEqual([]);
  });

  it('never offers a secret-shaped option as something to author', () => {
    expect(
      selectAuthorableAgentRoleConfigOptions([
        { configId: 'thought_level' },
        { configId: 'openai_api_key' },
      ])
    ).toEqual([{ configId: 'thought_level' }]);
  });
});

describe('run config summary', () => {
  it('reads model, then reasoning, then the rest', () => {
    expect(
      buildAgentRoleRunConfigSummary({
        modelId: 'gpt-5.6-sol',
        modeId: 'plan',
        configOptionValues: { verbosity: 'high', reasoning_effort: 'max' },
      })
    ).toEqual(['gpt-5.6-sol', 'max', 'plan', 'high']);
    // Some agents name the option after the category instead of `reasoning_effort`.
    expect(
      buildAgentRoleRunConfigSummary({ configOptionValues: { thought_level: 'high', a: 'z' } })
    ).toEqual(['high', 'z']);
  });

  it('shows a boolean only when it is on, and drops an explicit off', () => {
    expect(
      buildAgentRoleRunConfigSummary({
        configOptionValues: { 'fast-mode': true, sandbox: false, telemetry: 'off' },
      })
    ).toEqual(['fast-mode']);
  });

  it('is empty for a role that pins nothing', () => {
    expect(buildAgentRoleRunConfigSummary({})).toEqual([]);
  });
});

describe('machine targets in the form', () => {
  const linux = targetValue({
    machineId: 'machine-2' as MachineId,
    agentConfigId: 'config-2' as AgentConfigId,
    modelId: 'gpt-5.6-luna',
  });
  const twoMachines = (overrides: Partial<AgentRoleFormValue> = {}): AgentRoleFormValue =>
    formValue({ ...overrides, targets: [targetValue(), linux] });

  it('saves every machine and reopens on the machine it was asked for', () => {
    const saved = buildAgentRoleFromForm(twoMachines(), {
      ownerUserId: 'user-1',
      now: 100,
      createId,
    });
    expect(saved).toMatchObject({ machineId: 'machine-1', agentConfigId: 'config-1' });
    expect(saved.additionalTargets).toEqual([
      { machineId: 'machine-2', agentConfigId: 'config-2', runConfig: { modelId: 'gpt-5.6-luna' } },
    ]);
    const reopened = buildAgentRoleFormValue(saved, 'machine-2' as MachineId);
    expect(reopened.activeMachineId).toBe('machine-2');
    expect(reopened.targets.map((target) => target.machineId)).toEqual(['machine-1', 'machine-2']);
    expect(
      buildAgentRoleFromForm(reopened, {
        existing: saved,
        ownerUserId: 'user-1',
        now: 200,
        createId,
      })
    ).toBe(saved);
  });

  it('reconciles retired options only on the machine being edited', () => {
    const value = formValue({
      targets: [
        targetValue({ configOptionValues: { thinking: 'high' } }),
        { ...linux, configOptionValues: { thinking: 'high' } },
      ],
    });
    const saved = buildAgentRoleFromForm(value, {
      ownerUserId: 'user-1',
      now: 100,
      createId,
      selectorOptions: selectorOptions(),
    });
    expect(saved.runConfig.configOptionValues).not.toHaveProperty('thinking');
    // Machine 2's agent was never probed in this editor; nothing proves it retired.
    expect(saved.additionalTargets?.[0]?.runConfig.configOptionValues).toEqual({
      thinking: 'high',
    });
  });

  it('stores aliases only while the role runs on several machines', () => {
    const aliased = formValue({
      targets: [targetValue({ alias: 'Reviewer-Mac' }), { ...linux, alias: 'Reviewer-Linux' }],
    });
    const saved = buildAgentRoleFromForm(aliased, { ownerUserId: 'user-1', now: 1, createId });
    expect(saved.alias).toBe('Reviewer-Mac');
    expect(saved.additionalTargets?.[0]?.alias).toBe('Reviewer-Linux');
    const single = buildAgentRoleFromForm(formValue({ alias: 'Reviewer-Mac' }), {
      ownerUserId: 'user-1',
      now: 1,
      createId,
    });
    expect(single.alias).toBeUndefined();
  });

  it('checks aliases against role names, other aliases and each other', () => {
    const other = role({
      id: 'other' as AgentRoleId,
      name: 'Writer',
      alias: 'Writer-Mac',
      additionalTargets: [
        {
          machineId: 'machine-2' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: {},
        },
      ],
    });
    const withAliases = (first: string, second: string) =>
      formValue({ targets: [targetValue({ alias: first }), { ...linux, alias: second }] });
    expect(
      validateAgentRoleForm(withAliases('Writer Mac', ''), { accessibleRoles: [other] })
    ).toEqual(['alias_taken']);
    expect(validateAgentRoleForm(withAliases('Writer', ''), { accessibleRoles: [other] })).toEqual([
      'alias_taken',
    ]);
    expect(validateAgentRoleForm(withAliases('Same', 'same'), { accessibleRoles: [] })).toEqual([]);
    expect(validateAgentRoleForm(withAliases('Same', 'Same'), { accessibleRoles: [] })).toEqual([
      'alias_taken',
    ]);
    expect(validateAgentRoleForm(withAliases('Reviewer', ''), { accessibleRoles: [] })).toEqual([
      'alias_taken',
    ]);
    // Another role's alias also blocks a name.
    expect(
      validateAgentRoleForm(formValue({ name: 'Writer-Mac' }), { accessibleRoles: [other] })
    ).toEqual(['name_taken']);
  });

  it('requires an agent config on every machine', () => {
    expect(
      validateAgentRoleForm(
        formValue({ targets: [targetValue(), { ...linux, agentConfigId: null }] }),
        { accessibleRoles: [] }
      )
    ).toEqual(['agent_config_required']);
  });
});

describe('adding a role to another machine', () => {
  const codex = (id: string, name: string, machineId = 'machine-2') => ({
    id: id as AgentConfigId,
    cliType: 'builtin' as const,
    agentType: 'codex' as const,
    name,
    machineId,
  });
  const source = targetValue({
    modeId: 'default',
    configOptionValues: { thought_level: 'high' },
    memory: { providerId: 'nowledge', memoryId: 'reviewer' },
  });

  it('starts from the same agent, preferring the same name, with the settings copied', () => {
    const suggestion = suggestAgentRoleTarget({
      machineId: 'machine-2' as MachineId,
      source,
      sourceConfig: codex('config-1', 'Codex', 'machine-1'),
      machineConfigs: [
        { ...codex('claude', 'Claude'), agentType: 'claude' as const },
        codex('codex-work', 'Codex work'),
        codex('codex', 'Codex'),
      ],
      memories: [],
    });
    expect(suggestion).toEqual({
      machineId: 'machine-2',
      agentConfigId: 'codex',
      modeId: 'default',
      modelId: 'gpt-5.6',
      configOptionValues: { thought_level: 'high' },
      alias: '',
    });
  });

  it('links memory only when that machine has the same identity', () => {
    const input = {
      machineId: 'machine-2' as MachineId,
      source,
      sourceConfig: codex('config-1', 'Codex', 'machine-1'),
      machineConfigs: [codex('codex', 'Codex')],
    };
    expect(suggestAgentRoleTarget({ ...input, memories: [] }).memory).toBeUndefined();
    expect(
      suggestAgentRoleTarget({
        ...input,
        memories: [{ providerId: 'nowledge', memoryId: 'reviewer' }],
      }).memory
    ).toEqual({ providerId: 'nowledge', memoryId: 'reviewer' });
  });

  it('leaves the agent to the user when the machine has no such agent', () => {
    expect(
      suggestAgentRoleTarget({
        machineId: 'machine-2' as MachineId,
        source,
        sourceConfig: codex('config-1', 'Codex', 'machine-1'),
        machineConfigs: [{ ...codex('claude', 'Claude'), agentType: 'claude' as const }],
        memories: [],
      })
    ).toEqual(createAgentRoleTargetFormValue('machine-2' as MachineId));
  });
});

describe('editing a role opened on another machine', () => {
  it('keeps the stored machine order, so an unchanged save is no edit', () => {
    const existing = role({
      additionalTargets: [
        {
          machineId: 'machine-2' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: {},
        },
      ],
    });
    const bound = bindAgentRoleTarget(existing, 'machine-2' as MachineId);
    if (!bound) throw new Error('expected a target on machine-2');
    const saved = buildAgentRoleFromForm(buildAgentRoleFormValue(bound), {
      existing,
      ownerUserId: 'user-1',
      now: 20,
      createId,
    });
    expect(saved).toBe(existing);
  });
});
