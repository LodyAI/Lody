import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { DeviceAuthPage } from '@/components/pages/device-auth-page';

const meta = {
  title: 'Pages/DeviceAuthPage',
  component: DeviceAuthPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    userLabel: 'Sign in as Storybook User (storybook@lody.ai)',
    userCode: '',
    canSubmit: false,
    onUserCodeChange: fn(),
    onSubmit: fn(),
  },
} satisfies Meta<typeof DeviceAuthPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const ReadyToSubmit: Story = {
  args: {
    userCode: 'ABCD1234',
    canSubmit: true,
  },
};

export const PastedFormattedCode: Story = {
  args: {
    userCode: 'ABCD-EFGH',
    canSubmit: true,
  },
};

export const Verifying: Story = {
  args: {
    userCode: 'ABCD1234',
    canSubmit: true,
    isVerifying: true,
  },
};

export const ErrorState: Story = {
  args: {
    userCode: 'ABCD1234',
    canSubmit: true,
    error: 'Request failed (HTTP 401)',
  },
};

export const SuccessState: Story = {
  args: {
    success: true,
    countdown: 8,
  },
};
