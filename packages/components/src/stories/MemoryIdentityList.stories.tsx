import type { Meta, StoryObj } from '@storybook/react';
import { MemoryIdentityList } from '@/components/settings/memory-setting';

const meta = {
  title: 'Settings/MemoryIdentityList',
  component: MemoryIdentityList,
  args: {
    memories: [
      {
        id: 'reviewer',
        name: 'Code Reviewer',
        description: 'Architecture and code review decisions.',
      },
      {
        id: 'designer',
        name: 'Designer',
        description: 'Product language and interaction patterns.',
      },
    ],
  },
} satisfies Meta<typeof MemoryIdentityList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Catalog: Story = {};
export const Selected: Story = { args: { selected: ['reviewer', 'designer'], onSelect: () => {} } };
export const Empty: Story = { args: { memories: [] } };
export const Imported: Story = { args: { linkedIds: ['reviewer'] } };
export const Saving: Story = { args: { selected: ['reviewer', 'designer'], disabled: true } };
