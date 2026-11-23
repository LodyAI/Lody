import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { userEvent } from 'storybook/test';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { AgentRoleForm, type AgentRoleFormProps } from '@/components/settings/agent-role-form';
import { SettingsEditorDialogFrame } from './settings-editor-dialog-frame';
import type { AcpSelectorOptions } from '@/components/shared/acp-selector-options';
import {
  createAgentRoleTargetFormValue,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  type AgentRoleFormValue,
  type AgentRoleTargetFormValue,
} from '@/lib/agent-role-form';
const storyLayout = stylex.create({
  form: { minHeight: 0, flex: '1 1 0%' },
  stack: {
    'margin-inline': 'auto',
    display: 'flex',
    height: '620px',
    width: '620px',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 4)',
    overflow: 'hidden',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
});

const machines = [
  { machineId: 'machine-1' as MachineId, label: 'Studio', online: true },
  { machineId: 'machine-2' as MachineId, label: 'Build box', online: false },
  { machineId: 'machine-3' as MachineId, label: 'Linux runner', online: true },
];

const targetAgentLabels = {
  ['machine-1' as MachineId]: 'Codex',
  ['machine-2' as MachineId]: 'Claude',
};

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
  modeId: 'default',
  configOptionValues: { thought_level: 'high', 'fast-mode': false },
};

const buildBox: AgentRoleTargetFormValue = {
  ...createAgentRoleTargetFormValue('machine-2' as MachineId),
  agentConfigId: 'config-2' as AgentConfigId,
  modelId: 'gpt-5.6-luna',
  modeId: 'plan',
  configOptionValues: { thought_level: 'medium', 'fast-mode': true },
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

/** The dialog owns the value in the product; the story owns it here. */
function StatefulAgentRoleForm(props: AgentRoleFormProps) {
  const [value, setValue] = useState(props.value);
  return <AgentRoleForm {...props} value={value} onChange={setValue} />;
}

const meta = {
  title: 'Settings/AgentRoleForm',
  component: StatefulAgentRoleForm,
  args: {
    xstyle: storyLayout.form,
    value: configured,
    onChange: () => undefined,
    machines,
    agentConfigs,
    selectorOptions,
    issues: [],
    errors: [],
    onSubmit: () => undefined,
    onCancel: () => undefined,
    targetAgentLabels,

  },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, { args }) => (
      <SettingsEditorDialogFrame
        title={args.isEditing ? 'Edit Agent Role' : 'New Agent Role'}
        description="A Role never stores API keys or MCP selections."
        height="min(680px, 88dvh)"
      >

        <Story />
      </SettingsEditorDialogFrame>
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
 * Runs on two machines. Each row is one machine and shows the `@` token that
 * runs the Role there; the open row holds that machine's own agent, model and
 * memory, and the `@` name field appears once there is more than one machine.
 */
export const TwoMachines: Story = {
  args: {
    value: {
      ...configured,
      targets: [studio, { ...buildBox, alias: 'Reviewer-CI' }],
      activeMachineId: 'machine-2' as MachineId,
    },
    isEditing: true,
  },
};

/** Every machine row closed: the list alone says where the Role runs. */
export const AllMachinesCollapsed: Story = {
  args: {
    value: { ...configured, targets: [studio, buildBox], activeMachineId: null },
    isEditing: true,
  },
};

/** Machines the Role does not run on yet are one menu away, added in one step. */
export const AddMachineMenu: Story = {
  args: { isEditing: true },
  play: async ({ canvasElement }) => {
    const add = [...canvasElement.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add machine')
    );
    if (!add) throw new Error('Add machine button missing');
    await userEvent.click(add);
  },
};

/** Many machines stay a short menu rather than a strip of tabs. */
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
  play: AddMachineMenu.play,
};
