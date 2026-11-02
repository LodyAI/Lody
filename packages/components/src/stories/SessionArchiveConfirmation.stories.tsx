import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { SessionArchiveConfirmationView } from '@/components/sessions/session-archive-confirmation';

const meta: Meta<typeof SessionArchiveConfirmationView> = {
  title: 'Sessions/SessionArchiveConfirmation',
  component: SessionArchiveConfirmationView,
  args: {
    summary: { count: 3, workingCount: 1 },
    onAnswer: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof SessionArchiveConfirmationView>;

export const SomeWorking: Story = {};

export const NoneWorking: Story = {
  args: { summary: { count: 2, workingCount: 0 } },
};

export const SingleWorking: Story = {
  args: { summary: { count: 1, workingCount: 1 } },
};

/** The always-confirm path (keyboard shortcut) with no sub-conversations. */
export const Plain: Story = {
  args: { summary: { count: 0, workingCount: 0 } },
};
