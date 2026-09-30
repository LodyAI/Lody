import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent } from 'storybook/test';
import {
  PreviewConnectionPlaceholder,
  PreviewConnectionStatus,
} from '@/components/sessions/preview-connection-status';

const meta = {
  title: 'Sessions/PreviewConnectionStatus',
  component: PreviewConnectionStatus,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    local: false,
    remoteMachineName: 'Build Mac',
    onRestore: () => {},
    onStopSharing: () => {},
  },
} satisfies Meta<typeof PreviewConnectionStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

const openStatusPopover: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const trigger = canvasElement.querySelector('[data-testid="preview-status-trigger"]');
  if (!(trigger instanceof HTMLElement)) throw new Error('Expected preview status trigger');
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
};

export const Connected: Story = {
  args: { connection: { status: 'active' }, hasShareUrl: true },
  play: openStatusPopover,
};
export const Connecting: Story = { args: { busy: true } };
export const Checking: Story = { args: { checking: true } };
export const Expired: Story = {
  args: { connection: { status: 'closed', closedReason: 'idle_timeout' } },
};
export const Failed: Story = {
  args: {
    connection: { status: 'failed' },
    error: 'The development server is not listening on port 5173.',
  },
};
export const Closed: Story = {
  args: { connection: { status: 'closed', closedReason: 'revoked' } },
};
export const MachineOffline: Story = {
  args: {
    connection: { status: 'closed', closedReason: 'runtime_lost' },
    unavailableReason: 'The session machine is offline. Bring it online to restore preview.',
  },
};
export const LocalDirect: Story = { args: { local: true } };
export const LocalWithExpiredShare: Story = {
  args: { local: true, connection: { status: 'closed', closedReason: 'idle_timeout' } },
};
export const PlaceholderExpired: Story = {
  render: (args) => <PreviewConnectionPlaceholder {...args} />,
  args: { connection: { status: 'closed', closedReason: 'idle_timeout' } },
};
export const PlaceholderFailed: Story = {
  render: (args) => <PreviewConnectionPlaceholder {...args} />,
  args: {
    connection: { status: 'failed' },
    error: 'The development server is not listening on port 5173.',
  },
};
