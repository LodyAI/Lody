import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { useState, type ComponentProps } from 'react';
import { WorkspaceJoinRequestPage } from '@/components/pages/workspace-join-request-page';

const meta = {
  title: 'Pages/WorkspaceJoinRequestPage',
  component: WorkspaceJoinRequestPage,
  parameters: { layout: 'fullscreen' },
  args: {
    workspaceName: 'PKU Research Lab',
    currentEmail: 'hello@nsd.pku.edu.cn',
    reason: '',
    onReasonChange: fn(),
    onContinue: fn(),
    onVerifyEmail: fn(),
    onSubmit: fn(),
    onOpenWorkspace: fn(),
    onBackHome: fn(),
  },
} satisfies Meta<typeof WorkspaceJoinRequestPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = { args: { state: 'form' } };
export const Loading: Story = { args: { state: 'loading' } };
export const SignInRequired: Story = { args: { state: 'auth_required' } };
export const VerificationRequired: Story = { args: { state: 'verification_required' } };
export const Submitting: Story = {
  args: { state: 'submitting', reason: 'I am contributing to the research project.' },
};
export const Pending: Story = { args: { state: 'pending' } };
export const Approved: Story = { args: { state: 'approved' } };
export const AlreadyMember: Story = { args: { state: 'already_member' } };
export const Rejected: Story = {
  args: { state: 'rejected', reason: 'I am contributing to the research project.' },
};
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Error: Story = {
  args: { state: 'error', errorMessage: 'Unable to load this request.' },
};

function InteractiveFormFixture(args: ComponentProps<typeof WorkspaceJoinRequestPage>) {
  const [reason, setReason] = useState(args.reason);
  const [submitted, setSubmitted] = useState(false);
  return (
    <WorkspaceJoinRequestPage
      {...args}
      reason={reason}
      state={submitted ? 'submitting' : 'form'}
      onReasonChange={(next) => {
        setReason(next);
        args.onReasonChange(next);
      }}
      onSubmit={() => {
        setSubmitted(true);
        args.onSubmit();
      }}
    />
  );
}

export const InteractiveForm: Story = {
  args: { state: 'form' },
  render: (args) => <InteractiveFormFixture {...args} />,
};
