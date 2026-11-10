import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { AcceptInvitationPage } from '@/components/pages/accept-invitation-page';

const meta = {
  title: 'Pages/AcceptInvitationPage',
  component: AcceptInvitationPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    onAccept: fn(),
    onBackHome: fn(),
    onContinue: fn(),
    onSwitchAccount: fn(),
    onVerifyEmail: fn(),
  },
} satisfies Meta<typeof AcceptInvitationPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: {
    state: 'loading',
  },
};

export const Idle: Story = {
  args: {
    state: 'idle',
    invitationOrganizationName: 'Loro',
    inviterEmail: 'zoe@loro.dev',
  },
};

export const IdleWithoutInviter: Story = {
  args: {
    state: 'idle',
    invitationOrganizationName: 'Loro',
  },
};

export const SignInRequired: Story = {
  args: {
    state: 'auth_required',
    invitationOrganizationName: 'PKU Research Lab',
    inviterName: 'Ada',
    recipientEmailMasked: 'h***@nsd.pku.edu.cn',
    invitationRole: 'member',
  },
};

export const AccountMismatch: Story = {
  args: {
    state: 'account_mismatch',
    invitationOrganizationName: 'PKU Research Lab',
    recipientEmailMasked: 'h***@nsd.pku.edu.cn',
    invitationRole: 'member',
    currentUserEmail: 'personal@example.com',
  },
};

export const VerificationRequired: Story = {
  args: {
    state: 'verification_required',
  },
};

export const Success: Story = {
  args: {
    state: 'success',
    organizationName: 'Loro',
  },
};

export const ErrorState: Story = {
  args: {
    state: 'error',
    errorMessage: 'Invitation not found or expired.',
  },
};

export const BillingBlocked: Story = {
  globals: { locale: 'zh_CN' },
  args: {
    state: 'billing_blocked',
    errorMessage:
      '新增付费席位加入前，管理员需在账单设置中绑定可自动扣款的支付方式。已有成员不受影响。',
  },
};
