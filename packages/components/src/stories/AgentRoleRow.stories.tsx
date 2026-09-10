import type { Meta, StoryObj } from '@storybook/react';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import { AgentRoleRow } from '@/components/settings/agent-roles-setting';

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

const meta = {
  title: 'Settings/AgentRoleRow',
  component: AgentRoleRow,
  args: {
    role: base,
    availability: { kind: 'available' },
    agentConfig,
    canManage: true,
    onEdit: () => undefined,
    onRemove: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[640px] p-4">
        <Story />
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

/**
 * A machine that is simply asleep. The row says nothing about it: in the list
 * these rows sit under their machine's pill, which carries that status.
 */
export const MachineOffline: Story = {
  args: { availability: { kind: 'unavailable', reason: 'machine_offline' } },
};

/** The provider was deleted. Nothing is substituted for it. */
export const AgentConfigMissing: Story = {
  args: {
    availability: { kind: 'unavailable', reason: 'agent_config_missing' },
    agentConfig: undefined,
  },
};

/** That machine's configs have not been read yet, so nothing is claimed. */
export const CheckingAvailability: Story = {
  args: { availability: { kind: 'unknown' } },
};

/** Another member's shared role: readable and editable, not deletable. */
export const SharedByAnotherMember: Story = {
  args: {
    role: { ...base, ownerUserId: 'user-2', visibility: 'workspace' },
    canManage: false,
  },
};
