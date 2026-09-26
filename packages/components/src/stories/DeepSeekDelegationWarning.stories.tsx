import type { Meta, StoryObj } from '@storybook/react';

import { DeepSeekDelegationWarningContent } from '@/components/shared/deepseek-delegation-warning';

const meta = {
  title: 'Shared/DeepSeekDelegationWarning',
  component: DeepSeekDelegationWarningContent,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof DeepSeekDelegationWarningContent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mirrors the desktop run-config menu's wrapping note without opening the menu. */
export const MenuNotice: Story = {
  render: () => (
    <span className="flex max-w-[18rem] items-start gap-2 whitespace-normal py-1.5 font-normal">
      <DeepSeekDelegationWarningContent />
    </span>
  ),
};
