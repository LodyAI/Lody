import type { Meta, StoryObj } from '@storybook/react';
import { PreviewConnectionStatus } from '@/components/sessions/preview-connection-status';

const meta = {
  title: 'Sessions/PreviewConnectionStatus',
  component: PreviewConnectionStatus,
  parameters: { layout: 'fullscreen' },
  args: { local: false, onRestore: () => {} },
} satisfies Meta<typeof PreviewConnectionStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = { args: { connection: { status: 'active' } } };
export const Connecting: Story = { args: { busy: true, placeholder: true } };
export const Expired: Story = {
  args: { connection: { status: 'closed', closedReason: 'idle_timeout' }, placeholder: true },
};
export const Failed: Story = {
  args: {
    connection: { status: 'failed' },
    error: 'The development server is not listening on port 5173.',
    placeholder: true,
  },
};
export const Closed: Story = {
  args: { connection: { status: 'closed', closedReason: 'revoked' }, placeholder: true },
};
export const MachineOffline: Story = {
  args: {
    connection: { status: 'closed', closedReason: 'runtime_lost' },
    unavailableReason: 'The session machine is offline. Bring it online to restore preview.',
    placeholder: true,
  },
};
export const LocalWithExpiredShare: Story = {
  args: { local: true, connection: { status: 'closed', closedReason: 'idle_timeout' } },
};
