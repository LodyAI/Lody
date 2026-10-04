import type { Meta, StoryObj } from '@storybook/react';
import { MEMORY_PROVIDERS } from '@lody/shared';
import { MemoryProviderPanel } from '@/components/settings/memory-setting';
const meta = {
  title: 'Settings/MemoryProviderPanel',
  component: MemoryProviderPanel,
  args: {
    provider: MEMORY_PROVIDERS[0],
    online: true,
    supported: true,
    busy: false,
    onRefresh: () => {},
    onCreate: () => {},
    result: {
      type: 'machine/memory',
      status: 'ready',
      memories: [
        {
          id: 'reviewer',
          name: 'Code Reviewer',
          description: 'Architecture and code review decisions.',
        },
      ],
    },
  },
} satisfies Meta<typeof MemoryProviderPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Empty: Story = {
  args: { result: { type: 'machine/memory', status: 'ready', memories: [] } },
};
export const NotInstalled: Story = {
  args: { result: { type: 'machine/memory', status: 'not_installed', memories: [] } },
};
export const NotRunning: Story = {
  args: { result: { type: 'machine/memory', status: 'not_running', memories: [] } },
};
export const Offline: Story = { args: { online: false } };
export const Loading: Story = { args: { busy: true } };
