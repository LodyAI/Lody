import type { Meta, StoryObj } from '@storybook/react';
import { Archive, ArchiveRestore } from 'lucide-react';

import { ArchivePendingIcon } from '@/components/icons/archive-pending-icon';

const meta = {
  title: 'Icons/ArchivePending',
  component: ArchivePendingIcon,
  tags: ['autodocs'],
  args: { size: 24, strokeWidth: 2, 'aria-hidden': true },
  argTypes: {
    size: { control: { type: 'range', min: 14, max: 48, step: 2 } },
    strokeWidth: { control: { type: 'range', min: 1, max: 3, step: 0.25 } },
    color: { control: 'color' },
  },
} satisfies Meta<typeof ArchivePendingIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Compare with the existing archive actions at actual sidebar and toolbar sizes. */
export const Sizes: Story = {
  render: (args) => (
    <table>
      <thead>
        <tr>
          <th scope="col">Size</th>
          <th scope="col">Archive</th>
          <th scope="col">Pending archive</th>
          <th scope="col">Restore</th>
        </tr>
      </thead>
      <tbody>
        {[14, 16, 20, 24, 32].map((size) => (
          <tr key={size}>
            <th scope="row">{size}px</th>
            <td>
              <Archive {...args} size={size} />
            </td>
            <td>
              <ArchivePendingIcon {...args} size={size} />
            </td>
            <td>
              <ArchiveRestore {...args} size={size} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
};
