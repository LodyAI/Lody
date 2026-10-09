import type { Meta, StoryObj } from '@storybook/react';
import { MemoryAssociationList } from '@/components/settings/memory-setting';
const meta = {
  title: 'Settings/MemoryCatalog',
  component: MemoryAssociationList,
  args: {
    entries: [
      {
        machineId: 'machine',
        providerId: 'nowledge-mem',
        memoryId: 'reviewer',
        name: 'Code reviewer',
        description: 'Architecture decisions and lessons from code reviews.',
      },
      {
        machineId: 'machine',
        providerId: 'nowledge-mem',
        memoryId: 'designer',
        name: 'Product designer',
        description: 'Product language, interaction patterns and design decisions.',
      },
    ],
    inventory: {
      type: 'machine/memory',
      status: 'ready',
      memories: [
        { id: 'reviewer', name: 'Reviewer' },
        { id: 'designer', name: 'Designer' },
      ],
    },
    onEdit: () => {},
    onRemove: () => {},
  },
} satisfies Meta<typeof MemoryAssociationList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Linked: Story = {};
export const Missing: Story = {
  args: {
    inventory: {
      type: 'machine/memory',
      status: 'ready',
      memories: [{ id: 'designer', name: 'Designer' }],
    },
  },
};
export const Offline: Story = { args: { inventory: undefined } };
export const Empty: Story = { args: { entries: [] } };
