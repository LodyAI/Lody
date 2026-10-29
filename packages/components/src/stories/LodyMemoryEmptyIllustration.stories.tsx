import type { Meta, StoryObj } from '@storybook/react';
import { LodyMemoryEmptyIllustration } from '@/components/settings/lody-memory-empty-illustration';

const meta = {
  title: 'Settings/LodyMemoryEmptyIllustration',
  component: LodyMemoryEmptyIllustration,
  args: { theme: 'light' },
} satisfies Meta<typeof LodyMemoryEmptyIllustration>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};
export const Dark: Story = { args: { theme: 'dark' } };
export const FollowsSystem: Story = { args: { theme: 'auto' } };
/** Two on one page: per-instance id prefixes keep their filters and patterns apart. */
export const SideBySide: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16 }}>
      <LodyMemoryEmptyIllustration theme="light" />
      <LodyMemoryEmptyIllustration theme="dark" />
    </div>
  ),
};
