import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { AgentRoleProposalCard } from '@/components/ai-gui/agent-role-proposal-notice';

const meta = {
  title: 'AI/AgentRoleProposal',
  component: AgentRoleProposalCard,
  parameters: { layout: 'padded' },
  args: { onSave: fn(), onDismiss: fn() },
} satisfies Meta<typeof AgentRoleProposalCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Create: Story = {
  args: {
    target: 'Code Agent · Workstation',
    meta: {
      requesterUserId: 'user',
      roleId: 'role',
      command: {
        action: 'create',
        requestId: 'request',
        name: 'Reviewer',
        description: 'Review changes before merging',
        promptPrefix: 'Review correctness and security. Explain actionable findings.',
        machineId: 'machine',
        agentConfigId: 'agent',
      },
    },
  },
};
export const Update: Story = {
  args: {
    meta: {
      requesterUserId: 'user',
      roleId: 'role',
      before: { name: 'Reviewer', promptPrefix: 'Review correctness.' },
      command: {
        action: 'update',
        requestId: 'request',
        roleId: 'role',
        patch: { promptPrefix: 'Review correctness and security. Explain actionable findings.' },
      },
    },
  },
};
/** Per-machine memory: one identity is imported on Save, another target is unlinked. */
export const MemoryUpdate: Story = {
  args: {
    machineNames: { machine: 'Workstation', build: 'Build box' },
    meta: {
      requesterUserId: 'user',
      roleId: 'role',
      before: {
        name: 'Reviewer',
        targets: [
          { machineId: 'build' },
          { machineId: 'machine', memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' } },
        ],
      },
      memoryImports: [
        { machineId: 'build', providerId: 'nowledge-mem', memoryId: 'scout', name: 'Scout' },
      ],
      command: {
        action: 'update',
        requestId: 'request',
        roleId: 'role',
        patch: {
          targets: [
            { machineId: 'build', memory: { providerId: 'nowledge-mem', memoryId: 'scout' } },
            { machineId: 'machine', memory: null },
          ],
        },
      },
    },
  },
};
/** Adds the Role to another machine with that machine's Agent and a memory. */
export const AddMachine: Story = {
  args: {
    machineNames: { build: 'Build box' },
    agentNames: { 'build-agent': 'Claude Code' },
    meta: {
      requesterUserId: 'user',
      roleId: 'role',
      before: { name: 'Reviewer', targets: [{ machineId: 'build' }] },
      command: {
        action: 'update',
        requestId: 'request',
        roleId: 'role',
        patch: {
          targets: [
            {
              machineId: 'build',
              agentConfigId: 'build-agent',
              memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' },
            },
          ],
        },
      },
    },
  },
};
export const Saved: Story = {
  args: { ...Update.args, meta: { ...Update.args.meta, outcome: 'saved' } },
};
export const Failed: Story = { args: { ...Update.args, error: 'Agent Role no longer exists' } };
export const ReadOnly: Story = { args: { ...Update.args, disabled: true } };
