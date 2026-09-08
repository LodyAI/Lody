import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceOwnershipTransfer } from '@/components/settings/workspace-ownership-transfer';

const meta = {
  title: 'Settings/WorkspaceOwnershipTransfer',
  component: WorkspaceOwnershipTransfer,
  parameters: { layout: 'padded' },
  args: {
    workspaceName: 'Acme Team',
    currentUserId: 'alice',
    members: [
      {
        id: 'a',
        userId: 'alice',
        role: 'owner',
        user: { id: 'alice', name: 'Alice', email: 'alice@example.com' },
      },
      {
        id: 'b',
        userId: 'bob',
        role: 'member',
        user: { id: 'bob', name: 'Bob Chen', email: 'bob@example.com' },
      },
    ],
    onTransfer: async () => {},
  },
} satisfies Meta<typeof WorkspaceOwnershipTransfer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const NoMembers: Story = { args: { members: [] } };
export const FailedTransfer: Story = {
  args: {
    onTransfer: async () => {
      throw new Error('Unavailable');
    },
  },
};
