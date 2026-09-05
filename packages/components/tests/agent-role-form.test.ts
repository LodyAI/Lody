import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  applyAgentRoleRunConfigDefaults,
  buildAgentRoleFormValue,
  buildAgentRoleRunConfigSummary,
  buildAgentRoleFromForm,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  findAgentRoleRunConfigIssues,
  selectAuthorableAgentRoleConfigOptions,
  validateAgentRoleForm,
  type AgentRoleFormValue,
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

const formValue = (overrides: Partial<AgentRoleFormValue> = {}): AgentRoleFormValue => ({
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  name: 'Reviewer',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  modelId: 'gpt-5.6',
  ...overrides,
});

const createId = () => 'new-role' as AgentRoleId;

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
  ...overrides,
});

describe('agent role form validation', () => {
  it('requires a name and an exact machine + agent config pair', () => {
    expect(validateAgentRoleForm(EMPTY_AGENT_ROLE_FORM_VALUE, { accessibleRoles: [] })).toEqual([
      'name_required',
      'machine_required',
      'agent_config_required',
    ]);
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
  it('never seeds a synthetic default or authorizes an unavailable control', () => {
    const options = selectorOptions({
      configOptionSelectors: [
        {
          configId: 'fast-mode',
          label: 'Fast',
          type: 'boolean',
          options: [],
          currentValue: false,
          perModel: true,
          hasDefault: false,
          availability: 'unknown',
        },
      ],
    });
    expect(applyAgentRoleRunConfigDefaults(formValue(), options).configOptionValues).toEqual({});
    expect(
      findAgentRoleRunConfigIssues({ configOptionValues: { 'fast-mode': true } }, options)
    ).toEqual([{ kind: 'option_value_unsupported', configId: 'fast-mode', value: 'true' }]);
  });

  it('writes the agent own defaults into the unset fields', () => {
    expect(
      applyAgentRoleRunConfigDefaults(formValue({ modelId: null }), selectorOptions())
    ).toEqual(
      formValue({
        modelId: 'gpt-5.6',
        modeId: 'default',
        configOptionValues: { thought_level: 'medium', 'fast-mode': false },
      })
    );
  });

  it('never overwrites a stored selection, so an incompatible one stays visible', () => {
    const stored = formValue({
      modelId: 'retired-model',
      modeId: 'default',
      configOptionValues: { thought_level: 'ultra', 'fast-mode': true },
    });
    expect(applyAgentRoleRunConfigDefaults(stored, selectorOptions())).toBe(stored);
  });

  it('fills nothing while the agent capabilities are unknown', () => {
    const value = formValue({ modelId: null });
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
      formValue({ modelId: null }),
      selectorOptions({
        configOptionSelectors: [
          { type: 'select', configId: 'api_key', label: 'Key', currentValue: 'x', options: [] },
        ],
      })
    );
    expect(seeded.configOptionValues).toEqual({});
  });
});

describe('run config compatibility', () => {
  it('does not authorize a model merely retained for display', () => {
    const options = selectorOptions();
    options.modelOptions.push({ value: 'unlisted', label: 'Unlisted', disabled: true });
    expect(findAgentRoleRunConfigIssues({ modelId: 'unlisted' }, options)).toEqual([
      { kind: 'model_unsupported', value: 'unlisted' },
    ]);
  });

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
