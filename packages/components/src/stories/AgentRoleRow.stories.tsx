import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import { AgentRoleRow, type AgentRoleRowTarget } from '@/components/settings/agent-roles-setting';
import { settingsSurface } from '@/components/settings/surface';

const base: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'reviewer' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6-sol', configOptionValues: { thought_level: 'high' } },
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
};

const agentConfig: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env' | 'name'> = {
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  name: 'Codex',
};

const studio: AgentRoleRowTarget = {
  machineId: 'machine-1' as MachineId,
  label: 'Studio',
  online: true,
  availability: { kind: 'available' },
  runConfig: base.runConfig,
  agentConfig,
};

const buildBox: AgentRoleRowTarget = {
  ...studio,
  machineId: 'machine-2' as MachineId,
  label: 'Build box',
  online: false,
};

const meta = {
  title: 'Settings/AgentRoleRow',
  component: AgentRoleRow,
  args: {
    role: base,
    targets: [studio],
    canManage: true,
    onEdit: () => undefined,
    onRemove: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[640px] p-4">
        {/* The row is a line of the list's card; the list draws the card. */}
        <div {...stylex.props(settingsSurface.card)}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof AgentRoleRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Private: Story = {};

/** No emoji picked: the row shows the shared default glyph. */
export const DefaultEmoji: Story = {
  args: { role: { ...base, emoji: undefined } },
};

export const SharedWithWorkspace: Story = {
  args: { role: { ...base, visibility: 'workspace' } },
};

export const WithPromptPrefix: Story = {
  args: { role: { ...base, promptPrefix: 'Check correctness before style.' } },
};

/** A machine that is simply asleep: its dot says so, the row adds nothing. */
export const MachineOffline: Story = {
  args: {
    targets: [
      {
        ...studio,
        online: false,
        availability: { kind: 'unavailable', reason: 'machine_offline' },
      },
    ],
  },
};

/** The provider was deleted. Nothing is substituted for it. */
export const AgentConfigMissing: Story = {
  args: {
    targets: [
      {
        ...studio,
        availability: { kind: 'unavailable', reason: 'agent_config_missing' },
        agentConfig: undefined,
      },
    ],
  },
};

/** That machine's configs have not been read yet, so nothing is claimed. */
export const CheckingAvailability: Story = {
  args: { targets: [{ ...studio, availability: { kind: 'unknown' } }] },
};

/** Two machines running it the same way: both named, one summary. */
export const TwoMachines: Story = {
  args: { targets: [studio, buildBox] },
};

/** Two machines running it differently: the row says so instead of picking one. */
export const ConfiguredPerMachine: Story = {
  args: { targets: [studio, { ...buildBox, runConfig: { modelId: 'gpt-5.6-luna' } }] },
};

/** On every machine the user has: one phrase, however many there are. */
export const AllMachines: Story = {
  args: { targets: [studio, buildBox], allMachines: true },
};

/** A binding problem on one machine names that machine. */
export const ProblemOnOneMachine: Story = {
  args: {
    targets: [
      studio,
      { ...buildBox, availability: { kind: 'unavailable', reason: 'agent_config_missing' } },
    ],
  },
};

/** Another member's shared role: readable and editable, not deletable. */
export const SharedByAnotherMember: Story = {
  args: {
    role: { ...base, ownerUserId: 'user-2', visibility: 'workspace' },
    canManage: false,
  },
};

/** Machines past two fold into "+N"; hovering it names them. */
export const ThreeMachines: Story = {
  args: {
    targets: [
      studio,
      buildBox,
      { ...studio, machineId: 'machine-3' as MachineId, label: 'Linux runner' },
    ],
  },
};

/**
 * Every state in one list. Each row is the same two lines; where a Role runs
 * and what is wrong there sit in the trailing column.
 */
export const MixedList: Story = {
  render: (args) => {
    const rows: Partial<typeof args>[] = [
      {},
      {
        role: { ...base, id: 'b' as AgentRoleId, name: 'Release Notes', emoji: '📝' },
        targets: [studio, buildBox],
      },
      {
        role: {
          ...base,
          id: 'c' as AgentRoleId,
          name: 'Architect',
          emoji: '🏛️',
          visibility: 'workspace',
        },
        targets: [studio, { ...buildBox, runConfig: { modelId: 'gpt-5.6-luna' } }],
        allMachines: true,
      },
      {
        role: { ...base, id: 'd' as AgentRoleId, name: 'Triage', emoji: '🚑', promptPrefix: 'x' },
        targets: [
          studio,
          { ...buildBox, availability: { kind: 'unavailable', reason: 'agent_config_missing' } },
        ],
      },
      {
        role: { ...base, id: 'e' as AgentRoleId, name: 'Docs', emoji: '📚' },
        targets: [{ ...studio, availability: { kind: 'unknown' } }],
      },
      {
        role: { ...base, id: 'f' as AgentRoleId, name: 'Migrator', emoji: '🚚' },
        targets: [
          studio,
          buildBox,
          { ...studio, machineId: 'machine-3' as MachineId, label: 'Linux runner' },
        ],
      },
    ];
    return (
      <>
        {rows.map((row, index) => (
          <div
            key={row.role?.id ?? 'a'}
            {...stylex.props(settingsSurface.line, index > 0 && settingsSurface.lineRuled)}
          >
            <AgentRoleRow {...args} {...row} />
          </div>
        ))}
      </>
    );
  },
};
