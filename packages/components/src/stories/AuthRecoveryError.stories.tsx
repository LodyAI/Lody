import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { AuthRecoveryErrorView } from '@/components/auth-recovery-error';

const meta = {
  title: 'Auth/RecoveryError',
  component: AuthRecoveryErrorView,
  args: { onRetry: fn(), onSignOut: fn().mockResolvedValue(undefined) },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AuthRecoveryErrorView>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Exhausted: Story = {};
