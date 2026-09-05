import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { AgentRoleForm, type AgentRoleFormProps } from '@/components/settings/agent-role-form';
import type { AcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { EMPTY_AGENT_ROLE_FORM_VALUE, type AgentRoleFormValue } from '@/lib/agent-role-form';

const machines = [
  { machineId: 'machine-1' as MachineId, label: 'Studio', online: true },
  { machineId: 'machine-2' as MachineId, label: 'Build box', online: false },
];

const agentConfigs = [
  { agentConfigId: 'config-1' as AgentConfigId, label: 'Codex' },
  { agentConfigId: 'config-2' as AgentConfigId, label: 'Claude' },
];

const selectorOptions: AcpSelectorOptions = {
  capabilityAuthority: 'authoritative',
  defaultModeId: 'default',
  defaultModelId: 'gpt-5.6-sol',
  modelReasoningEfforts: undefined,
  modeOptions: [
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ],
  modelOptions: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ],
  configOptionSelectors: [
    {
      type: 'select',
      configId: 'thought_level',
      label: 'Reasoning',
      description: 'How long the agent thinks before answering.',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    },
    {
      type: 'boolean',
      configId: 'fast-mode',
      label: 'Fast mode',
      options: [],
      currentValue: false,
    },
  ],
};

const configured: AgentRoleFormValue = {
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  modelId: 'gpt-5.6-sol',
  configOptionValues: { thought_level: 'high' },
  promptPrefix: 'Check correctness before style.',
};

/** The dialog owns the value in the product; the story owns it here. */
function StatefulAgentRoleForm(props: AgentRoleFormProps) {
  const [value, setValue] = useState(props.value);
  return <AgentRoleForm {...props} value={value} onChange={setValue} />;
}

const meta = {
  title: 'Settings/AgentRoleForm',
  component: StatefulAgentRoleForm,
  args: {
    value: configured,
    onChange: () => undefined,
    machines,
    agentConfigs,
    selectorOptions,
    issues: [],
    errors: [],
    onSubmit: () => undefined,
    onCancel: () => undefined,
    className: 'min-h-0 flex-1',
  },
  decorators: [
    // Mirrors the settings dialog that hosts the form: a fixed-height panel the
    // form's own scroll body and sticky footer size themselves against.
    (Story) => (
      <div className="mx-auto flex h-[620px] w-[620px] flex-col overflow-hidden rounded-lg border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatefulAgentRoleForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewRole: Story = {
  args: {
    value: EMPTY_AGENT_ROLE_FORM_VALUE,
    agentConfigs: [],
    selectorOptions: null,
    errors: ['name_required', 'machine_required', 'agent_config_required'],
  },
};

export const Configured: Story = {};

/**
 * No emoji picked: the trigger shows the default glyph, so a Role never looks
 * half-authored. Clicking it opens the picker.
 */
export const DefaultEmoji: Story = {
  args: { value: { ...configured, emoji: '' } },
};

/** The memory notice sits above the share toggle in every state. */
export const SharedWithWorkspace: Story = {
  args: { value: { ...configured, shareWithWorkspace: true }, isEditing: true },
};

/** The machine has no providers yet: nothing is offered in their place. */
export const MachineWithoutAgentConfigs: Story = {
  args: {
    value: { ...configured, agentConfigId: null },
    agentConfigs: [],
    selectorOptions: null,
  },
};

/** Capabilities were never reported, so no run-config control is offered. */
export const CapabilitiesUnavailable: Story = {
  args: {
    selectorOptions: { ...selectorOptions, capabilityAuthority: 'unavailable' },
    issues: [{ kind: 'capabilities_unknown' }],
  },
};

/** A saved model that the agent stopped publishing — reported, never swapped. */
export const IncompatibleRunConfig: Story = {
  args: {
    value: { ...configured, modelId: 'gpt-5.5-retired' },
    issues: [
      { kind: 'model_unsupported', value: 'gpt-5.5-retired' },
      { kind: 'option_unsupported', configId: 'legacy_effort' },
    ],
  },
};

export const DuplicateName: Story = {
  args: { errors: ['name_taken'], isEditing: true },
};

export const SavedLocallyNotSynced: Story = {
  args: {
    isEditing: true,
    error:
      'Saved on this device but not yet synced to the workspace (offline). Other members cannot see it yet.',
  },
};
