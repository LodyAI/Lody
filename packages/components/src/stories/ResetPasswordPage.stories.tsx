import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import { fn } from 'storybook/test';
import { ResetPasswordPage } from '@/components/pages/reset-password-page';

const meta = {
  title: 'Components/ResetPasswordPage',
  component: ResetPasswordPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    password: '',
    confirmPassword: '',
    onPasswordChange: fn(),
    onConfirmPasswordChange: fn(),
    onSubmit: fn(),
    onBackToLogin: fn(),
  },
} satisfies Meta<typeof ResetPasswordPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Submitting: Story = {
  args: {
    password: 'synthetic-password',
    confirmPassword: 'synthetic-password',
    submitting: true,
  },
};

export const ScopedSubmitting: Story = {
  args: Submitting.args,
  render: (args) => (
    <div style={{ '--spacing': '6px' } as CSSProperties} data-password-spinner-scope>
      <ResetPasswordPage {...args} />
    </div>
  ),
};

export const Success: Story = {
  args: {
    success: true,
  },
};

export const MissingToken: Story = {
  args: {
    tokenAvailable: false,
  },
};

export const Error: Story = {
  args: {
    submitError: 'Unable to reset password. Please try again.',
  },
};
