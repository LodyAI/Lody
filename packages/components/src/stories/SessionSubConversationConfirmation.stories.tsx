import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { SessionSubConversationConfirmationView } from '@/components/sessions/session-sub-conversation-confirmation';

const meta: Meta<typeof SessionSubConversationConfirmationView> = {
  title: 'Sessions/SessionSubConversationConfirmation',
  component: SessionSubConversationConfirmationView,
  args: {
    pending: { action: 'archive', count: 3, workingCount: 1 },
    onAnswer: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof SessionSubConversationConfirmationView>;

export const ArchiveSomeWorking: Story = {};

export const ArchiveNoneWorking: Story = {
  args: { pending: { action: 'archive', count: 2, workingCount: 0 } },
};

export const ArchiveSingleWorking: Story = {
  args: { pending: { action: 'archive', count: 1, workingCount: 1 } },
};

/** The always-confirm path (keyboard shortcut) with no sub-conversations. */
export const ArchivePlain: Story = {
  args: { pending: { action: 'archive', count: 0, workingCount: 0 } },
};

export const SettleSomeWorking: Story = {
  args: { pending: { action: 'settle', count: 3, workingCount: 1 } },
};

export const SettleNoneWorking: Story = {
  args: { pending: { action: 'settle', count: 2, workingCount: 0 } },
};

export const SnoozeSomeWorking: Story = {
  args: { pending: { action: 'snooze', count: 3, workingCount: 1 } },
};

export const MoveToFocus: Story = {
  args: { pending: { action: 'focus', count: 2, workingCount: 0 } },
};
