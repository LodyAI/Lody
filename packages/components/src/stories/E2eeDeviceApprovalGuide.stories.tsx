import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { E2eeDeviceApprovalGuide } from '@/components/pages/e2ee-device-approval-guide';

const meta = {
  title: 'Pages/EncryptedWorkspace/DeviceApprovalGuide',
  component: E2eeDeviceApprovalGuide,
  parameters: { layout: 'fullscreen' },
  args: { onRefresh: fn(), onShowDetails: fn(), onBack: fn() },
} satisfies Meta<typeof E2eeDeviceApprovalGuide>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Waiting: Story = {};
export const Refreshing: Story = { args: { refreshing: true } };
export const Revoked: Story = { args: { reason: 'revoked' } };
