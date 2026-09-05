import type { Meta, StoryObj } from '@storybook/react';
import { AcpControlAvailability } from '../components/shared/acp-control-availability';

const meta = {
  title: 'Chat/Model capability status',
  component: AcpControlAvailability,
  args: {
    selector: {
      configId: 'reasoning_effort',
      label: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: '',
      options: [],
      perModel: true,
      availability: 'unknown',
      hasDefault: false,
    },
  },
} satisfies Meta<typeof AcpControlAvailability>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unknown: Story = {};
export const SavedSelection: Story = { args: { value: 'high' } };
export const NoSelectableLevels: Story = {
  args: { selector: { ...meta.args.selector, availability: 'unsupported' } },
};
