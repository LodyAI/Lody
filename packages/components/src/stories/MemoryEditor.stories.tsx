import type { Meta, StoryObj } from '@storybook/react';
import { MEMORY_PROVIDERS, type MachineId } from '@lody/shared';
import { MemoryEditor } from '@/components/settings/memory-setting';
const result = {
  type: 'machine/memory' as const,
  status: 'ready' as const,
  memories: [
    {
      id: 'reviewer',
      name: 'Code reviewer',
      description: 'Architecture decisions and lessons from code reviews.',
    },
    {
      id: 'designer',
      name: 'Product designer',
      description: 'Product language and interaction patterns.',
    },
  ],
};
const meta = {
  title: 'Settings/MemoryEditor',
  component: MemoryEditor,
  args: {
    machineId: 'machine' as MachineId,
    provider: MEMORY_PROVIDERS[0],
    entries: [],
    online: true,
    supported: true,
    state: {
      result,
      busy: false,
      create: async () => result,
      update: async () => result,
    },
    onProvider: () => {},
    onClose: () => {},
    save: async () => {},
  },
} satisfies Meta<typeof MemoryEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Create: Story = {};
export const NotInstalled: Story = {
  args: {
    state: {
      ...meta.args.state,
      result: { type: 'machine/memory', status: 'not_installed', memories: [] },
    },
  },
};
export const Edit: Story = {
  args: {
    entry: {
      machineId: 'machine',
      providerId: 'nowledge-mem',
      memoryId: 'reviewer',
      name: 'Code reviewer',
      description: 'Architecture decisions and lessons from code reviews.',
    },
  },
};
