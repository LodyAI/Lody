import type { Meta, StoryObj } from '@storybook/react';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import { MemoryAssociationList } from '@/components/settings/memory-setting';

const assignedRole = (id: string, name: string, emoji: string): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: id as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'workspace',
  name,
  emoji,
  machineId: 'machine' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});

const lodyRole = assignedRole('lody', 'Lody', '🐳');
const pauliRole = assignedRole('pauli', 'Pauli', '🐕');

const meta = {
  title: 'Settings/MemoryCatalog',
  component: MemoryAssociationList,
  args: {
    entries: [
      {
        machineId: 'machine',
        providerId: 'nowledge-mem',
        memoryId: 'reviewer',
        name: 'Code reviewer',
        description: 'Architecture decisions and lessons from code reviews.',
      },
      {
        machineId: 'machine',
        providerId: 'nowledge-mem',
        memoryId: 'designer',
        name: 'Product designer',
        description: 'Product language, interaction patterns and design decisions.',
      },
    ],
    inventory: {
      type: 'machine/memory',
      status: 'ready',
      memories: [
        { id: 'reviewer', name: 'Reviewer' },
        { id: 'designer', name: 'Designer' },
      ],
    },
    onEdit: () => {},
    onRemove: () => {},
  },
} satisfies Meta<typeof MemoryAssociationList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Linked: Story = {};
/**
 * A long description must not push the "linked" cluster down or wrap it: both
 * rows keep the label and avatar together, level with the name.
 */
export const AssignedRoles: Story = {
  args: {
    entries: [
      {
        machineId: 'machine',
        providerId: 'nowledge-mem',
        memoryId: 'reviewer',
        name: 'Lody',
        description:
          'Works across the public Lody repositories: it records architectural decisions, assumptions and design notes, follows up on issues, and helps maintain the code with less effort. This description is intentionally long enough to wrap several times in the story.',
      },
      {
        machineId: 'machine',
        providerId: 'nowledge-mem',
        memoryId: 'designer',
        name: 'Pauli',
        description: 'Just a small dog.',
      },
    ],
    getAssignedRoles: (entry) => (entry.memoryId === 'reviewer' ? [lodyRole] : [pauliRole]),
  },
};
export const Missing: Story = {
  args: {
    inventory: {
      type: 'machine/memory',
      status: 'ready',
      memories: [{ id: 'designer', name: 'Designer' }],
    },
  },
};
export const Offline: Story = { args: { inventory: undefined } };
export const Empty: Story = { args: { entries: [] } };
