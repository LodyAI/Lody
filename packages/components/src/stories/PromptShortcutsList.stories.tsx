import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { PromptShortcutsList } from '@/components/settings/prompt-shortcuts-setting';

const meta = {
  title: 'Settings/PromptShortcutsList',
  component: PromptShortcutsList,
  args: {
    entries: [],
    currentUserId: 'story-user',
    loading: false,
    busy: false,
    canCreate: true,
    onCreate: fn(),
    onOpen: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof PromptShortcutsList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Loading: Story = { args: { loading: true } };
export const ReadOnlyEmpty: Story = { args: { canCreate: false } };
