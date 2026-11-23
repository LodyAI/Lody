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
export const Saved: Story = {
  args: { ...Update.args, meta: { ...Update.args.meta, outcome: 'saved' } },
};
export const Failed: Story = { args: { ...Update.args, error: 'Agent Role no longer exists' } };
export const ReadOnly: Story = { args: { ...Update.args, disabled: true } };
