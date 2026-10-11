import type { Meta, StoryObj } from '@storybook/react';
import { MEMORY_PROVIDERS } from '@lody/shared';
import { MemoryProviderStatus } from '@/components/settings/memory-setting';
const meta = {
  title: 'Settings/MemoryProviderStatus',
  component: MemoryProviderStatus,
  args: {
    provider: MEMORY_PROVIDERS[0],
    online: true,
    supported: true,
    busy: false,
    result: { type: 'machine/memory', status: 'ready', memories: [] },
  },
} satisfies Meta<typeof MemoryProviderStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const NotInstalled: Story = {
  args: { result: { type: 'machine/memory', status: 'not_installed', memories: [] } },
};
export const NotRunning: Story = {
  args: { result: { type: 'machine/memory', status: 'not_running', memories: [] } },
};
export const Offline: Story = { args: { online: false } };
export const Loading: Story = { args: { busy: true } };
