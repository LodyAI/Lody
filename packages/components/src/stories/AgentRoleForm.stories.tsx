import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@lody/ui/button';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { AgentRoleForm, type AgentRoleFormProps } from '@/components/settings/agent-role-form';
import type { AcpSelectorOptions } from '@/components/shared/acp-selector-options';
import {
  createAgentRoleTargetFormValue,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  type AgentRoleFormValue,
  type AgentRoleTargetFormValue,
} from '@/lib/agent-role-form';

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

const studio: AgentRoleTargetFormValue = {
  ...createAgentRoleTargetFormValue('machine-1' as MachineId),
  agentConfigId: 'config-1' as AgentConfigId,
  modelId: 'gpt-5.6-sol',
  configOptionValues: { thought_level: 'high' },
};

const buildBox: AgentRoleTargetFormValue = {
  ...createAgentRoleTargetFormValue('machine-2' as MachineId),
  agentConfigId: 'config-2' as AgentConfigId,
  modelId: 'gpt-5.6-luna',
};

const configured: AgentRoleFormValue = {
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  name: 'Code Reviewer',
  description: 'Call this agent to review code changes for correctness before merging.',
  emoji: '🔍',
  promptPrefix: 'Check correctness before style.',
  targets: [studio],
  activeMachineId: 'machine-1' as MachineId,
};

/**
 * What a machine tab without the Role shows. The dialog's own panel also reads
 * that machine's agents and memories, which a story has no workspace for.
 */
const addTargetPanel = (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
    <p style={{ margin: 0, fontSize: 12 }}>
      This role does not run on Build box yet. Adding it starts from Codex, the same agent, with the
      current settings.
    </p>
    <Button type="button" size="small" variant="secondary">
      Add to this machine
    </Button>
  </div>
);

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
    addTargetPanel,
    className: 'min-h-0 flex-1',
  },
  decorators: [
    // Mirrors the settings dialog that hosts the form: a fixed-height panel the
    // form's own scroll body and sticky footer size themselves against. The
    // panel pads its content; the form has no padding of its own.
    (Story) => (
      <div className="mx-auto flex h-[620px] w-[620px] flex-col gap-4 overflow-hidden rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatefulAgentRoleForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewRole: Story = {
  args: {
    value: {
      ...EMPTY_AGENT_ROLE_FORM_VALUE,
      targets: [createAgentRoleTargetFormValue('machine-1' as MachineId)],
      activeMachineId: 'machine-1' as MachineId,
    },
    selectorOptions: null,
    errors: ['name_required', 'agent_config_required'],
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
    value: { ...configured, targets: [{ ...studio, agentConfigId: null }] },
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
    value: { ...configured, targets: [{ ...studio, modelId: 'gpt-5.5-retired' }] },
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

/**
 * Runs on two machines. Each tab is that machine's own agent, model and memory;
 * the alias field appears once there is more than one.
 */
export const TwoMachines: Story = {
  args: {
    value: { ...configured, targets: [studio, { ...buildBox, alias: 'Reviewer-CI' }] },
    isEditing: true,
  },
};

/** A machine the Role does not run on yet: one action adds it. */
export const MachineNotAdded: Story = {
  args: {
    value: { ...configured, activeMachineId: 'machine-2' as MachineId },
    isEditing: true,
  },
};

/** Overflow belongs to the machine tabs, leaving the fields and footer in place. */
export const ManyMachines: Story = {
  args: {
    machines: [
      ...machines,
      ...Array.from({ length: 12 }, (_, index) => ({
        machineId: `extra-machine-${index}` as MachineId,
        label: `Development workstation ${index + 1}`,
        online: index % 2 === 0,
      })),
    ],
    isEditing: true,
  },
};
