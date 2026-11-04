import type { Meta, StoryObj } from '@storybook/react';
import { StorageFullDialogView } from '@/components/storage-full-guard';

const GIB = 1024 ** 3;

const meta = {
  title: 'Recovery/StorageFullGuard',
  component: StorageFullDialogView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StorageFullDialogView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LowSpace: Story = {
  args: {
    state: {
      blocked: true,
      source: 'renderer',
      volume: { freeBytes: 3.6 * GIB, totalBytes: 360 * GIB, resumeFreeBytes: 8.2 * GIB },
    },
  },
};

export const UnknownSpace: Story = {
  args: { state: { blocked: true, source: 'cli' } },
};
